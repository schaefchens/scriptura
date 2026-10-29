use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::reader::words_of;
use crate::{Block, Book, Library, Options, Recording, Reference, VerseNumbers, Word};

/// Where a word stands: in which passage of a request, in which book – the passage's, or one read
/// along with it – and where in the scripture: its chapter, its verse, and which word of the verse.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Place {
    pub passage: u32,
    pub book: String,
    pub chapter: u32,
    pub verse: u32,
    pub word: u32,
}

/// Text for a voice, in one language: a chapter's heading, spoken on its own, or verses of a
/// passage's book, word after word, without their numbers.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Utterance {
    pub passage: u32,
    pub book: String,
    pub language: String,
    pub heading: bool,
    pub text: String,
    /// Each word where it stands, and its range in `text`, in UTF-16 code units, as voices report
    /// the words they speak. A heading has none.
    pub words: Vec<Word>,
}

/// Verses of a passage's book played from a recording of their chapter: from `start` to `end` in
/// its audio, in milliseconds – or to the audio's end, without an end – with each word where it
/// stands and where it starts in the audio.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Take {
    pub passage: u32,
    pub book: String,
    /// The recording's: who reads, and where its audio is.
    pub voice: String,
    pub audio: String,
    pub start: u32,
    pub end: Option<u32>,
    pub words: Vec<TimedWord>,
}

/// A word where it stands, and where it starts in a recording, in milliseconds.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TimedWord {
    pub chapter: u32,
    pub verse: u32,
    pub index: u32,
    pub start: u32,
}

/// What is read aloud next: an utterance for the device's voice, or a take from a recording.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Speak(Utterance),
    Play(Take),
}

/// What is read aloud of passages, part by part. A chapter with a recording is played from it;
/// a voice on the device says the rest, utterance by utterance: each chapter's heading on its own,
/// then its verses, as the core's words – no verse numbers, no word written but not read, no mark
/// standing alone, Hebrew without its cantillation marks. Voices plan their intonation sentence by
/// sentence, so the verses are cut only at sentence ends, into utterances as long as a voice takes;
/// a sentence longer than that at a clause. Each passage and book is spoken in its language. Read
/// along with other books, by default only the passage's own book is read; `along`, each verse is
/// followed by the same verse in each of them.
pub struct Speech {
    stretches: Vec<Stretch>,
    /// The recordings that stretches are played from.
    recordings: Vec<Recording>,
    /// Where the next part starts: a stretch, and a word of it.
    at: (usize, usize),
}

/// A heading, or verses that follow each other in one passage, book and language, and either
/// played from one recording or not.
struct Stretch {
    passage: u32,
    book: String,
    language: String,
    heading: Option<String>,
    words: Vec<Spoken>,
    /// The recording it is played from, as its index in the speech's.
    recording: Option<usize>,
}

/// A word as spoken, and where it stands: in the scripture, and in which row its book is read along.
struct Spoken {
    chapter: u32,
    verse: u32,
    index: u32,
    row: u32,
    text: String,
    /// What is said after it, before the next: a verse's stop in a mushaf.
    after: &'static str,
    pause: Pause,
}

impl Spoken {
    fn length(&self) -> usize {
        utf16(&self.text) + utf16(self.after)
    }
}

/// What a voice makes of a word's end: a sentence ends there, or a clause, or only the word.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
enum Pause {
    Word,
    Clause,
    Sentence,
}

