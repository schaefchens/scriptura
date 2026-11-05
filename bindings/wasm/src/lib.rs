//! Scriptura for the web, through wasm-bindgen: a library of books and recordings in the page, and
//! passages of them as paragraphs for its reader. Books and paragraphs cross as JSON, which a
//! browser parses faster than it takes objects built field by field.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct Library(scriptura::Library);

/// What is read aloud of passages, part by part: see `scriptura::Speech`.
#[wasm_bindgen]
pub struct Speech(scriptura::Speech);

/// A recording as a list shows it: whose it is, which chapter it reads, and why it isn't played for
/// it, if it isn't.
#[derive(Serialize)]
struct RecordingInfo<'a> {
    id: &'a str,
    voice: &'a str,
    name: Option<&'a str>,
    book: &'a str,
    chapter: u32,
    misfit: Option<String>,
}

/// A mark as a list shows it: which words of which book it marks and how, and whether it has a note –
/// not the note itself.
#[derive(Serialize)]
struct MarkInfo<'a> {
    id: &'a str,
    book: &'a str,
    from: scriptura::MarkEnd,
    to: scriptura::MarkEnd,
    highlight: Option<&'a str>,
    underline: Option<&'a str>,
    note: bool,
}

/// A lexicon as a list shows it: what it is and how many entries it has.
#[derive(Serialize)]
struct LexiconInfo<'a> {
    id: &'a str,
    title: &'a str,
    language: &'a str,
    entries: usize,
}

/// A book as a list of books shows it: what it is, not what it says.
#[derive(Serialize)]
struct BookInfo<'a> {
    id: &'a str,
    code: Option<&'a str>,
    title: &'a str,
    work: &'a str,
    language: &'a str,
    direction: &'a str,
}

#[derive(Deserialize)]
struct Reference {
    book: String,
    chapter: Option<u32>,
    from: Option<u32>,
    to: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    font_size: f64,
    #[serde(default)]
    verse_per_line: bool,
    #[serde(default)]
    companions: Vec<String>,
    #[serde(default = "marks")]
    notes: String,
    #[serde(default = "yes")]
    drop_caps: bool,
    #[serde(default = "sign")]
    mark_notes: String,
    #[serde(default = "entries")]
    lexicon: String,
    #[serde(default)]
    lexicon_books: Option<Vec<String>>,
    #[serde(default)]
    linked_books: Vec<String>,
    #[serde(default)]
    marked_number: Option<String>,
}

fn entries() -> String {
    "entries".into()
}

fn sign() -> String {
    "sign".into()
}

fn yes() -> bool {
    true
}

fn marks() -> String {
    "marks".into()
}

#[derive(Deserialize)]
struct SpeechOptions {
    #[serde(default)]
    companions: Vec<String>,
    #[serde(default)]
    along: bool,
    recorded: Option<Vec<String>>,
}

#[wasm_bindgen]
impl Library {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Library {
        Library::default()
    }

    /// Adds the books of a JSON array, each replacing one of the same id, and returns their ids.
    pub fn add(&mut self, json: &[u8]) -> Result<Vec<String>, JsError> {
        Ok(self.0.add(json)?)
    }

