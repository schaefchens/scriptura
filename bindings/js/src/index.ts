import fonts from './fonts.json';

export { CONTRASTS, MARK_COLORS, type Palette, palette, ROLE_COLORS, type Theme } from './palette';

/** A whole book, one chapter of it, or a verse range in that chapter. */
export type Passage = { book: string; chapter?: number; from?: number; to?: number };

/** A book as a list shows it: what it is, not what it says. Editions of the same book share its code. */
export type BookInfo = {
  id: string;
  code?: string | null;
  title: string;
  work: string;
  language: string;
  direction: 'ltr' | 'rtl';
};

/**
 * A recording of a chapter, as a list shows it: whose voice it is – by the id recordedVoices names, and the name to show – which chapter
 * of which book it reads, and why it isn't played for it, if it isn't: the library holds no such book, or the book's verses or words
 * aren't the recording's.
 */
export type RecordingInfo = { id: string; voice: string; name?: string | null; book: string; chapter: number; misfit?: string | null };

/**
 * Where the reader's current word stands: the passage it belongs to, its book (the passage's, or
 * one read along with it) and its place in the scripture. Never its text.
 */
export type WordPosition = { passage: number; book: string; chapter: number; verse: number; word: number };

/** An end of a mark or a selection: a word of a verse, by its index among the verse's words, or the whole verse, without one. */
export type MarkEnd = { chapter: number; verse: number; word?: number };

/**
 * Words or verses selected in a reader – by a long press and a drag, by a screen reader, or by
 * select() – in which passage and book, from a word, or a whole verse, to another, both included.
 * Never their text.
 */
export type Selection = { passage: number; book: string; from: MarkEnd; to: MarkEnd };

/** A rectangle in a reader, from its top left, in points – in pixels on the web: x, y, width and height. */
export type Frame = [x: number, y: number, width: number, height: number];

/**
 * Where a selection shows in a reader: the part of its first line in sight, and of its last – the same where it takes one line. For
 * an app to set a panel of its own beside it.
 */
export type SelectionFrame = { first: Frame; last: Frame };

/** A tap on marked words: the marks there, by id, and the word tapped, which the tap reaches as any tap does. */
export type MarkTap = WordPosition & { ids: string[] };

/**
 * A mark an app keeps on a book: words or verses of it, by where they stand – never by their text
 * – with how it is drawn and a note. Readers draw it over the text wherever the book shows, in
 * every layout, report a tap on it by its id, and open its note where the mark ends.
 */
export type Mark = {
  /** Unique among the marks of a library. */
  id: string;
  /** The book, by id, whose words it marks. */
  book: string;
  /** From a word, or a whole verse, to another, both included. */
  from: MarkEnd;
  to: MarkEnd;
  /** A color behind the words: one the palette names – yellow, green, blue, pink – or any color. */
  highlight?: string;
  /** A line under the words, in a color named or given the same way. */
  underline?: string;
  /** Its note, in runs as an edition's notes have them. A sign where the mark ends opens it. */
  note?: NoteRun[];
};

export { cutOut, marksTouching, spanOf, type Stretch, within } from './marks';

/** A mark as a list shows it: which words of which book it marks and how, and whether it has a note – not the note itself. */
export type MarkInfo = {
  id: string;
  book: string;
  from: MarkEnd;
  to: MarkEnd;
  highlight?: string | null;
  underline?: string | null;
  note: boolean;
};

/**
 * A run of a note's text: its role, if it has one – "origin" (the verse the note is on, as it names it), "quotation", "emphasis",
 * "label"; "number" and "preview" for the verses the note refers to, which follow its runs after a line break where the library
 * holds their book – its language, where it isn't the book's, and the verses it refers to.
 */
export type NoteRun = { text: string; role?: string | null; language?: string | null; target?: Target | null };

/** Verses a note refers to: by their book's USFM code, chapter, and verse – to `to` – or the whole chapter. */
export type Target = { book: string; chapter: number; verse?: number | null; to?: number | null };

