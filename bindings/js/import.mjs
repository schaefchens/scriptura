#!/usr/bin/env node
// Imports scripture as the books Scriptura reads – a JSON array in the shape of the core's
// src/model.rs – and fetches the fonts the reader sets them in:
//
//   scriptura-import <config.json>
//
// The config names what to take and where it goes, paths relative to it:
//
//   {
//     "books": "texts/books.json",
//     "fonts": "fonts",
//     "bibles": [{ "usfm": "<zip from eBible.org>", "work": "World English Bible", "language": "en",
//                  "direction": "ltr", "books": [{ "id": "jonah", "code": "JON" }] }],
//     "quran": { "surahs": [1, 112] }
//   }
//
// Bibles come as USFM in a zip, as eBible.org has them, or as OSIS (`"osis": "<base URL>"`, a book
// as `file` there), as the Open Scriptures Hebrew Bible has them. An edition writing numbers in
// other digits gives their zero as `digits`, such as 1632 (0x660) for Arabic-Indic; a book can
// have a `title` the source lacks. Surahs come from Tanzil's text with quran-tajweed's rules laid
// over it, titled as Tanzil names them. `fonts` fetches the reader's fonts per script, and any
// `extraFonts` ({ family, url, file? }), named after their PostScript names, so one family name
// works on iOS, Android and the web.
//
// Texts and fonts are licensed one by one: check each before passing it on, with the notice it
// asks for – the SBLGNT's and Tanzil's do.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import scriptFonts from './fonts.json' with { type: 'json' };

const TANZIL_METADATA = 'https://tanzil.net/res/text/metadata/quran-data.js';
// Tanzil's Uthmani text as of April 2017: quran-tajweed's rules count code points in this copy.
const TANZIL_TEXT = 'https://github.com/cpfair/quran-tajweed/files/7281388/quran-uthmani.txt';
const TAJWEED_RULES =
  'https://raw.githubusercontent.com/cpfair/quran-tajweed/master/output/tajweed.hafs.uthmani-pause-sajdah.json';
const ARABIC_INDIC = 0x660;

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: scriptura-import <config.json>');
  process.exit(1);
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const relative = (path) => resolve(dirname(configPath), path);

/** A number in the digits that start at `zero`, such as ٢ for 2 in Arabic-Indic. */
const inDigits = (number, zero) =>
  zero ? String(number).replace(/\d/g, (digit) => String.fromCharCode(zero + Number(digit))) : String(number);

/** A verse's text in runs, each with the tajweed rule that colors it; where rules overlap, the shorter wins. */
function tajweedRuns(text, annotations) {
  const letters = Array.from(text);
  const rules = letters.map(() => null);
  for (const { rule, start, end } of annotations.toSorted((a, b) => b.end - b.start - (a.end - a.start))) {
    rules.fill(rule, start, end);
  }
  const runs = [];
  letters.forEach((letter, index) => {
    if (index > 0 && rules[index] === rules[index - 1]) runs.at(-1)[0] += letter;
    else runs.push([letter, rules[index]]);
  });
  return runs;
}

// USFM markers whose text goes on with the verse: paragraphs, lines of poetry and list items only
// lay it out. The text of all others, such as titles, headings and references, is left out.
const LAYOUT = /^(?:p|pi\d?|pm[cor]?|po|pr|pc|m|mi|nb|b|q\d?|q[mrc]\d?|li\d?|cls)$/;
// USFM character styles: their markers go, their text stays.
const CHARACTER_STYLES = 'add|bd|bdit|bk|em|it|k|nd|no|ord|pn|qs|qt|sc|sig|tl|wj';

