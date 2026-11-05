use std::collections::HashMap;
use std::ops::RangeFrom;

use serde::Serialize;

use crate::lexicon::{Lexicons, digits};
use crate::model::{Mark, Note, NoteRun, WordTag};
use crate::{Book, Chapter, Library, MarkNotes, Notes, Options, Reference, Verse, VerseNumbers};

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
    /// The notes on its verses, each at its mark in the text.
    pub notes: Vec<NoteMark>,
    /// What opens the chapter, set large over the paragraph's first lines: in running text, where
    /// the passage reads the chapter from its start.
    pub drop_cap: Option<DropCap>,
    /// The host's marks on its verses, each as the range of its words here.
    pub marks: Vec<PlacedMark>,
}

/// Text, and what it is: "heading", "number" (a verse number), "note" (a note's mark), "noteText"
/// (a note shown in full, in brackets), "ketiv" (a word as written where another is read) or a
/// tajweed rule – or nothing, for plain text. The reader colors it by its role, and sets a mark
/// small and raised.
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
/// in UTF-16 code units, as iOS, Android and JavaScript count them. A note's mark before or after
/// a word is no part of it; one within it, before its last letter or stop, is spanned.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Word {
    pub chapter: u32,
    pub verse: u32,
    pub index: u32,
    pub start: u32,
    pub end: u32,
    /// Whether it opens an entry of the library's lexicons, as the options let its book's words: see
    /// [`Library::entry`]. A reader opens it on a double tap.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub entry: bool,
}

/// A note's mark in a paragraph: on which verse, its range in the paragraph's text in UTF-16 code
/// units – the mark alone, or the whole of a note shown in full – and the note it opens – its kind
/// ("footnote", "endnote" or "crossReference"; "mark" for the sign of an app's mark's note; "entry"
/// for a word's number), its mark as text, and its runs, which may refer to verses. A tap on the
/// mark opens the note where it stands; a screen reader announces it with the verse.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMark {
    pub chapter: u32,
    pub verse: u32,
    pub start: u32,
    pub end: u32,
    pub kind: String,
    pub mark: String,
    pub runs: Vec<NoteRun>,
    /// The app's mark whose note it opens, for a mark's sign; none for an edition's note.
    pub id: Option<String>,
    /// The word, by its index in the verse, whose entry it opens, for a word's number: its runs are
    /// none, and [`Library::entry`] gives them.
    pub word: Option<u32>,
}

/// What opens a chapter, set large over the first lines of its paragraph: the first letter of the
/// text – the characters from `letter_start` to `letter_end` in the paragraph's text, in UTF-16
/// code units: the letter with its marks, and any quotation mark before it. The first verse goes
/// without its number; the chapter's stands in the heading.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropCap {
    pub letter_start: u32,
    pub letter_end: u32,
}

/// An app's mark in a paragraph: the words of it the paragraph holds, as their range in the
/// paragraph's text in UTF-16 code units – a verse's number and the notes' marks left out – and how
/// it is drawn. The sign of its note stands in the text where the mark ends, as a note's mark: see
/// [`MARK_SIGN_KIND`]. See [`Mark`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedMark {
    pub id: String,
    pub start: u32,
    pub end: u32,
    pub highlight: Option<String>,
    pub underline: Option<String>,
}

/// A paragraph's marks, for a reader to draw them anew as they change, its layout kept: the marks
/// over its words, and the signs of their notes, which stand in its text – as these change, so does
/// the text, and the paragraph is to be laid out anew.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ParagraphMarks {
    pub marks: Vec<PlacedMark>,
    pub signs: Vec<NoteMark>,
}

/// The kind of a note's mark that is the sign of an app's mark's note: it stands in the text where
/// the mark ends, and opens the mark's note as an edition's note's mark opens its note.
pub const MARK_SIGN_KIND: &str = "mark";
/// The kind of a note's mark that is a word's number in a lexicon, standing after the word: it opens
/// the word's entry. See [`crate::LexiconUse`].
pub const ENTRY_KIND: &str = "entry";
/// The sign itself: a pencil.
const MARK_SIGN: &str = "\u{270E}";
/// Where the sign stands alone, a word joiner before it keeps it on the line of the word it follows.
const JOINED_SIGN: &str = "\u{2060}\u{270E}";

const HEADING: &str = "heading";
const NUMBER: &str = "number";
const NOTE: &str = "note";
const NOTE_TEXT: &str = "noteText";
/// A word as written where another is read, which comes after it; it isn't a word of the verse.
const KETIV: &str = "ketiv";
/// Headings are about half the size of the text.
const HEADING_SCALE: f64 = 0.46;

