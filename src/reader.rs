use std::ops::RangeFrom;

use serde::Serialize;

use crate::{Book, Chapter, Library, Reference, Verse, VerseNumbers};

/// A paragraph with its own direction, language and font, from the passage at `passage` in the
/// request: a chapter's heading, its running text, or a verse on a line of its own.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub passage: u32,
    /// The book it is from, by id: the passage's, or one read along with it.
    pub book: String,
    /// Where it stands when books are read side by side: a row for a verse of the passage and the
    /// same verse in each book read along (and a row for a chapter's headings), a column per book,
    /// the passage's first. Read alone, each block is a row of its own. In verse lines, a cell holds
    /// a block per verse.
    pub row: u32,
    pub column: u32,
    /// "heading", "text" or "verse". A verse's number, where it comes first, is followed by a tab,
    /// so the number can hang before the text.
    pub kind: String,
    pub direction: String,
    pub language: String,
    /// The font family its book asks for, if any.
    pub font_family: Option<String>,
    /// A typical letter of the block's script – an x in Latin, ο in Greek, ה in Hebrew, ه in
    /// Arabic script – and how tall it is to be, in points. The reader sizes whatever font it sets
    /// the block in so that the letter comes out that tall.
    pub letter: String,
    pub letter_height: f64,
    pub segments: Vec<Segment>,
    pub verses: Vec<VerseRange>,
    pub words: Vec<Word>,
}

/// Text, and what it is: "heading", "number" (a verse number), "ketiv" (a word as written where
/// another is read) or a tajweed rule – or nothing, for plain text. The reader colors it by its role.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Segment {
    pub text: String,
    pub role: Option<String>,
}

/// A verse of a paragraph: where it stands in the scripture, and its range in the paragraph's
/// text, number included, in UTF-16 code units.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VerseRange {
    pub chapter: u32,
    pub verse: u32,
    pub start: u32,
    pub end: u32,
}

/// A word of a paragraph: where it stands in the scripture, and its range in the paragraph's text,
/// in UTF-16 code units, as iOS, Android and JavaScript count them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Word {
    pub chapter: u32,
    pub verse: u32,
    pub index: u32,
    pub start: u32,
    pub end: u32,
}

const HEADING: &str = "heading";
const NUMBER: &str = "number";
/// A word as written where another is read, which comes after it; it isn't a word of the verse.
const KETIV: &str = "ketiv";
/// Headings are about half the size of the text.
const HEADING_SCALE: f64 = 0.46;

/// A heading per chapter of the passage, then the chapter as running text – or each verse on a line
/// of its own. Read along with other editions of its book, it comes in rows instead (see `along`).
/// Every block takes the next row from `rows`, unless it is read along.
pub(crate) fn blocks(
    library: &Library,
    reference: &Reference,
    passage: u32,
    size: f64,
    verse_per_line: bool,
    companions: &[&Book],
    rows: &mut RangeFrom<u32>,
) -> Vec<Block> {
    let Some(book) = library.book(&reference.book) else {
        return Vec::new();
    };
    let wanted = reference.from.unwrap_or(0)..=reference.to.unwrap_or(u32::MAX);
    let chapters =
        book.chapters.iter().filter(|chapter| reference.chapter.is_none_or(|number| number == chapter.number));
    let editions: Vec<&Book> = companions
        .iter()
        .copied()
        .filter(|other| other.id != book.id && other.code.is_some() && other.code == book.code)
        .collect();
    if !editions.is_empty() {
        let verses = chapters
            .map(|chapter| (chapter, chapter.verses.iter().filter(|verse| wanted.contains(&verse.number)).collect()));
        return along(book, verses.collect(), reference, passage, size, verse_per_line, &editions, rows);
    }
    let mut blocks = Vec::new();
    for chapter in chapters {
        let verses = chapter.verses.iter().filter(|verse| wanted.contains(&verse.number));
        blocks.push(heading(book, chapter, (reference.from, reference.to), passage, size));
        if verse_per_line {
            blocks.extend(verses.map(|verse| paragraph(book, [(chapter, verse)], passage, size, "verse", None)));
            continue;
        }
        // Unnumbered text before verse 1, such as the basmala, stands apart from the verses.
        let (opening, numbered): (Vec<_>, Vec<_>) = verses.partition(|verse| verse.number == 0);
        for verses in [opening, numbered].into_iter().filter(|verses| !verses.is_empty()) {
            blocks.push(paragraph(book, verses.into_iter().map(|verse| (chapter, verse)), passage, size, "text", None));
        }
    }
    for block in &mut blocks {
        block.row = rows.next().unwrap_or_default();
    }
    blocks
}

