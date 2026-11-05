//! Scripture made ready to read: a library of books – a book of the Bible in one edition, a
//! surah – and passages of them as paragraphs to lay out. A paragraph is a chapter's heading, its
//! running text or a verse on a line of its own, in its book's language, direction and script,
//! with each verse and word where it stands. Other editions of a book can be read along with it,
//! verse by verse, matched by the KJV's numbers. Passages can be read aloud, by the device's voices
//! or from recordings of their chapters: see [`Speech`].
//!
//! The library holds no texts of its own: a host adds books as JSON (see [`Book`]), recordings
//! (see [`Recording`]), its marks on the books' words (see [`Mark`]), which readers draw, and
//! lexicons (see [`Lexicon`]) that the numbers of tagged words lead to: a word's entry opens where
//! it stands, and the numbers can stand in the text.

mod lexicon;
mod model;
mod reader;
mod speech;

use serde::de::Error as _;

pub use lexicon::{NumberedVerse, WordEntry};
pub use model::{
    Book, Chapter, Entry, Lexicon, Mark, MarkEnd, Note, NoteRun, RecordedVerse, Recording, Target, Verse, VerseNumbers,
    WordPart, WordTag,
};
pub use reader::{
    Block, DropCap, ENTRY_KIND, MARK_SIGN_KIND, NoteMark, ParagraphMarks, PlacedMark, Segment, VerseRange,
    WORD_DEFINITION, Word,
};
pub use speech::{Part, Place, Speech, Take, TimedWord, Utterance};

/// A whole book, one chapter of it, or a verse range in that chapter.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub book: String,
    pub chapter: Option<u32>,
    pub from: Option<u32>,
    pub to: Option<u32>,
}

/// How passages become paragraphs.
#[derive(Clone, Debug)]
pub struct Options {
    /// The text's size, in points, by which each script's typical letter is sized.
    pub font_size: f64,
    /// Each verse on a line of its own, instead of running text.
    pub verse_per_line: bool,
    /// Other editions of the passages' books, by id, read along with them verse by verse.
    pub companions: Vec<String>,
    /// How the books' notes – footnotes, endnotes and cross references – show in the text.
    pub notes: Notes,
    /// Chapters in running text open with a drop cap: the first letter of the text set large, the
    /// first verse without its number.
    pub drop_caps: bool,
    /// How the notes of the host's marks show in the text.
    pub mark_notes: MarkNotes,
    /// What the numbers of tagged words do: see [`LexiconUse`].
    pub lexicon: LexiconUse,
    /// The books, by id, whose words' numbers do so; with none named, every book's.
    pub lexicon_books: Option<Vec<String>>,
    /// Books, by id, whose words link to those of the books above when read along, without opening
    /// entries themselves – translations whose tagging can be trusted: see [`Library::counterparts`].
    pub linked_books: Vec<String>,
    /// A number whose words are marked, lightly, in the books that link: for a reading list of every
    /// verse with a word. See [`Word::linked`].
    pub marked_number: Option<String>,
}

/// What the numbers of tagged words do, where the library's lexicons hold their entries: nothing; a
/// word opens its entry – a reader opens it on a double tap (see [`Word::entry`]); or that, and each
/// number stands in the text after its word, as a note's mark of the kind [`ENTRY_KIND`], which
/// opens the entry too.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LexiconUse {
    None,
    #[default]
    Entries,
    Numbers,
}

impl Options {
    /// Whether a book's words open their entries.
    pub(crate) fn entries_in(&self, book: &str) -> bool {
        self.lexicon != LexiconUse::None
            && self.lexicon_books.as_ref().is_none_or(|books| books.iter().any(|id| id == book))
    }

    /// Whether a book's words' numbers stand in its text.
    pub(crate) fn numbers_in(&self, book: &str) -> bool {
        self.lexicon == LexiconUse::Numbers && self.entries_in(book)
    }

    /// Whether a book's words link to the others' by their numbers: those that open entries, and the
    /// translations linked.
    pub(crate) fn links_in(&self, book: &str) -> bool {
        self.lexicon != LexiconUse::None && (self.entries_in(book) || self.linked_books.iter().any(|id| id == book))
    }
}

