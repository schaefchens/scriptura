import type { BookInfo, Mark, MarkInfo, NoteRun, Passage, RecordingInfo, Target, WordPosition } from '@schaefchens/scriptura';

import init, { Library as Core, type Speech as CoreSpeech } from './generated/scriptura_wasm.js';

/** A paragraph to lay out: a chapter's heading, its running text, or a verse on a line of its own. See the core's Block. */
export type Block = {
  passage: number;
  /** Its book, by id: the passage's, or one read along with it. */
  book: string;
  /** Where it stands when books are read side by side: a row per verse of the passage, a column per book. */
  row: number;
  column: number;
  kind: 'heading' | 'text' | 'verse';
  direction: 'ltr' | 'rtl';
  language: string;
  fontFamily: string | null;
  /** A typical letter of the block's script, and how tall it is to be, in points. */
  letter: string;
  letterHeight: number;
  segments: { text: string; role: string | null }[];
  /** Ranges in the block's text in UTF-16 code units, as JS counts them. */
  verses: { chapter: number; verse: number; start: number; end: number }[];
  words: { chapter: number; verse: number; index: number; start: number; end: number }[];
  /** The notes on its verses, each at its mark in the text, which opens it. See the core's NoteMark. */
  notes: NoteMark[];
  /** What opens the chapter, set large over the paragraph's first lines: in running text, where the passage reads the chapter from its start. */
  dropCap: { letterStart: number; letterEnd: number } | null;
  /** The page's marks on its verses, each as the range of its words here. */
  marks: PlacedMark[];
};

/**
 * A mark in a paragraph: the words of it the paragraph holds, as their range in the paragraph's text – a verse's number and the
 * notes' marks left out – and how it is drawn. The sign of its note stands in the text where the mark ends, as a note's mark of the
 * kind "mark". See the core's PlacedMark.
 */
export type PlacedMark = { id: string; start: number; end: number; highlight: string | null; underline: string | null };

/**
 * A note's mark in a paragraph – its range in the text, on which verse – and the note it opens: a
 * footnote, an endnote or a cross reference, as runs, some of which refer to verses; or, of the kind
 * "mark", the sign of an app's mark's note, with the mark's id.
 */
export type NoteMark = {
  chapter: number;
  verse: number;
  start: number;
  end: number;
  kind: 'footnote' | 'endnote' | 'crossReference' | 'mark';
  mark: string;
  runs: NoteRun[];
  id?: string | null;
};

export type { NoteRun, Target };

/** Text for a voice, in one language: a chapter's heading, or verses of a passage's book without their numbers. See the core's Utterance. */
export type Utterance = {
  passage: number;
  book: string;
  language: string;
  heading: boolean;
  text: string;
  /** Each word where it stands, and its range in `text` in UTF-16 code units, as voices report the words they speak. */
  words: { chapter: number; verse: number; index: number; start: number; end: number }[];
};

/**
 * Verses played from a recording of their chapter: from `start` to `end` in its audio, in milliseconds – or to its end, without an
 * end – with each word where it stands and where it starts in the audio. See the core's Take.
 */
export type Take = {
  passage: number;
  book: string;
  /** The recording's: who reads, and where its audio is. */
  voice: string;
  audio: string;
  start: number;
  end: number | null;
  words: { chapter: number; verse: number; index: number; start: number }[];
};

/** What is read aloud next: an utterance for the device's voice, or a take from a recording. */
export type Part = { speak: Utterance } | { play: Take };

/** What is read aloud of passages, part by part: see the core's Speech. */
export class Speech {
  constructor(private core: CoreSpeech) {}

  /** The next part: a take, or an utterance at most `limit` UTF-16 code units long, cut at a sentence end; none after the last. */
  next(limit: number): Part | undefined {
    const json = this.core.nextJson(limit);
    return json === undefined ? undefined : JSON.parse(json);
  }

  free() {
    this.core.free();
  }
}

let loading: Promise<unknown> | undefined;

/** Loads the core, once; everything else waits for it. A bundler brings the wasm file along, or it comes from `url`. */
export async function loadScriptura(url?: string | URL) {
  loading ??= init(url ? { module_or_path: url } : undefined);
  await loading;
}

const bytesOf = (json: string | ArrayBuffer | Uint8Array) =>
  typeof json === 'string' ? new TextEncoder().encode(json) : json instanceof Uint8Array ? json : new Uint8Array(json);

