//! Scriptura for Swift and Kotlin, through UniFFI: one library of books and recordings per process,
//! which the host fills and every reader view reads from. Only native code binds it, so a passage's
//! text never has to pass through JavaScript: React Native's module gives JS the books' names, not
//! their text.

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

/// Recordings that couldn't be read, with why: they aren't a JSON array of recordings, or count words
/// otherwise than the core does.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum RecordingsError {
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

/// A recording as JS may see it: whose it is, and which chapter it reads.
#[derive(uniffi::Record)]
pub struct RecordingInfo {
    pub id: String,
    pub voice: String,
    pub book: String,
    pub chapter: u32,
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

/// Verses played from a recording: see `scriptura::Take`.
#[derive(uniffi::Record)]
pub struct Take {
    pub passage: u32,
    pub book: String,
    pub voice: String,
    pub audio: String,
    pub start: u32,
    pub end: Option<u32>,
    pub words: Vec<TimedWord>,
}

#[derive(uniffi::Record)]
pub struct TimedWord {
    pub chapter: u32,
    pub verse: u32,
    pub index: u32,
    pub start: u32,
}

/// What is read aloud next: an utterance for the device's voice, or a take from a recording. Not Part,
/// which Swift's reader has.
#[derive(uniffi::Enum)]
pub enum SpeechPart {
    Speak { utterance: Utterance },
    Play { take: Take },
}

/// What is read aloud of passages, part by part: see `scriptura::Speech`. It holds what is still to
/// be read, so a reader drops it as the host removes books or recordings.
#[derive(uniffi::Object)]
pub struct Speech(Mutex<scriptura::Speech>);

#[uniffi::export]
impl Speech {
    /// The passages read along with `companions` – only their own books, or `along`, each verse in
    /// every book – from the word at `from`, or else from the start; chapters from recordings of
    /// the `recorded` voices, or with none named, of any.
    #[uniffi::constructor]
    pub fn new(
        references: Vec<Reference>,
        companions: Vec<String>,
        along: bool,
        from: Option<WordPosition>,
        recorded: Option<Vec<String>>,
    ) -> Self {
        let from = from.map(|WordPosition { passage, book, chapter, verse, word }| scriptura::Place {
            passage,
            book,
            chapter,
            verse,
            word,
        });
        let library = LIBRARY.read().unwrap();
        let speech =
            library.speech(&core_references(references), &companions, along, from.as_ref(), recorded.as_deref());
        Speech(Mutex::new(speech))
    }

    /// The next part: a take, or an utterance at most `limit` UTF-16 code units long, cut at a
    /// sentence end; none after the last.
    pub fn next(&self, limit: u32) -> Option<SpeechPart> {
        Some(match self.0.lock().unwrap().next(limit as usize)? {
            scriptura::Part::Speak(scriptura::Utterance { passage, book, language, heading, text, words }) => {
                let words = words.into_iter().map(Word::from).collect();
                SpeechPart::Speak { utterance: Utterance { passage, book, language, heading, text, words } }
            }
            scriptura::Part::Play(scriptura::Take { passage, book, voice, audio, start, end, words }) => {
                let words = (words.into_iter())
                    .map(|scriptura::TimedWord { chapter, verse, index, start }| TimedWord {
                        chapter,
                        verse,
                        index,
                        start,
                    })
                    .collect();
                SpeechPart::Play { take: Take { passage, book, voice, audio, start, end, words } }
            }
        })
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

/// Adds the recordings of a JSON array, each replacing one of the same id, and returns their ids. An
/// audio that is no URI is taken as relative to `base`, where they came from.
#[uniffi::export]
pub fn add_recordings(json: Vec<u8>, base: Option<String>) -> Result<Vec<String>, RecordingsError> {
    let mut library = LIBRARY.write().unwrap();
    library.add_recordings(&json, base.as_deref()).map_err(|error| RecordingsError::Invalid(error.to_string()))
}

#[uniffi::export]
pub fn remove_recordings(ids: Vec<String>) {
    LIBRARY.write().unwrap().remove_recordings(&ids);
}

#[uniffi::export]
pub fn clear_recordings() {
    LIBRARY.write().unwrap().clear_recordings();
}

#[uniffi::export]
pub fn recordings() -> Vec<RecordingInfo> {
    let library = LIBRARY.read().unwrap();
    let info = |recording: &scriptura::Recording| RecordingInfo {
        id: recording.id.clone(),
        voice: recording.voice.clone(),
        book: recording.book.clone(),
        chapter: recording.chapter,
    };
    library.recordings().iter().map(info).collect()
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
