import fonts from '../fonts.json';

export { CONTRASTS, type Palette, palette, ROLE_COLORS, type Theme } from './palette';

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
 * Where the reader's current word stands: the passage it belongs to, its book (the passage's, or
 * one read along with it) and its place in the scripture. Never its text.
 */
export type WordPosition = { passage: number; book: string; chapter: number; verse: number; word: number };

/** One step through the words. */
export type MoveStep = 'word+1' | 'word-1' | 'word+10' | 'word-10' | 'verse+1' | 'verse-1';

/**
 * The reader's colors. Text takes the color of its role, where it has one: "number" (a verse
 * number), "heading", "ketiv" (a word as written where another is read) or a tajweed rule.
 * A palette() is one.
 */
export type ReaderColors = { background: string; text: string; highlight: string; roles: Record<string, string> };

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
  /** Read along inline (a verse, then the same verse in each companion) or side by side, a column each. */
  parallel?: 'inline' | 'columns';
};

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