/// A heading per chapter of the passage, then the chapter as running text – or each verse on a line
/// of its own. Read along with other editions of its book, it comes in rows instead (see `along`).
/// Every block takes the next row from `rows`, unless it is read along. In running text, a chapter
/// read from its start opens with a drop cap, if the options ask for them: its first letter set
/// large – in a Bible, whose verse numbers come first; a mushaf has none.
pub(crate) fn blocks(
    library: &Library,
    reference: &Reference,
    passage: u32,
    options: &Options,
    companions: &[&Book],
    rows: &mut RangeFrom<u32>,
) -> Vec<Block> {
    let Some(book) = library.book(&reference.book) else {
        return Vec::new();
    };
    let (size, verse_per_line) = (options.font_size, options.verse_per_line);
    let shown = Shown { options, lexicons: &library.lexicons };
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
        return along(book, verses.collect(), reference, passage, &shown, &editions, rows);
    }
    let mut blocks = Vec::new();
    for chapter in chapters {
        let verses = chapter.verses.iter().filter(|verse| wanted.contains(&verse.number));
        blocks.push(heading(book, chapter, (reference.from, reference.to), passage, size));
        if verse_per_line {
            blocks
                .extend(verses.map(|verse| paragraph(book, [(chapter, verse)], passage, "verse", None, &shown, false)));
            continue;
        }
        // Unnumbered text before verse 1, such as the basmala, stands apart from the verses.
        let (opening, numbered): (Vec<_>, Vec<_>) = verses.partition(|verse| verse.number == 0);
        let first = chapter.verses.iter().find(|verse| verse.number > 0).map(|verse| verse.number);
        for verses in [opening, numbered].into_iter().filter(|verses| !verses.is_empty()) {
            let opens =
                options.drop_caps && book.verse_numbers == VerseNumbers::Start && Some(verses[0].number) == first;
            let verses = verses.into_iter().map(|verse| (chapter, verse));
            blocks.push(paragraph(book, verses, passage, "text", None, &shown, opens));
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
fn along(
    book: &Book,
    chapters: Vec<(&Chapter, Vec<&Verse>)>,
    reference: &Reference,
    passage: u32,
    shown: &Shown,
    editions: &[&Book],
    rows: &mut RangeFrom<u32>,
) -> Vec<Block> {
    let (size, verse_per_line) = (shown.options.font_size, shown.options.verse_per_line);
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
            blocks.push(Block { row, ..paragraph(book, [(chapter, verse)], passage, kind, None, shown, false) });
            for ((column, edition), cell) in (1..).zip(editions).zip(cells).filter(|(_, cell)| !cell.is_empty()) {
                // In verse lines, each verse of a cell is a line of its own.
                let lines =
                    if verse_per_line { cell.into_iter().map(|verse| vec![verse]).collect() } else { vec![cell] };
                blocks.extend(lines.into_iter().map(|verses| Block {
                    row,
                    column,
                    ..paragraph(edition, verses, passage, kind, Some(chapter.number), shown, false)
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
        notes: Vec::new(),
        drop_cap: None,
        marks: Vec::new(),
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

/// What paragraphs show besides their words, as the options ask: the notes, and the words' numbers,
/// from the lexicons that hold their entries.
struct Shown<'a> {
    options: &'a Options,
    lexicons: &'a Lexicons,
}

/// Verses as a paragraph. Read along with a verse of another chapter, a verse's number names its
/// own chapter, as 2:1 beside 1:17. As `shown` asks, each note's mark stands in the text where the
/// note does, as a segment of its own – or, shown in full, in brackets after its mark – and each
/// tagged word's number after it, as a mark of the kind [`ENTRY_KIND`]; its words open their
/// entries. With `drop_cap`, the paragraph opens the chapter: its first verse goes without its
/// number, and the text's first letter is to be set large.
fn paragraph<'a>(
    book: &Book,
    verses: impl IntoIterator<Item = (&'a Chapter, &'a Verse)>,
    passage: u32,
    kind: &str,
    beside: Option<u32>,
    shown: &Shown,
    drop_cap: bool,
) -> Block {
    let (size, notes) = (shown.options.font_size, shown.options.notes);
    let (entries, numbers) = (shown.options.entries_in(&book.id), shown.options.numbers_in(&book.id));
    let mut text = Text::default();
    let mut drop = None;
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
        let opens = drop_cap && start == 0;
        // A no-break space keeps a verse number with its verse at the end of a line; on a line of
        // its own, a tab lets the number hang. A drop cap stands for the first verse's number.
        if book.verse_numbers == VerseNumbers::Start && !label.is_empty() && !opens {
            let separator = if kind == "verse" { '\t' } else { '\u{a0}' };
            text.push(&format!("{label}{separator}"), Some(NUMBER));
        }
        let offset = text.length;
        let verse_text: String = verse.runs.iter().map(|(run, _)| run.as_str()).collect();
        let words = words_of(verse);
        let mut inserts: Vec<Insert> = Vec::new();
        if numbers {
            inserts.extend(verse.tags.iter().filter_map(|tag| Insert::number(tag, &words)));
        }
        if notes != Notes::None {
            inserts.extend(verse.notes.iter().map(|note| Insert::of(note, notes, &verse_text)));
        }
        // In the order they stand; a number before a note at the same place, as it follows its word.
        inserts.sort_by_key(|insert| insert.at);
        // How far the notes that stand before a point of the verse's text move it: at a word's
        // start, a note there comes before the word; at its end, one there comes after it.
        let moved = |at: u32, before: bool| -> u32 {
            let before_it = |insert: &&Insert| if before { insert.at <= at } else { insert.at < at };
            inserts.iter().filter(before_it).map(|insert| insert.length).sum()
        };
        for (index, &(start, end)) in (0..).zip(&words) {
            let entry = entries && shown.lexicons.has_entry(verse, (start, end));
            let (start, end) = (offset + start + moved(start, true), offset + end + moved(end, false));
            text.words.push(Word { chapter, verse: verse.number, index, start, end, entry });
        }
        if opens && let Some(&(first, _)) = words.first() {
            let (start, letter) = (offset + first + moved(first, true), initial(&verse_text, first));
            if letter > 0 {
                drop = Some(DropCap { letter_start: start, letter_end: start + letter });
            }
        }
        text.push_runs(&verse.runs, &inserts, chapter, verse.number);
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
        notes: text.notes,
        drop_cap: drop,
        marks: Vec::new(),
    }
}

/// Each mark's words in every paragraph of its book that holds any – from the first of them to
/// the last – and the sign of its note, if it has one, where its words end in the last such
/// paragraph of each passage – or the note in full there, as `mark_notes` asks: see [`set_signs`].
/// A mark of a book no paragraph is from shows nowhere.
pub(crate) fn place_marks(blocks: &mut [Block], marks: &[Mark], mark_notes: MarkNotes) {
    let key = |word: &Word| (word.chapter, word.verse, word.index);
    // The paragraphs of each book that hold words, with the places of their first and last words:
    // a mark looks only at its book's, and passes over those it has no words in at a glance.
    type Place = (u32, u32, u32);
    let mut by_book: HashMap<&str, Vec<(usize, Place, Place)>> = HashMap::new();
    for (index, block) in blocks.iter().enumerate() {
        if let (Some(first), Some(last)) = (block.words.first(), block.words.last()) {
            by_book.entry(block.book.as_str()).or_default().push((index, key(first), key(last)));
        }
    }
    let mut placed: Vec<(usize, PlacedMark)> = Vec::new();
    // Where the signs of the marks' notes go: in a paragraph, where a mark's words there end.
    let mut signs: Vec<(usize, u32, &Mark)> = Vec::new();
    for mark in marks {
        let Some(candidates) = by_book.get(mark.book.as_str()) else { continue };
        let (from, to) = (mark.from.start(), mark.to.end());
        // Per passage, the last paragraph that holds any of the mark, and where its words end there.
        let mut last: Vec<(u32, usize, u32)> = Vec::new();
        for &(index, first, end) in candidates {
            if end < from || first > to {
                continue;
            }
            let block = &blocks[index];
            let start = block.words.partition_point(|word| key(word) < from);
            let stop = block.words.partition_point(|word| key(word) <= to);
            if start >= stop {
                continue;
            }
            let end = block.words[stop - 1].end;
            placed.push((
                index,
                PlacedMark {
                    id: mark.id.clone(),
                    start: block.words[start].start,
                    end,
                    highlight: mark.highlight.clone(),
                    underline: mark.underline.clone(),
                },
            ));
            match last.iter_mut().find(|(passage, ..)| *passage == block.passage) {
                Some(entry) => (entry.1, entry.2) = (index, end),
                None => last.push((block.passage, index, end)),
            }
        }
        if !mark.note.is_empty() {
            signs.extend(last.into_iter().map(|(_, index, end)| (index, end, mark)));
        }
    }
    for (index, mark) in placed {
        blocks[index].marks.push(mark);
    }
    set_signs(blocks, signs, mark_notes);
}

/// Sets the sign of each mark's note into its paragraph's text where the mark's words there end –
/// after an edition's note's mark that follows them straight away – as a note's mark of the kind
/// [`MARK_SIGN_KIND`], which opens the mark's note, on the verse of the mark's last word there; or,
/// in full, the note in brackets after the sign, as an edition's note shown in full. What follows in
/// the paragraph moves on: its words, verses, notes and marks; a mark the sign falls within takes it
/// in. Like the notes' marks, a sign is no word, nor is a note in full.
fn set_signs(blocks: &mut [Block], signs: Vec<(usize, u32, &Mark)>, mark_notes: MarkNotes) {
    // Where each goes in its paragraph's text as it is, and on which verse.
    let mut places: Vec<(usize, u32, usize, u32, u32, &Mark)> = Vec::new();
    for (order, (index, end, mark)) in signs.into_iter().enumerate() {
        let block = &blocks[index];
        let mut at = end;
        while let Some(note) =
            block.notes.iter().find(|note| note.start == at && note.end - note.start == utf16(&note.mark))
        {
            at = note.end;
        }
        let Some(word) = block.words.iter().rfind(|word| word.end <= end) else { continue };
        places.push((index, at, order, word.chapter, word.verse, mark));
    }
    // The last first, so each leaves the places of those before it as they are; of signs at one
    // place, the later mark's first, so the earlier's stands first.
    places.sort_by_key(|place| std::cmp::Reverse((place.0, place.1, place.2)));
    for (index, at, _, chapter, verse, mark) in places {
        insert_sign(&mut blocks[index], at, chapter, verse, mark, mark_notes);
    }
}

/// Sets a mark's sign – or its note in full – into a paragraph's text at `at`, on a verse: see
/// [`set_signs`].
fn insert_sign(block: &mut Block, at: u32, chapter: u32, verse: u32, mark: &Mark, mark_notes: MarkNotes) {
    let sign = |text: &str| Segment { text: text.into(), role: Some(NOTE.into()) };
    let inserted = match mark_notes {
        MarkNotes::Sign => vec![sign(JOINED_SIGN)],
        // Set off by spaces from the words around it where there are none, as an edition's note.
        MarkNotes::Inline => {
            let text: String = block.segments.iter().map(|segment| segment.text.as_str()).collect();
            let (before, after) = split_utf16(&text, at);
            let lead = before.chars().last().is_some_and(|char| !char.is_whitespace());
            let trail = after.chars().next().is_some_and(char::is_alphanumeric);
            vec![
                Segment { text: if lead { " [".into() } else { "[".into() }, role: Some(NOTE_TEXT.into()) },
                sign(MARK_SIGN),
                Segment {
                    text: format!(" {}]{}", inline_text(&mark.note), if trail { " " } else { "" }),
                    role: Some(NOTE_TEXT.into()),
                },
            ]
        }
    };
    let length: u32 = inserted.iter().map(|segment| utf16(&segment.text)).sum();
    // The segment the place is in is cut there, and the sign goes between its parts.
    let mut start = 0;
    let mut place = block.segments.len();
    for (index, segment) in block.segments.iter().enumerate() {
        let end = start + utf16(&segment.text);
        if at < end {
            place = index;
            break;
        }
        start = end;
    }
    if place < block.segments.len() && at > start {
        let (before, after) = split_utf16(&block.segments[place].text, at - start);
        let (before, after) = (before.to_string(), after.to_string());
        let role = block.segments[place].role.clone();
        block.segments[place].text = before;
        block.segments.insert(place + 1, Segment { text: after, role });
        place += 1;
    }
    for (offset, segment) in inserted.into_iter().enumerate() {
        block.segments.insert(place + offset, segment);
    }
    for word in &mut block.words {
        if word.start >= at {
            (word.start, word.end) = (word.start + length, word.end + length);
        }
    }
    // The verse the sign stands in takes it in.
    for range in &mut block.verses {
        if range.start >= at {
            range.start += length;
        }
        if range.end >= at {
            range.end += length;
        }
    }
    for note in &mut block.notes {
        if note.start >= at {
            (note.start, note.end) = (note.start + length, note.end + length);
        }
    }
    for placed in &mut block.marks {
        if placed.start >= at {
            (placed.start, placed.end) = (placed.start + length, placed.end + length);
        } else if placed.end > at {
            placed.end += length;
        }
    }
    if let Some(drop) = &mut block.drop_cap
        && drop.letter_start >= at
    {
        (drop.letter_start, drop.letter_end) = (drop.letter_start + length, drop.letter_end + length);
    }
    let position = block.notes.partition_point(|note| note.start < at);
    let sign = NoteMark {
        chapter,
        verse,
        start: at,
        end: at + length,
        kind: MARK_SIGN_KIND.into(),
        mark: (if mark_notes == MarkNotes::Sign { JOINED_SIGN } else { MARK_SIGN }).into(),
        runs: mark.note.clone(),
        id: Some(mark.id.clone()),
        word: None,
    };
    block.notes.insert(position, sign);
}

/// A note as it goes into a verse's text, at `at`: its mark, as a segment of its own – shown in
/// full, in brackets after its mark, set off from the words around it by spaces where there are
/// none – and how long that is in UTF-16 code units. Or a word's number, which opens its entry.
struct Insert<'a> {
    opens: Opens<'a>,
    at: u32,
    segments: Vec<Segment>,
    length: u32,
}

/// What a mark set into the text opens: a note, or the entry of a word, by its index in the verse.
enum Opens<'a> {
    Note(&'a Note),
    Entry(u32),
}

impl<'a> Insert<'a> {
    /// A tagged word's numbers, after it, as one mark: its digits, those of each of its parts with a
    /// number. None for a tag without one, or within no word of the core.
    fn number(tag: &WordTag, words: &[(u32, u32)]) -> Option<Self> {
        let numbers: Vec<String> = tag.parts.iter().filter_map(|part| part.number.as_deref()).map(digits).collect();
        let word = words.iter().position(|&(start, end)| tag.at < end && tag.end() > start)?;
        if numbers.is_empty() {
            return None;
        }
        let mark = numbers.join("\u{a0}");
        let length = utf16(&mark);
        let segments = vec![Segment { text: mark, role: Some(NOTE.into()) }];
        Some(Insert { opens: Opens::Entry(word as u32), at: tag.end(), segments, length })
    }

    fn of(note: &'a Note, notes: Notes, verse_text: &str) -> Self {
        let mark = Segment { text: note.mark.clone(), role: Some(NOTE.into()) };
        let text = if notes == Notes::Inline { inline_text(&note.runs) } else { String::new() };
        let segments = if text.is_empty() {
            vec![mark]
        } else {
            let (before, after) = split_utf16(verse_text, note.at);
            let lead = before.chars().last().is_some_and(|char| !char.is_whitespace());
            let trail = after.chars().next().is_some_and(char::is_alphanumeric);
            vec![
                Segment { text: if lead { " [".into() } else { "[".into() }, role: Some(NOTE_TEXT.into()) },
                mark,
                Segment { text: format!(" {text}]{}", if trail { " " } else { "" }), role: Some(NOTE_TEXT.into()) },
            ]
        };
        let length = segments.iter().map(|segment| utf16(&segment.text)).sum();
        Insert { opens: Opens::Note(note), at: note.at, segments, length }
    }
}

/// A note's text as it shows in full: its runs as one line, without the verse it names, which it
/// stands in.
fn inline_text(runs: &[NoteRun]) -> String {
    let runs = runs.iter().filter(|run| run.role.as_deref() != Some("origin"));
    let text: String = runs.map(|run| if run.text == "\n" { " ".to_string() } else { run.text.clone() }).collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How long the first letter of a text is, from `from` UTF-16 code units in: whatever comes before
/// the first letter or digit, such as a quotation mark, the letter, and the marks on it – a Hebrew
/// letter's points and accents, an Arabic one's vowels. 0 where no letter follows.
fn initial(text: &str, from: u32) -> u32 {
    let (_, rest) = split_utf16(text, from);
    let mut length = 0;
    let mut lettered = false;
    for char in rest.chars() {
        if char.is_whitespace() || (lettered && !is_combining(char)) {
            break;
        }
        length += char.len_utf16() as u32;
        lettered |= char.is_alphanumeric();
    }
    if lettered { length } else { 0 }
}

/// Whether a character is a mark on the letter before it: a combining diacritic, a Hebrew point or
/// accent, an Arabic vowel sign.
fn is_combining(char: char) -> bool {
    matches!(
        char as u32,
        0x0300..=0x036F
            | 0x0591..=0x05BD
            | 0x05BF
            | 0x05C1..=0x05C2
            | 0x05C4..=0x05C5
            | 0x05C7
            | 0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06DC
            | 0x06DF..=0x06E4
            | 0x06E7..=0x06E8
            | 0x06EA..=0x06ED
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x20D0..=0x20FF
            | 0xFE20..=0xFE2F
    )
}

fn utf16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
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

/// A paragraph's text as it grows: its segments, verses, words and notes, and its length in UTF-16
/// units.
#[derive(Default)]
struct Text {
    segments: Vec<Segment>,
    verses: Vec<VerseRange>,
    words: Vec<Word>,
    notes: Vec<NoteMark>,
    length: u32,
}

impl Text {
    fn push(&mut self, text: &str, role: Option<&str>) {
        self.length += utf16(text);
        self.segments.push(Segment { text: text.into(), role: role.map(String::from) });
    }

    /// A verse's runs, with its notes where they stand: a run that holds a note's place is split
    /// there. A note past the text's end comes last.
    fn push_runs(&mut self, runs: &[(String, Option<String>)], inserts: &[Insert], chapter: u32, verse: u32) {
        let mut inserts = inserts.iter().peekable();
        let mut at = 0;
        for (run, role) in runs {
            let mut rest = run.as_str();
            while let Some(insert) = inserts.next_if(|insert| insert.at < at + utf16(rest)) {
                let (before, after) = split_utf16(rest, insert.at.saturating_sub(at));
                if !before.is_empty() {
                    self.push(before, role.as_deref());
                }
                at += utf16(before);
                self.push_note(insert, chapter, verse);
                rest = after;
            }
            if !rest.is_empty() {
                self.push(rest, role.as_deref());
                at += utf16(rest);
            }
        }
        for insert in inserts {
            self.push_note(insert, chapter, verse);
        }
    }

    fn push_note(&mut self, insert: &Insert, chapter: u32, verse: u32) {
        let start = self.length;
        for segment in &insert.segments {
            self.push(&segment.text, segment.role.as_deref());
        }
        let mark = match insert.opens {
            Opens::Note(note) => NoteMark {
                chapter,
                verse,
                start,
                end: self.length,
                kind: note.kind.clone(),
                mark: note.mark.clone(),
                runs: note.runs.clone(),
                id: None,
                word: None,
            },
            Opens::Entry(word) => NoteMark {
                chapter,
                verse,
                start,
                end: self.length,
                kind: ENTRY_KIND.into(),
                mark: insert.segments.iter().map(|segment| segment.text.as_str()).collect(),
                runs: Vec::new(),
                id: None,
                word: Some(word),
            },
        };
        self.notes.push(mark);
    }
}

/// A text split after `units` UTF-16 code units – or before them, where that would cut a character.
fn split_utf16(text: &str, units: u32) -> (&str, &str) {
    let mut counted = 0;
    for (index, char) in text.char_indices() {
        if counted + char.len_utf16() as u32 > units {
            return text.split_at(index);
        }
        counted += char.len_utf16() as u32;
    }
    (text, "")
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

    fn options(verse_per_line: bool) -> Options {
        Options {
            font_size: 28.0,
            verse_per_line,
            companions: Vec::new(),
            notes: Notes::Marks,
            drop_caps: true,
            mark_notes: MarkNotes::Sign,
            lexicon: crate::LexiconUse::Entries,
            lexicon_books: None,
        }
    }

    fn passage(book: &str, chapter: Option<u32>, from: Option<u32>, to: Option<u32>) -> Vec<Block> {
        blocks(&LIBRARY, &Reference { book: book.into(), chapter, from, to }, 0, &options(false), &[], &mut (0..))
    }

    fn verse_lines(book: &str, chapter: Option<u32>) -> Vec<Block> {
        blocks(
            &LIBRARY,
            &Reference { book: book.into(), chapter, from: None, to: None },
            0,
            &options(true),
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
            &options(false),
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
            .filter(|segment| segment.role.as_deref() != Some(KETIV) && segment.role.as_deref() != Some(NUMBER))
            .map(|segment| segment.text.as_str())
            .collect();
        let expected: Vec<String> =
            read.split_whitespace().filter(|word| word.chars().any(char::is_alphanumeric)).map(String::from).collect();
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
            &options(false),
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
            &options(true),
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
                &options(false),
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

    /// A verse with notes, as the import writes them: a cross reference before the first word, a
    /// footnote after "God", and one within "heavens." before its stop.
    const NOTED: &str = r#"[{"id": "noted", "code": "GEN", "title": "Genesis", "work": "Test", "direction": "ltr", "language": "en",
        "chapters": [{"number": 1, "label": "1", "verses": [
          {"number": 1, "label": "1", "runs": [["In the beginning, God created the heavens.", null]],
           "notes": [{"kind": "crossReference", "mark": "a", "at": 0, "runs": [{"text": "John 1:1", "target": {"book": "JHN", "chapter": 1, "verse": 1}}]},
                     {"kind": "footnote", "mark": "1", "at": 21, "runs": [{"text": "1:1 ", "role": "origin"}, {"text": "Elohim"}]},
                     {"kind": "footnote", "mark": "2", "at": 41, "runs": [{"text": "or, sky"}]}]},
          {"number": 2, "label": "2", "runs": [["The earth was formless.", null]]}]}]},
       {"id": "john", "code": "JHN", "title": "John", "work": "Test", "direction": "ltr", "language": "en",
        "chapters": [{"number": 1, "label": "1", "verses": [
          {"number": 1, "label": "1", "runs": [["In the beginning was the Word, and the Word was with God.", null]]},
          {"number": 2, "label": "2", "runs": [["The same was in the beginning with God.", null]]}]}]}]"#;

    fn noted(notes: Notes, drop_caps: bool) -> Block {
        let mut library = Library::new();
        library.add(NOTED.as_bytes()).unwrap();
        let reference = Reference { book: "noted".into(), chapter: None, from: None, to: None };
        let options = Options { notes, drop_caps, ..options(false) };
        library.blocks(&[reference], &options).swap_remove(1)
    }

    fn text(block: &Block) -> String {
        block.segments.iter().map(|segment| segment.text.as_str()).collect()
    }

    #[test]
    fn a_notes_mark_stands_where_the_note_does_and_is_no_word() {
        let block = noted(Notes::Marks, false);
        assert_eq!(text(&block), "1\u{a0}aIn the beginning, God1 created the heavens2. 2\u{a0}The earth was formless.");
        let marks: Vec<_> = block.segments.iter().filter(|segment| segment.role.as_deref() == Some("note")).collect();
        assert_eq!(marks.iter().map(|segment| segment.text.as_str()).collect::<Vec<_>>(), ["a", "1", "2"]);
        let utf16 = utf16(&block);
        for (note, mark) in block.notes.iter().zip(["a", "1", "2"]) {
            assert_eq!(String::from_utf16(&utf16[note.start as usize..note.end as usize]).unwrap(), mark);
            assert_eq!((note.chapter, note.verse, note.mark.as_str()), (1, 1, mark));
        }
        assert_eq!(block.notes[0].kind, "crossReference");
        assert_eq!(block.notes[0].runs[0].target.as_ref().unwrap().book, "JHN");
        assert_eq!(block.notes[1].runs[1].text, "Elohim");
        // The verses a note refers to follow its runs, where the library holds their book.
        let preview: Vec<(&str, Option<&str>)> =
            block.notes[0].runs[1..].iter().map(|run| (run.text.as_str(), run.role.as_deref())).collect();
        assert_eq!(
            preview,
            [
                ("\n", None),
                ("1\u{a0}", Some("number")),
                ("In the beginning was the Word, and the Word was with God.", Some("preview"))
            ]
        );
        assert_eq!(block.notes[0].runs[2].language.as_deref(), Some("en"));
        assert_eq!(block.notes[1].runs.len(), 2);
        // The words are the verse's, a mark before or after one left out, one within it spanned.
        let plain = noted(Notes::None, false);
        assert_eq!(text(&plain), "1\u{a0}In the beginning, God created the heavens. 2\u{a0}The earth was formless.");
        assert!(plain.notes.is_empty() && plain.segments.iter().all(|segment| segment.role.as_deref() != Some("note")));
        let places = |block: &Block| block.words.iter().map(|word| (word.verse, word.index)).collect::<Vec<_>>();
        assert_eq!(places(&block), places(&plain));
        let expected: Vec<String> = words(std::slice::from_ref(&plain))
            .into_iter()
            .map(|word| if word == "heavens." { "heavens2.".into() } else { word })
            .collect();
        assert_eq!(words(std::slice::from_ref(&block)), expected);
        // As the import has them: the World English Bible's note on "Yahweh" in Jonah 1:1.
        let jonah = &passage("jonah", Some(1), Some(1), Some(1))[1];
        assert!(text(jonah).starts_with("Now Yahweh’s1 word"));
        assert_eq!(jonah.notes.len(), 1);
        assert_eq!(
            jonah.notes[0].runs[0],
            NoteRun { text: "1:1 ".into(), role: Some("origin".into()), language: None, target: None }
        );
        assert_eq!(words(std::slice::from_ref(jonah))[1], "Yahweh’s");
    }

    #[test]
    fn a_chapter_read_from_its_start_opens_with_a_drop_cap() {
        // The first letter stands large, for the first verse's number too.
        let jonah = passage("jonah", Some(1), None, None);
        assert_eq!(jonah[1].drop_cap, Some(DropCap { letter_start: 0, letter_end: 1 }));
        assert!(text(&jonah[1]).starts_with("Now Yahweh"));
        assert_eq!(jonah[1].verses[0].start, 0);
        assert_eq!(jonah[1].words[0].start, 0);
        // A Hebrew letter takes its points and accents with it; an Arabic one its vowels.
        let hebrew = &passage("jonah-he", Some(1), None, None)[1];
        let letter = hebrew.drop_cap.as_ref().unwrap();
        assert!(letter.letter_end > 1 && letter.letter_end <= 4, "{letter:?}");
        assert!(passage("jonah-ar", Some(1), None, None)[1].drop_cap.is_some());
        // Not from the middle of a chapter, not in verse lines, not in a mushaf, not read along, and not unasked.
        assert_eq!(passage("jonah", Some(1), Some(16), None)[1].drop_cap, None);
        assert!(text(&passage("jonah", Some(1), Some(16), None)[1]).starts_with("16\u{a0}"));
        assert_eq!(verse_lines("jonah", Some(1))[1].drop_cap, None);
        assert_eq!(passage("quran-1", None, None, None)[1].drop_cap, None);
        let along = blocks(
            &LIBRARY,
            &Reference { book: "jonah".into(), chapter: Some(1), from: None, to: None },
            0,
            &options(false),
            &[book("jonah-de")],
            &mut (0..),
        );
        assert!(along.iter().all(|block| block.drop_cap.is_none()));
        assert_eq!(noted(Notes::Marks, false).drop_cap, None);
        // A note's mark before the first word stays in the text; the letter is the first word's.
        let noted = noted(Notes::Marks, true);
        assert_eq!(noted.drop_cap, Some(DropCap { letter_start: 1, letter_end: 2 }));
        assert!(text(&noted).starts_with("aIn the"));
    }

    #[test]
    fn a_note_shown_in_full_stands_in_brackets_where_it_does_and_is_no_word() {
        let block = noted(Notes::Inline, false);
        // Set off by spaces from the words around it, but not from a stop; the verse it names left out.
        assert_eq!(
            text(&block),
            "1\u{a0}[a John 1:1] In the beginning, God [1 Elohim] created the heavens [2 or, sky]. 2\u{a0}The earth was formless."
        );
        let roles: Vec<_> = block.segments.iter().filter_map(|segment| segment.role.as_deref()).collect();
        assert_eq!(roles[..4], ["number", "noteText", "note", "noteText"]);
        let utf16 = utf16(&block);
        assert_eq!(
            String::from_utf16(&utf16[block.notes[1].start as usize..block.notes[1].end as usize]).unwrap(),
            " [1 Elohim]"
        );
        let places = |block: &Block| block.words.iter().map(|word| (word.verse, word.index)).collect::<Vec<_>>();
        assert_eq!(places(&block), places(&noted(Notes::None, false)));
        let words = words(std::slice::from_ref(&block));
        assert_eq!(words[0], "In");
        assert_eq!(words[3], "God");
        assert_eq!(words.last().unwrap(), "formless.");
    }

    #[test]
    fn the_first_letter_takes_a_quotation_mark_before_it_and_its_marks() {
        assert_eq!(initial("“Behold, he comes", 0), 2);
        assert_eq!(initial("וַֽיְהִי֙ דְּבַר", 0), 3);
        assert_eq!(initial("بِسْمِ", 0), 2);
        assert_eq!(initial("… nothing", 0), 0);
        assert_eq!(initial("a b", 2), 1);
    }

    /// The fixtures' editions, with marks added as a host's JSON.
    fn marked(marks: &str) -> Library {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).unwrap();
        library.add_marks(marks.as_bytes()).unwrap();
        library
    }

    fn placed(
        library: &Library,
        book: &str,
        chapter: Option<u32>,
        verse_per_line: bool,
        companions: &[&str],
    ) -> Vec<Block> {
        let companions = companions.iter().map(|id| id.to_string()).collect();
        let options = Options { companions, ..options(verse_per_line) };
        library.blocks(&[Reference { book: book.into(), chapter, from: None, to: None }], &options)
    }

    /// The signs of marks' notes in a block's text.
    fn signs(block: &Block) -> Vec<&NoteMark> {
        block.notes.iter().filter(|note| note.kind == MARK_SIGN_KIND).collect()
    }

    /// The part of a block's text from `start` to `end`, in UTF-16 code units.
    fn text_between(block: &Block, start: u32, end: u32) -> String {
        String::from_utf16(&utf16(block)[start as usize..end as usize]).unwrap()
    }

    /// A block's marks, each as its id and the text it covers.
    fn marked_text(block: &Block) -> Vec<(String, String)> {
        let text = utf16(block);
        let cut = |mark: &PlacedMark| String::from_utf16(&text[mark.start as usize..mark.end as usize]).unwrap();
        block.marks.iter().map(|mark| (mark.id.clone(), cut(mark))).collect()
    }

    const MARKS: &str = r##"[
      {"id": "fish", "book": "jonah", "from": {"chapter": 1, "verse": 17, "word": 3}, "to": {"chapter": 1, "verse": 17, "word": 4}, "highlight": "yellow"},
      {"id": "prayer", "book": "jonah", "from": {"chapter": 1, "verse": 17}, "to": {"chapter": 2, "verse": 1}, "underline": "blue",
       "note": [{"text": "Three days: see "}, {"text": "Matthew 12:40", "target": {"book": "MAT", "chapter": 12, "verse": 40}}]},
      {"id": "german", "book": "jonah-de", "from": {"chapter": 2, "verse": 1}, "to": {"chapter": 2, "verse": 1, "word": 1}, "highlight": "#FF0000"},
      {"id": "elsewhere", "book": "psalms", "from": {"chapter": 51, "verse": 1}, "to": {"chapter": 51, "verse": 2}}
    ]"##;

    const VERSE_17: &str = "Yahweh prepared a huge fish to swallow up Jonah, and Jonah was in the belly of the fish three days and three nights.";
    const VERSE_2_1: &str = "Then Jonah prayed to Yahweh, his God, out of the fish’s belly.";

    #[test]
    fn a_mark_covers_its_words_in_every_paragraph_of_its_book() {
        let library = marked(MARKS);
        // Running text: chapter 1's paragraph holds the words of 1:17, chapter 2's those of 2:1 –
        // the verse's number left out – and the note stands where the mark ends.
        let blocks = placed(&library, "jonah", None, false, &[]);
        assert_eq!(
            marked_text(&blocks[1]),
            [("fish".to_string(), "huge fish".to_string()), ("prayer".to_string(), VERSE_17.to_string())]
        );
        assert_eq!(marked_text(&blocks[3]), [("prayer".to_string(), VERSE_2_1.to_string())]);
        assert!(blocks.iter().all(|block| block.kind != "heading" || block.marks.is_empty()));
        assert_eq!(blocks[1].marks[0].highlight.as_deref(), Some("yellow"));
        assert_eq!(blocks[1].marks[1].underline.as_deref(), Some("blue"));
        // The note's sign stands in the text where the mark ends – after 2:1, in chapter 2's
        // paragraph – as a note's mark that opens the mark's note, the verses it refers to after it,
        // as with an edition's notes. It is no word: the words are as they were.
        assert!(signs(&blocks[1]).is_empty());
        let sign = signs(&blocks[3]);
        assert_eq!((sign.len(), sign[0].id.as_deref(), sign[0].chapter, sign[0].verse), (1, Some("prayer"), 2, 1));
        assert_eq!(text_between(&blocks[3], sign[0].start, sign[0].end), "\u{2060}\u{270E}");
        assert_eq!(verses(&blocks[3])[0], format!("{VERSE_2_1}\u{2060}\u{270E}"));
        assert!(verses(&blocks[3])[1].starts_with("2\u{a0}He said"));
        assert_eq!(sign[0].runs[0].text, "Three days: see ");
        assert_eq!(sign[0].runs.last().unwrap().role.as_deref(), Some("preview"));
        assert_eq!(words(&blocks), words(&placed(&marked("[]"), "jonah", None, false, &[])));
        // A verse per line: each verse's line holds its part; the note goes with the last.
        let lines = placed(&library, "jonah", None, true, &[]);
        let with: Vec<(usize, Vec<String>)> = (0..)
            .zip(&lines)
            .filter(|(_, block)| !block.marks.is_empty())
            .map(|(index, block)| (index, block.marks.iter().map(|mark| mark.id.clone()).collect()))
            .collect();
        assert_eq!(with, [(3, vec!["fish".to_string(), "prayer".to_string()]), (5, vec!["prayer".to_string()])]);
        assert_eq!(marked_text(&lines[5]), [("prayer".to_string(), VERSE_2_1.to_string())]);
        assert!(signs(&lines[3]).is_empty() && signs(&lines[5]).len() == 1);
        // Only chapter 2 shown: the mark's note still stands where it ends.
        let chapter = placed(&library, "jonah", Some(2), false, &[]);
        assert_eq!(marked_text(&chapter[1]), [("prayer".to_string(), VERSE_2_1.to_string())]);
        assert_eq!(signs(&chapter[1]).len(), 1);
        // A mark of a book that isn't shown shows nowhere; a passage of its book has it.
        assert!(blocks.iter().all(|block| block.marks.iter().all(|mark| mark.id != "elsewhere")));
        let psalm = placed(&library, "psalms", Some(51), false, &[]);
        assert_eq!(psalm[1].marks.len(), 1);
        assert_eq!(psalm[1].marks[0].start, psalm[1].words[0].start);
        let last = psalm[1].words.iter().rfind(|word| word.verse == 2).unwrap();
        assert_eq!(psalm[1].marks[0].end, last.end);
    }

    #[test]
    fn a_mark_shows_in_the_edition_read_along_too() {
        let library = marked(MARKS);
        let blocks = placed(&library, "jonah", Some(2), false, &["jonah-de"]);
        let german: Vec<_> =
            blocks.iter().filter(|block| block.book == "jonah-de" && !block.marks.is_empty()).collect();
        assert_eq!(german.len(), 1);
        assert_eq!(german[0].column, 1);
        assert_eq!(marked_text(german[0]), [("german".to_string(), "Und Jona".to_string())]);
        assert_eq!(german[0].marks[0].highlight.as_deref(), Some("#FF0000"));
        let english: Vec<_> = blocks.iter().filter(|block| block.book == "jonah" && !block.marks.is_empty()).collect();
        assert_eq!(english.len(), 1);
        assert_eq!(marked_text(english[0]), [("prayer".to_string(), VERSE_2_1.to_string())]);
        assert_eq!(signs(english[0]).len(), 1);
        // The same marks and signs, paragraph by paragraph, as a reader asks for them anew.
        let options = Options { companions: vec!["jonah-de".into()], ..options(false) };
        let again =
            library.marks_in(&[Reference { book: "jonah".into(), chapter: Some(2), from: None, to: None }], &options);
        let expected: Vec<ParagraphMarks> = (blocks.iter())
            .map(|block| ParagraphMarks {
                marks: block.marks.clone(),
                signs: signs(block).into_iter().cloned().collect(),
            })
            .collect();
        assert_eq!(again, expected);
    }

    #[test]
    fn a_marks_sign_follows_an_editions_note_and_is_no_word() {
        let mut library = Library::new();
        library.add(NOTED.as_bytes()).unwrap();
        let reference = Reference { book: "noted".into(), chapter: None, from: None, to: None };
        let blocks = |library: &Library, notes| {
            library.blocks(std::slice::from_ref(&reference), &Options { notes, ..options(false) })
        };
        let spoken = |library: &Library| {
            let mut speech = library.speech(std::slice::from_ref(&reference), &[], false, None, None);
            std::iter::from_fn(|| speech.next(10_000)).collect::<Vec<_>>()
        };
        let unmarked =
            (words(&blocks(&library, Notes::Marks)), words(&blocks(&library, Notes::Inline)), spoken(&library));
        library
            .add_marks(
                br#"[{"id": "god", "book": "noted", "from": {"chapter": 1, "verse": 1, "word": 3}, "to": {"chapter": 1, "verse": 1, "word": 3}, "highlight": "yellow", "note": [{"text": "On God"}]},
                     {"id": "again", "book": "noted", "from": {"chapter": 1, "verse": 1, "word": 3}, "to": {"chapter": 1, "verse": 1, "word": 3}, "underline": "blue", "note": [{"text": "Again"}]},
                     {"id": "earth", "book": "noted", "from": {"chapter": 1, "verse": 2}, "to": {"chapter": 1, "verse": 2}, "note": [{"text": "Formless"}]}]"#,
            )
            .unwrap();
        // After the edition's footnote that follows "God", in the marks' order; at the verse's end.
        let block = blocks(&library, Notes::Marks).swap_remove(1);
        assert_eq!(
            text(&block),
            "aIn the beginning, God1\u{2060}\u{270E}\u{2060}\u{270E} created the heavens2. 2\u{a0}The earth was formless.\u{2060}\u{270E}"
        );
        let found: Vec<_> = signs(&block)
            .iter()
            .map(|sign| (sign.id.clone().unwrap(), sign.verse, sign.runs[0].text.clone()))
            .collect();
        assert_eq!(
            found,
            [
                ("god".into(), 1, "On God".into()),
                ("again".into(), 1, "Again".into()),
                ("earth".into(), 2, "Formless".into())
            ]
        );
        for sign in signs(&block) {
            assert_eq!(text_between(&block, sign.start, sign.end), "\u{2060}\u{270E}");
        }
        assert!(block.notes.windows(2).all(|pair| pair[0].start < pair[1].start));
        assert_eq!(block.drop_cap, Some(DropCap { letter_start: 1, letter_end: 2 }));
        assert_eq!(
            marked_text(&block),
            [
                ("god".into(), "God".into()),
                ("again".into(), "God".into()),
                ("earth".into(), "The earth was formless.".into())
            ]
        );
        assert_eq!(verses(&block)[1], "2\u{a0}The earth was formless.\u{2060}\u{270E}");
        // A note shown in full stands after the signs; and either way, the words and what is read
        // aloud are as they were.
        let inline = blocks(&library, Notes::Inline).swap_remove(1);
        assert!(text(&inline).contains("God\u{2060}\u{270E}\u{2060}\u{270E} [1 Elohim] created"), "{}", text(&inline));
        let marked = (words(std::slice::from_ref(&block)), words(std::slice::from_ref(&inline)), spoken(&library));
        assert_eq!(marked, unmarked);
        // A mark's note shown in full stands in brackets after its sign, as an edition's note in full,
        // and its words are still as they were.
        let options = Options { mark_notes: MarkNotes::Inline, ..options(false) };
        let full = library.blocks(std::slice::from_ref(&reference), &options).swap_remove(1);
        assert_eq!(
            text(&full),
            "aIn the beginning, God1 [\u{270E} On God] [\u{270E} Again] created the heavens2. 2\u{a0}The earth was formless. [\u{270E} Formless]"
        );
        let first = signs(&full)[0];
        assert_eq!(text_between(&full, first.start, first.end), " [\u{270E} On God]");
        assert_eq!(verses(&full)[1], "2\u{a0}The earth was formless. [\u{270E} Formless]");
        assert_eq!(words(std::slice::from_ref(&full)), unmarked.0);
    }
}
