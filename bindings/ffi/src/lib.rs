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

/// Marks that couldn't be read, with why: they aren't a JSON array of marks, or one ends before it
/// starts.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum MarksError {
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

/// A recording as JS may see it: whose it is, which chapter it reads, and why it isn't played for
/// it, if it isn't.
#[derive(uniffi::Record)]
pub struct RecordingInfo {
    pub id: String,
    pub voice: String,
    pub name: Option<String>,
    pub book: String,
    pub chapter: u32,
    pub misfit: Option<String>,
}

/// An end of a mark: a word of a verse, or the whole verse, without one: see `scriptura::MarkEnd`.
#[derive(uniffi::Record)]
pub struct MarkEnd {
    pub chapter: u32,
    pub verse: u32,
    pub word: Option<u32>,
}

/// A mark as JS may see it: which words of which book it marks and how, and whether it has a note –
/// not the note itself.
#[derive(uniffi::Record)]
pub struct MarkInfo {
    pub id: String,
    pub book: String,
    pub from: MarkEnd,
    pub to: MarkEnd,
    pub highlight: Option<String>,
    pub underline: Option<String>,
    pub note: bool,
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
    pub notes: Vec<NoteMark>,
    pub drop_cap: Option<DropCap>,
    pub marks: Vec<PlacedMark>,
}

/// A host's mark in a paragraph, and its note where the mark ends: see `scriptura::PlacedMark`.
#[derive(uniffi::Record)]
pub struct PlacedMark {
    pub id: String,
    pub start: u32,
    pub end: u32,
    pub highlight: Option<String>,
    pub underline: Option<String>,
    pub note: Option<Vec<NoteRun>>,
}

#[derive(uniffi::Record)]
pub struct Segment {
    pub text: String,
    pub role: Option<String>,
}

/// A note's mark in a paragraph, and the note it opens: see `scriptura::NoteMark`.
#[derive(uniffi::Record)]
pub struct NoteMark {
    pub chapter: u32,
    pub verse: u32,
    pub start: u32,
    pub end: u32,
    pub kind: String,
    pub mark: String,
    pub runs: Vec<NoteRun>,
}

/// A run of a note's text: see `scriptura::NoteRun`.
#[derive(uniffi::Record)]
pub struct NoteRun {
    pub text: String,
    pub role: Option<String>,
    pub language: Option<String>,
    pub target: Option<Target>,
}

/// A verse a note refers to, by its book's code: see `scriptura::Target`.
#[derive(uniffi::Record)]
pub struct Target {
    pub book: String,
    pub chapter: u32,
    pub verse: Option<u32>,
    pub to: Option<u32>,
}

/// How notes show in the text: see `scriptura::Notes`.
#[derive(uniffi::Enum)]
pub enum Notes {
    None,
    Marks,
    Inline,
}

/// What opens a chapter, set large: see `scriptura::DropCap`.
#[derive(uniffi::Record)]
pub struct DropCap {
    pub letter_start: u32,
    pub letter_end: u32,
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
        name: recording.name.clone(),
        book: recording.book.clone(),
        chapter: recording.chapter,
        misfit: library.misfit(recording),
    };
    library.recordings().iter().map(info).collect()
}

/// Adds the marks of a JSON array, each replacing one of the same id, and returns their ids.
#[uniffi::export]
pub fn add_marks(json: Vec<u8>) -> Result<Vec<String>, MarksError> {
    LIBRARY.write().unwrap().add_marks(&json).map_err(|error| MarksError::Invalid(error.to_string()))
}

#[uniffi::export]
pub fn remove_marks(ids: Vec<String>) {
    LIBRARY.write().unwrap().remove_marks(&ids);
}

#[uniffi::export]
pub fn clear_marks() {
    LIBRARY.write().unwrap().clear_marks();
}

