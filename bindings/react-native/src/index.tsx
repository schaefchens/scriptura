import type { BookInfo, LaidOut, MoveStep, ReaderOptions, SpeechChange, Voice, WordPosition } from '@schaefchens/scriptura';
import { requireNativeModule, requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

export * from '@schaefchens/scriptura';

/**
 * Where books come from: a file, by a file:// URI or a path; one the app bundles, by its name (see
 * app.plugin.js); or JS itself. Only the last passes their text through JS.
 */
export type BooksSource = { uri: string } | { asset: string } | { json: string };

/**
 * What a screen reader finds in sight: a chapter's heading, or a verse, by where it stands, never
 * its text; its language; and where it is in the reader, in points.
 */
export type AccessibilityElement = {
  passage: number;
  book: string;
  chapter: number;
  verse?: number;
  language: string;
  frame: [x: number, y: number, width: number, height: number];
};

export type ReaderHandle = {
  move(step: MoveStep): Promise<void>;
  /** Brings the reader to a word by where it stands, as a tap would; to its verse's first word if the verse has no such word. False if the reader shows no such verse. */
  jump(position: WordPosition): Promise<boolean>;
  /**
   * Reads aloud with the device's voices, from the word marked – or, with none, the first in sight –
   * on to the end, marking each word as it is said. A tap, a move or a jump while it speaks goes on
   * from there. The reader takes the text from the books itself: it never passes through JS.
   */
  play(): Promise<void>;
  /** Pauses; play() goes on from the word reached. */
  pause(): Promise<void>;
  stop(): Promise<void>;
  /** The same as a tap at that point of the reader, in points: for tests without a finger. */
  tapAt(x: number, y: number): Promise<void>;
  /** For tests without a screen reader. */
  accessibilityElementsInSight(): Promise<AccessibilityElement[]>;
};

export type ReaderProps = ReaderOptions & {
  /** The word reached, by a tap or a move: where it stands, never its text. */
  onWordChange?: (position: WordPosition) => void;
  onLaidOut?: (time: LaidOut) => void;
  onSpeechChange?: (change: SpeechChange) => void;
  ref?: Ref<ReaderHandle>;
  style?: StyleProp<ViewStyle>;
};

type NativeProps = Omit<ReaderProps, 'onWordChange' | 'onLaidOut' | 'onSpeechChange'> & {
  onWordChange?: (event: NativeSyntheticEvent<WordPosition>) => void;
  onLaidOut?: (event: NativeSyntheticEvent<LaidOut>) => void;
  onSpeechChange?: (event: NativeSyntheticEvent<SpeechChange>) => void;
};

const NativeReader = requireNativeView<NativeProps>('Scriptura');

/**
 * Scripture in pages or one endless scroll, laid out with the platform's own text stack: TextKit 2
 * on iOS, Android's text layout. It gets the passages' text itself, from the books added.
 */
export function Reader({ onWordChange, onLaidOut, onSpeechChange, ...props }: ReaderProps) {
  return (
    <NativeReader
      {...props}
      onWordChange={onWordChange && (({ nativeEvent }) => onWordChange(nativeEvent))}
      onLaidOut={onLaidOut && (({ nativeEvent }) => onLaidOut(nativeEvent))}
      onSpeechChange={onSpeechChange && (({ nativeEvent }) => onSpeechChange(nativeEvent))}
    />
  );
}

type ScripturaModule = {
  addBooks(source: BooksSource): Promise<string[]>;
  books(): BookInfo[];
  removeBooks(ids: string[]): Promise<void>;
  clearBooks(): Promise<void>;
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

/** The voices on the device that can read aloud. */
export const speechVoices = () => scriptura.speechVoices();