/** One step through the words. */
export type MoveStep = 'word+1' | 'word-1' | 'word+10' | 'word-10' | 'verse+1' | 'verse-1';

/**
 * A cross reference followed to verses the reader doesn't show, for the app to show them: their
 * book by its USFM code, their chapter, and their verse – to `to`, for a range – or none, for the
 * whole chapter; and `book`, the library's book of that code, if it holds one – of the same work,
 * where it has it – or null, where it doesn't. `from` is the verse the reference stands in. Verses
 * the reader shows it jumps to itself.
 */
export type ReferenceTarget = {
  book: string | null;
  code: string;
  chapter: number;
  verse?: number;
  to?: number;
  from: { passage: number; book: string; chapter: number; verse: number };
};

/** What the reader's voice does: it speaks, it paused, or it stopped – at the end, by stop(), or as the passages changed. */
export type SpeechChange = {
  state: 'speaking' | 'paused' | 'stopped';
  /** After a start – by play(), or by a tap, a move or a jump while it speaks – how long until the voice sounded, in milliseconds. */
  firstSound?: number;
  /** The languages skipped so far, as the device has no voice for them. */
  unvoiced?: string[];
  /**
   * While it speaks: whether the reader keeps the word the voice is at in sight. Not once it was
   * scrolled or turned away from it by hand, until the word is in sight again, or after follow().
   */
  following?: boolean;
  /** While it reads: the voice of the recording it plays, by its id – empty while a voice on the device speaks. */
  recording?: string;
};

/**
 * A voice on the device that can read aloud: its id, for the reader's `voices`, its name and its
 * language as a BCP 47 tag. Voices that would send the text to a server are left out.
 */
export type Voice = { id: string; name: string; language: string; quality?: string };

/**
 * The reader's colors. Text takes the color of its role, where it has one: "number" (a verse
 * number), "heading", "note" (a note's mark, and a reference in a note), "noteText" (a note shown in
 * full), "origin" (the verse a note names), "ketiv" (a word as written where another is read) or a tajweed rule. A mark names its
 * colors – "yellow", say – and takes its fill from `marks` and its underline's color from `markLines`; a name neither has is a
 * color itself. The word the voice is at is drawn in `highlight`, over the marks; the selection behind the text in `selection`. A
 * palette() is one.
 */
export type ReaderColors = {
  background: string;
  text: string;
  highlight: string;
  selection?: string;
  marks?: Record<string, string>;
  markLines?: Record<string, string>;
  roles: Record<string, string>;
};