impl Speech {
    pub(crate) fn new(
        library: &Library,
        references: &[Reference],
        companions: &[String],
        along: bool,
        from: Option<&Place>,
        recorded: Option<&[String]>,
    ) -> Speech {
        let options = Options { font_size: 1.0, verse_per_line: false, companions: companions.to_vec() };
        let blocks = library.blocks(references, &options);
        let mut recordings = Recordings { library, voices: recorded, chapters: HashMap::new(), chosen: Vec::new() };
        let mut stretches: Vec<Stretch> = Vec::new();
        // Where `from` is spoken – or, in a book not spoken, the row it stands in.
        let mut start = None;
        let mut beside = None;
        for (at, block) in blocks.iter().enumerate() {
            let spoken = along || block.column == 0;
            if block.kind == "heading" {
                if let Some(text) = spoken.then(|| heading(library, block, &blocks[at + 1..])).flatten() {
                    stretches.push(Stretch::of(block, Some(text), None));
                }
                continue;
            }
            if !spoken {
                beside = beside.or(from.filter(|place| block.holds(place)).map(|_| (block.passage, block.row)));
                continue;
            }
            let Some(book) = library.book(&block.book).filter(|_| !block.words.is_empty()) else { continue };
            let text: Vec<u16> = block.segments.iter().flat_map(|segment| segment.text.encode_utf16()).collect();
            for (index, word) in block.words.iter().enumerate() {
                let recording = recordings.of(book, word.chapter);
                let follows = stretches.last().is_some_and(|last| {
                    last.heading.is_none()
                        && last.recording == recording
                        && (last.passage, &last.book, &last.language) == (block.passage, &block.book, &block.language)
                });
                if !follows {
                    stretches.push(Stretch::of(block, None, recording));
                }
                let at = stretches.len() - 1;
                let stretch = &mut stretches[at];
                if from.is_some_and(|place| block.place(word) == *place) {
                    start = Some((at, stretch.words.len()));
                }
                let text = speakable(
                    &String::from_utf16_lossy(&text[word.start as usize..word.end as usize]),
                    &block.language,
                );
                let mut pause = pause_after(&text, &block.language);
                let mut after = "";
                // In a mushaf, each verse ends at a stop, which its end-of-ayah sign marks.
                let last = block.words.get(index + 1).is_none_or(|next| next.verse != word.verse);
                if book.verse_numbers == VerseNumbers::End && last && pause < Pause::Sentence {
                    (pause, after) = (Pause::Sentence, ".");
                }
                let (chapter, verse, index, row) = (word.chapter, word.verse, word.index, block.row);
                stretch.words.push(Spoken { chapter, verse, index, row, text, after, pause });
            }
        }
        // A recording reads its chapter's verses without their heading.
        for at in 0..stretches.len() {
            let (passage, book) = (stretches[at].passage, &stretches[at].book);
            let verses = stretches[at + 1..]
                .iter()
                .find(|other| other.heading.is_none() && other.passage == passage && other.book == *book);
            if verses.is_some_and(|verses| verses.recording.is_some()) {
                stretches[at].heading = None;
            }
        }
        // A word of a book not spoken starts the reading at the passage's own verse in its row.
        let start = start.or_else(|| {
            let (passage, row) = beside?;
            stretches.iter().enumerate().find_map(|(at, stretch)| {
                let word = stretch.words.iter().position(|word| word.row >= row)?;
                (stretch.passage == passage).then_some((at, word))
            })
        });
        Speech { stretches, recordings: recordings.chosen, at: start.unwrap_or((0, 0)) }
    }

    /// The next part: a take of a recording, or an utterance at most `limit` UTF-16 code units long
    /// – or a single word longer than that – cut at the last sentence end within it, or else at a
    /// clause; none after the last.
    pub fn next(&mut self, limit: usize) -> Option<Part> {
        let (mut at, mut first) = self.at;
        // Past what is left with nothing to say: a heading a recording reads.
        while self.stretches.get(at).is_some_and(|stretch| stretch.heading.is_none() && first >= stretch.words.len()) {
            (at, first) = (at + 1, 0);
        }
        let stretch = self.stretches.get(at)?;
        if let Some(recording) = stretch.recording {
            self.at = (at + 1, 0);
            return Some(Part::Play(self.take(at, first, recording)));
        }
        let mut utterance = Utterance {
            passage: stretch.passage,
            book: stretch.book.clone(),
            language: stretch.language.clone(),
            heading: stretch.heading.is_some(),
            text: stretch.heading.clone().unwrap_or_default(),
            words: Vec::new(),
        };
        if stretch.heading.is_some() {
            self.at = (at + 1, 0);
            return Some(Part::Speak(utterance));
        }
        let words = &stretch.words;
        // The words that fit, a space between each two.
        let mut length = 0;
        let mut end = first;
        while let Some(word) = words.get(end) {
            let more = word.length() + usize::from(end > first);
            if end > first && length + more > limit {
                break;
            }
            length += more;
            end += 1;
        }
        if end < words.len() {
            let cut = |pause| (first..end).rev().find(|&index| words[index].pause >= pause).map(|index| index + 1);
            end = cut(Pause::Sentence).or_else(|| cut(Pause::Clause)).unwrap_or(end);
        }
        let mut offset = 0;
        for word in &words[first..end] {
            if offset > 0 {
                utterance.text.push(' ');
                offset += 1;
            }
            let start = offset;
            offset += utf16(&word.text) as u32;
            utterance.words.push(Word {
                chapter: word.chapter,
                verse: word.verse,
                index: word.index,
                start,
                end: offset,
            });
            utterance.text.push_str(&word.text);
            utterance.text.push_str(word.after);
            offset += utf16(word.after) as u32;
        }
        self.at = if end == words.len() { (at + 1, 0) } else { (at, end) };
        Some(Part::Speak(utterance))
    }