#[uniffi::export]
pub fn marks() -> Vec<MarkInfo> {
    let library = LIBRARY.read().unwrap();
    let end = |end: &scriptura::MarkEnd| MarkEnd { chapter: end.chapter, verse: end.verse, word: end.word };
    let info = |mark: &scriptura::Mark| MarkInfo {
        id: mark.id.clone(),
        book: mark.book.clone(),
        from: end(&mark.from),
        to: end(&mark.to),
        highlight: mark.highlight.clone(),
        underline: mark.underline.clone(),
        note: !mark.note.is_empty(),
    };
    library.marks().iter().map(info).collect()
}

/// The passages as paragraphs, read along with `companions`, with the notes as asked for and drop
/// caps if asked for, and the host's marks over their words: see `scriptura::Library::blocks`.
#[uniffi::export]
pub fn reader_blocks(
    references: Vec<Reference>,
    font_size: f64,
    verse_per_line: bool,
    companions: Vec<String>,
    notes: Notes,
    drop_caps: bool,
) -> Vec<Block> {
    let options = core_options(font_size, verse_per_line, companions, notes, drop_caps);
    LIBRARY.read().unwrap().blocks(&core_references(references), &options).into_iter().map(Block::from).collect()
}

/// The marks in the passages' paragraphs, paragraph by paragraph as `reader_blocks` gives them with
/// the same arguments: for a reader to draw them anew as they change, its layout kept.
#[uniffi::export]
pub fn reader_marks(
    references: Vec<Reference>,
    font_size: f64,
    verse_per_line: bool,
    companions: Vec<String>,
    notes: Notes,
    drop_caps: bool,
) -> Vec<Vec<PlacedMark>> {
    let options = core_options(font_size, verse_per_line, companions, notes, drop_caps);
    let placed = LIBRARY.read().unwrap().marks_in(&core_references(references), &options);
    placed.into_iter().map(|marks| marks.into_iter().map(PlacedMark::from).collect()).collect()
}

fn core_options(
    font_size: f64,
    verse_per_line: bool,
    companions: Vec<String>,
    notes: Notes,
    drop_caps: bool,
) -> scriptura::Options {
    let notes = match notes {
        Notes::None => scriptura::Notes::None,
        Notes::Marks => scriptura::Notes::Marks,
        Notes::Inline => scriptura::Notes::Inline,
    };
    scriptura::Options { font_size, verse_per_line, companions, notes, drop_caps }
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
            notes: block.notes.into_iter().map(NoteMark::from).collect(),
            drop_cap: block
                .drop_cap
                .map(|scriptura::DropCap { letter_start, letter_end }| DropCap { letter_start, letter_end }),
            marks: block.marks.into_iter().map(PlacedMark::from).collect(),
        }
    }
}

impl From<scriptura::NoteMark> for NoteMark {
    fn from(note: scriptura::NoteMark) -> Self {
        NoteMark {
            chapter: note.chapter,
            verse: note.verse,
            start: note.start,
            end: note.end,
            kind: note.kind,
            mark: note.mark,
            runs: note.runs.into_iter().map(NoteRun::from).collect(),
        }
    }
}

impl From<scriptura::PlacedMark> for PlacedMark {
    fn from(mark: scriptura::PlacedMark) -> Self {
        PlacedMark {
            id: mark.id,
            start: mark.start,
            end: mark.end,
            highlight: mark.highlight,
            underline: mark.underline,
            note: mark.note.map(|runs| runs.into_iter().map(NoteRun::from).collect()),
        }
    }
}

impl From<scriptura::NoteRun> for NoteRun {
    fn from(scriptura::NoteRun { text, role, language, target }: scriptura::NoteRun) -> Self {
        let target = target.map(|scriptura::Target { book, chapter, verse, to }| Target { book, chapter, verse, to });
        NoteRun { text, role, language, target }
    }
}

impl From<scriptura::Word> for Word {
    fn from(scriptura::Word { chapter, verse, index, start, end }: scriptura::Word) -> Self {
        Word { chapter, verse, index, start, end }
    }
}
