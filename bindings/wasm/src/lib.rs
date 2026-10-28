//! Scriptura for the web, through wasm-bindgen: a library of books in the page, and passages of them
//! as paragraphs for its reader. Books and paragraphs cross as JSON, which a browser parses faster
//! than it takes objects built field by field.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct Library(scriptura::Library);

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
        let references: Vec<Reference> = serde_json::from_str(references)?;
        let Options { font_size, verse_per_line, companions } = serde_json::from_str(options)?;
        let references: Vec<_> = references
            .into_iter()
            .map(|Reference { book, chapter, from, to }| scriptura::Reference { book, chapter, from, to })
            .collect();
        let blocks = self.0.blocks(&references, &scriptura::Options { font_size, verse_per_line, companions });
        Ok(serde_json::to_string(&blocks)?)
    }
}
