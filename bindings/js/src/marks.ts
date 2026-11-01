// How marks and selections stand to one another, by their places alone: for an app keeping marks. Apart from the rest, so that
// plain Node can run its tests.
import type { MarkEnd } from './index';

/** Words of a book a mark or a selection covers: from a word, or a whole verse, to another. */
export type Stretch = { from: MarkEnd; to: MarkEnd };

/** Where an end stands, to compare: a whole verse reaches from before its first word, as a start, to past its last, as an end. */
const startOf = ({ chapter, verse, word }: MarkEnd) => [chapter, verse, word ?? -1];
const endOf = ({ chapter, verse, word }: MarkEnd) => [chapter, verse, word ?? Infinity];
const compare = (a: number[], b: number[]) => a.map((value, at) => (value < b[at] ? -1 : value > b[at] ? 1 : 0)).find((sign) => sign !== 0) ?? 0;

/**
 * The marks that share a word with words of their book – a selection, say – in the order given: for an app to change them, or
 * make them one with the selection, rather than set a mark on top of them.
 */
export function marksTouching<T extends Stretch & { book: string }>(marks: T[], words: Stretch & { book: string }): T[] {
  return marks.filter(
    (mark) => mark.book === words.book && compare(startOf(mark.from), endOf(words.to)) <= 0 && compare(startOf(words.from), endOf(mark.to)) <= 0,
  );
}

/** Whether all the words of a stretch lie within another. */
export function within(inner: Stretch, outer: Stretch): boolean {
  return compare(startOf(outer.from), startOf(inner.from)) <= 0 && compare(endOf(inner.to), endOf(outer.to)) <= 0;
}

/**
 * The parts of a stretch outside words of it – before them and after them: none, one or two – for an app to take a mark off some of
 * its words. Each part's ends are found from the words' places alone: the word before or after, or the verse before or after, which
 * still bounds the part where the book has no such verse.
 */
export function cutOut(stretch: Stretch, words: Stretch): Stretch[] {
  const parts: Stretch[] = [];
  if (compare(startOf(stretch.from), startOf(words.from)) < 0) parts.push({ from: stretch.from, to: endBefore(words.from) });
  if (compare(endOf(words.to), endOf(stretch.to)) < 0) parts.push({ from: startAfter(words.to), to: stretch.to });
  // A part between a verse's start and its first word holds none.
  return parts.filter((part) => compare(startOf(part.from), endOf(part.to)) <= 0);
}

/** Past every verse of a chapter, as the core counts them. */
const LAST_VERSE = 4294967295;

/** The end just before a start: the word before, or the verse before – or the end of the chapter before. */
function endBefore({ chapter, verse, word }: MarkEnd): MarkEnd {
  if (word !== undefined && word > 0) return { chapter, verse, word: word - 1 };
  return verse > 0 ? { chapter, verse: verse - 1 } : { chapter: chapter - 1, verse: LAST_VERSE };
}

/** The start just after an end: the word after, or the verse after. */
function startAfter({ chapter, verse, word }: MarkEnd): MarkEnd {
  return word !== undefined ? { chapter, verse, word: word + 1 } : { chapter, verse: verse + 1 };
}

/** The words from the first start of stretches of one book to their last end. */
export function spanOf(stretches: Stretch[]): Stretch {
  const from = stretches.reduce((first, { from }) => (compare(startOf(from), startOf(first)) < 0 ? from : first), stretches[0].from);
  const to = stretches.reduce((last, { to }) => (compare(endOf(to), endOf(last)) > 0 ? to : last), stretches[0].to);
  return { from, to };
}