    /// The stretch at `at`, from its word `first`, played from its recording: from the start of the
    /// audio if it reads the chapter from its start, else from the verse's start, or the word's;
    /// up to where the verse after its last starts.
    fn take(&self, at: usize, first: usize, recording: usize) -> Take {
        let stretch = &self.stretches[at];
        let recording = &self.recordings[recording];
        let words = &stretch.words[first..];
        // A recording fits only if it has every verse of the chapter.
        let verse = |number: u32| recording.verses.iter().position(|verse| verse.number == number).unwrap_or_default();
        let start_of = |word: &Spoken| recording.verses[verse(word.verse)].words[word.index as usize];
        let opening = &words[0];
        let start = match verse(opening.verse) {
            0 if first == 0 && opening.index == 0 => 0,
            at if opening.index == 0 => recording.verses[at].start,
            _ => start_of(opening),
        };
        let last = verse(words[words.len() - 1].verse);
        Take {
            passage: stretch.passage,
            book: stretch.book.clone(),
            voice: recording.voice.clone(),
            audio: recording.audio.clone(),
            start,
            end: recording.verses.get(last + 1).map(|verse| verse.start),
            words: (words.iter())
                .map(|word| TimedWord {
                    chapter: word.chapter,
                    verse: word.verse,
                    index: word.index,
                    start: start_of(word),
                })
                .collect(),
        }
    }
}

impl Stretch {
    fn of(block: &Block, heading: Option<String>, recording: Option<usize>) -> Stretch {
        let (passage, book, language) = (block.passage, block.book.clone(), block.language.clone());
        Stretch { passage, book, language, heading, words: Vec::new(), recording }
    }
}

/// The recordings a speech plays its chapters from: for each chapter, the first of the voices asked
/// for – or with none asked for, of any – that recorded it whole, counting its words as the core does.
struct Recordings<'a> {
    library: &'a Library,
    voices: Option<&'a [String]>,
    /// Each chapter's, by book and chapter number, as its index in `chosen`.
    chapters: HashMap<(String, u32), Option<usize>>,
    chosen: Vec<Recording>,
}

impl Recordings<'_> {
    fn of(&mut self, book: &Book, chapter: u32) -> Option<usize> {
        let key = (book.id.clone(), chapter);
        if let Some(&found) = self.chapters.get(&key) {
            return found;
        }
        let all = self.library.recordings();
        let fitting =
            |recording: &&Recording| recording.book == book.id && recording.chapter == chapter && fits(recording, book);
        let found = match self.voices {
            None => all.iter().find(fitting),
            Some(voices) => {
                voices.iter().find_map(|voice| all.iter().filter(|recording| recording.voice == *voice).find(fitting))
            }
        };
        let found = found.map(|recording| {
            self.chosen.push(recording.clone());
            self.chosen.len() - 1
        });
        self.chapters.insert(key, found);
        found
    }
}