/** What changed in a library: its books, its recordings, or its marks. */
export type LibraryChange = 'books' | 'recordings' | 'marks';

/**
 * The books a page has added, the recordings of their chapters, the page's marks on their words, and passages of them as paragraphs.
 * On the web, their text is the page's anyway. Its readers follow its changes: new books lay them out anew, new marks are drawn at
 * once, and what they still had to read goes with the books or recordings that change.
 */
export class Library {
  private core = new Core();
  private listeners = new Set<(change: LibraryChange) => void>();

  /** Tells `listener` of each change, until the function it returns is called. */
  onChange(listener: (change: LibraryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds the books of a JSON array, each replacing one of the same id, and returns their ids. */
  add(json: string | ArrayBuffer | Uint8Array): string[] {
    const ids = this.core.add(bytesOf(json));
    this.changed('books');
    return ids;
  }

  /** Fetches books and adds them. */
  async fetch(url: string | URL): Promise<string[]> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    return this.add(await response.arrayBuffer());
  }

  remove(ids: string[]) {
    this.core.remove(ids);
    this.changed('books');
  }

  /**
   * Adds the recordings of a JSON array, each replacing one of the same id, and returns their ids. An audio that is no URL is taken as
   * relative to `base`, where they came from. Recordings that count words otherwise than the core does are refused.
   */
  addRecordings(json: string | ArrayBuffer | Uint8Array, base?: string | URL): string[] {
    const ids = this.core.addRecordings(bytesOf(json), base === undefined ? undefined : new URL(base, location.href).href);
    this.changed('recordings');
    return ids;
  }

  /** Fetches recordings and adds them: their audio is found next to them. */
  async fetchRecordings(url: string | URL): Promise<string[]> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    return this.addRecordings(await response.arrayBuffer(), new URL('.', new URL(url, location.href)));
  }

  removeRecordings(ids: string[]) {
    this.core.removeRecordings(ids);
    this.changed('recordings');
  }

  clearRecordings() {
    this.core.clearRecordings();
    this.changed('recordings');
  }

  /** What the recordings are: id, voice and its name, book and chapter, and why one isn't played, if it isn't. */
  recordings(): RecordingInfo[] {
    return JSON.parse(this.core.recordingsJson());
  }

  clear() {
    this.core.clear();
    this.changed('books');
  }

  /**
   * Adds marks – the page's, with their notes – each replacing one of the same id, and returns their ids: readers draw them at once. A
   * mark that ends before it starts is refused.
   */
  addMarks(marks: Mark[] | string): string[] {
    const json = typeof marks === 'string' ? marks : JSON.stringify(marks);
    const ids = this.core.addMarks(new TextEncoder().encode(json));
    this.changed('marks');
    return ids;
  }

  removeMarks(ids: string[]) {
    this.core.removeMarks(ids);
    this.changed('marks');
  }

  clearMarks() {
    this.core.clearMarks();
    this.changed('marks');
  }

  /** What the marks are: which words of which book each marks and how, and whether it has a note. */
  marks(): MarkInfo[] {
    return JSON.parse(this.core.marksJson());
  }

  private changed(change: LibraryChange) {
    for (const listener of this.listeners) listener(change);
  }

  /** What the books are: id, code, title, work, language and direction. */
  books(): BookInfo[] {
    return JSON.parse(this.core.booksJson());
  }

  /** The passages as paragraphs, read along with `companions`. */
  blocks(
    passages: Passage[],
    options: { fontSize: number; versePerLine?: boolean; companions?: string[]; notes?: 'marks' | 'inline' | 'none'; dropCaps?: boolean; markNotes?: 'sign' | 'inline' },
  ): Block[] {
    return JSON.parse(this.core.blocksJson(JSON.stringify(passages), JSON.stringify(options)));
  }

  /**
   * What is read aloud of the passages, read along with `companions` – only their own books, or `along`, each verse in every book –
   * from the word at `from`, or else from the start; chapters from recordings of the `recorded` voices, or with none named, of any.
   */
  speech(passages: Passage[], options: { companions?: string[]; along?: boolean; recorded?: string[] }, from?: WordPosition): Speech {
    return new Speech(this.core.speech(JSON.stringify(passages), JSON.stringify(options), from ? JSON.stringify(from) : ''));
  }
}