/** A book's title and chapters from USFM: the verses' text, without notes, headings or layout. */
function parseUsfm(usfm, digits) {
  const plain = usfm
    // Footnotes and cross-references, then word attributes and character styles.
    .replace(/\\(f|fe|x) .*?\\\1\*/gs, '')
    .replace(/\\\+?w ([^|\\]*)(?:\|[^\\]*)?\\\+?w\*/g, '$1')
    .replace(new RegExp(`\\\\\\+?(?:${CHARACTER_STYLES})(?: |\\*)`, 'g'), '');
  // What is left are markers, each followed by its text.
  const parts = plain.split(/\\([a-z]+\d*)\s*/);
  const chapters = [];
  let title;
  let verse;
  for (let i = 1; i < parts.length; i += 2) {
    const [marker, text] = [parts[i], parts[i + 1]];
    if (marker === 'h') title = text.trim();
    else if (marker === 'c') {
      const number = parseInt(text);
      chapters.push({ number, label: inDigits(number, digits), verses: [] });
      verse = undefined;
    } else if (marker === 'v') {
      const [, label, rest] = text.match(/^(\S+)\s*(.*)$/s);
      verse = { number: parseInt(label), label: inDigits(label, digits), text: rest };
      chapters.at(-1).verses.push(verse);
    } else if (verse && LAYOUT.test(marker)) verse.text += ` ${text}`;
  }
  for (const { verses } of chapters) {
    for (const verse of verses) {
      const text = verse.text
        // The SBLGNT's signs for its apparatus, which isn't imported.
        .replace(/[⸀-⸃]/g, '')
        // A translator's note, as the Persian Old Version has one in Psalm 121:1.
        .replace(/\[\*[^\]]*\]/g, '')
        // The edition's own number for a verse it numbers otherwise, as Luther 1912 has "[2:1]"
        // before what English Bibles number Jonah 1:17.
        .replace(/^\s*\[\d+:\d+\]/, '');
      verse.runs = [[text.replace(/\s+/g, ' ').trim(), null]];
      delete verse.text;
    }
  }
  return { title, chapters };
}

/** Runs spaced as running text is: one space between words, none at the start or the end. */
function tidy(runs) {
  const tidied = [];
  for (const [text, rule] of runs) {
    let run = text.replace(/\s+/g, ' ');
    if ((tidied.at(-1)?.[0] ?? ' ').endsWith(' ')) run = run.trimStart();
    if (run) tidied.push([run, rule]);
  }
  if (tidied.length > 0) tidied.at(-1)[0] = tidied.at(-1)[0].trimEnd();
  return tidied;
}

/**
 * A book's chapters from the Open Scriptures Hebrew Bible's OSIS: each verse's words, with its
 * maqaf, paseq and sof pasuq. A word written one way and read another (ketiv and qere) shows the
 * written form in parentheses, as no word of the verse, and then the word read. Paragraph marks
 * and the editors' notes are left out – but for those giving the verse's number in the KJV,
 * where it differs, which a verse keeps as `kjv`.
 */
function parseOsis(osis) {
  const chapters = [];
  for (const [, chapter, verse, body] of osis.matchAll(/<verse osisID="[^.]+\.(\d+)\.(\d+)">(.*?)<\/verse>/gs)) {
    const kjv = body.match(/<note>KJV:[^.]+\.(\d+)\.(\d+)<\/note>/);
    if (chapters.at(-1)?.number !== Number(chapter)) chapters.push({ number: Number(chapter), label: chapter, verses: [] });
    // A word's parts are split by slashes; segments carry the marks between words.
    const text = (xml) =>
      xml
        .replace(/<w [^>]*>([^<]*)<\/w>/g, (_, word) => word.replaceAll('/', ''))
        .replace(/<seg type="x-(?:pe|samekh)">[^<]*<\/seg>/g, '')
        .replace(/<seg [^>]*>([^<]*)<\/seg>/g, '$1')
        .replace(/<[^>]+>/g, '');
    const pieces = body.replace(/<note(?! type="variant")[^>]*>.*?<\/note>/gs, '').split(
      /<w type="x-ketiv"[^>]*>([^<]*)<\/w>\s*<note type="variant">.*?<rdg type="x-qere">(.*?)<\/rdg>.*?<\/note>/s,
    );
    // The text before each written word, the written word and the one read, and the text after.
    const runs = [[text(pieces[0]), null]];
    for (let i = 1; i < pieces.length; i += 3) {
      runs.push([' ', null], [`(${pieces[i].replaceAll('/', '')})`, 'ketiv'], [` ${text(pieces[i + 1])}${text(pieces[i + 2])}`, null]);
    }
    chapters.at(-1).verses.push({ number: Number(verse), label: verse, runs: tidy(runs), ...(kjv && { kjv: [Number(kjv[1]), Number(kjv[2])] }) });
  }
  // A verse without a note is numbered as in the KJV – unless another took its number there: the
  // KJV leaves it unnumbered, as it does a psalm's title, which then counts as verse 0.
  const taken = new Set(chapters.flatMap(({ verses }) => verses.filter(({ kjv }) => kjv).map(({ kjv }) => kjv.join(':'))));
  for (const { number, verses } of chapters) {
    for (const verse of verses) {
      if (!verse.kjv && taken.has(`${number}:${verse.number}`)) verse.kjv = [number, 0];
    }
  }
  return chapters;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response;
}

const downloads = await mkdtemp(join(tmpdir(), 'scriptura-'));

