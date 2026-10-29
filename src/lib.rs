//! Scripture made ready to read: a library of books – a book of the Bible in one edition, a
//! surah – and passages of them as paragraphs to lay out. A paragraph is a chapter's heading, its
//! running text or a verse on a line of its own, in its book's language, direction and script,
//! with each verse and word where it stands. Other editions of a book can be read along with it,
//! verse by verse, matched by the KJV's numbers. Passages can be read aloud, by the device's voices
//! or from recordings of their chapters: see [`Speech`].
//!
//! The library holds no texts of its own: a host adds books as JSON (see [`Book`]), and recordings
//! (see [`Recording`]).

mod model;
mod reader;
mod speech;

use serde::de::Error as _;

pub use model::{Book, Chapter, RecordedVerse, Recording, Verse, VerseNumbers};
pub use reader::{Block, Segment, VerseRange, WORD_DEFINITION, Word};
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
}

/// The books a host has added, and the recordings of their chapters, in the order added.
#[derive(Default)]
pub struct Library {
    books: Vec<Book>,
    recordings: Vec<Recording>,
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

    /// Why a recording isn't played for the book it reads, if it isn't: the library holds no such
    /// book, or the book's verses or their words aren't the recording's.
    pub fn misfit(&self, recording: &Recording) -> Option<String> {
        speech::misfit(recording, self.book(&recording.book))
    }

    /// The passages as paragraphs: per chapter a heading, then the chapter as running text, or a
    /// verse per line. With companions, other editions of a passage's book are read along with it:
    /// see [`Block::row`]. Passages of books the library doesn't hold give nothing.
    pub fn blocks(&self, references: &[Reference], options: &Options) -> Vec<Block> {
        let companions: Vec<&Book> = options.companions.iter().filter_map(|id| self.book(id)).collect();
        let mut rows = 0..;
        let mut blocks = Vec::new();
        for (passage, reference) in (0..).zip(references) {
            let (size, verse_per_line) = (options.font_size, options.verse_per_line);
            blocks.extend(reader::blocks(self, reference, passage, size, verse_per_line, &companions, &mut rows));
        }
        blocks
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
    fn a_passage_of_a_book_not_held_gives_nothing() {
        let reference = Reference { book: "jonah".into(), chapter: None, from: None, to: None };
        let options = Options { font_size: 28.0, verse_per_line: false, companions: Vec::new() };
        assert!(Library::new().blocks(&[reference], &options).is_empty());
    }
}
