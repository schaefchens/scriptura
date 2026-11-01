import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cutOut, marksTouching, spanOf, within } from '../src/marks.ts';

const words = (from, to) => ({ from, to });
const at = (chapter, verse, word) => (word === undefined ? { chapter, verse } : { chapter, verse, word });

test("a stretch cut around words of it keeps the words before and after them, found by their places", () => {
  // Words 3 to 7 of a verse, the third taken off: 4 to 7 are left.
  assert.deepEqual(cutOut(words(at(1, 1, 2), at(1, 1, 6)), words(at(1, 1, 2), at(1, 1, 2))), [words(at(1, 1, 3), at(1, 1, 6))]);
  // From the middle: a part before and a part after.
  assert.deepEqual(cutOut(words(at(1, 1), at(1, 3)), words(at(1, 2, 1), at(1, 2, 4))), [
    words(at(1, 1), at(1, 2, 0)),
    words(at(1, 2, 5), at(1, 3)),
  ]);
  // A whole verse taken off the start of a chapter's mark leaves the verses after it; one at a chapter's start, the chapter before.
  assert.deepEqual(cutOut(words(at(1, 1), at(1, 3)), words(at(1, 1), at(1, 1))), [words(at(1, 2), at(1, 3))]);
  assert.deepEqual(cutOut(words(at(1, 20), at(2, 2)), words(at(2, 0), at(2, 2))), [words(at(1, 20), at(1, 4294967295))]);
  // Nothing is left where all of it goes, nor between a verse's start and its first word.
  assert.deepEqual(cutOut(words(at(1, 1, 2), at(1, 1, 6)), words(at(1, 1), at(1, 1))), []);
  assert.deepEqual(cutOut(words(at(1, 1), at(1, 1)), words(at(1, 1, 0), at(1, 1))), []);
});

test("marks touching words, a span over them, and words within a mark", () => {
  const marks = [
    { id: 'a', book: 'jonah', ...words(at(1, 1, 2), at(1, 1, 6)) },
    { id: 'b', book: 'jonah', ...words(at(1, 3), at(1, 3)) },
    { id: 'c', book: 'ruth', ...words(at(1, 1), at(1, 1)) },
  ];
  const selection = { book: 'jonah', ...words(at(1, 1, 5), at(1, 3, 0)) };
  assert.deepEqual(marksTouching(marks, selection).map((mark) => mark.id), ['a', 'b']);
  assert.deepEqual(spanOf([selection, ...marks.slice(0, 2)]), words(at(1, 1, 2), at(1, 3)));
  assert.equal(within(words(at(1, 1, 3), at(1, 1, 4)), marks[0]), true);
  assert.equal(within(words(at(1, 1, 3), at(1, 2, 0)), marks[0]), false);
  assert.equal(within(words(at(1, 3, 2), at(1, 3, 2)), marks[1]), true);
});
