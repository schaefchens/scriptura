//! The books a host gives the library, and the recordings of their chapters, as JSON: arrays in
//! the shapes below, with camelCase names. The import tool, `bindings/js/import.mjs`, writes books
//! from USFM, OSIS and Tanzil's text, and recordings from recitations whose words were timed.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

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
    /// The edition's notes on the verse, each where it stands in the verse's text.
    #[serde(default)]
    pub notes: Vec<Note>,
    /// The words its source tags, each where it stands in the text with its number in a lexicon –
    /// Strong's, as editions tag their words – and its grammar, where the source gives it.
    #[serde(default)]
    pub tags: Vec<WordTag>,
}

/// A word as its source tags it: where it starts in the verse's text, in UTF-16 code units, and its
/// parts, which follow one another from there – a Hebrew word's prefixes, its stem and its suffix,
/// or the word whole. A word of the core may hold more than one, as two Hebrew words joined by a
/// maqaf do, and a tagged word may be less than one, as "Yahweh" is of "Yahweh’s". As JSON, an
/// array: where it starts, then its parts – `[4, [6, "H3068"]]`, `[0, [3, null, "HC"], [6, "H1961",
/// "HVqw3ms"]]` – as books tag most of their words.
#[derive(Debug, Clone, PartialEq)]
pub struct WordTag {
    pub at: u32,
    pub parts: Vec<WordPart>,
}

impl WordTag {
    /// Where it ends in the verse's text, in UTF-16 code units.
    pub fn end(&self) -> u32 {
        self.at + self.parts.iter().map(|part| part.length).sum::<u32>()
    }
}

/// A part of a tagged word: how long it is, in UTF-16 code units; its entry in a lexicon, by
/// number, such as H1961 – none for a part the source gives none, as a Hebrew prefix or suffix –
/// and its grammar, by a code a lexicon spells out, such as HVqw3ms. As JSON, an array of the three,
/// those at its end left out where there are none.
#[derive(Debug, Clone, PartialEq)]
pub struct WordPart {
    pub length: u32,
    pub number: Option<String>,
    pub grammar: Option<String>,
}

impl<'de> Deserialize<'de> for WordTag {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Tag;
        impl<'de> serde::de::Visitor<'de> for Tag {
            type Value = WordTag;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a tag: where it starts, then its parts")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<WordTag, A::Error> {
                let at = seq.next_element()?.ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
                let mut parts = Vec::new();
                while let Some(part) = seq.next_element()? {
                    parts.push(part);
                }
                Ok(WordTag { at, parts })
            }
        }
        deserializer.deserialize_seq(Tag)
    }
}

impl<'de> Deserialize<'de> for WordPart {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Part;
        impl<'de> serde::de::Visitor<'de> for Part {
            type Value = WordPart;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a part of a tag: its length, number and grammar")
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<WordPart, A::Error> {
                let length = seq.next_element()?.ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
                let number = seq.next_element::<Option<String>>()?.flatten();
                let grammar = seq.next_element::<Option<String>>()?.flatten();
                Ok(WordPart { length, number, grammar })
            }
        }
        deserializer.deserialize_seq(Part)
    }
}

/// A lexicon that words' numbers lead to: its entries, and its grammar codes spelled out.
#[derive(Deserialize, Debug)]
pub struct Lexicon {
    /// Unique among the lexicons of a library.
    pub id: String,
    /// Its name, and where it comes from, as its license may ask to show.
    pub title: String,
    /// The language its glosses and definitions are written in, and its direction: "ltr", the
    /// default, or "rtl".
    pub language: String,
    #[serde(default = "left_to_right")]
    pub direction: String,
    pub entries: Vec<Entry>,
    /// Grammar codes, as words' parts give them, each spelled out: HVqw3ms as "Verb, Qal,
    /// consecutive imperfect, third person, masculine, singular".
    #[serde(default)]
    pub grammar: HashMap<String, String>,
}

fn left_to_right() -> String {
    "ltr".into()
}

/// An entry of a lexicon: its number, such as H1961 or G0976, the word it is about – as the lexicon
/// writes it, in its language – how that is read, what it means in a word or a few, and its
/// definition, in runs as notes have them, which may refer to verses.
#[derive(Deserialize, Debug, Clone)]
pub struct Entry {
    pub number: String,
    pub lemma: String,
    pub language: String,
    #[serde(default)]
    pub transliteration: Option<String>,
    pub gloss: String,
    #[serde(default)]
    pub definition: Vec<NoteRun>,
}

/// A note on a verse, as the edition has it: a footnote, an endnote or a cross reference. The
/// reader shows its mark in the text where it stands, and opens the note there.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Note {
    /// "footnote", "endnote" or "crossReference".
    pub kind: String,
    /// Its mark, as the edition numbers or letters its notes: "1", "a", "٣". A mark is no word.
    pub mark: String,
    /// Where it stands: after this many UTF-16 code units of the verse's text, as the runs have it.
    pub at: u32,
    pub runs: Vec<NoteRun>,
}

/// A run of a note's text, and what it is: its role, if it has one – "origin" (the verse the note
/// is on, as the note names it), "quotation" (words of the text), "emphasis", "label" – its
/// language, where it isn't the book's, and the verse it refers to, where it is a reference.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct NoteRun {
    pub text: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub target: Option<Target>,
}

/// A verse a note refers to: its book by USFM code, which the book's editions share, its chapter,
/// and its verse, or verses up to `to` – the whole chapter, without a verse.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct Target {
    pub book: String,
    pub chapter: u32,
    #[serde(default)]
    pub verse: Option<u32>,
    #[serde(default)]
    pub to: Option<u32>,
}

/// A mark a host keeps on a book: words or verses of it, by where they stand – never by their
/// text – with how it is drawn and a note. Readers draw it over the text wherever the book shows,
/// in every layout, report a tap on it by its id, and open its note where the mark ends.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Mark {
    /// Unique among the marks of a library.
    pub id: String,
    /// The book, by id, whose words it marks.
    pub book: String,
    /// From a word, or a whole verse, to another, both included.
    pub from: MarkEnd,
    pub to: MarkEnd,
    /// A color behind the words: one the reader's palette names, such as "yellow", or any color.
    #[serde(default)]
    pub highlight: Option<String>,
    /// A line under the words, in a color named or given the same way.
    #[serde(default)]
    pub underline: Option<String>,
    /// Its note, in runs as an edition's notes have them; none without. A sign where the mark
    /// ends opens it.
    #[serde(default)]
    pub note: Vec<NoteRun>,
}

/// An end of a mark: a word of a verse, by its index among the verse's words, or the whole verse,
/// without one.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
pub struct MarkEnd {
    pub chapter: u32,
    pub verse: u32,
    #[serde(default)]
    pub word: Option<u32>,
}

impl MarkEnd {
    /// Where a mark starts, in the order of the words: the word, or the verse's first.
    pub(crate) fn start(&self) -> (u32, u32, u32) {
        (self.chapter, self.verse, self.word.unwrap_or(0))
    }

    /// Where it ends: the word, or the verse's last.
    pub(crate) fn end(&self) -> (u32, u32, u32) {
        (self.chapter, self.verse, self.word.unwrap_or(u32::MAX))
    }
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
    /// Who reads it – a reciter, a narrator, a voice it was rendered in – by an id the host gives
    /// them, as a reader's recorded voices name them; and by the name to show, if it has one.
    pub voice: String,
    pub name: Option<String>,
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
