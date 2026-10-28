//! Scriptura for Swift and Kotlin, through UniFFI: one library of books per process, which the host
//! fills and every reader view reads from. Only native code binds it, so a passage's text never has
//! to pass through JavaScript: React Native's module gives JS the books' names, not their text.

use std::sync::{LazyLock, RwLock};

uniffi::setup_scaffolding!();

static LIBRARY: LazyLock<RwLock<scriptura::Library>> = LazyLock::new(Default::default);

/// Books that couldn't be read, with why: they aren't a JSON array of books.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BooksError {
    #[error("{message}")]
    Invalid { message: String },
}

/// A book as JS may see it: what it is, not what it says. Editions of the same book share its code.
#[derive(uniffi::Record)]
pub struct BookInfo {
    pub id: String,
    pub code: Option<String>,
    pub title: String,
    pub work: String,
    pub language: String,
    pub direction: String,
}

/// A whole book, one chapter of it, or a verse range in that chapter.
#[derive(uniffi::Record)]
pub struct Reference {
    pub book: String,
    pub chapter: Option<u32>,
    pub from: Option<u32>,
    pub to: Option<u32>,
}

/// A paragraph to lay out: see `scriptura::Block`.
#[derive(uniffi::Record)]
pub struct Block {
    pub passage: u32,
    pub book: String,
    pub row: u32,
    pub column: u32,
    pub kind: String,
    pub direction: String,
    pub language: String,
    pub font_family: Option<String>,
    pub letter: String,
    pub letter_height: f64,
    pub segments: Vec<Segment>,
    pub verses: Vec<VerseRange>,
    pub words: Vec<Word>,
}

#[derive(uniffi::Record)]
pub struct Segment {
    pub text: String,
    pub role: Option<String>,
}

#[derive(uniffi::Record)]
pub struct VerseRange {
    pub chapter: u32,
    pub verse: u32,
    pub start: u32,
    pub end: u32,
}

#[derive(uniffi::Record)]
pub struct Word {
    pub chapter: u32,
    pub verse: u32,
    pub index: u32,
    pub start: u32,
    pub end: u32,
}

/// Adds the books of a JSON array, each replacing one of the same id, and returns their ids.
#[uniffi::export]
pub fn add_books(json: Vec<u8>) -> Result<Vec<String>, BooksError> {
    LIBRARY.write().unwrap().add(&json).map_err(|error| BooksError::Invalid { message: error.to_string() })
}

#[uniffi::export]
pub fn remove_books(ids: Vec<String>) {
    LIBRARY.write().unwrap().remove(&ids);
}

#[uniffi::export]
pub fn clear_books() {
    LIBRARY.write().unwrap().clear();
}

#[uniffi::export]
pub fn books() -> Vec<BookInfo> {
    let library = LIBRARY.read().unwrap();
    let info = |book: &scriptura::Book| BookInfo {
        id: book.id.clone(),
        code: book.code.clone(),
        title: book.title.clone(),
        work: book.work.clone(),
        language: book.language.clone(),
        direction: book.direction.clone(),
    };
    library.books().iter().map(info).collect()
}

/// The passages as paragraphs, read along with `companions`: see `scriptura::Library::blocks`.
#[uniffi::export]
pub fn reader_blocks(
    references: Vec<Reference>,
    font_size: f64,
    verse_per_line: bool,
    companions: Vec<String>,
) -> Vec<Block> {
    let references: Vec<_> = references
        .into_iter()
        .map(|Reference { book, chapter, from, to }| scriptura::Reference { book, chapter, from, to })
        .collect();
    let options = scriptura::Options { font_size, verse_per_line, companions };
    LIBRARY.read().unwrap().blocks(&references, &options).into_iter().map(Block::from).collect()
}

impl From<scriptura::Block> for Block {
    fn from(block: scriptura::Block) -> Self {
        Block {
            passage: block.passage,
            book: block.book,
            row: block.row,
            column: block.column,
            kind: block.kind,
            direction: block.direction,
            language: block.language,
            font_family: block.font_family,
            letter: block.letter,
            letter_height: block.letter_height,
            segments: block
                .segments
                .into_iter()
                .map(|scriptura::Segment { text, role }| Segment { text, role })
                .collect(),
            verses: block
                .verses
                .into_iter()
                .map(|scriptura::VerseRange { chapter, verse, start, end }| VerseRange { chapter, verse, start, end })
                .collect(),
            words: block
                .words
                .into_iter()
                .map(|scriptura::Word { chapter, verse, index, start, end }| Word { chapter, verse, index, start, end })
                .collect(),
        }
    }
}
