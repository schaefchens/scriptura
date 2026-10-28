//! Scriptura for the web, through wasm-bindgen: a library of books in the page, and passages of them
//! as paragraphs for its reader. Books and paragraphs cross as JSON, which a browser parses faster
//! than it takes objects built field by field.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct Library(scriptura::Library);

/// What a voice says of passages, utterance by utterance: see `scriptura::Speech`.
#[wasm_bindgen]
pub struct Speech(scriptura::Speech);

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
}

#[derive(Deserialize)]
struct SpeechOptions {
    #[serde(default)]
    companions: Vec<String>,
    #[serde(default)]
    along: bool,
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

    /// The passages – a JSON array of references – as paragraphs, in JSON. `options` is JSON too:
    /// fontSize, versePerLine and companions.
    #[wasm_bindgen(js_name = blocksJson)]
    pub fn blocks_json(&self, references: &str, options: &str) -> Result<String, JsError> {
        let Options { font_size, verse_per_line, companions } = serde_json::from_str(options)?;
        let options = scriptura::Options { font_size, verse_per_line, companions };
        Ok(serde_json::to_string(&self.0.blocks(&parse_references(references)?, &options))?)
    }

    /// What a voice says of the passages – a JSON array of references – from a word's place, in
    /// JSON, or from the start if it is empty. `options` is JSON too: companions, and whether each
    /// verse is spoken in every book read along.
    pub fn speech(&self, references: &str, options: &str, from: &str) -> Result<Speech, JsError> {
        let SpeechOptions { companions, along } = serde_json::from_str(options)?;
        let from: Option<scriptura::Place> = if from.is_empty() { None } else { Some(serde_json::from_str(from)?) };
        Ok(Speech(self.0.speech(&parse_references(references)?, &companions, along, from.as_ref())))
    }
}

#[wasm_bindgen]
impl Speech {
    /// The next utterance, in JSON, at most `limit` UTF-16 code units long, cut at a sentence end;
    /// none after the last.
    #[wasm_bindgen(js_name = nextJson)]
    pub fn next_json(&mut self, limit: u32) -> Option<String> {
        self.0.next(limit as usize).map(|utterance| serde_json::to_string(&utterance).expect("utterances serialize"))
    }
}

fn parse_references(json: &str) -> Result<Vec<scriptura::Reference>, serde_json::Error> {
    let references: Vec<Reference> = serde_json::from_str(json)?;
    Ok(references
        .into_iter()
        .map(|Reference { book, chapter, from, to }| scriptura::Reference { book, chapter, from, to })
        .collect())
}
