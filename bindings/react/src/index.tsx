import {
  createReader,
  type MoveStep,
  type WebReader,
  type WebReaderOptions,
  type WordPosition,
} from '@schaefchens/scriptura-web';
import { type CSSProperties, type Ref, useEffect, useImperativeHandle, useRef } from 'react';

export * from '@schaefchens/scriptura-web';

export type ReaderHandle = {
  move(step: MoveStep): void;
  /** Brings the reader to a word by where it stands, as a tap would. False if the reader shows no such verse. */
  jump(position: WordPosition): boolean;
  /** Reads aloud from the word marked, or the first in sight, marking each word as it is said. */
  play(): void;
  pause(): void;
  stop(): void;
  /** Brings the word the voice is at, or the word marked, into sight, and keeps the words the voice comes to there. */
  follow(): void;
  /** Turns to the next or previous page, or a screen down or up. */
  turn(forward: boolean): void;
  /** Shows what the library now holds, after books were added or removed. */
  refresh(): void;
};

export type ReaderProps = WebReaderOptions & {
  ref?: Ref<ReaderHandle>;
  className?: string;
  style?: CSSProperties;
};

/**
 * Scriptura's reader in a React page: the web reader, with its options as props. A change of what
 * it shows or how lays the text out again, at the word it was at; new callbacks alone don't.
 */
export function Reader({ ref, className, style, ...options }: ReaderProps) {
  const element = useRef<HTMLDivElement>(null);
  const reader = useRef<WebReader>(null);
  // Made with the options of its first render, it needs no update right after.
  const made = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const { library, onWordChange: _word, onLaidOut: _laidOut, onSpeechChange: _speech, ...shown } = options;
  const shownKey = JSON.stringify(shown);
  const withCallbacks = (): WebReaderOptions => ({
    ...latest.current,
    onWordChange: (position) => latest.current.onWordChange?.(position),
    onLaidOut: (time) => latest.current.onLaidOut?.(time),
    onSpeechChange: (change) => latest.current.onSpeechChange?.(change),
  });

  useEffect(() => {
    reader.current = createReader(element.current!, withCallbacks());
    made.current = true;
    return () => {
      reader.current?.destroy();
      reader.current = null;
    };
  }, []);

  useEffect(() => {
    if (made.current) made.current = false;
    else reader.current?.update(withCallbacks());
  }, [library, shownKey]);

  useImperativeHandle(ref, () => ({
    move: (step) => reader.current?.move(step),
    jump: (position) => reader.current?.jump(position) ?? false,
    play: () => reader.current?.play(),
    pause: () => reader.current?.pause(),
    stop: () => reader.current?.stop(),
    follow: () => reader.current?.follow(),
    turn: (forward) => reader.current?.turn(forward),
    refresh: () => reader.current?.refresh(),
  }), []);

  return <div ref={element} className={className} style={style} />;
}