/// How many verses a note shows of the ones it refers to, and how long they may be, in UTF-16 units.
pub const PREVIEW_VERSES: usize = 3;
pub const PREVIEW_LENGTH: usize = 400;

fn text_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `units` UTF-16 code units of a text, or fewer where that would cut a character.
fn take_utf16(text: &str, units: usize) -> &str {
    let mut counted = 0;
    for (index, char) in text.char_indices() {
        if counted + char.len_utf16() > units {
            return &text[..index];
        }
        counted += char.len_utf16();
    }
    text
}

/// How notes show in the text: not at all; as marks where they stand, which open them; or in
/// full, each in brackets where it stands, its mark before its text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Notes {
    None,
    #[default]
    Marks,
    Inline,
}

/// How the notes of a host's marks show in the text: as a sign where each mark ends, which opens its
/// note; or in full there, in brackets after the sign, as an edition's note shown in full.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MarkNotes {
    #[default]
    Sign,
    Inline,
}

/// The books a host has added, the recordings of their chapters, and the host's marks on their
/// words, each in the order added.
#[derive(Default)]
pub struct Library {
    books: Vec<Book>,
    recordings: Vec<Recording>,
    marks: Vec<Mark>,
    lexicons: lexicon::Lexicons,
}

impl Library {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the books of a JSON array, each replacing one of the same id, and returns their ids.
    pub fn add(&mut self, json: &[u8]) -> Result<Vec<String>, serde_json::Error> {
        let books: Vec<Book> = serde_json::from_slice(json)?;
        let ids = books.iter().map(|book| book.id.clone()).collect();
        for book in books {
            match self.books.iter_mut().find(|old| old.id == book.id) {
                Some(old) => *old = book,
                None => self.books.push(book),
            }
        }
        Ok(ids)
    }

    pub fn remove(&mut self, ids: &[String]) {
        self.books.retain(|book| !ids.contains(&book.id));
    }

    pub fn clear(&mut self) {
        self.books.clear();
    }

    pub fn books(&self) -> &[Book] {
        &self.books
    }

    pub fn book(&self, id: &str) -> Option<&Book> {
        self.books.iter().find(|book| book.id == id)
    }

    /// Adds the recordings of a JSON array, each replacing one of the same id, and returns their
    /// ids. An audio that is no URI is taken as relative to `base`, where the recordings came from.
    /// Recordings that count words otherwise than the core does, or whose times go back, are refused.
    pub fn add_recordings(&mut self, json: &[u8], base: Option<&str>) -> Result<Vec<String>, serde_json::Error> {
        let mut recordings: Vec<Recording> = serde_json::from_slice(json)?;
        for recording in &mut recordings {
            check(recording)?;
            if let Some(base) = base.filter(|_| !is_absolute(&recording.audio)) {
                recording.audio = format!("{}/{}", base.trim_end_matches('/'), recording.audio);
            }
        }
        let ids = recordings.iter().map(|recording| recording.id.clone()).collect();
        for recording in recordings {
            match self.recordings.iter_mut().find(|old| old.id == recording.id) {
                Some(old) => *old = recording,
                None => self.recordings.push(recording),
            }
        }
        Ok(ids)
    }

    pub fn remove_recordings(&mut self, ids: &[String]) {
        self.recordings.retain(|recording| !ids.contains(&recording.id));
    }

    pub fn clear_recordings(&mut self) {
        self.recordings.clear();
    }

    pub fn recordings(&self) -> &[Recording] {
        &self.recordings
    }

    /// Adds the marks of a JSON array, each replacing one of the same id, and returns their ids. A
    /// mark that ends before it starts is refused.
    pub fn add_marks(&mut self, json: &[u8]) -> Result<Vec<String>, serde_json::Error> {
        let marks: Vec<Mark> = serde_json::from_slice(json)?;
        if let Some(mark) = marks.iter().find(|mark| mark.from.start() > mark.to.end()) {
            return Err(serde_json::Error::custom(format!("the mark {} ends before it starts", mark.id)));
        }
        let ids = marks.iter().map(|mark| mark.id.clone()).collect();
        for mark in marks {
            match self.marks.iter_mut().find(|old| old.id == mark.id) {
                Some(old) => *old = mark,
                None => self.marks.push(mark),
            }
        }
        Ok(ids)
    }