/// A passage read along with other editions of its book, in rows: per chapter a row of each
/// book's heading, then a row per verse – the verse, and in each edition the verses the KJV numbers
/// alike, after any it numbers apart or leaves out that come before them, such as a psalm's title.
/// An edition with none for a verse leaves its cell empty.
#[allow(clippy::too_many_arguments)]
fn along(
    book: &Book,
    chapters: Vec<(&Chapter, Vec<&Verse>)>,
    reference: &Reference,
    passage: u32,
    size: f64,
    verse_per_line: bool,
    editions: &[&Book],
    rows: &mut RangeFrom<u32>,
) -> Vec<Block> {
    let kind = if verse_per_line { "verse" } else { "text" };
    let mut read: Vec<Edition> = editions.iter().map(|edition| Edition::of(edition)).collect();
    // Each edition starts at the verse numbered as the passage's first – from a chapter's start,
    // with what comes before its verse 1. The start is the KJV's: the Hebrew Jonah's 2:1 is its 1:17.
    if let Some((chapter, verse)) =
        chapters.iter().find_map(|(chapter, verses)| verses.first().map(|verse| (*chapter, *verse)))
    {
        let first = kjv(chapter, verse);
        let start = if first.1 <= 1 { (first.0, 0) } else { first };
        for edition in &mut read {
            edition.at = edition.verses.iter().position(|(number, _)| *number >= start).unwrap_or(edition.verses.len());
        }
    }
    let mut blocks = Vec::new();
    for (chapter, verses) in chapters.into_iter().filter(|(_, verses)| !verses.is_empty()) {
        let rowed: Vec<(&Verse, Vec<Verses>)> = verses
            .into_iter()
            .map(|verse| (verse, read.iter_mut().map(|edition| edition.read_up_to(kjv(chapter, verse))).collect()))
            .collect();
        let row = rows.next().unwrap_or_default();
        blocks.push(Block { row, ..heading(book, chapter, (reference.from, reference.to), passage, size) });
        for (column, edition) in (1..).zip(editions) {
            // An edition's heading names the chapter its first verse here is in.
            if let Some((their, _)) = rowed.iter().find_map(|(_, cells)| cells[column as usize - 1].first().copied()) {
                blocks.push(Block { row, column, ..heading(edition, their, (None, None), passage, size) });
            }
        }
        for (verse, cells) in rowed {
            let row = rows.next().unwrap_or_default();
            blocks.push(Block { row, ..paragraph(book, [(chapter, verse)], passage, size, kind, None) });
            for ((column, edition), cell) in (1..).zip(editions).zip(cells).filter(|(_, cell)| !cell.is_empty()) {
                // In verse lines, each verse of a cell is a line of its own.
                let lines =
                    if verse_per_line { cell.into_iter().map(|verse| vec![verse]).collect() } else { vec![cell] };
                blocks.extend(lines.into_iter().map(|verses| Block {
                    row,
                    column,
                    ..paragraph(edition, verses, passage, size, kind, Some(chapter.number))
                }));
            }
        }
    }
    blocks
}

/// A verse with its chapter, and verses so.
type ChapterVerse<'a> = (&'a Chapter, &'a Verse);
type Verses<'a> = Vec<ChapterVerse<'a>>;

/// An edition read along: its verses in order, each with its number in the KJV, and how far into
/// them the passage has come.
struct Edition<'a> {
    verses: Vec<((u32, u32), ChapterVerse<'a>)>,
    at: usize,
}

impl<'a> Edition<'a> {
    fn of(book: &'a Book) -> Self {
        let verses = book
            .chapters
            .iter()
            .flat_map(|chapter| chapter.verses.iter().map(move |verse| (kjv(chapter, verse), (chapter, verse))));
        Edition { verses: verses.collect(), at: 0 }
    }

