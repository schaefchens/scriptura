//! The books a host gives the library, and the recordings of their chapters, as JSON: arrays in
//! the shapes below, with camelCase names. The import tool, `bindings/js/import.mjs`, writes books
//! from USFM, OSIS and Tanzil's text, and recordings from recitations whose words were timed.

use serde::Deserialize;

/// A book of a scripture in one edition: a book of the Bible in one translation, or a surah.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// Unique among the books of a library.
    pub id: String,
    /// The book's USFM code, such as JON, which all its editions share and by which they are read
    /// along; none for a book without editions to read along, such as a surah.
    pub code: Option<String>,
    /// The book's and its edition's names, in the book's own language.
    pub title: String,
    pub work: String,
    /// "ltr" or "rtl".
    pub direction: String,
    /// A BCP 47 tag, so screen readers pick the right voice. Biblical Hebrew and Koine Greek go by
    /// the modern languages' tags, he and el: there are no voices for hbo or grc.
    pub language: String,
    /// The font family the book asks to be set in, as a surah does for the marks of its script.
    pub font: Option<String>,
    #[serde(default)]
    pub verse_numbers: VerseNumbers,
    /// What comes before a number written after its verse, such as the end-of-ayah sign U+06DD that
    /// a font draws around the digits after it.
    #[serde(default)]
    pub verse_number_prefix: String,
    pub chapters: Vec<Chapter>,
}

/// Where a verse's number stands: before the verse, as in Bibles, or after it, as in a mushaf.
#[derive(Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VerseNumbers {
    #[default]
    Start,
    End,
}

#[derive(Deserialize, Debug)]
pub struct Chapter {
    pub number: u32,
    /// The number as the book writes it, such as ٢ in Arabic-Indic digits.
    pub label: String,
    pub verses: Vec<Verse>,
}

/// A verse. Number 0 holds unnumbered text before verse 1, such as the basmala opening a surah.
#[derive(Deserialize, Debug)]
pub struct Verse {
    pub number: u32,
    /// The number as the book writes it; empty for none, as for verse 0.
    pub label: String,
    /// Its chapter and number as the KJV counts them, where they differ, so editions that number
    /// otherwise can be read along: Jonah 2:1 in the Hebrew is 1:17 in the KJV. 0 is for what the
    /// KJV leaves unnumbered, such as a psalm's title.
    #[serde(default)]
    pub kjv: Option<(u32, u32)>,
    /// The text in runs, each with its role, if it has one: "ketiv" for a word as written where
    /// another is read, or a tajweed rule. The reader colors a run by its role.
    pub runs: Vec<(String, Option<String>)>,
}

/// A chapter read aloud: its audio, and where each of its verses and their words start in it, in
/// milliseconds. A word ends where the next starts, and a verse where the next verse does, or with
/// the audio: there are no end times. What precedes the first verse, such as a heading read or an
/// opening formula, plays only as the chapter is read from its start.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    /// Unique among the recordings of a library.
    pub id: String,
    /// Who reads it, as the host names them: a reciter, a narrator, a voice it was rendered in.
    pub voice: String,
    /// The book, by id, and the chapter of it that it reads.
    pub book: String,
    pub chapter: u32,
    /// Where its audio is: a URI, or one relative to where the recordings came from.
    pub audio: String,
    /// What a word is to its timings: the version of the core's [`WORD_DEFINITION`](crate::WORD_DEFINITION)
    /// they count words in.
    pub word_definition: u32,
    /// Every verse of the chapter, in order.
    pub verses: Vec<RecordedVerse>,
}

/// A verse of a recording: where it starts, and where each of its words does.
#[derive(Deserialize, Debug, Clone)]
pub struct RecordedVerse {
    pub number: u32,
    pub start: u32,
    pub words: Vec<u32>,
}