/// Whether a recording has every verse of its chapter, each with as many words as the core counts.
fn fits(recording: &Recording, book: &Book) -> bool {
    let Some(chapter) = book.chapters.iter().find(|chapter| chapter.number == recording.chapter) else { return false };
    chapter.verses.len() == recording.verses.len()
        && chapter
            .verses
            .iter()
            .zip(&recording.verses)
            .all(|(verse, recorded)| verse.number == recorded.number && words_of(verse).len() == recorded.words.len())
}

impl Block {
    fn place(&self, word: &Word) -> Place {
        let (passage, book) = (self.passage, self.book.clone());
        Place { passage, book, chapter: word.chapter, verse: word.verse, word: word.index }
    }

    fn holds(&self, place: &Place) -> bool {
        self.words.iter().any(|word| self.place(word) == *place)
    }
}

/// A heading as spoken: its book's title and the chapter – the chapter of the next verse of its
/// book – or for a book of one chapter, such as a surah, the title alone. None for a heading no
/// verse follows.
fn heading(library: &Library, block: &Block, after: &[Block]) -> Option<String> {
    let book = library.book(&block.book)?;
    let verses = after
        .iter()
        .find(|next| next.passage == block.passage && next.book == block.book && !next.verses.is_empty())?;
    let chapter = book.chapters.iter().find(|chapter| chapter.number == verses.verses[0].chapter)?;
    Some(if book.chapters.len() == 1 { book.title.clone() } else { format!("{} {}", book.title, chapter.label) })
}

/// A word as a voice is to say it. Hebrew goes without its cantillation marks, the accents that
/// guide chanting, and the meteg among them: Google's Hebrew voice read about a word a second with
/// them, Apple's ignore them. Its vowel points stay.
fn speakable(word: &str, language: &str) -> String {
    match language {
        "he" => word.chars().filter(|char| !matches!(char, '\u{591}'..='\u{5af}' | '\u{5bd}')).collect(),
        _ => word.into(),
    }
}

/// What ends a word: a sentence's end, such as a full stop or the Hebrew sof pasuq – or ";", the
/// Greek question mark – or a clause's, such as a comma; quotation marks and brackets after it
/// don't count.
fn pause_after(word: &str, language: &str) -> Pause {
    let closing = |char: char| matches!(char, '"' | '\'' | '”' | '’' | '»' | '›' | ')' | ']' | '}' | '\u{5c6}');
    match word.trim_end_matches(closing).chars().last() {
        Some('.' | '!' | '?' | '…' | '؟' | '۔' | '\u{5c3}' | '։' | '।' | '॥' | '。' | '！' | '？') => {
            Pause::Sentence
        }
        Some(';' | '\u{37e}') if language == "el" => Pause::Sentence,
        Some(',' | ';' | ':' | '·' | '\u{387}' | '،' | '؛' | '—' | '–') => Pause::Clause,
        _ => Pause::Word,
    }
}