    /// The verses from where it has come to, up to those the KJV numbers as `number`.
    fn read_up_to(&mut self, number: (u32, u32)) -> Verses<'a> {
        let mut read = Vec::new();
        while self.at < self.verses.len() && self.verses[self.at].0 <= number {
            read.push(self.verses[self.at].1);
            self.at += 1;
        }
        read
    }
}

/// A verse's chapter and number as the KJV counts them.
fn kjv(chapter: &Chapter, verse: &Verse) -> (u32, u32) {
    verse.kjv.unwrap_or((chapter.number, verse.number))
}

/// A chapter's heading in its book's language and direction: the book, the chapter and verses
/// in the book's digits, and the work.
fn heading(book: &Book, chapter: &Chapter, (from, to): (Option<u32>, Option<u32>), passage: u32, size: f64) -> Block {
    let label = |number: u32| match chapter.verses.iter().find(|verse| verse.number == number) {
        Some(verse) if !verse.label.is_empty() => verse.label.clone(),
        _ => number.to_string(),
    };
    let range = match (from, to) {
        (None, _) => String::new(),
        (Some(from), Some(to)) if to != from => format!(":{}–{}", label(from), label(to)),
        (Some(from), _) => format!(":{}", label(from)),
    };
    Block {
        passage,
        book: book.id.clone(),
        row: 0,
        column: 0,
        kind: HEADING.into(),
        direction: book.direction.clone(),
        language: book.language.clone(),
        font_family: None,
        letter: typical_letter(book).0.into(),
        letter_height: typical_letter(book).1 * size * HEADING_SCALE,
        segments: vec![Segment {
            text: format!("{} {}{range} · {}", book.title, chapter.label, book.work),
            role: Some(HEADING.into()),
        }],
        verses: Vec::new(),
        words: Vec::new(),
    }
}

/// A typical letter of the script a book is written in, and how tall it is to be per point of the
/// size asked for. Every script's is as tall as ه in Amiri Quran, so that the Quran comes out at
/// the size asked for; only a Hebrew letter stands a little taller than an x, as in bilingual type.
fn typical_letter(book: &Book) -> (&'static str, f64) {
    const HEIGHT: f64 = 0.33;
    match book.language.as_str() {
        "ar" | "fa" => ("ه", HEIGHT),
        "he" => ("ה", HEIGHT * 1.15),
        "el" => ("ο", HEIGHT),
        _ => ("x", HEIGHT),
    }
}

/// Verses as a paragraph. Read along with a verse of another chapter, a verse's number names its
/// own chapter, as 2:1 beside 1:17.
fn paragraph<'a>(
    book: &Book,
    verses: impl IntoIterator<Item = (&'a Chapter, &'a Verse)>,
    passage: u32,
    size: f64,
    kind: &str,
    beside: Option<u32>,
) -> Block {
    let mut text = Text::default();
    for (chapter, verse) in verses {
        let label = match beside {
            Some(other) if other != chapter.number && !verse.label.is_empty() => {
                format!("{}:{}", chapter.label, verse.label)
            }
            _ => verse.label.clone(),
        };
        let chapter = chapter.number;
        if text.length > 0 {
            text.push(" ", None);
        }
        let start = text.length;
        // A no-break space keeps a verse number with its verse at the end of a line; on a line of
        // its own, a tab lets the number hang.
        if book.verse_numbers == VerseNumbers::Start && !label.is_empty() {
            let separator = if kind == "verse" { '\t' } else { '\u{a0}' };
            text.push(&format!("{label}{separator}"), Some(NUMBER));
        }
        let offset = text.length;
        for (index, (start, end)) in (0..).zip(words_of(verse)) {
            text.words.push(Word { chapter, verse: verse.number, index, start: offset + start, end: offset + end });
        }
        for (run, rule) in &verse.runs {
            text.push(run, rule.as_deref());
        }
        if book.verse_numbers == VerseNumbers::End && !label.is_empty() {
            text.push(&format!("\u{a0}{}{label}", book.verse_number_prefix), Some(NUMBER));
        }
        text.verses.push(VerseRange { chapter, verse: verse.number, start, end: text.length });
    }
    Block {
        passage,
        book: book.id.clone(),
        row: 0,
        column: 0,
        kind: kind.into(),
        direction: book.direction.clone(),
        language: book.language.clone(),
        font_family: book.font.clone(),
        letter: typical_letter(book).0.into(),
        letter_height: typical_letter(book).1 * size,
        segments: text.segments,
        verses: text.verses,
        words: text.words,
    }
}

