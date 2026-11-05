import type {
  BookInfo,
  LaidOut,
  LexiconInfo,
  MarkInfo,
  MarkTap,
  MoveStep,
  ReaderOptions,
  RecordingInfo,
  ReferenceTarget,
  Selection,
  SelectionFrame,
  SpeechChange,
  VersePosition,
  Voice,
  WordPosition,
} from '@schaefchens/scriptura';
import { requireNativeModule, requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

export * from '@schaefchens/scriptura';

/**
 * Where books or recordings come from: a file, by a file:// URI or a path; one the app bundles, by
 * its name (see app.plugin.js); or JS itself. Only the last passes books' text through JS.
 */
export type BooksSource = { uri: string } | { asset: string } | { json: string };

/**
 * What a screen reader finds in sight: a chapter's heading, or a verse, by where it stands, never
 * its text; its language; and where it is in the reader, in points. A note's mark in a verse is
 * one too, with its mark and kind; so is the sign of a mark's note, with the mark's id, and a word's
 * number, of the kind "entry". A verse with marks on it is announced as marked; one whose words
 * open lexicon entries has the action that opens the entry of its word reached (`entries`).
 */
export type AccessibilityElement = {
  passage: number;
  book: string;
  chapter: number;
  verse?: number;
  note?: string;
  kind?: 'footnote' | 'endnote' | 'crossReference' | 'mark' | 'entry';
  entries?: boolean;
  mark?: string;
  marked?: boolean;
  language: string;
  frame: [x: number, y: number, width: number, height: number];
};

export type ReaderHandle = {
  move(step: MoveStep): Promise<void>;
  /** Brings the reader to a word by where it stands, as a tap would; to its verse's first word if the verse has no such word. False if the reader shows no such verse. */
  jump(position: WordPosition): Promise<boolean>;
  /**
   * Reads aloud – chapters with recordings from them, the rest with the device's voices – from the
   * word marked, or with none, the first in sight, on to the end, marking each word as it is said
   * and keeping it in sight, unless the reader was scrolled away from it by hand. A tap, a move or a
   * jump while it reads goes on from there. The reader takes the text from the books itself: it
   * never passes through JS.
   */
  play(): Promise<void>;
  /** Pauses; play() goes on from the word reached – a recording where it paused. */
  pause(): Promise<void>;
  stop(): Promise<void>;
  /** Brings the word the voice is at – or, not reading aloud, the word marked – into sight, and keeps the words the voice comes to there. */
  follow(): Promise<void>;
  /** Turns to the next or previous page, or a screen down or up, as a hand would. */
  turn(forward: boolean): Promise<void>;
  /** The same as a tap at that point of the reader, in points: for tests without a finger. */
  tapAt(x: number, y: number): Promise<void>;
  /** The same as a double tap at that point, which opens the lexicon entry of a word that has one: for tests without a finger. */
  doubleTapAt(x: number, y: number): Promise<void>;
  /**
   * Selects words or verses, as a long press and a drag would – from a word, or a verse's first, to
   * a word, or a verse's last – or nothing. Reported through onSelectionChange like any selection.
   */
  select(selection: Selection | null): Promise<void>;
  /** For tests without a screen reader. */
  accessibilityElementsInSight(): Promise<AccessibilityElement[]>;
};

export type ReaderProps = ReaderOptions & {
  /** The word reached, by a tap or a move: where it stands, never its text. */
  onWordChange?: (position: WordPosition) => void;
  onLaidOut?: (time: LaidOut) => void;
  onSpeechChange?: (change: SpeechChange) => void;
  /** A cross reference followed to verses the reader doesn't show: for the app to show them, if the library holds their book. */
  onReference?: (target: ReferenceTarget) => void;
  /**
   * The words or verses selected – by a long press and a drag, by a screen reader, or by select() –
   * or none, as the selection goes: where they stand, never their text. Reading aloud goes on from
   * the word marked, as before.
   */
  onSelectionChange?: (selection: Selection | null) => void;
  /** A tap on marked words: the marks there, by id, and the word, which the tap reaches as any tap does. A mark's sign opens its note instead. */
  onMarkTap?: (tap: MarkTap) => void;
  /**
   * Where the selection shows in the reader, in points from its top left, as it settles – after a drag, a scroll, a page turn or a
   * change of layout – and none while a finger drags or the reader moves, or where none of it is in sight: for a panel of the app's
   * own beside it.
   */
  onSelectionFrame?: (frame: SelectionFrame | null) => void;
  /**
   * The verse in sight, as it changes: the verse of the first word on the page, or of the first whole line in sight – as the text is
   * scrolled or turned, brought somewhere, or laid out anew. For an app's index of books and chapters, or a place to come back to.
   */
  onVerseInSight?: (verse: VersePosition) => void;
  ref?: Ref<ReaderHandle>;
  style?: StyleProp<ViewStyle>;
};

type NativeProps = Omit<
  ReaderProps,
  'onWordChange' | 'onLaidOut' | 'onSpeechChange' | 'onReference' | 'onSelectionChange' | 'onMarkTap' | 'onSelectionFrame' | 'onVerseInSight'
> & {
  onWordChange?: (event: NativeSyntheticEvent<WordPosition>) => void;
  onLaidOut?: (event: NativeSyntheticEvent<LaidOut>) => void;
  onSpeechChange?: (event: NativeSyntheticEvent<SpeechChange>) => void;
  onReference?: (event: NativeSyntheticEvent<ReferenceTarget>) => void;
  onSelectionChange?: (event: NativeSyntheticEvent<{ selection?: Selection | null }>) => void;
  onMarkTap?: (event: NativeSyntheticEvent<MarkTap>) => void;
  onSelectionFrame?: (event: NativeSyntheticEvent<{ frame?: SelectionFrame | null }>) => void;
  onVerseInSight?: (event: NativeSyntheticEvent<VersePosition>) => void;
};

const NativeReader = requireNativeView<NativeProps>('Scriptura');

/**
 * Scripture in pages or one endless scroll, laid out with the platform's own text stack: TextKit 2
 * on iOS, Android's text layout. It gets the passages' text itself, from the books added.
 */
export function Reader({ onWordChange, onLaidOut, onSpeechChange, onReference, onSelectionChange, onMarkTap, onSelectionFrame, onVerseInSight, ...props }: ReaderProps) {
  return (
    <NativeReader
      {...props}
      onWordChange={onWordChange && (({ nativeEvent }) => onWordChange(nativeEvent))}
      onLaidOut={onLaidOut && (({ nativeEvent }) => onLaidOut(nativeEvent))}
      onSpeechChange={onSpeechChange && (({ nativeEvent }) => onSpeechChange(nativeEvent))}
      onReference={onReference && (({ nativeEvent }) => onReference(nativeEvent))}
      onSelectionChange={onSelectionChange && (({ nativeEvent }) => onSelectionChange(nativeEvent.selection ?? null))}
      onMarkTap={onMarkTap && (({ nativeEvent }) => onMarkTap(nativeEvent))}
      onSelectionFrame={onSelectionFrame && (({ nativeEvent }) => onSelectionFrame(nativeEvent.frame ?? null))}
      onVerseInSight={onVerseInSight && (({ nativeEvent }) => onVerseInSight(nativeEvent))}
    />
  );
}

type ScripturaModule = {
  addBooks(source: BooksSource): Promise<string[]>;
  books(): BookInfo[];
  removeBooks(ids: string[]): Promise<void>;
  clearBooks(): Promise<void>;
  addRecordings(source: BooksSource): Promise<string[]>;
  recordings(): RecordingInfo[];
  removeRecordings(ids: string[]): Promise<void>;
  clearRecordings(): Promise<void>;
  addMarks(source: BooksSource): Promise<string[]>;
  marks(): MarkInfo[];
  removeMarks(ids: string[]): Promise<void>;
  clearMarks(): Promise<void>;
  addLexicons(source: BooksSource): Promise<string[]>;
  lexicons(): LexiconInfo[];
  removeLexicons(ids: string[]): Promise<void>;
  clearLexicons(): Promise<void>;
  speechVoices(): Promise<Voice[]>;
};

const scriptura = requireNativeModule<ScripturaModule>('Scriptura');

/** Adds books, each replacing one of the same id, and returns their ids. Readers show them at once. */
export const addBooks = (source: BooksSource) => scriptura.addBooks(source);

/** The books added: what they are, not what they say. */
export const books = () => scriptura.books();

export const removeBooks = (ids: string[]) => scriptura.removeBooks(ids);

/** Removes every book, as when an app locks: readers show nothing until books are added again. */
export const clearBooks = () => scriptura.clearBooks();

/**
 * Adds recordings of chapters, each replacing one of the same id, and returns their ids: a JSON array
 * in the shape of the core's src/model.rs, whose audio, where it is no URI, is found next to them.
 * Recordings that count words otherwise than the core does are refused. Reading aloud stops.
 */
export const addRecordings = (source: BooksSource) => scriptura.addRecordings(source);

/** The recordings added: whose voice, which chapter, and why one isn't played, if it isn't. */
export const recordings = () => scriptura.recordings();

export const removeRecordings = (ids: string[]) => scriptura.removeRecordings(ids);

export const clearRecordings = () => scriptura.clearRecordings();

/**
 * Adds marks – the app's, kept with their notes – each replacing one of the same id, and returns
 * their ids: a JSON array of marks (see Mark), from a file or an asset, so that a note's text needn't
 * pass through JS, or from JS. Readers draw them at once, their layout kept. A mark that ends before
 * it starts is refused.
 */
export const addMarks = (source: BooksSource) => scriptura.addMarks(source);

/** The marks added: which words of which book each marks and how, and whether it has a note – not the note itself. */
export const marks = () => scriptura.marks();

export const removeMarks = (ids: string[]) => scriptura.removeMarks(ids);

/** Removes every mark, as when an app locks. */
export const clearMarks = () => scriptura.clearMarks();

/**
 * Adds lexicons – a JSON array, as the import tool writes them – each replacing one of the same id,
 * and returns their ids: from a file or an asset, so their text needn't pass through JS, or from JS.
 * Words tagged with their numbers open their entries, in readers that let them (`lexicon`).
 */
export const addLexicons = (source: BooksSource) => scriptura.addLexicons(source);

/** The lexicons added: what they are and how many entries each has. */
export const lexicons = () => scriptura.lexicons();

export const removeLexicons = (ids: string[]) => scriptura.removeLexicons(ids);

/** Removes every lexicon, as when an app locks. */
export const clearLexicons = () => scriptura.clearLexicons();

/** The voices on the device that can read aloud. */
export const speechVoices = () => scriptura.speechVoices();