/** A downloaded zip's path, to take files out of it. */
async function downloadZip(url, name) {
  const zip = join(downloads, name);
  await writeFile(zip, Buffer.from(await (await download(url)).arrayBuffer()));
  return zip;
}

let fontCount = 0;
if (config.fonts) {
  const directory = relative(config.fonts);
  await mkdir(directory, { recursive: true });
  const files = new Map([...scriptFonts, ...(config.extraFonts ?? [])].map((font) => [font.family, font]));
  for (const { family, url, file } of files.values()) {
    // Some come zipped, with the font as one file among its documentation.
    const font = file ? execFileSync('unzip', ['-p', await downloadZip(url, `${family}.zip`), file]) : Buffer.from(await (await download(url)).arrayBuffer());
    await writeFile(join(directory, `${family}.ttf`), font);
  }
  fontCount = files.size;
}

const books = [];
for (const { usfm, osis, work, language, direction, digits, books: wanted } of config.bibles ?? []) {
  const zip = usfm && (await downloadZip(usfm, `${books.length}.zip`));
  for (const { id, code, file, title } of wanted) {
    // eBible.org names the files like 33-JONeng-web.usfm.
    const book = usfm
      ? parseUsfm(execFileSync('unzip', ['-p', zip, `*-${code}*.usfm`], { encoding: 'utf8', maxBuffer: 1 << 28 }), digits)
      : { chapters: parseOsis(await (await download(`${osis}${file}.xml`)).text()) };
    // The book's USFM code, which every edition shares, reads them along.
    books.push({ id, code, title: title ?? book.title, work, direction, language, chapters: book.chapters });
  }
}

if (config.quran) {
  const font = scriptFonts.find(({ quran }) => quran);
  const metadata = await (await download(TANZIL_METADATA)).text();
  // Tanzil's metadata lists each surah as [start, verses, order, rukus, name, transliteration, …].
  const start = metadata.indexOf('QuranData.Sura = [');
  const titles = [...metadata.slice(start, metadata.indexOf('];', start)).matchAll(/\[\d+, \d+, \d+, \d+, '([^']*)'/g)].map(([, title]) => title);
  // One verse per line, as surah|verse|text, below the notice.
  const quran = new Map(
    (await (await download(TANZIL_TEXT)).text())
      .split('\n')
      .filter((line) => /^\d/.test(line))
      .map((line) => line.split('|'))
      .map(([surah, verse, text]) => [`${surah}:${verse}`, text.trim()]),
  );
  const rules = new Map((await (await download(TAJWEED_RULES)).json()).map(({ surah, ayah, annotations }) => [`${surah}:${ayah}`, annotations]));
  for (const surah of config.quran.surahs) {
    const verses = [];
    for (let verse = 1; quran.has(`${surah}:${verse}`); verse++) {
      const key = `${surah}:${verse}`;
      let [letters, annotations] = [Array.from(quran.get(key)), rules.get(key) ?? []];
      // Tanzil's text opens the first verse of every surah but Al-Fatiha (whose first verse it is)
      // and At-Tawba with the basmala's four words, which the mushaf doesn't count. They become
      // verse 0, so verse 1 and its words match the mushaf.
      if (verse === 1 && surah !== 1 && surah !== 9) {
        const basmala = letters.join('').split(' ').slice(0, 4).join(' ');
        const length = Array.from(basmala).length + 1;
        verses.push({ number: 0, label: '', runs: tajweedRuns(basmala, annotations.filter(({ end }) => end <= length)) });
        letters = letters.slice(length);
        annotations = annotations
          .filter(({ start }) => start >= length)
          .map((annotation) => ({ ...annotation, start: annotation.start - length, end: annotation.end - length }));
      }
      // Arabic-Indic digits, as a mushaf writes them.
      verses.push({ number: verse, label: inDigits(verse, ARABIC_INDIC), runs: tajweedRuns(letters.join(''), annotations) });
    }
    books.push({
      id: `quran-${surah}`,
      title: titles[surah - 1],
      work: config.quran.work ?? 'القرآن',
      direction: 'rtl',
      language: 'ar',
      font: font.family,
      verseNumbers: 'end',
      verseNumberPrefix: font.verseNumberPrefix ?? '',
      chapters: [{ number: surah, label: inDigits(surah, ARABIC_INDIC), verses }],
    });
  }
}

const out = relative(config.books);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(books));
console.log(`Imported ${books.length} books into ${out}${fontCount ? ` and ${fontCount} fonts into ${relative(config.fonts)}` : ''}.`);