/// What a word is, in the version recordings name, as their timings count words so: see
/// [`words_of`]. Whatever changes what a word is raises it.
pub const WORD_DEFINITION: u32 = 1;

/// A verse's words, each as its range in the verse's text, in UTF-16 code units. A word is a run of
/// non-space characters, which may span tajweed runs, with a letter or a digit in it: a mark
/// standing alone, such as the Hebrew paseq, is none, nor is a word as written where another is read.
pub(crate) fn words_of(verse: &Verse) -> Vec<(u32, u32)> {
    let mut words = Vec::new();
    let mut word: Option<(u32, bool)> = None;
    let mut end_word = |word: Option<(u32, bool)>, end: u32| {
        if let Some((start, true)) = word {
            words.push((start, end));
        }
    };
    let mut offset = 0;
    for (run, rule) in &verse.runs {
        let read = rule.as_deref() != Some(KETIV);
        for char in run.chars() {
            if char.is_whitespace() || !read {
                end_word(word.take(), offset);
            } else {
                let (start, lettered) = word.unwrap_or((offset, false));
                word = Some((start, lettered || char.is_alphanumeric()));
            }
            offset += char.len_utf16() as u32;
        }
    }
    end_word(word, offset);
    words
}

/// A paragraph's text as it grows: its segments, verses and words, and its length in UTF-16 units.
#[derive(Default)]
struct Text {
    segments: Vec<Segment>,
    verses: Vec<VerseRange>,
    words: Vec<Word>,
    length: u32,
}

impl Text {
    fn push(&mut self, text: &str, role: Option<&str>) {
        self.length += text.encode_utf16().count() as u32;
        self.segments.push(Segment { text: text.into(), role: role.map(String::from) });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use super::*;

    /// Excerpts of the editions the tests read, from tests/fixtures.
    static LIBRARY: LazyLock<Library> = LazyLock::new(|| {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).expect("the fixtures are valid");
        library
    });

