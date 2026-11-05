use std::collections::HashMap;

use serde::Serialize;

use crate::model::{Entry, Lexicon, NoteRun, Verse, WordTag};
use crate::reader::words_of;

/// A verse with words of a number, by where they stand – never by their text: its book, chapter
/// and number, and the words, by their indices in the verse.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NumberedVerse {
    pub book: String,
    pub chapter: u32,
    pub verse: u32,
    pub words: Vec<u32>,
}

/// Whether two numbers are of one word: alike, or one of them without the letter that tells words of
/// a number apart – H1121 is H1121a's, a son, as a translation tags it; H1121a isn't H1121b, Beno.
pub(crate) fn same_number(a: &str, b: &str) -> bool {
    let plain = |number: &str| number.trim_end_matches(|char: char| char.is_ascii_lowercase()).len();
    a == b || (plain(a) == a.len() || plain(b) == b.len()) && a[..plain(a)] == b[..plain(b)]
}

/// The numbers of a verse's tags within a word – its range in the verse's text, in UTF-16 code units.
pub(crate) fn numbers_within(verse: &Verse, (start, end): (u32, u32)) -> impl Iterator<Item = &str> {
    tags_within(verse, start, end).flat_map(|tag| tag.parts.iter().filter_map(|part| part.number.as_deref()))
}

/// The indices of a verse's words with a number that is one of `numbers`' (see [`same_number`]).
pub(crate) fn words_with<'a>(verse: &'a Verse, numbers: &'a [&str]) -> impl Iterator<Item = u32> + 'a {
    (0..).zip(words_of(verse)).filter_map(move |(index, word)| {
        let found = numbers_within(verse, word).any(|own| numbers.iter().any(|number| same_number(own, number)));
        found.then_some(index)
    })
}

/// A word's entry as a note opens it, at the word: in the language and direction of the lexicon it
/// comes from, its runs – for each word its source tagged within it, each part's grammar where the
/// source gives it, and each part's entry: the word as the lexicon writes it, in its language, how
/// that is read, its gloss and its number, then its definition, which may refer to verses.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WordEntry {
    pub language: String,
    pub direction: String,
    pub runs: Vec<NoteRun>,
}

/// The lexicons of a library, in the order added, each with its entries by number.
#[derive(Default)]
pub(crate) struct Lexicons(Vec<(Lexicon, HashMap<String, usize>)>);

impl Lexicons {
    /// Adds lexicons, each replacing one of the same id, and returns their ids.
    pub(crate) fn add(&mut self, lexicons: Vec<Lexicon>) -> Vec<String> {
        let ids = lexicons.iter().map(|lexicon| lexicon.id.clone()).collect();
        for lexicon in lexicons {
            let index = (lexicon.entries.iter().enumerate()).map(|(at, entry)| (entry.number.clone(), at)).collect();
            match self.0.iter_mut().find(|(old, _)| old.id == lexicon.id) {
                Some(old) => *old = (lexicon, index),
                None => self.0.push((lexicon, index)),
            }
        }
        ids
    }

