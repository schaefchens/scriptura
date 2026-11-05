// The import's notes and tags, on a book made up for them: tests/fixtures/99-TSTnotes.usfm, zipped as
// eBible.org zips its editions, and verses of the Open Scriptures Hebrew Bible in TSTtags.xml,
// imported through the tool as an app would run it, with a lexicon from excerpts of its sources.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../tests/fixtures');

async function importedAll() {
  const directory = await mkdtemp(join(tmpdir(), 'scriptura-test-'));
  execFileSync('zip', ['-q', '-j', join(directory, 'notes.zip'), join(fixtures, '99-TSTnotes.usfm')]);
  const lexicon = (file) => join(fixtures, 'lexicon', file);
  const config = {
    books: 'books.json',
    lexicons: { file: 'lexicons.json', sources: { hebrew: lexicon('tbesh.txt'), greek: lexicon('tbesg.txt'), strongsHebrew: lexicon('strongs-hebrew.js') } },
    bibles: [
      { usfm: 'notes.zip', work: 'Test', language: 'en', direction: 'ltr', books: [{ id: 'test', code: 'TST' }] },
      { osis: fixtures, work: 'Test', language: 'he', direction: 'rtl', books: [{ id: 'test-he', code: 'TST', file: 'TSTtags', title: 'Test' }] },
    ],
  };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  execFileSync('node', [resolve(here, '../import.mjs'), join(directory, 'config.json')], { stdio: 'ignore' });
  const read = async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'));
  return { books: await read('books.json'), lexicons: await read('lexicons.json') };
}

let once;
const imported = async () => (await (once ??= importedAll())).books[0];

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

/** A verse's text, its tags' words cut out of it, and their parts. */
function tagged(verse) {
  const text = verse.runs.map(([run]) => run).join('');
  return verse.tags.map(([at, ...parts]) => [text.slice(at, at + parts.reduce((sum, [length]) => sum + length, 0)), parts]);
}

test('a word keeps its Strong\'s number, where it stands in the text', async () => {
  const verse = (await imported()).chapters[0].verses[0];
  // Notes after the words and between them leave the places as the text has them.
  assert.deepEqual(verse.tags, [[7, [9, 'H7225']], [17, [3, 'H0430']]]);
  assert.deepEqual(tagged(verse).map(([word]) => word), ['beginning', 'God']);
  assert.equal(verse.notes[0].at, 16);
  // Words without numbers have no tags.
  assert.equal((await imported()).chapters[0].verses[3].tags, undefined);
});

test('a Hebrew word keeps its parts: the lemmas\' numbers and the grammar of each', async () => {
  const [first, second] = (await once).books[1].chapters[0].verses;
  // וַֽיְהִי֙: a conjunction, and a verb of H1961; דְּבַר־יְהוָ֔ה: two words, joined by a maqaf.
  assert.deepEqual(first.tags[0], [0, [3, null, 'HC'], [6, 'H1961', 'HVqw3ms']]);
  assert.deepEqual(first.tags.slice(1, 3), [[10, [6, 'H1697', 'HNcmsc']], [17, [7, 'H3068', 'HNp']]]);
  assert.equal(first.tags[5][1][1], 'H1121a', 'a number that tells words apart keeps its letter');
  // A word written one way and read another: the word read is tagged, the written one isn't.
  const words = tagged(second);
  assert.equal(words.length, 4);
  assert.ok(second.runs.some(([, role]) => role === 'ketiv'));
  assert.equal(words[1][0], 'לִֽידוּת֗וּן');
  assert.deepEqual(words[0][1], [[2, null, 'HRd'], [10, 'H5329', 'HVprmsa']]);
});

test('the lexicon has the entries of the numbers the books have, and their grammar spelled out', async () => {
  const [lexicon] = (await once).lexicons;
  const entry = (number) => lexicon.entries.find((candidate) => candidate.number === number);
  assert.equal(lexicon.language, 'en');
  // STEPBible's word, how it is read and its gloss; Strong's definition, where the word comes from in the color of what is said of it.
  const be = entry('H1961');
  assert.deepEqual([be.lemma, be.language, be.transliteration, be.gloss], ['הָיָה', 'he', 'ha.yah', 'to be']);
  assert.ok(be.definition[0].text.startsWith('to exist, i.e. be or become'));
  assert.deepEqual(be.definition.find((run) => run.language), { text: 'הָוָא', role: 'origin', language: 'he' });
  assert.equal(entry('H1121a').gloss, 'son: child');
  // The Greek, which no book here has, is left out; so are numbers the sources lack.
  assert.equal(entry('G0976'), undefined);
  assert.equal(entry('H1697'), undefined);
  assert.equal(lexicon.grammar.HVqw3ms, 'Verb, Qal, sequential imperfect (wayyiqtol), third person masculine singular');
  assert.equal(lexicon.grammar.HRd, 'Preposition, with the definite article');
  assert.equal(lexicon.grammar.HNcmsc, 'Noun, common, masculine singular, construct');
  assert.equal(lexicon.grammar.HVprmsa, 'Verb, Piel, active participle, masculine singular, absolute');
});