    pub fn remove_marks(&mut self, ids: &[String]) {
        self.marks.retain(|mark| !ids.contains(&mark.id));
    }

    pub fn clear_marks(&mut self) {
        self.marks.clear();
    }

    pub fn marks(&self) -> &[Mark] {
        &self.marks
    }

    /// Adds the lexicons of a JSON array, each replacing one of the same id, and returns their ids.
    pub fn add_lexicons(&mut self, json: &[u8]) -> Result<Vec<String>, serde_json::Error> {
        Ok(self.lexicons.add(serde_json::from_slice(json)?))
    }

    pub fn remove_lexicons(&mut self, ids: &[String]) {
        self.lexicons.remove(ids);
    }

    pub fn clear_lexicons(&mut self) {
        self.lexicons.clear();
    }

    pub fn lexicons(&self) -> impl Iterator<Item = &Lexicon> {
        self.lexicons.all()
    }

    /// A word's entry, by where the word stands, to open where it stands: see [`WordEntry`]. After
    /// each part's entry, a link to every verse of `books` with its number, as [`Library::verses_with`]
    /// finds them – of every book, without `books` – where there are more than one. None where the
    /// lexicons hold nothing of it.
    pub fn entry(
        &self,
        book: &str,
        chapter: u32,
        verse: u32,
        word: u32,
        books: Option<&[String]>,
    ) -> Option<WordEntry> {
        let all: Vec<String>;
        let books = match books {
            Some(books) => books,
            None => {
                all = self.books.iter().map(|book| book.id.clone()).collect();
                &all
            }
        };
        let book = self.book(book)?;
        let chapter = book.chapters.iter().find(|candidate| candidate.number == chapter)?;
        let verse = chapter.verses.iter().find(|candidate| candidate.number == verse)?;
        self.lexicons.of(verse, &book.language, word, |number| self.verses_with(number, books).len())
    }

    /// Every verse of `books` – by id, in the order given – with words of a number, and which of its
    /// words, by where they stand. A verse that a book before it in the list holds too – an edition of
    /// it, by code and the KJV's number – is left out: a translation adds the verses the originals
    /// lack. See [`lexicon::same_number`] for which numbers are one word's.
    pub fn verses_with(&self, number: &str, books: &[String]) -> Vec<NumberedVerse> {
        let mut held: std::collections::HashSet<(&str, (u32, u32))> = std::collections::HashSet::new();
        let mut found = Vec::new();
        for book in books.iter().filter_map(|id| self.book(id)) {
            let code = book.code.as_deref().unwrap_or(&book.id);
            let mut own = Vec::new();
            for chapter in &book.chapters {
                for verse in &chapter.verses {
                    let key = (code, reader::kjv(chapter, verse));
                    own.push(key);
                    if held.contains(&key) {
                        continue;
                    }
                    // Its words only where a tag has the number, which few verses do.
                    let tagged = verse.tags.iter().flat_map(|tag| &tag.parts).filter_map(|part| part.number.as_deref());
                    if !tagged.into_iter().any(|own| lexicon::same_number(own, number)) {
                        continue;
                    }
                    let words: Vec<u32> = lexicon::words_with(verse, &[number]).collect();
                    if !words.is_empty() {
                        found.push(NumberedVerse {
                            book: book.id.clone(),
                            chapter: chapter.number,
                            verse: verse.number,
                            words,
                        });
                    }
                }
            }
            held.extend(own);
        }
        found
    }