    pub(crate) fn remove(&mut self, ids: &[String]) {
        self.0.retain(|(lexicon, _)| !ids.contains(&lexicon.id));
    }

    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }

    pub(crate) fn all(&self) -> impl Iterator<Item = &Lexicon> {
        self.0.iter().map(|(lexicon, _)| lexicon)
    }

    /// The entry of a number, in the first lexicon that has it – or, for a number that tells a
    /// word apart from another of the same number, as H1121a does, the entry of the number alone –
    /// and that lexicon.
    pub(crate) fn entry(&self, number: &str) -> Option<(&Entry, &Lexicon)> {
        let find = |number: &str| {
            self.0.iter().find_map(|(lexicon, index)| index.get(number).map(|&at| (&lexicon.entries[at], lexicon)))
        };
        find(number).or_else(|| {
            let plain = number.trim_end_matches(|char: char| char.is_ascii_lowercase());
            (plain != number).then(|| find(plain)).flatten()
        })
    }

    /// A grammar code spelled out, by the first lexicon that knows it, and that lexicon.
    fn grammar(&self, code: &str) -> Option<(&str, &Lexicon)> {
        self.0.iter().find_map(|(lexicon, _)| lexicon.grammar.get(code).map(|text| (text.as_str(), lexicon)))
    }

    /// Whether a word – its range in the verse's text, in UTF-16 code units – has an entry: a part
    /// of a tag within it has a number the lexicons hold.
    pub(crate) fn has_entry(&self, verse: &Verse, (start, end): (u32, u32)) -> bool {
        tags_within(verse, start, end).any(|tag| {
            tag.parts.iter().any(|part| part.number.as_deref().is_some_and(|number| self.entry(number).is_some()))
        })
    }

    /// A word's entry – see [`WordEntry`] – the word in the book's `language`; after each part's
    /// entry, a link to every verse with its number, where `verses` counts more than one. None where
    /// the lexicons hold neither an entry nor the grammar of any of its parts.
    pub(crate) fn of(
        &self,
        verse: &Verse,
        language: &str,
        word: u32,
        verses: impl Fn(&str) -> usize,
    ) -> Option<WordEntry> {
        let &(start, end) = words_of(verse).get(word as usize)?;
        let text: Vec<u16> = verse.runs.iter().flat_map(|(run, _)| run.encode_utf16()).collect();
        let mut runs = Vec::new();
        // The lexicon the entry is written in: the first that gives any of it.
        let mut written: Option<&Lexicon> = None;
        for tag in tags_within(verse, start, end) {
            let mut at = tag.at;
            for part in &tag.parts {
                let spelled = (at as usize..(at + part.length) as usize).filter_map(|index| text.get(index).copied());
                let spelled = String::from_utf16_lossy(&spelled.collect::<Vec<_>>());
                at += part.length;
                if let Some((grammar, lexicon)) = part.grammar.as_deref().and_then(|code| self.grammar(code)) {
                    written.get_or_insert(lexicon);
                    line_break(&mut runs);
                    runs.push(run(&spelled, None, Some(language)));
                    runs.push(run(&format!("  {grammar}"), Some("origin"), None));
                }
                let Some((entry, lexicon)) = part.number.as_deref().and_then(|number| self.entry(number)) else {
                    continue;
                };
                written.get_or_insert(lexicon);
                line_break(&mut runs);
                runs.extend(entry_runs(entry));
                let number = part.number.as_deref().unwrap_or_default();
                let count = verses(number);
                if count > 1 {
                    runs.push(run("\n", None, None));
                    runs.push(NoteRun {
                        text: format!("All {count} verses"),
                        number: Some(number.into()),
                        ..NoteRun::default()
                    });
                }
                if !entry.definition.is_empty() {
                    runs.push(run("\n", None, None));
                    runs.extend(entry.definition.iter().cloned());
                }
            }
        }
        let lexicon = written?;
        Some(WordEntry { language: lexicon.language.clone(), direction: lexicon.direction.clone(), runs })
    }
}

/// The tags whose words lie within a word of the core, or overlap it: a word's range in the verse's
/// text, in UTF-16 code units.
fn tags_within(verse: &Verse, start: u32, end: u32) -> impl Iterator<Item = &WordTag> {
    verse.tags.iter().filter(move |tag| tag.at < end && tag.end() > start)
}

/// An entry's head: the word as the lexicon writes it, in its language; how it is read; what it
/// means; and its number, as Strong's numbers are written, without the zeros before it: H1961, G976.
fn entry_runs(entry: &Entry) -> Vec<NoteRun> {
    let mut runs = vec![run(&entry.lemma, None, Some(&entry.language))];
    if let Some(transliteration) = entry.transliteration.as_deref().filter(|text| !text.is_empty()) {
        runs.push(run(&format!(" {transliteration}"), Some("emphasis"), None));
    }
    runs.push(run(" – ", None, None));
    runs.push(run(&entry.gloss, Some("strong"), None));
    runs.push(run(&format!("  {}", shown_number(&entry.number)), Some("origin"), None));
    runs
}

