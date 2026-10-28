//! Scriptura for Swift and Kotlin, through UniFFI: one library of books per process, which the host
//! fills and every reader view reads from. Only native code binds it, so a passage's text never has
//! to pass through JavaScript: React Native's module gives JS the books' names, not their text.

use std::sync::{LazyLock, Mutex, RwLock};

uniffi::setup_scaffolding!();

static LIBRARY: LazyLock<RwLock<scriptura::Library>> = LazyLock::new(Default::default);

/// Books that couldn't be read, with why: they aren't a JSON array of books. Its message becomes the
/// Swift error's and the Kotlin exception's.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum BooksError {
    #[error("{0}")]
    Invalid(String),
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

/// Where a word stands: see `scriptura::Place`.
#[derive(uniffi::Record)]
pub struct WordPosition {
    pub passage: u32,
    pub book: String,
    pub chapter: u32,
    pub verse: u32,
    pub word: u32,
}

/// Text for a voice: see `scriptura::Utterance`.
#[derive(uniffi::Record)]
pub struct Utterance {
    pub passage: u32,
    pub book: String,
    pub language: String,
    pub heading: bool,
    pub text: String,
    pub words: Vec<Word>,
}

/// What a voice says of passages, utterance by utterance: see `scriptura::Speech`. It holds what
/// is still to be said, so a reader drops it as the host removes books.
#[derive(uniffi::Object)]
pub struct Speech(Mutex<scriptura::Speech>);

#[uniffi::export]
impl Speech {
    /// The passages read along with `companions` – only their own books, or `along`, each verse in
    /// every book – from the word at `from`, or else from the start.
    #[uniffi::constructor]
    pub fn new(references: Vec<Reference>, companions: Vec<String>, along: bool, from: Option<WordPosition>) -> Self {
        let from = from.map(|WordPosition { passage, book, chapter, verse, word }| scriptura::Place {
            passage,
            book,
            chapter,
            verse,
            word,
        });
        let speech = LIBRARY.read().unwrap().speech(&core_references(references), &companions, along, from.as_ref());
        Speech(Mutex::new(speech))
    }

    /// The next utterance, at most `limit` UTF-16 code units long, cut at a sentence end; none after
    /// the last.
    pub fn next(&self, limit: u32) -> Option<Utterance> {
        let utterance = self.0.lock().unwrap().next(limit as usize)?;
        let scriptura::Utterance { passage, book, language, heading, text, words } = utterance;
        Some(Utterance { passage, book, language, heading, text, words: words.into_iter().map(Word::from).collect() })
    }
}

/// Adds the books of a JSON array, each replacing one of the same id, and returns their ids.
#[uniffi::export]
pub fn add_books(json: Vec<u8>) -> Result<Vec<String>, BooksError> {
    LIBRARY.write().unwrap().add(&json).map_err(|error| BooksError::Invalid(error.to_string()))
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
    let options = scriptura::Options { font_size, verse_per_line, companions };
    LIBRARY.read().unwrap().blocks(&core_references(references), &options).into_iter().map(Block::from).collect()
}

fn core_references(references: Vec<Reference>) -> Vec<scriptura::Reference> {
    references
        .into_iter()
        .map(|Reference { book, chapter, from, to }| scriptura::Reference { book, chapter, from, to })
        .collect()
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
            words: block.words.into_iter().map(Word::from).collect(),
        }
    }
}

impl From<scriptura::Word> for Word {
    fn from(scriptura::Word { chapter, verse, index, start, end }: scriptura::Word) -> Self {
        Word { chapter, verse, index, start, end }
    }
}