    /// The words that carry a number of the word at `place` in the other books its passage shows read
    /// along with – in the verses the KJV numbers alike – where both books link (see
    /// [`Options::linked_books`]): a translation's words for a word of the original, the original's
    /// for a translation's. None where nothing is read along, or the word has no number.
    pub fn counterparts(&self, references: &[Reference], options: &Options, place: &Place) -> Vec<Place> {
        let Some(reference) = references.get(place.passage as usize) else { return Vec::new() };
        let (Some(own), Some(main)) = (self.book(&place.book), self.book(&reference.book)) else { return Vec::new() };
        if !options.links_in(&own.id) {
            return Vec::new();
        }
        let Some(chapter) = own.chapters.iter().find(|chapter| chapter.number == place.chapter) else {
            return Vec::new();
        };
        let Some(verse) = chapter.verses.iter().find(|verse| verse.number == place.verse) else { return Vec::new() };
        let Some(&word) = reader::words_of(verse).get(place.word as usize) else { return Vec::new() };
        let numbers: Vec<&str> = lexicon::numbers_within(verse, word).collect();
        let key = reader::kjv(chapter, verse);
        // The passage's book and the editions of it read along, but the word's own.
        let shown = std::iter::once(main.id.as_str())
            .chain(options.companions.iter().map(String::as_str))
            .filter_map(|id| self.book(id))
            .filter(|book| {
                book.id != own.id && book.code.is_some() && book.code == main.code && options.links_in(&book.id)
            });
        let mut places = Vec::new();
        for book in shown {
            for chapter in &book.chapters {
                for verse in chapter.verses.iter().filter(|verse| reader::kjv(chapter, verse) == key) {
                    places.extend(lexicon::words_with(verse, &numbers).map(|word| Place {
                        passage: place.passage,
                        book: book.id.clone(),
                        chapter: chapter.number,
                        verse: verse.number,
                        word,
                    }));
                }
            }
        }
        places
    }

    /// Why a recording isn't played for the book it reads, if it isn't: the library holds no such
    /// book, or the book's verses or their words aren't the recording's.
    pub fn misfit(&self, recording: &Recording) -> Option<String> {
        speech::misfit(recording, self.book(&recording.book))
    }

    /// The passages as paragraphs: per chapter a heading, then the chapter as running text, or a
    /// verse per line. With companions, other editions of a passage's book are read along with it:
    /// see [`Block::row`]. Passages of books the library doesn't hold give nothing. A note that
    /// refers to verses the library holds shows them: see [`Library::preview`]. The host's marks
    /// stand over their words, and the signs of their notes in the text: see [`PlacedMark`].
    pub fn blocks(&self, references: &[Reference], options: &Options) -> Vec<Block> {
        let companions: Vec<&Book> = options.companions.iter().filter_map(|id| self.book(id)).collect();
        let mut rows = 0..;
        let mut blocks = Vec::new();
        for (passage, reference) in (0..).zip(references) {
            blocks.extend(reader::blocks(self, reference, passage, options, &companions, &mut rows));
        }
        reader::place_marks(&mut blocks, &self.marks, options.mark_notes);
        for block in &mut blocks {
            for note in &mut block.notes {
                let previews = self.previews(&block.book, &note.runs);
                note.runs.extend(previews);
            }
        }
        blocks
    }

    /// The marks in the passages' paragraphs, as [`Library::blocks`] places them, paragraph by
    /// paragraph, and the signs of their notes: for a reader to draw them anew as they change – its
    /// layout kept, unless the signs changed, which stand in the text.
    pub fn marks_in(&self, references: &[Reference], options: &Options) -> Vec<ParagraphMarks> {
        let paragraph = |block: Block| ParagraphMarks {
            signs: block.notes.into_iter().filter(|note| note.kind == MARK_SIGN_KIND).collect(),
            marks: block.marks,
        };
        self.blocks(references, options).into_iter().map(paragraph).collect()
    }

    /// The book that verses a note refers to are read in: of the code the note names, the edition
    /// of the book the note is in, if the library holds it, or else any.
    pub fn edition(&self, code: &str, of: &str) -> Option<&Book> {
        let work = self.book(of).map(|book| book.work.as_str());
        let editions = self.books.iter().filter(|book| book.code.as_deref() == Some(code));
        editions.clone().find(|book| Some(book.work.as_str()) == work).or_else(|| editions.clone().next())
    }

    /// The verses a note's runs refer to, as runs after them, for each target the library holds a
    /// book for: a line break, then – where the note refers to more than one place – the reference
    /// as the note gives it, and then the verses, each number as its book writes it, in the book's
    /// language. At most [`PREVIEW_VERSES`] verses and [`PREVIEW_LENGTH`] code units, or else
    /// what fits and an ellipsis.
    fn previews(&self, of: &str, runs: &[NoteRun]) -> Vec<NoteRun> {
        let targets: Vec<&NoteRun> = runs.iter().filter(|run| run.target.is_some()).collect();
        let mut previews = Vec::new();
        for run in &targets {
            let target = run.target.as_ref().expect("a target");
            let Some(preview) = self.preview(of, target) else { continue };
            previews.push(NoteRun { text: "\n".into(), ..NoteRun::default() });
            if targets.len() > 1 {
                previews.push(NoteRun {
                    text: run.text.trim().to_string(),
                    role: Some("origin".into()),
                    ..NoteRun::default()
                });
                previews.push(NoteRun { text: "\n".into(), ..NoteRun::default() });
            }
            previews.extend(preview);
        }
        previews
    }