/// A number as Strong's numbers are written: H1961, G976 – its zeros left out.
pub(crate) fn shown_number(number: &str) -> String {
    let (letter, rest) = number.split_at(number.find(|char: char| char.is_ascii_digit()).unwrap_or(0));
    format!("{letter}{}", rest.trim_start_matches('0'))
}

/// A number as it stands in the text after its word: its digits alone, 1961 for H1961.
pub(crate) fn digits(number: &str) -> String {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() { digits } else { trimmed.to_string() }
}

fn line_break(runs: &mut Vec<NoteRun>) {
    if !runs.is_empty() {
        runs.push(run("\n", None, None));
    }
}

fn run(text: &str, role: Option<&str>, language: Option<&str>) -> NoteRun {
    NoteRun {
        text: text.into(),
        role: role.map(String::from),
        language: language.map(String::from),
        ..NoteRun::default()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use super::*;
    use crate::{Block, LexiconUse, Library, MarkNotes, Notes, Options, Place, Reference};

    /// The fixtures' books, and the entries of the numbers their words are tagged with.
    static LIBRARY: LazyLock<Library> = LazyLock::new(|| {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).expect("the books are valid");
        library.add_lexicons(include_bytes!("../tests/fixtures/lexicons.json")).expect("the lexicons are valid");
        library
    });

    fn options(lexicon: LexiconUse, lexicon_books: Option<Vec<String>>) -> Options {
        Options {
            font_size: 28.0,
            verse_per_line: false,
            companions: Vec::new(),
            notes: Notes::Marks,
            drop_caps: false,
            mark_notes: MarkNotes::Sign,
            lexicon,
            lexicon_books,
            linked_books: Vec::new(),
            marked_number: None,
        }
    }

    /// The paragraph of a verse, as the options show it.
    fn verse(library: &Library, book: &str, chapter: u32, verse: u32, options: &Options) -> Block {
        let reference = Reference { book: book.into(), chapter: Some(chapter), from: Some(verse), to: Some(verse) };
        library.blocks(&[reference], options).swap_remove(1)
    }

    fn texts(runs: &[NoteRun]) -> Vec<&str> {
        runs.iter().map(|run| run.text.as_str()).collect()
    }

    fn text(block: &Block) -> String {
        block.segments.iter().map(|segment| segment.text.as_str()).collect()
    }

    /// The words as their ranges cut them out of the paragraph's text.
    fn words(block: &Block) -> Vec<String> {
        let text: Vec<u16> = text(block).encode_utf16().collect();
        block
            .words
            .iter()
            .map(|word| String::from_utf16(&text[word.start as usize..word.end as usize]).unwrap())
            .collect()
    }

    #[test]
    fn tags_are_arrays_of_where_they_start_and_their_parts() {
        let tag: WordTag = serde_json::from_str(r#"[0, [3, null, "HC"], [6, "H1961", "HVqw3ms"]]"#).unwrap();
        assert_eq!((tag.at, tag.end(), tag.parts.len()), (0, 9, 2));
        assert_eq!((tag.parts[0].number.as_deref(), tag.parts[0].grammar.as_deref()), (None, Some("HC")));
        assert_eq!(tag.parts[1].number.as_deref(), Some("H1961"));
        let english: WordTag = serde_json::from_str(r#"[4, [6, "H3068"]]"#).unwrap();
        assert_eq!((english.parts[0].length, english.parts[0].grammar.as_deref()), (6, None));
        assert!(serde_json::from_str::<WordTag>("[]").is_err());
    }

    #[test]
    fn a_hebrew_word_opens_each_parts_grammar_and_its_entry() {
        // וַֽיְהִי֙, Jonah 1:1's first word: a conjunction, and a verb of the number H1961.
        let entry = LIBRARY.entry("jonah-he", 1, 1, 0, None).unwrap();
        // In the lexicon's language and direction, the Hebrew in its own.
        assert_eq!((entry.language.as_str(), entry.direction.as_str()), ("en", "ltr"));
        let runs = entry.runs;
        assert_eq!(
            texts(&runs[..12]),
            [
                "וַֽ",
                "  Conjunction",
                "\n",
                "יְהִי֙",
                "  Verb, Qal, sequential imperfect (wayyiqtol), third person masculine singular",
                "\n",
                "הָיָה",
                " ha.yah",
                " – ",
                "to be",
                "  H1961",
                "\n"
            ]
        );
        assert_eq!(runs[0].language.as_deref(), Some("he"));
        assert_eq!(runs[6].language.as_deref(), Some("he"));
        assert_eq!(runs[9].role.as_deref(), Some("strong"));
        // A link to every verse with the number follows; then Strong's definition.
        assert_eq!(runs[12].number.as_deref(), Some("H1961"));
        assert!(runs[12].text.starts_with("All ") && runs[12].text.ends_with(" verses"));
        assert!(runs[14].text.starts_with("to exist, i.e. be or become"));
        // Two words joined by a maqaf are one word, and open both entries.
        let joined = LIBRARY.entry("jonah-he", 1, 1, 1, None).unwrap().runs;
        assert!(["  H1697", "  H3068"].iter().all(|number| texts(&joined).contains(number)));
    }

    #[test]
    fn a_translations_word_opens_the_entry_of_the_word_it_renders() {
        // "Yahweh’s", of which the World English Bible tags "Yahweh".
        let runs = LIBRARY.entry("jonah", 1, 1, 1, None).unwrap().runs;
        assert_eq!(texts(&runs[..5]), ["יְהֹוָה", " ye.ho.vah", " – ", "LORD", "  H3068"]);
        // "Amittai," it leaves untagged.
        assert!(LIBRARY.entry("jonah", 1, 1, 9, None).is_none());
        // The Greek: no grammar, the entry at once.
        let greek = LIBRARY.entry("matthew-el", 1, 1, 0, None).unwrap().runs;
        assert_eq!(texts(&greek[1..5]), [" biblos", " – ", "book", "  G976"]);
        assert_eq!(greek[0].language.as_deref(), Some("el"));
        assert!(
            LIBRARY.entry("matthew-el", 1, 1, 99, None).is_none() && LIBRARY.entry("jonah", 9, 1, 0, None).is_none()
        );
    }

    #[test]
    fn words_open_entries_as_the_options_let_their_books() {
        let entries = |library: &Library, book: &str, options: &Options| {
            verse(library, book, 1, 1, options).words.iter().map(|word| word.entry).collect::<Vec<_>>()
        };
        let all = options(LexiconUse::Entries, None);
        assert!(entries(&LIBRARY, "jonah-he", &all).iter().all(|&entry| entry));
        // "Amittai," has no number.
        assert_eq!(
            entries(&LIBRARY, "jonah", &all),
            [true, true, true, true, true, true, true, true, true, false, true]
        );
        assert!(entries(&LIBRARY, "jonah-he", &options(LexiconUse::None, None)).iter().all(|&entry| !entry));
        let hebrew = options(LexiconUse::Entries, Some(vec!["jonah-he".into()]));
        assert!(entries(&LIBRARY, "jonah", &hebrew).iter().all(|&entry| !entry));
        assert!(entries(&LIBRARY, "jonah-he", &hebrew).iter().all(|&entry| entry));
        // Without a lexicon, no entries.
        let mut bare = Library::new();
        bare.add(include_bytes!("../tests/fixtures/books.json")).unwrap();
        assert!(entries(&bare, "jonah-he", &all).iter().all(|&entry| !entry));
    }

    #[test]
    fn numbers_stand_after_their_words_as_marks_that_are_no_words() {
        let plain = verse(&LIBRARY, "jonah-he", 1, 1, &options(LexiconUse::Entries, None));
        let numbered = verse(&LIBRARY, "jonah-he", 1, 1, &options(LexiconUse::Numbers, None));
        // Each word's number after it, the maqaf after a number of the word before it.
        let without_digits = |text: String| text.chars().filter(|char| !char.is_ascii_digit()).collect::<String>();
        assert_eq!(without_digits(text(&numbered)), without_digits(text(&plain)));
        let numbers: Vec<String> = text(&numbered)
            .split(|char: char| !char.is_ascii_digit())
            .filter(|digits| !digits.is_empty())
            .map(String::from)
            .collect();
        assert_eq!(numbers, ["1", "1961", "1697", "3068", "413", "3124", "1121", "573", "559"]);
        assert!(text(&numbered).contains("1697־") && text(&numbered).ends_with("559׃"));
        let marks: Vec<_> =
            numbered.notes.iter().map(|note| (note.kind.as_str(), note.mark.as_str(), note.word)).collect();
        assert_eq!(marks[..3], [("entry", "1961", Some(0)), ("entry", "1697", Some(1)), ("entry", "3068", Some(1))]);
        assert!(numbered.notes.iter().all(|note| note.runs.is_empty()));
        // The words stay: a number after a word is no part of it, one within it – before a maqaf – is spanned.
        let places = |block: &Block| block.words.iter().map(|word| (word.verse, word.index)).collect::<Vec<_>>();
        assert_eq!(places(&numbered), places(&plain));
        assert_eq!(words(&numbered)[0], words(&plain)[0]);
        assert_eq!(words(&numbered)[1], words(&plain)[1].replacen('־', "1697־", 1));
        // Only in the books asked for; a translation's numbers before its notes' marks.
        let english = verse(&LIBRARY, "jonah", 1, 1, &options(LexiconUse::Numbers, None));
        assert!(text(&english).starts_with("1\u{a0}Now1961 Yahweh3068’s1 word1697 came1961"));
        let only_hebrew = options(LexiconUse::Numbers, Some(vec!["jonah-he".into()]));
        assert!(text(&verse(&LIBRARY, "jonah", 1, 1, &only_hebrew)).starts_with("1\u{a0}Now Yahweh’s1 word"));
    }

    fn place(passage: u32, book: &str, chapter: u32, verse: u32, word: u32) -> Place {
        Place { passage, book: book.into(), chapter, verse, word }
    }

    /// The Hebrew Jonah read along with Luther 1912, whose words link, and the World English Bible, whose don't.
    fn read_along() -> ([Reference; 1], Options) {
        let reference = Reference { book: "jonah-he".into(), chapter: Some(2), from: None, to: None };
        let options = Options {
            companions: vec!["jonah-de".into(), "jonah".into()],
            linked_books: vec!["jonah-de".into()],
            ..options(LexiconUse::Entries, Some(vec!["jonah-he".into()]))
        };
        ([reference], options)
    }

    #[test]
    fn a_word_links_to_the_words_of_its_number_in_the_verse_read_along() {
        let (references, options) = read_along();
        // יְהוָה֙ in Jonah 2:1, the verse Luther 1912 numbers 1:17 as the KJV does: "der HERR". The English isn't linked.
        let found = LIBRARY.counterparts(&references, &options, &place(0, "jonah-he", 2, 1, 1));
        assert_eq!(found, [place(0, "jonah-de", 1, 17, 2)]);
        // And back: "HERR" to יְהוָה֙; "Jona" to both of the Hebrew's – אֶת־יוֹנָ֑ה, a maqaf word, and יוֹנָה֙.
        assert_eq!(
            LIBRARY.counterparts(&references, &options, &place(0, "jonah-de", 1, 17, 2)),
            [place(0, "jonah-he", 2, 1, 1)]
        );
        let jona = LIBRARY.counterparts(&references, &options, &place(0, "jonah-de", 1, 17, 7));
        assert_eq!(jona, [place(0, "jonah-he", 2, 1, 5), place(0, "jonah-he", 2, 1, 7)]);
        // Read alone, or without the translation linked, nothing.
        let alone = Options { companions: Vec::new(), ..options.clone() };
        assert!(LIBRARY.counterparts(&references, &alone, &place(0, "jonah-he", 2, 1, 1)).is_empty());
        let unlinked = Options { linked_books: Vec::new(), ..options };
        assert!(LIBRARY.counterparts(&references, &unlinked, &place(0, "jonah-he", 2, 1, 1)).is_empty());
    }

    #[test]
    fn every_verse_with_a_number_is_found_the_translations_adding_only_what_the_originals_lack() {
        let ids = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        let found = LIBRARY.verses_with("H3068", &ids(&["jonah-he", "jonah-de"]));
        assert!(!found.is_empty() && found.iter().all(|verse| verse.book == "jonah-he"), "{found:?}");
        assert!(found.iter().any(|verse| (verse.chapter, verse.verse, verse.words.as_slice()) == (2, 1, &[1][..])));
        // Luther 1912 alone has them in its own verses.
        let luther = LIBRARY.verses_with("H3068", &ids(&["jonah-de"]));
        assert_eq!(luther[0], NumberedVerse { book: "jonah-de".into(), chapter: 1, verse: 17, words: vec![2] });
        // The English Psalm 51:3 is the Hebrew's 51:5, which the library doesn't hold: it is added, with its words "I",
        // "transgressions." and "sin".
        let transgression = LIBRARY.verses_with("H6588", &ids(&["psalms-he", "psalms"]));
        let places: Vec<_> =
            transgression.iter().map(|verse| (verse.book.as_str(), verse.verse, verse.words.clone())).collect();
        assert_eq!(places, [("psalms-he", 3, vec![6]), ("psalms", 3, vec![1, 4, 6])]);
        // A number with the letter that tells words apart finds the plain one, and the other way round.
        assert!(same_number("H1121a", "H1121") && same_number("H1121", "H1121a") && !same_number("H1121a", "H1121b"));
        assert!(!same_number("H1121", "H11210"));
        // The entry counts them: יְהוָה's in the Hebrew Jonah.
        let count = LIBRARY.verses_with("H3068", &ids(&["jonah-he"])).len();
        let runs = LIBRARY.entry("jonah-he", 2, 1, 1, Some(&ids(&["jonah-he"]))).unwrap().runs;
        let link = runs.iter().find(|run| run.number.is_some()).unwrap();
        assert_eq!((link.text.clone(), link.number.as_deref()), (format!("All {count} verses"), Some("H3068")));
    }

    #[test]
    fn a_marked_number_marks_its_words_in_the_books_that_link() {
        let (references, options) = read_along();
        let marked = Options { marked_number: Some("H3068".into()), ..options };
        let blocks = LIBRARY.blocks(&references, &marked);
        let linked: Vec<_> = (blocks.iter())
            .flat_map(|block| {
                block
                    .words
                    .iter()
                    .filter(|word| word.linked)
                    .map(move |word| (block.book.as_str(), word.verse, word.index))
            })
            .collect();
        // יְהוָה֙ in the Hebrew 2:1 and 2:3, "HERR" in Luther 1912; the English, which doesn't link, has none.
        assert!(linked.contains(&("jonah-he", 1, 1)) && linked.contains(&("jonah-de", 17, 2)), "{linked:?}");
        assert!(linked.iter().all(|(book, ..)| *book != "jonah"));
        let unmarked = LIBRARY.blocks(&references, &Options { marked_number: None, ..read_along().1 });
        assert!(unmarked.iter().all(|block| block.words.iter().all(|word| !word.linked)));
    }
}