    fn book(id: &str) -> &'static Book {
        LIBRARY.book(id).unwrap()
    }

    fn passage(book: &str, chapter: Option<u32>, from: Option<u32>, to: Option<u32>) -> Vec<Block> {
        blocks(&LIBRARY, &Reference { book: book.into(), chapter, from, to }, 0, 28.0, false, &[], &mut (0..))
    }

    fn verse_lines(book: &str, chapter: Option<u32>) -> Vec<Block> {
        blocks(
            &LIBRARY,
            &Reference { book: book.into(), chapter, from: None, to: None },
            0,
            28.0,
            true,
            &[],
            &mut (0..),
        )
    }

    /// A passage read along with other editions: per row, each column's verses as book:chapter:verse.
    fn along_with(book: &str, chapter: u32, from: Option<u32>, to: Option<u32>, editions: &[&str]) -> Vec<Vec<String>> {
        let editions: Vec<&Book> = editions.iter().map(|id| self::book(id)).collect();
        let blocks = blocks(
            &LIBRARY,
            &Reference { book: book.into(), chapter: Some(chapter), from, to },
            0,
            28.0,
            false,
            &editions,
            &mut (0..),
        );
        let rows = blocks.iter().map(|block| block.row).max().unwrap() + 1;
        (0..rows)
            .map(|row| {
                let cells = blocks.iter().filter(|block| block.row == row && block.kind != "heading");
                cells
                    .map(|block| {
                        block
                            .verses
                            .iter()
                            .map(|verse| format!("{}:{}:{}", block.book, verse.chapter, verse.verse))
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .collect()
            })
            .filter(|cells: &Vec<String>| !cells.is_empty())
            .collect()
    }

    fn utf16(block: &Block) -> Vec<u16> {
        block.segments.iter().flat_map(|segment| segment.text.encode_utf16()).collect()
    }

    /// The words as their ranges cut them out of their paragraphs' text.
    fn words(blocks: &[Block]) -> Vec<String> {
        let cut = |block: &Block| {
            let text = utf16(block);
            let words = block
                .words
                .iter()
                .map(|word| String::from_utf16(&text[word.start as usize..word.end as usize]).unwrap());
            words.collect::<Vec<_>>()
        };
        blocks.iter().flat_map(cut).collect()
    }

    fn verses(block: &Block) -> Vec<String> {
        let text = utf16(block);
        block
            .verses
            .iter()
            .map(|verse| String::from_utf16(&text[verse.start as usize..verse.end as usize]).unwrap())
            .collect()
    }

    fn verse_text(book: &str, chapter: Option<u32>, number: u32) -> String {
        let book = self::book(book);
        let chapters = book.chapters.iter().filter(|candidate| chapter.is_none_or(|number| number == candidate.number));
        let verse = chapters.flat_map(|chapter| &chapter.verses).find(|verse| verse.number == number).unwrap();
        verse.runs.iter().map(|(run, _)| run.as_str()).collect()
    }

    #[test]
    fn words_are_the_verse_text_between_spaces() {
        for (book, chapter, verse) in
            [("quran-1", None, 1), ("quran-2", None, 255), ("jonah", Some(1), 17), ("jonah", Some(2), 2)]
        {
            let expected: Vec<String> = verse_text(book, chapter, verse).split_whitespace().map(String::from).collect();
            assert_eq!(words(&passage(book, chapter, Some(verse), Some(verse))), expected, "{book} {verse}");
        }
        assert_eq!(words(&passage("quran-1", None, Some(1), Some(1))).len(), 4);
    }

    #[test]
    fn the_basmala_stands_before_verse_one() {
        // The heading, the basmala in a paragraph of its own, then the verses from verse 1.
        let whole = passage("quran-2", None, None, None);
        assert!(whole[1].words.len() == 4 && whole[1].words.iter().all(|word| word.verse == 0));
        assert_eq!(whole[2].words[0].verse, 1);
        assert_eq!(words(&whole[2..3])[0], "الٓمٓ");
    }

    #[test]
    fn a_mark_standing_alone_is_no_word() {
        // Jonah 1:3 has a paseq, ׀, between two words.
        let text = verse_text("jonah-he", Some(1), 3);
        assert!(text.contains(" \u{5c0} "));
        let expected: Vec<String> =
            text.split_whitespace().filter(|word| word.chars().any(char::is_alphanumeric)).map(String::from).collect();
        assert_eq!(words(&passage("jonah-he", Some(1), Some(3), Some(3))), expected);
    }

    #[test]
    fn a_word_written_but_not_read_is_no_word() {
        // Psalm 5:9 writes הושר where it reads the word after it.
        let psalm = &passage("psalms-he", Some(5), Some(9), Some(9))[1];
        let ketiv = psalm.segments.iter().find(|segment| segment.role.as_deref() == Some(KETIV)).unwrap();
        assert_eq!(ketiv.text, "(הושר)");
        let read: String = psalm
            .segments
            .iter()
            .filter(|segment| segment.role.as_deref() != Some(KETIV))
            .map(|segment| segment.text.as_str())
            .collect();
        let expected: Vec<String> = read
            .split_whitespace()
            .skip(1)
            .filter(|word| word.chars().any(char::is_alphanumeric))
            .map(String::from)
            .collect();
        assert_eq!(words(std::slice::from_ref(psalm)), expected);
    }

    #[test]
    fn every_script_asks_for_a_letter_as_tall() {
        let height = |book: &str| {
            let block = &passage(book, Some(1), Some(1), Some(1))[1];
            (block.letter.clone(), block.letter_height / 28.0)
        };
        for (book, letter) in [("jonah", "x"), ("matthew-el", "ο"), ("jonah-ar", "ه"), ("quran-1", "ه")] {
            assert_eq!(height(book), (letter.to_string(), 0.33), "{book}");
        }
        let (letter, hebrew) = height("jonah-he");
        assert!(letter == "ה" && hebrew > 0.33);
    }

    #[test]
    fn editions_read_along_verse_by_verse() {
        assert_eq!(
            along_with("matthew-el", 12, Some(39), Some(40), &["matthew-de"]),
            [["matthew-el:12:39", "matthew-de:12:39"], ["matthew-el:12:40", "matthew-de:12:40"]],
        );
    }

    #[test]
    fn verses_match_across_numbering() {
        // The Hebrew numbers Jonah 1:17 as 2:1, and its verse number says so.
        assert_eq!(
            along_with("jonah", 1, Some(17), Some(17), &["jonah-he", "jonah-de"]),
            [["jonah:1:17", "jonah-he:2:1", "jonah-de:1:17"]],
        );
        let jonah = blocks(
            &LIBRARY,
            &Reference { book: "jonah".into(), chapter: Some(1), from: Some(17), to: Some(17) },
            0,
            28.0,
            false,
            &[book("jonah-he")],
            &mut (0..),
        );
        assert!(jonah.iter().any(|block| block.book == "jonah-he" && block.segments[0].text.starts_with("2:1")));
        // A passage that starts a chapter in one numbering may start mid-chapter in the other.
        assert_eq!(
            along_with("jonah-he", 2, Some(1), Some(2), &["jonah-de"]),
            [["jonah-he:2:1", "jonah-de:1:17"], ["jonah-he:2:2", "jonah-de:2:1"]],
        );
        // A psalm's title, which the KJV leaves unnumbered, comes with its first verse; read the other
        // way round, it stands alone.
        assert_eq!(
            along_with("psalms", 51, None, Some(1), &["psalms-he"])[0],
            ["psalms:51:1", "psalms-he:51:1 psalms-he:51:2 psalms-he:51:3"]
        );
        assert_eq!(
            along_with("psalms-he", 51, None, Some(3), &["psalms"]),
            [vec!["psalms-he:51:1"], vec!["psalms-he:51:2"], vec!["psalms-he:51:3", "psalms:51:1"]]
        );
        // In verse lines, the verses of a cell are lines of their own.
        let lines = blocks(
            &LIBRARY,
            &Reference { book: "psalms".into(), chapter: Some(51), from: None, to: Some(1) },
            0,
            28.0,
            true,
            &[book("psalms-he")],
            &mut (0..),
        );
        let hebrew: Vec<_> = lines.iter().filter(|block| block.book == "psalms-he" && block.kind == "verse").collect();
        assert_eq!(
            hebrew.iter().map(|block| (block.row, block.verses.len())).collect::<Vec<_>>(),
            [(1, 1), (1, 1), (1, 1)]
        );
    }

    #[test]
    fn a_heading_is_in_its_books_language_and_digits() {
        let heading = &passage("jonah-ar", Some(2), Some(1), Some(2))[0];
        assert_eq!(heading.segments[0].text, "يُونَان ٢:١–٢ · ترجمة فاندايك");
        assert_eq!((heading.direction.as_str(), heading.language.as_str()), ("rtl", "ar"));
    }

    #[test]
    fn a_verse_runs_from_its_number_to_its_end() {
        let jonah = passage("jonah", Some(1), Some(16), Some(17));
        assert_eq!(
            verses(&jonah[1]),
            [16, 17].map(|verse| format!("{verse}\u{a0}{}", verse_text("jonah", Some(1), verse)))
        );
        let fatiha = passage("quran-1", None, Some(1), Some(1));
        assert_eq!(verses(&fatiha[1]), [format!("{}\u{a0}\u{6dd}١", verse_text("quran-1", None, 1))]);
    }

    #[test]
    fn verse_lines_hold_a_verse_each_with_the_same_words() {
        for (book, chapter) in [("jonah", Some(2)), ("quran-2", None)] {
            let lines = verse_lines(book, chapter);
            let running = blocks(
                &LIBRARY,
                &Reference { book: book.into(), chapter, from: None, to: None },
                0,
                28.0,
                false,
                &[],
                &mut (0..),
            );
            assert_eq!(words(&lines), words(&running), "{book}");
            for line in lines.iter().filter(|block| block.kind != "heading") {
                assert_eq!(line.kind, "verse");
                assert_eq!(line.verses.len(), 1, "{book}");
                assert!(line.words.iter().all(|word| word.verse == line.verses[0].verse));
            }
        }
        // A verse number that comes first is followed by a tab, so it can hang.
        let jonah = verse_lines("jonah", Some(2));
        assert_eq!(jonah[1].segments[0].text, "1\t");
        assert_eq!(jonah[1].segments[0].role.as_deref(), Some("number"));
    }
}