    /// The verses a target names, in the book the note's book refers to – see [`Library::edition`]
    /// – as runs: each verse's number as the book writes it, then its text, in the book's language.
    pub fn preview(&self, of: &str, target: &Target) -> Option<Vec<NoteRun>> {
        let book = self.edition(&target.book, of)?;
        let chapter = book.chapters.iter().find(|chapter| chapter.number == target.chapter)?;
        let from = target.verse.unwrap_or(1);
        let to = target.to.unwrap_or(if target.verse.is_some() { from } else { u32::MAX });
        let verses = chapter.verses.iter().filter(|verse| (from..=to).contains(&verse.number)).take(PREVIEW_VERSES);
        let mut runs = Vec::new();
        let mut length = 0;
        let mut cut = false;
        for verse in verses {
            let mut text: String = verse.runs.iter().map(|(run, _)| run.as_str()).collect();
            let mut end = text_length(&text);
            if length + end > PREVIEW_LENGTH {
                let room = PREVIEW_LENGTH.saturating_sub(length);
                text = take_utf16(&text, room).trim_end().to_string() + "…";
                end = text_length(&text);
                cut = true;
            }
            if !verse.label.is_empty() {
                let number = format!("{}{}\u{a0}", if runs.is_empty() { "" } else { " " }, verse.label);
                runs.push(NoteRun {
                    text: number,
                    role: Some("number".into()),
                    language: Some(book.language.clone()),
                    ..NoteRun::default()
                });
            }
            runs.push(NoteRun {
                text,
                role: Some("preview".into()),
                language: Some(book.language.clone()),
                ..NoteRun::default()
            });
            length += end;
            if cut {
                break;
            }
        }
        if chapter.verses.iter().filter(|verse| (from..=to).contains(&verse.number)).count() > PREVIEW_VERSES && !cut {
            runs.push(NoteRun {
                text: " …".into(),
                role: Some("preview".into()),
                language: Some(book.language.clone()),
                ..NoteRun::default()
            });
        }
        (!runs.is_empty()).then_some(runs)
    }

    /// What is read aloud of the passages, read along with `companions` – only the passages' own
    /// books, or `along`, each verse in every book – from the word at `from`, or else from the
    /// start: see [`Speech`]. A chapter is played from a recording of one of the `recorded` voices,
    /// the first that has one – or, with none named, of any – and the device's voice reads the rest.
    pub fn speech(
        &self,
        references: &[Reference],
        companions: &[String],
        along: bool,
        from: Option<&Place>,
        recorded: Option<&[String]>,
    ) -> Speech {
        Speech::new(self, references, companions, along, from, recorded)
    }
}

/// Whether a recording counts words as the core does, and its times go forward: each verse after
/// the one before, and each word in its verse, from the verse's start on.
fn check(recording: &Recording) -> Result<(), serde_json::Error> {
    if recording.word_definition != WORD_DEFINITION {
        return Err(serde_json::Error::custom(format!(
            "the recording {} counts words by definition {}, the core by {WORD_DEFINITION}",
            recording.id, recording.word_definition
        )));
    }
    let mut number = None;
    let mut time = 0;
    for verse in &recording.verses {
        let mut forward = number.is_none_or(|number| verse.number > number);
        for next in std::iter::once(verse.start).chain(verse.words.iter().copied()) {
            forward &= next >= time;
            time = next;
        }
        if !forward {
            return Err(serde_json::Error::custom(format!(
                "the recording {} goes back at verse {}",
                recording.id, verse.number
            )));
        }
        number = Some(verse.number);
    }
    Ok(())
}