    pub fn remove(&mut self, ids: Vec<String>) {
        self.0.remove(&ids);
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Adds the recordings of a JSON array, each replacing one of the same id, and returns their ids.
    /// An audio that is no URI is taken as relative to `base`, where they came from.
    #[wasm_bindgen(js_name = addRecordings)]
    pub fn add_recordings(&mut self, json: &[u8], base: Option<String>) -> Result<Vec<String>, JsError> {
        Ok(self.0.add_recordings(json, base.as_deref())?)
    }

    #[wasm_bindgen(js_name = removeRecordings)]
    pub fn remove_recordings(&mut self, ids: Vec<String>) {
        self.0.remove_recordings(&ids);
    }

    #[wasm_bindgen(js_name = clearRecordings)]
    pub fn clear_recordings(&mut self) {
        self.0.clear_recordings();
    }

    /// The recordings as JSON: id, voice and name, book and chapter of each, and why it isn't played,
    /// if it isn't.
    #[wasm_bindgen(js_name = recordingsJson)]
    pub fn recordings_json(&self) -> String {
        let recordings: Vec<_> = (self.0.recordings().iter())
            .map(|recording| RecordingInfo {
                id: &recording.id,
                voice: &recording.voice,
                name: recording.name.as_deref(),
                book: &recording.book,
                chapter: recording.chapter,
                misfit: self.0.misfit(recording),
            })
            .collect();
        serde_json::to_string(&recordings).expect("recordings serialize")
    }

    /// Adds the marks of a JSON array, each replacing one of the same id, and returns their ids. A
    /// mark that ends before it starts is refused.
    #[wasm_bindgen(js_name = addMarks)]
    pub fn add_marks(&mut self, json: &[u8]) -> Result<Vec<String>, JsError> {
        Ok(self.0.add_marks(json)?)
    }

    #[wasm_bindgen(js_name = removeMarks)]
    pub fn remove_marks(&mut self, ids: Vec<String>) {
        self.0.remove_marks(&ids);
    }

    #[wasm_bindgen(js_name = clearMarks)]
    pub fn clear_marks(&mut self) {
        self.0.clear_marks();
    }

    /// The marks as JSON: id, book, from and to, highlight and underline of each, and whether it has a note.
    #[wasm_bindgen(js_name = marksJson)]
    pub fn marks_json(&self) -> String {
        let marks: Vec<_> = (self.0.marks().iter())
            .map(|mark| MarkInfo {
                id: &mark.id,
                book: &mark.book,
                from: mark.from,
                to: mark.to,
                highlight: mark.highlight.as_deref(),
                underline: mark.underline.as_deref(),
                note: !mark.note.is_empty(),
            })
            .collect();
        serde_json::to_string(&marks).expect("marks serialize")
    }

    /// Adds the lexicons of a JSON array, each replacing one of the same id, and returns their ids.
    #[wasm_bindgen(js_name = addLexicons)]
    pub fn add_lexicons(&mut self, json: &[u8]) -> Result<Vec<String>, JsError> {
        Ok(self.0.add_lexicons(json)?)
    }

    #[wasm_bindgen(js_name = removeLexicons)]
    pub fn remove_lexicons(&mut self, ids: Vec<String>) {
        self.0.remove_lexicons(&ids);
    }

    #[wasm_bindgen(js_name = clearLexicons)]
    pub fn clear_lexicons(&mut self) {
        self.0.clear_lexicons();
    }

    /// The lexicons as JSON: id, title, language and the number of entries of each.
    #[wasm_bindgen(js_name = lexiconsJson)]
    pub fn lexicons_json(&self) -> String {
        let lexicons: Vec<_> = (self.0.lexicons())
            .map(|lexicon| LexiconInfo {
                id: &lexicon.id,
                title: &lexicon.title,
                language: &lexicon.language,
                entries: lexicon.entries.len(),
            })
            .collect();
        serde_json::to_string(&lexicons).expect("lexicons serialize")
    }

    /// A word's entry, by where the word stands, in JSON – its lexicon's language and direction, and
    /// its runs, whose links count the verses of `books`, or of every book, with each number – or
    /// none, where the lexicons hold nothing of it.
    #[wasm_bindgen(js_name = entryJson)]
    pub fn entry_json(
        &self,
        book: &str,
        chapter: u32,
        verse: u32,
        word: u32,
        books: Option<Vec<String>>,
    ) -> Option<String> {
        let entry = self.0.entry(book, chapter, verse, word, books.as_deref())?;
        Some(serde_json::to_string(&entry).expect("entries serialize"))
    }

    /// Every verse of `books`, in the order given, with words of a number, in JSON: book, chapter,
    /// verse and the words' indices of each – a translation's only where the books before it lack it.
    #[wasm_bindgen(js_name = versesWithJson)]
    pub fn verses_with_json(&self, number: &str, books: Vec<String>) -> String {
        serde_json::to_string(&self.0.verses_with(number, &books)).expect("verses serialize")
    }

    /// The words that carry a number of the word at `from` – a word's place, in JSON – in the books
    /// its passage shows read along with, where both link, as places in JSON. The passages and
    /// options as `blocksJson` takes them.
    #[wasm_bindgen(js_name = counterpartsJson)]
    pub fn counterparts_json(&self, references: &str, options: &str, from: &str) -> Result<String, JsError> {
        let options = core_options(options)?;
        let from: scriptura::Place = serde_json::from_str(from)?;
        Ok(serde_json::to_string(&self.0.counterparts(&parse_references(references)?, &options, &from))?)
    }

    /// The books as JSON: id, code, title, work, language and direction of each.
    #[wasm_bindgen(js_name = booksJson)]
    pub fn books_json(&self) -> String {
        let books: Vec<_> = (self.0.books().iter())
            .map(|book| BookInfo {
                id: &book.id,
                code: book.code.as_deref(),
                title: &book.title,
                work: &book.work,
                language: &book.language,
                direction: &book.direction,
            })
            .collect();
        serde_json::to_string(&books).expect("books serialize")
    }

    /// The passages – a JSON array of references – as paragraphs, in JSON, the marks over their
    /// words. `options` is JSON too: fontSize, versePerLine and companions, how the notes show
    /// (notes: "marks", "inline" or "none"; marks by default), whether drop caps are wanted
    /// (dropCaps: by default they are), how the marks' notes show (markNotes: "sign" or "inline";
    /// a sign by default), what the words' numbers do (lexicon: "entries", "numbers" or "none";
    /// entries by default) in which books (lexiconBooks; every book's by default), the translations
    /// whose words link to them (linkedBooks), and a number whose words are marked (markedNumber).
    #[wasm_bindgen(js_name = blocksJson)]
    pub fn blocks_json(&self, references: &str, options: &str) -> Result<String, JsError> {
        let options = core_options(options)?;
        Ok(serde_json::to_string(&self.0.blocks(&parse_references(references)?, &options))?)
    }

    /// What is read aloud of the passages – a JSON array of references – from a word's place, in
    /// JSON, or from the start if it is empty. `options` is JSON too: companions, whether each verse
    /// is read in every book read along, and the voices whose recordings are played.
    pub fn speech(&self, references: &str, options: &str, from: &str) -> Result<Speech, JsError> {
        let SpeechOptions { companions, along, recorded } = serde_json::from_str(options)?;
        let from: Option<scriptura::Place> = if from.is_empty() { None } else { Some(serde_json::from_str(from)?) };
        let references = parse_references(references)?;
        Ok(Speech(self.0.speech(&references, &companions, along, from.as_ref(), recorded.as_deref())))
    }
}

#[wasm_bindgen]
impl Speech {
    /// The next part, in JSON – `{"speak": utterance}` or `{"play": take}` – where an utterance is
    /// at most `limit` UTF-16 code units long, cut at a sentence end; none after the last.
    #[wasm_bindgen(js_name = nextJson)]
    pub fn next_json(&mut self, limit: u32) -> Option<String> {
        self.0.next(limit as usize).map(|part| serde_json::to_string(&part).expect("parts serialize"))
    }
}

/// The options of `blocksJson`, from their JSON: see `Library::blocks_json`.
fn core_options(options: &str) -> Result<scriptura::Options, serde_json::Error> {
    let Options {
        font_size,
        verse_per_line,
        companions,
        notes,
        drop_caps,
        mark_notes,
        lexicon,
        lexicon_books,
        linked_books,
        marked_number,
    } = serde_json::from_str(options)?;
    let notes = match notes.as_str() {
        "none" => scriptura::Notes::None,
        "inline" => scriptura::Notes::Inline,
        _ => scriptura::Notes::Marks,
    };
    let mark_notes = if mark_notes == "inline" { scriptura::MarkNotes::Inline } else { scriptura::MarkNotes::Sign };
    let lexicon = match lexicon.as_str() {
        "none" => scriptura::LexiconUse::None,
        "numbers" => scriptura::LexiconUse::Numbers,
        _ => scriptura::LexiconUse::Entries,
    };
    Ok(scriptura::Options {
        font_size,
        verse_per_line,
        companions,
        notes,
        drop_caps,
        mark_notes,
        lexicon,
        lexicon_books,
        linked_books,
        marked_number,
    })
}

fn parse_references(json: &str) -> Result<Vec<scriptura::Reference>, serde_json::Error> {
    let references: Vec<Reference> = serde_json::from_str(json)?;
    Ok(references
        .into_iter()
        .map(|Reference { book, chapter, from, to }| scriptura::Reference { book, chapter, from, to })
        .collect())
}
