import type { BookInfo, Passage } from '@schaefchens/scriptura';

import init, { Library as Core } from './generated/scriptura_wasm.js';

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
};

let loading: Promise<unknown> | undefined;

/** Loads the core, once; everything else waits for it. A bundler brings the wasm file along, or it comes from `url`. */
export async function loadScriptura(url?: string | URL) {
  loading ??= init(url ? { module_or_path: url } : undefined);
  await loading;
}

/** The books a page has added, and passages of them as paragraphs. On the web, their text is the page's anyway. */
export class Library {
  private core = new Core();

  /** Adds the books of a JSON array, each replacing one of the same id, and returns their ids. */
  add(json: string | ArrayBuffer | Uint8Array): string[] {
    const bytes = typeof json === 'string' ? new TextEncoder().encode(json) : json instanceof Uint8Array ? json : new Uint8Array(json);
    return this.core.add(bytes);
  }

  /** Fetches books and adds them. */
  async fetch(url: string | URL): Promise<string[]> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    return this.add(await response.arrayBuffer());
  }

  remove(ids: string[]) {
    this.core.remove(ids);
  }

  clear() {
    this.core.clear();
  }

  /** What the books are: id, code, title, work, language and direction. */
  books(): BookInfo[] {
    return JSON.parse(this.core.booksJson());
  }

  /** The passages as paragraphs, read along with `companions`. */
  blocks(passages: Passage[], options: { fontSize: number; versePerLine?: boolean; companions?: string[] }): Block[] {
    return JSON.parse(this.core.blocksJson(JSON.stringify(passages), JSON.stringify(options)));
  }
}