/// Whether a reference to audio is a URI of its own, or a path from the root, rather than relative.
fn is_absolute(reference: &str) -> bool {
    reference.starts_with('/') || reference.split_once(':').is_some_and(|(scheme, _)| !scheme.contains('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A book with only what the format needs.
    fn jonah(work: &str) -> String {
        format!(
            r#"[{{"id": "jonah", "title": "Jonah", "work": "{work}", "direction": "ltr", "language": "en",
                 "chapters": [{{"number": 1, "label": "1", "verses": [{{"number": 1, "label": "1", "runs": [["Now…", null]]}}]}}]}}]"#
        )
    }

    #[test]
    fn a_book_added_again_replaces_the_one_before() {
        let mut library = Library::new();
        assert_eq!(library.add(jonah("First").as_bytes()).unwrap(), ["jonah"]);
        library.add(jonah("Second").as_bytes()).unwrap();
        assert_eq!(library.books().iter().map(|book| book.work.as_str()).collect::<Vec<_>>(), ["Second"]);
        library.remove(&["jonah".into()]);
        assert!(library.books().is_empty());
    }

    #[test]
    fn what_is_no_array_of_books_is_refused() {
        let mut library = Library::new();
        assert!(library.add(b"{}").is_err());
        assert!(library.add(br#"[{"id": "jonah"}]"#).is_err());
        assert!(library.books().is_empty());
    }

    /// A recording of Jonah 1 with what its verse 1 holds, in the word definition given.
    fn recording(definition: u32, audio: &str, verse: &str) -> String {
        format!(
            r#"[{{"id": "jonah-1", "voice": "Reader", "book": "jonah", "chapter": 1, "audio": "{audio}",
                 "wordDefinition": {definition}, "verses": [{verse}]}}]"#
        )
    }

    #[test]
    fn a_recording_counting_words_otherwise_or_going_back_is_refused() {
        let mut library = Library::new();
        let verse = r#"{"number": 1, "start": 100, "words": [200, 900]}"#;
        assert!(library.add_recordings(recording(WORD_DEFINITION, "1.mp3", verse).as_bytes(), None).is_ok());
        assert!(library.add_recordings(recording(WORD_DEFINITION + 1, "1.mp3", verse).as_bytes(), None).is_err());
        let back = r#"{"number": 1, "start": 100, "words": [900, 200]}"#;
        assert!(library.add_recordings(recording(WORD_DEFINITION, "1.mp3", back).as_bytes(), None).is_err());
        let behind = r#"{"number": 1, "start": 100, "words": [200]}, {"number": 2, "start": 150, "words": [300]}"#;
        assert!(library.add_recordings(recording(WORD_DEFINITION, "1.mp3", behind).as_bytes(), None).is_err());
        assert_eq!(library.recordings().len(), 1);
    }

    #[test]
    fn audio_is_found_relative_to_where_its_recording_came_from() {
        let verse = r#"{"number": 1, "start": 0, "words": [0]}"#;
        for (audio, found) in [
            ("reader/jonah-1.m4a", "file:///books/reader/jonah-1.m4a"),
            ("https://example.org/jonah-1.m4a", "https://example.org/jonah-1.m4a"),
            ("asset:///jonah-1.m4a", "asset:///jonah-1.m4a"),
            ("/audio/jonah-1.m4a", "/audio/jonah-1.m4a"),
        ] {
            let mut library = Library::new();
            library
                .add_recordings(recording(WORD_DEFINITION, audio, verse).as_bytes(), Some("file:///books/"))
                .unwrap();
            assert_eq!(library.recordings()[0].audio, found);
        }
    }

    #[test]
    fn a_note_shows_the_verses_it_refers_to_in_the_notes_own_edition_first() {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).unwrap();
        // Jonah 1:17 in the World English Bible, from a note in the same edition's Psalms – or, from the
        // Hebrew, in the Hebrew, which numbers it 2:1 and has no 1:17.
        let jonah = Target { book: "JON".into(), chapter: 1, verse: Some(17), to: None };
        let english = library.preview("psalms", &jonah).unwrap();
        assert_eq!(english[0].text, "17\u{a0}");
        assert!(english[1].text.starts_with("Yahweh prepared a huge fish"));
        assert_eq!(english[1].language.as_deref(), Some("en"));
        assert!(library.preview("psalms-he", &jonah).is_none());
        let hebrew =
            library.preview("psalms-he", &Target { book: "JON".into(), chapter: 2, verse: Some(1), to: None }).unwrap();
        assert_eq!(hebrew[1].language.as_deref(), Some("he"));
        // A range gives each verse with its number; a chapter, its first verses and an ellipsis.
        let range =
            library.preview("jonah", &Target { book: "JON".into(), chapter: 2, verse: Some(2), to: Some(3) }).unwrap();
        assert_eq!(range.iter().filter(|run| run.role.as_deref() == Some("number")).count(), 2);
        assert_eq!(range[2].text, " 3\u{a0}");
        let chapter =
            library.preview("jonah", &Target { book: "JON".into(), chapter: 2, verse: None, to: None }).unwrap();
        assert_eq!(chapter.iter().filter(|run| run.role.as_deref() == Some("number")).count(), PREVIEW_VERSES);
        assert_eq!(chapter.last().unwrap().text, " …");
        assert!(
            library.preview("jonah", &Target { book: "ISA".into(), chapter: 7, verse: Some(14), to: None }).is_none()
        );
    }

    #[test]
    fn a_passage_of_a_book_not_held_gives_nothing() {
        let reference = Reference { book: "jonah".into(), chapter: None, from: None, to: None };
        let options = Options {
            font_size: 28.0,
            verse_per_line: false,
            companions: Vec::new(),
            notes: Notes::Marks,
            drop_caps: true,
            mark_notes: MarkNotes::Sign,
            lexicon: LexiconUse::Entries,
            lexicon_books: None,
            linked_books: Vec::new(),
            marked_number: None,
        };
        assert!(Library::new().blocks(&[reference], &options).is_empty());
    }

    fn mark(id: &str, from: &str, to: &str) -> String {
        format!(r#"{{"id": "{id}", "book": "jonah", "from": {from}, "to": {to}, "highlight": "yellow"}}"#)
    }

    #[test]
    fn marks_replace_those_of_the_same_id_and_a_mark_ending_before_it_starts_is_refused() {
        let mut library = Library::new();
        let first = mark("a", r#"{"chapter": 1, "verse": 1, "word": 2}"#, r#"{"chapter": 1, "verse": 3}"#);
        let second = mark("b", r#"{"chapter": 2, "verse": 1}"#, r#"{"chapter": 2, "verse": 1}"#);
        assert_eq!(library.add_marks(format!("[{first}, {second}]").as_bytes()).unwrap(), ["a", "b"]);
        let again = mark("a", r#"{"chapter": 1, "verse": 1}"#, r#"{"chapter": 1, "verse": 1}"#);
        library.add_marks(format!("[{again}]").as_bytes()).unwrap();
        assert_eq!(library.marks().len(), 2);
        assert_eq!(library.marks()[0].from.word, None);
        assert_eq!(library.marks()[0].from, MarkEnd { chapter: 1, verse: 1, word: None });
        assert!(library.marks()[0].note.is_empty() && library.marks()[0].underline.is_none());
        // A whole verse reaches past any word of it; a later verse or chapter comes after.
        for (from, to) in [
            (r#"{"chapter": 1, "verse": 2}"#, r#"{"chapter": 1, "verse": 1}"#),
            (r#"{"chapter": 2, "verse": 1}"#, r#"{"chapter": 1, "verse": 9}"#),
            (r#"{"chapter": 1, "verse": 1, "word": 3}"#, r#"{"chapter": 1, "verse": 1, "word": 2}"#),
        ] {
            assert!(library.add_marks(format!("[{}]", mark("c", from, to)).as_bytes()).is_err());
        }
        assert!(
            library
                .add_marks(
                    format!(
                        "[{}]",
                        mark("c", r#"{"chapter": 1, "verse": 1, "word": 3}"#, r#"{"chapter": 1, "verse": 1}"#)
                    )
                    .as_bytes()
                )
                .is_ok()
        );
        assert!(library.add_marks(br#"[{"id": "d"}]"#).is_err());
        library.remove_marks(&["a".into()]);
        assert_eq!(library.marks().iter().map(|mark| mark.id.as_str()).collect::<Vec<_>>(), ["b", "c"]);
        library.clear_marks();
        assert!(library.marks().is_empty());
    }
}