/** What the reader shows, and how, on every platform. */
export type ReaderOptions = {
  passages: Passage[];
  /** In points, by which each script's typical letter is sized: see SCRIPT_FONTS. */
  fontSize?: number;
  /** Pages turned one by one, or one endless scroll. */
  paging?: 'scroll' | 'pages';
  /** Columns on a page, the text flowing through them. */
  columns?: number;
  colors?: ReaderColors;
  /** For text whose language `fonts` names no font for: the system's. */
  font?: 'sans' | 'serif';
  /** A font family per language, such as SCRIPT_FONTS. */
  fonts?: Record<string, string>;
  /** Line height as a multiple of the font's own. */
  lineSpacing?: number;
  /** Space at the sides, in points. */
  sideMargin?: number;
  /** Each verse on a line of its own, its number hanging before it, instead of running text. */
  versePerLine?: boolean;
  /** Other editions of the passages' books, by id, read along verse by verse. */
  companions?: string[];
  /**
   * The books' notes – footnotes, endnotes and cross references – each as a small raised mark in
   * the text where it stands, numbered or lettered through the chapter ('marks', the default); or
   * shown in full there, in brackets after the mark ('inline'); or left out ('none'). A tap on a
   * mark opens the note there; a cross reference's verses it jumps to, or reports (onReference).
   */
  notes?: 'marks' | 'inline' | 'none';
  /**
   * The notes of the app's marks: a sign, ✎, in the text where each mark ends, which opens the note ('sign', the default); or the
   * note shown in full there, in brackets after its sign, as an edition's note in full ('inline'), which still opens it.
   */
  markNotes?: 'sign' | 'inline';
  /**
   * How the selection is drawn: in the selection's color (none given, the default); or, given a mark's look – by the names or colors
   * a mark gives – as the words would look marked so: for a pen that marks as it goes. A pen that also erases (`erases`) takes its
   * look off words that all lie in one mark of that look, by place: those show as they would then – the mark cut around them, the
   * rest of its look left on them. What it erases is found as the words selected or the style change, not as the marks change after.
   */
  selectionStyle?: { highlight?: string; underline?: string; erases?: boolean };
  /**
   * How a long press and a drag select: word by word ('word', the default), or by whole verses ('verse'), for an app that deals in
   * verses, as cards of them – a long press on any word selects its verse, a drag takes in the verses it passes, and `select()` takes
   * in the whole verses of what it is given. On the web the page's own selection, by a quick drag or a double click, takes in its
   * verses as the pointer lifts.
   */
  selectBy?: 'word' | 'verse';
  /** Chapters in running text open with a drop cap: the first letter of the text set large over two lines, the first verse without its number. On by default. */
  dropCaps?: boolean;
  /**
   * A font family for the drop cap's letter, such as one of ornamental initials the app brings
   * like its other fonts; letters it lacks, as Hebrew's and Arabic's, are set in the text's font.
   */
  dropCapFont?: string;
  /** Read along inline (a verse, then the same verse in each companion) or side by side, a column each. */
  parallel?: 'inline' | 'columns';
  /** For reading aloud, a voice per language, by id; otherwise the device's for each. */
  voices?: Record<string, string>;
  /** Read aloud, each verse is followed by the same verse in each companion; otherwise only the passages' own books are spoken. */
  speakAlong?: boolean;
  /** How fast the voice reads, as a multiple of its own rate: from 0.5 to 2. iOS's voices read no slower than 0.56. */
  speechRate?: number;
  /**
   * The voices whose recordings are played, by the ids the recordings give them: a chapter is
   * played from a recording of the first that has one, and a voice on the device reads the rest.
   * Without it, from a recording of any voice; with none, from none.
   */
  recordedVoices?: string[];
  /**
   * While it reads aloud, the system's media controls – the lock screen, the control center or a notification – show this, and play,
   * pause and move it verse by verse, and reading aloud goes on in the background: with the screen off or in another app. Without it,
   * they show nothing of it, and reading aloud pauses as the app goes to the background. In the background, iOS needs the app's audio
   * background mode and Android a service: the config plugin's backgroundAudio adds them.
   */
  nowPlaying?: NowPlaying;
};

/** What the system's media controls show of the reader reading aloud: the app chooses, a passage's title or none in particular. */
export type NowPlaying = { title: string; subtitle?: string };

/** How long a text took until its first pages showed, and until all of it was laid out, in milliseconds; and its pages, 0 in one endless scroll. */
export type LaidOut = { pages: number; milliseconds: number; all: number };

/** A font file to fetch: by family, where it comes from (a file in a zip, for some), and its license. */
export type FontFile = { family: string; url: string; file?: string; license: string };

/**
 * The reader's own fonts, one per script, all under the SIL Open Font License: Ezra SIL for Hebrew,
 * Gentium Plus for Greek and Latin, Amiri for Arabic, Vazirmatn for Persian, and Amiri Quran for
 * surahs, which their books ask for. They look alike on every platform, where the systems' fonts
 * don't: iOS's lack polytonic Greek. The import tool fetches them.
 */
export const FONT_FILES: FontFile[] = fonts;

/** A font family per language, from FONT_FILES, for the reader's `fonts`. */
export const SCRIPT_FONTS: Record<string, string> = Object.fromEntries(
  fonts.flatMap(({ family, languages }) => (languages ?? []).map((language) => [language, family])),
);
