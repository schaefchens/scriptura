// The import's notes, on a book made up for them: tests/fixtures/99-TSTnotes.usfm, zipped as eBible.org
// zips its editions, imported through the tool as an app would run it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../tests/fixtures');

async function imported() {
  const directory = await mkdtemp(join(tmpdir(), 'scriptura-test-'));
  execFileSync('zip', ['-q', '-j', join(directory, 'notes.zip'), join(fixtures, '99-TSTnotes.usfm')]);
  const config = { books: 'books.json', bibles: [{ usfm: 'notes.zip', work: 'Test', language: 'en', direction: 'ltr', books: [{ id: 'test', code: 'TST' }] }] };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  execFileSync('node', [resolve(here, '../import.mjs'), join(directory, 'config.json')], { stdio: 'ignore' });
  return JSON.parse(await readFile(join(directory, 'books.json'), 'utf8'))[0];
}

test('footnotes, endnotes and cross references stand where they do, numbered and lettered through a chapter', async () => {
  const book = await imported();
  assert.equal(book.title, 'Test');
  const [one, two] = book.chapters;
  const verse = (chapter, number) => chapter.verses.find((verse) => verse.number === number);
  const first = verse(one, 1);
  assert.equal(first.runs[0][0], 'In the beginning God created the heavens.');
  assert.deepEqual(
    first.notes.map(({ kind, mark, at }) => [kind, mark, at]),
    [['footnote', '1', 16], ['endnote', '2', 20], ['crossReference', 'a', 40]],
  );
  // A note's runs: the verse it names, text, a quotation.
  assert.deepEqual(first.notes[0].runs, [{ text: '1:1 ', role: 'origin' }, { text: 'A footnote, with ' }, { text: 'a quotation', role: 'quotation' }, { text: '.' }]);
  // Its verses by the names the edition's books go by – a header, a short name – and words before them left as they are.
  const targets = first.notes[2].runs.filter((run) => run.target).map(({ text, target }) => [text, target]);
  assert.deepEqual(targets, [
    ['Test 1:2', { book: 'TST', chapter: 1, verse: 2 }],
    ['Tst 1:3-4', { book: 'TST', chapter: 1, verse: 3, to: 4 }],
  ]);
  assert.ok(first.notes[2].runs.some((run) => run.text.endsWith('See Job 9:8') && !run.target), 'a book the edition lacks is no link');
  // A note after a space stands with the word before it; the heading's note went with the heading.
  assert.equal(verse(one, 2).notes[0].at, 'And the earth was formless.'.length);
  assert.equal(one.verses.flatMap((verse) => verse.notes ?? []).length, 5);
  // Paragraphs within a note, and a Hebrew word in its language.
  const light = verse(one, 3).notes[0].runs;
  assert.ok(light.some((run) => run.text === '\n'));
  assert.deepEqual(light.find((run) => run.language), { text: 'אוֹר', language: 'he' });
  // The next chapter counts from one again.
  assert.equal(verse(two, 1).notes[0].mark, '1');
});
