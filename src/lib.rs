//! Scripture made ready to read: a library of books – a book of the Bible in one edition, a
//! surah – and passages of them as paragraphs to lay out. A paragraph is a chapter's heading, its
//! running text or a verse on a line of its own, in its book's language, direction and script,
//! with each verse and word where it stands. Other editions of a book can be read along with it,
//! verse by verse, matched by the KJV's numbers. Passages can be read aloud: see [`Speech`].
//!
//! The library holds no texts of its own: a host adds books as JSON (see [`Book`]).

mod model;
mod reader;
mod speech;

pub use model::{Book, Chapter, Verse, VerseNumbers};
pub use reader::{Block, Segment, VerseRange, Word};
pub use speech::{Place, Speech, Utterance};

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

/// The books a host has added, in the order added.
#[derive(Default)]
pub struct Library {
    books: Vec<Book>,
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

    /// What a voice says of the passages, read along with `companions` – only the passages' own
    /// books, or `along`, each verse in every book – from the word at `from`, or else from the
    /// start: see [`Speech`].
    pub fn speech(&self, references: &[Reference], companions: &[String], along: bool, from: Option<&Place>) -> Speech {
        Speech::new(self, references, companions, along, from)
    }
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

    #[test]
    fn a_passage_of_a_book_not_held_gives_nothing() {
        let reference = Reference { book: "jonah".into(), chapter: None, from: None, to: None };
        let options = Options { font_size: 28.0, verse_per_line: false, companions: Vec::new() };
        assert!(Library::new().blocks(&[reference], &options).is_empty());
    }
}