fn utf16(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use super::*;

    static LIBRARY: LazyLock<Library> = LazyLock::new(|| {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).expect("the fixtures are valid");
        library
    });

    /// The same books, and recordings of Al-Fatiha in two voices and of the start of Al-Baqarah.
    static RECORDED: LazyLock<Library> = LazyLock::new(|| {
        let mut library = Library::new();
        library.add(include_bytes!("../tests/fixtures/books.json")).expect("the fixtures are valid");
        let recordings = include_bytes!("../tests/fixtures/recordings.json");
        library.add_recordings(recordings, Some("file:///recordings/")).expect("the fixtures are valid");
        library
    });

    fn reference(book: &str, chapter: Option<u32>, from: Option<u32>, to: Option<u32>) -> Reference {
        Reference { book: book.into(), chapter, from, to }
    }

    fn speech(references: &[Reference], companions: &[&str], along: bool, from: Option<&Place>) -> Speech {
        let companions: Vec<String> = companions.iter().map(|id| id.to_string()).collect();
        LIBRARY.speech(references, &companions, along, from, None)
    }

    /// The utterances, each at most `limit` long, to the end – of a speech without recordings.
    fn all(speech: Speech, limit: usize) -> Vec<Utterance> {
        let parts = parts(speech, limit);
        parts
            .into_iter()
            .map(|part| if let Part::Speak(utterance) = part { utterance } else { panic!("{part:?}") })
            .collect()
    }

    fn parts(mut speech: Speech, limit: usize) -> Vec<Part> {
        std::iter::from_fn(|| speech.next(limit)).collect()
    }

    /// What is read aloud with the recordings, by the voices `recorded`, or any.
    fn recorded(references: &[Reference], from: Option<&Place>, recorded: Option<&[&str]>) -> Vec<Part> {
        let recorded: Option<Vec<String>> =
            recorded.map(|voices| voices.iter().map(|voice| voice.to_string()).collect());
        parts(RECORDED.speech(references, &[], false, from, recorded.as_deref()), 4000)
    }

    fn take(part: &Part) -> &Take {
        let Part::Play(take) = part else { panic!("{part:?}") };
        take
    }

    fn texts(utterances: &[Utterance]) -> Vec<&str> {
        utterances.iter().map(|utterance| utterance.text.as_str()).collect()
    }

    fn cut(utterance: &Utterance, word: &Word) -> String {
        let text: Vec<u16> = utterance.text.encode_utf16().collect();
        String::from_utf16(&text[word.start as usize..word.end as usize]).unwrap()
    }

    fn place(passage: u32, book: &str, chapter: u32, verse: u32, word: u32) -> Place {
        Place { passage, book: book.into(), chapter, verse, word }
    }

    #[test]
    fn a_heading_is_spoken_on_its_own_and_verses_without_numbers() {
        let spoken = all(speech(&[reference("jonah", Some(1), Some(16), Some(17))], &[], false, None), 4000);
        assert_eq!(texts(&spoken)[0], "Jonah 1");
        assert!(spoken[0].heading && spoken[0].words.is_empty());
        assert!(spoken[1].text.starts_with("Then the men feared Yahweh exceedingly"), "{}", spoken[1].text);
        assert!(!spoken[1].text.contains("16") && !spoken[1].text.contains("17"));
        // A surah, a book of one chapter, is spoken by its title.
        assert_eq!(all(speech(&[reference("quran-1", None, None, None)], &[], false, None), 4000)[0].text, "الفاتحة");
    }

    #[test]
    fn the_words_are_the_cores_with_their_places() {
        let blocks = LIBRARY.blocks(
            &[reference("jonah", Some(2), None, None)],
            &Options { font_size: 28.0, verse_per_line: true, companions: Vec::new() },
        );
        let spoken = all(speech(&[reference("jonah", Some(2), None, None)], &[], false, None), 4000);
        let words: Vec<(u32, u32, u32, String)> = spoken
            .iter()
            .flat_map(|utterance| {
                utterance.words.iter().map(|word| (word.chapter, word.verse, word.index, cut(utterance, word)))
            })
            .collect();
        let expected: Vec<(u32, u32, u32, String)> = blocks
            .iter()
            .flat_map(|block| {
                let text: Vec<u16> = block.segments.iter().flat_map(|segment| segment.text.encode_utf16()).collect();
                block.words.iter().map(move |word| {
                    let cut = String::from_utf16(&text[word.start as usize..word.end as usize]).unwrap();
                    (word.chapter, word.verse, word.index, cut)
                })
            })
            .collect();
        assert_eq!(words, expected);
        // A word written but not read isn't spoken, nor is a mark standing alone.
        let psalm = all(speech(&[reference("psalms-he", Some(5), Some(9), Some(9))], &[], false, None), 4000);
        assert!(!psalm[1].text.contains("(הושר)"));
        let jonah = all(speech(&[reference("jonah-he", Some(1), Some(3), Some(3))], &[], false, None), 4000);
        assert!(!jonah[1].text.contains('\u{5c0}'));
    }

    #[test]
    fn utterances_are_cut_at_sentence_ends() {
        // Jonah 2 has 1,000 characters: at most 400 each, three utterances, each ending a sentence.
        let spoken = all(speech(&[reference("jonah", Some(2), None, None)], &[], false, None), 400);
        assert_eq!(spoken.len(), 4);
        for utterance in &spoken[1..] {
            assert!(utf16(&utterance.text) <= 400, "{}", utterance.text);
            assert_eq!(pause_after(&utterance.text, "en"), Pause::Sentence, "{}", utterance.text);
        }
        // Spoken whole, it is the same text.
        let whole = all(speech(&[reference("jonah", Some(2), None, None)], &[], false, None), 4000);
        assert_eq!(whole.len(), 2);
        assert_eq!(whole[1].text, texts(&spoken[1..]).join(" "));
        // A sentence longer than the limit is cut at a clause, or else between words.
        let short = all(speech(&[reference("jonah", Some(1), Some(17), Some(17))], &[], false, None), 60);
        assert_eq!(
            texts(&short)[1..],
            [
                "Yahweh prepared a huge fish to swallow up Jonah,",
                "and Jonah was in the belly of the fish three days and three",
                "nights."
            ]
        );
    }

    #[test]
    fn a_mushaf_stops_at_every_verse_end() {
        let fatiha = all(speech(&[reference("quran-1", None, None, None)], &[], false, None), 4000);
        assert_eq!(fatiha[1].text.matches(". ").count(), 6);
        assert!(fatiha[1].text.ends_with('.'));
        // The stop is said, but isn't part of the word: the basmala's last.
        let word = &fatiha[1].words[3];
        assert_eq!((word.verse, word.index), (1, 3));
        assert!(!cut(&fatiha[1], word).ends_with('.'));
        assert_eq!(fatiha[1].text.encode_utf16().nth(word.end as usize), Some(u16::from(b'.')));
    }

    #[test]
    fn hebrew_is_spoken_without_its_cantillation() {
        let jonah = all(speech(&[reference("jonah-he", Some(1), Some(1), Some(1))], &[], false, None), 4000);
        let text = &jonah[1].text;
        assert!(!text.chars().any(|char| ('\u{591}'..='\u{5af}').contains(&char) || char == '\u{5bd}'), "{text}");
        // The points stay, and so does the sof pasuq, which ends the sentence.
        assert!(text.contains('\u{5b0}') && text.ends_with('\u{5c3}'));
        let words: Vec<String> = jonah[1].words.iter().map(|word| cut(&jonah[1], word)).collect();
        assert_eq!(words.join(" "), *text);
    }

    #[test]
    fn hebrew_and_greek_sentences_end_their_own_way() {
        assert_eq!(pause_after("לֵאמֹֽר׃", "he"), Pause::Sentence);
        assert_eq!(pause_after("αὐτοῦ;", "el"), Pause::Sentence);
        assert_eq!(pause_after("him;", "en"), Pause::Clause);
        assert_eq!(pause_after("αὐτοῦ·", "el"), Pause::Clause);
        assert_eq!(pause_after("me.”", "en"), Pause::Sentence);
        assert_eq!(pause_after("قَائِلًا:", "ar"), Pause::Clause);
    }

    #[test]
    fn reading_starts_at_a_word() {
        let from = place(0, "jonah", 1, 17, 3);
        let spoken = all(speech(&[reference("jonah", Some(1), Some(16), Some(17))], &[], false, Some(&from)), 4000);
        assert!(!spoken[0].heading);
        assert_eq!((spoken[0].words[0].verse, spoken[0].words[0].index), (17, 3));
        assert_eq!(cut(&spoken[0], &spoken[0].words[0]), "huge");
        // The next passage's heading follows.
        let references =
            [reference("jonah", Some(1), Some(17), Some(17)), reference("jonah", Some(2), Some(1), Some(1))];
        let spoken = all(speech(&references, &[], false, Some(&place(0, "jonah", 1, 17, 0))), 4000);
        assert_eq!(texts(&spoken)[1], "Jonah 2");
        assert_eq!(spoken[2].passage, 1);
    }

    #[test]
    fn read_along_only_the_passages_book_is_spoken_or_each_verse_in_each() {
        let references = [reference("jonah", Some(2), Some(1), Some(2))];
        let leading = all(speech(&references, &["jonah-he", "jonah-de"], false, None), 4000);
        assert_eq!(leading.iter().map(|utterance| utterance.book.as_str()).collect::<Vec<_>>(), ["jonah", "jonah"]);
        let along = all(speech(&references, &["jonah-he", "jonah-de"], true, None), 4000);
        let spoken: Vec<(&str, bool)> =
            along.iter().map(|utterance| (utterance.book.as_str(), utterance.heading)).collect();
        // The headings of the row, then verse by verse in each book: the Hebrew numbers the verses
        // 2:2 and 2:3.
        assert_eq!(
            spoken,
            [
                ("jonah", true),
                ("jonah-he", true),
                ("jonah-de", true),
                ("jonah", false),
                ("jonah-he", false),
                ("jonah-de", false),
                ("jonah", false),
                ("jonah-he", false),
                ("jonah-de", false),
            ]
        );
        assert_eq!((along[1].text.as_str(), along[1].language.as_str()), ("יונה 2", "he"));
        // A word of a book not spoken starts the reading at the passage's verse beside it.
        let beside = all(speech(&references, &["jonah-de"], false, Some(&place(0, "jonah-de", 2, 2, 4))), 4000);
        assert_eq!((beside[0].book.as_str(), beside[0].words[0].verse, beside[0].words[0].index), ("jonah", 2, 0));
    }

    #[test]
    fn a_chapter_recorded_is_played_whole_without_its_heading() {
        let fatiha = recorded(&[reference("quran-1", None, None, None)], None, None);
        assert_eq!(fatiha.len(), 1);
        let take = take(&fatiha[0]);
        assert_eq!((take.voice.as_str(), take.audio.as_str()), ("Reciter", "file:///recordings/reciter/quran-1.mp3"));
        assert_eq!((take.start, take.end, take.words.len()), (0, None, 29));
        let word = &take.words[5];
        assert_eq!((word.chapter, word.verse, word.index, word.start), (1, 2, 1, 6900));
    }

    #[test]
    fn verses_play_from_their_start_to_the_next_verse_and_a_word_from_its_own() {
        let verses = recorded(&[reference("quran-1", None, Some(2), Some(3))], None, None);
        let verses = take(&verses[0]);
        assert_eq!((verses.start, verses.end, verses.words.len()), (6000, Some(18000), 6));
        let from = place(0, "quran-1", 1, 7, 2);
        let rest = recorded(&[reference("quran-1", None, None, None)], Some(&from), None);
        let rest = take(&rest[0]);
        assert_eq!((rest.start, rest.end, rest.words[0].index), (37500, None, 2));
    }

    #[test]
    fn the_first_voice_asked_for_reads_and_without_one_the_devices() {
        let fatiha = [reference("quran-1", None, None, None)];
        assert_eq!(take(&recorded(&fatiha, None, Some(&["Nobody", "Other", "Reciter"]))[0]).voice, "Other");
        assert_eq!(take(&recorded(&fatiha, None, Some(&["Other"]))[0]).audio, "https://example.org/other/quran-1.mp3");
        let spoken = recorded(&fatiha, None, Some(&[]));
        assert!(matches!(&spoken[..], [Part::Speak(heading), Part::Speak(_)] if heading.heading));
    }

    #[test]
    fn a_recording_that_counts_other_words_is_not_played() {
        // Its verse 255 has three words, not fifty.
        let baqarah = recorded(&[reference("quran-2", None, None, None)], None, None);
        assert!(baqarah.iter().all(|part| matches!(part, Part::Speak(_))), "{baqarah:?}");
    }

    #[test]
    fn a_reading_list_mixes_the_devices_voice_and_recordings() {
        let list = [reference("jonah", Some(1), Some(17), Some(17)), reference("quran-1", None, Some(7), Some(7))];
        let parts = recorded(&list, None, None);
        let kinds: Vec<_> = parts
            .iter()
            .map(|part| match part {
                Part::Speak(utterance) => {
                    (utterance.book.as_str(), if utterance.heading { "heading" } else { "verses" })
                }
                Part::Play(take) => (take.book.as_str(), "take"),
            })
            .collect();
        assert_eq!(kinds, [("jonah", "heading"), ("jonah", "verses"), ("quran-1", "take")]);
        assert_eq!((take(&parts[2]).start, take(&parts[2]).end), (36000, None));
    }
}
