// A lexicon for the numbers books' words are tagged with, in the shape of the core's src/model.rs:
// STEPBible's brief lexicons – TBESH for Hebrew, TBESG for Greek – give each entry its word, how it
// is read and its gloss, and the Greek its definition, Abbott-Smith's (1922); a Hebrew entry's
// definition is Strong's own (1890), as Open Scriptures has it, for TBESH's are Online Bible's,
// which asks for permission first. The Open Scriptures Hebrew Bible's grammar codes are spelled
// out as its own table of them reads.
//
// STEPBible's data is CC BY 4.0: credit Tyndale House, Cambridge and STEPBible.org, with a link to
// https://github.com/STEPBible/STEPBible-Data. Open Scriptures' Strong's Hebrew Dictionary is CC BY-SA.

const STEPBIBLE = 'https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master/';
export const LEXICON_SOURCES = {
  hebrew: `${STEPBIBLE}Lexicons/TBESH%20-%20Translators%20Brief%20lexicon%20of%20Extended%20Strongs%20for%20Hebrew%20-%20STEPBible.org%20CC%20BY.txt`,
  greek: `${STEPBIBLE}Lexicons/TBESG%20-%20Translators%20Brief%20lexicon%20of%20Extended%20Strongs%20for%20Greek%20-%20STEPBible.org%20CC%20BY.txt`,
  strongsHebrew: 'https://raw.githubusercontent.com/openscriptures/strongs/master/hebrew/strongs-hebrew-dictionary.js',
};

// Its name, crediting its sources and noting what was changed, as STEPBible's license asks.
const TITLE =
  'STEPBible.org’s brief lexicons TBESH and TBESG, by Tyndale House, Cambridge (CC BY 4.0; github.com/STEPBible/STEPBible-Data), with Abbott-Smith’s Greek definitions – changed: the first sense of each number only, the markup made plain, and for the Hebrew Strong’s definitions (Open Scriptures, CC BY-SA) in place of TBESH’s';

/**
 * The lexicon's entries for `numbers` – or for all its numbers, with `all` – and `codes`, the
 * grammar codes words give, spelled out. `read` fetches a source's text, by URL or path.
 */
export async function lexicon({ numbers, codes, all = false, sources = {}, read }) {
  const { hebrew, greek, strongsHebrew } = { ...LEXICON_SOURCES, ...sources };
  const rows = new Map([...stepRows(await read(hebrew)), ...stepRows(await read(greek))]);
  const strongs = strongsDictionary(await read(strongsHebrew));
  const wanted = all ? [...new Set([...rows.keys(), ...numbers])] : [...numbers];
  const entries = [];
  const missing = [];
  for (const number of wanted.sort()) {
    // A number without the letter that tells words of it apart takes the first word's entry: H1121 is H1121a's, a son.
    const row = rows.get(number) ?? rows.get(`${number}a`);
    if (!row) {
      missing.push(number);
      continue;
    }
    const hebrewWord = number.startsWith('H');
    entries.push({
      number,
      lemma: row.lemma,
      language: hebrewWord ? 'he' : 'el',
      ...(row.transliteration && { transliteration: row.transliteration }),
      gloss: row.gloss,
      definition: hebrewWord ? strongsRuns(strongs.get(Number(number.slice(1, 5)))) : abbottSmithRuns(row.meaning),
    });
  }
  const grammar = Object.fromEntries([...codes].sort().map((code) => [code, spellOut(code)]).filter(([, text]) => text));
  return { lexicon: { id: 'stepbible', title: TITLE, language: 'en', entries, grammar }, missing };
}

/** STEPBible's lexicon rows by number – the first row of each, its main sense – each with its word, how it is read, its gloss and its meaning. */
function stepRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const [number, , , lemma, transliteration, , gloss, meaning] = line.split('\t');
    if (!/^[HG]\d{4}[a-z]?$/.test(number) || rows.has(number)) continue;
    rows.set(number, { lemma: lemma.trim(), transliteration: transliteration?.trim(), gloss: gloss?.trim() ?? '', meaning: meaning?.trim() ?? '' });
  }
  return rows;
}

/** Strong's Hebrew Dictionary as Open Scriptures has it – a script assigning one object – by number. */
function strongsDictionary(script) {
  const json = script.slice(script.indexOf('{', script.indexOf('=')), script.lastIndexOf('}') + 1);
  return new Map(Object.entries(JSON.parse(json)).map(([key, entry]) => [Number(key.slice(1)), entry]));
}

/** A Strong's entry as runs: its definition; then, in the color of what it is said of, where the word comes from and how the KJV renders it. */
function strongsRuns(entry) {
  if (!entry) return [];
  const clean = (text) => text?.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  const lines = [
    clean(entry.strongs_def) && scriptRuns(clean(entry.strongs_def)),
    clean(entry.derivation) && scriptRuns(clean(entry.derivation), { role: 'origin' }),
    clean(entry.kjv_def) && [{ text: 'KJV: ', role: 'origin' }, ...scriptRuns(clean(entry.kjv_def), { role: 'origin' })],
  ].filter(Boolean);
  return joined(lines.flatMap((runs, index) => (index > 0 ? [{ text: '\n' }, ...runs] : runs)));
}

// STEPBible's books, as their references name them, where their USFM codes aren't the names in capitals.
const BOOK_CODES = { JUDE: 'JUD', LUKE: 'LUK', MARK: 'MRK', JOHN: 'JHN', MATT: 'MAT', ACTS: 'ACT', PHIL: 'PHP', '1COR': '1CO', '1TIM': '1TI', '1PET': '1PE', '1JO': '1JN', PSS: 'PSA', '1MAC': '1MA', '2MAC': '2MA', '3MAC': '3MA', '4MAC': '4MA', '3KI': '1KI', '4KI': '2KI' };

/** A reference as STEPBible writes it – Mat.1.1, Gen.4.2-10 – as verses a note's run refers to; none where it reads otherwise. */
function referenceOf(reference) {
  const found = reference.match(/^(\w+)\.(\d+)(?:\.(\d+))?(?:-(\d+))?/);
  if (!found) return undefined;
  const [, book, chapter, verse, to] = found;
  const code = BOOK_CODES[book.toUpperCase()] ?? book.toUpperCase();
  return { book: code, chapter: Number(chapter), ...(verse && { verse: Number(verse) }), ...(to && { to: Number(to) }) };
}

const ENTITIES = { '&gt;': '>', '&lt;': '<', '&amp;': '&', '&quot;': '"', '&nbsp;': ' ' };

/** Abbott-Smith's definition, as TBESG marks it up, as runs: line breaks, bold and italics, each reference a link to its verses, Greek and Hebrew words in their languages. */
function abbottSmithRuns(meaning) {
  const runs = [];
  let strong = 0;
  let emphasis = 0;
  let target;
  for (const token of meaning.split(/(<[^>]*>)/)) {
    if (token.startsWith('<')) {
      const tag = token.toLowerCase();
      if (/^<br\s*\/?>$/.test(tag)) runs.push({ text: '\n' });
      else if (tag === '<lb />') runs.push({ text: ' ' });
      else if (tag === '<b>') strong++;
      else if (tag === '</b>') strong = Math.max(0, strong - 1);
      else if (tag === '<i>') emphasis++;
      else if (tag === '</i>') emphasis = Math.max(0, emphasis - 1);
      else if (tag.startsWith('<ref=')) target = referenceOf(token.match(/<ref='([^']*)'/i)?.[1] ?? '');
      else if (tag === '</ref>') target = undefined;
      continue;
    }
    const text = token.replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity).replaceAll('__', '');
    if (!text) continue;
    const role = strong ? 'strong' : emphasis ? 'emphasis' : undefined;
    runs.push(...scriptRuns(text, { ...(role && { role }), ...(target && { target }) }));
  }
  return joined(runs);
}

/** Text as runs, Greek and Hebrew words in their languages – so they are set in their fonts – the rest as it is. */
function scriptRuns(text, extra = {}) {
  const runs = [];
  let at = 0;
  for (const found of text.matchAll(/(\p{Script=Greek}[\p{Script=Greek}\p{M}]*(?:[\s,.·;-]+\p{Script=Greek}[\p{Script=Greek}\p{M}]*)*)|(\p{Script=Hebrew}[\p{Script=Hebrew}\p{M}]*(?:[\s,־-]+\p{Script=Hebrew}[\p{Script=Hebrew}\p{M}]*)*)/gu)) {
    if (found.index > at) runs.push({ text: text.slice(at, found.index), ...extra });
    runs.push({ text: found[0], ...extra, language: found[1] ? 'el' : 'he' });
    at = found.index + found[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), ...extra });
  return runs;
}

/** Runs with spaces tidied and alike neighbours joined: paragraphs without spaces at their ends, and none empty. */
function joined(runs) {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    const paragraphStart = !last || last.text === '\n';
    let text = run.text === '\n' ? '\n' : run.text.replace(/\s+/g, ' ');
    if (text !== '\n' && (paragraphStart || last.text.endsWith(' '))) text = text.trimStart();
    if (!text) continue;
    if (text === '\n') {
      if (last) last.text = last.text === '\n' ? last.text : last.text.trimEnd();
      if (last && last.text !== '\n') out.push({ text });
      continue;
    }
    const alike = last && last.text !== '\n' && last.role === run.role && last.language === run.language && JSON.stringify(last.target) === JSON.stringify(run.target);
    if (alike) last.text += text;
    else out.push({ ...run, text });
  }
  while (out.at(-1)?.text === '\n') out.pop();
  if (out.length > 0) out.at(-1).text = out.at(-1).text.trimEnd();
  return out.filter(({ text }) => text);
}

// The Open Scriptures Hebrew Bible's grammar codes, as its table of them has them
// (https://hb.openscriptures.org/parsing/HebrewMorphologyCodes.html, CC BY 4.0).
const PARTS_OF_SPEECH = { A: 'adjective', C: 'conjunction', D: 'adverb', N: 'noun', P: 'pronoun', R: 'preposition', S: 'suffix', T: 'particle', V: 'verb' };
const TYPES = {
  A: { c: 'cardinal number', g: 'gentilic', o: 'ordinal number' },
  N: { c: 'common', g: 'gentilic', p: 'proper name' },
  P: { d: 'demonstrative', f: 'indefinite', i: 'interrogative', p: 'personal', r: 'relative' },
  R: { d: 'with the definite article' },
  S: { d: 'directional he', h: 'paragogic he', n: 'paragogic nun', p: 'pronominal' },
  T: { a: 'affirmation', d: 'definite article', e: 'exhortation', i: 'interrogative', j: 'interjection', m: 'demonstrative', n: 'negative', o: 'direct object marker', r: 'relative' },
};
const STEMS = {
  H: { q: 'Qal', N: 'Niphal', p: 'Piel', P: 'Pual', h: 'Hiphil', H: 'Hophal', t: 'Hithpael', o: 'Polel', O: 'Polal', r: 'Hithpolel', m: 'Poel', M: 'Poal', k: 'Palel', K: 'Pulal', u: 'Hothpaal', c: 'Tiphil', v: 'Hishtaphel', w: 'Nithpalel', y: 'Nithpoel', z: 'Hithpoel', Q: 'Qal passive', l: 'Pilpel', L: 'Polpal', f: 'Hithpalpel', D: 'Nithpael', j: 'Pealal', i: 'Pilel' },
  A: { q: 'Peal', Q: 'Peil', u: 'Hithpeel', p: 'Pael', P: 'Ithpaal', M: 'Hithpaal', a: 'Aphel', h: 'Haphel', s: 'Saphel', e: 'Shaphel', H: 'Hophal', i: 'Ithpeel', t: 'Hishtaphel', b: 'Hephal', c: 'Tiphel', m: 'Poel', l: 'Palpel', L: 'Ithpalpel', O: 'Ithpolel', G: 'Ittaphal', v: 'Ishtaphel', w: 'Hithaphel', o: 'Polel', z: 'Ithpoel', r: 'Hithpolel', f: 'Hithpalpel' },
};
const CONJUGATIONS = {
  p: 'perfect (qatal)',
  q: 'sequential perfect (weqatal)',
  i: 'imperfect (yiqtol)',
  w: 'sequential imperfect (wayyiqtol)',
  h: 'cohortative',
  j: 'jussive',
  v: 'imperative',
  r: 'active participle',
  s: 'passive participle',
  a: 'infinitive absolute',
  c: 'infinitive construct',
};
const PERSONS = { 1: 'first person', 2: 'second person', 3: 'third person' };
const GENDERS = { b: 'masculine or feminine', c: 'common', f: 'feminine', m: 'masculine' };
const NUMBERS = { d: 'dual', p: 'plural', s: 'singular' };
const STATES = { a: 'absolute', c: 'construct', d: 'determined' };

/** A grammar code of one part of a word – HVqw3ms – spelled out: "Verb, Qal, sequential imperfect (wayyiqtol), third person masculine singular". Empty for a code it can't read. */
export function spellOut(code) {
  const [language, part, ...rest] = code;
  const speech = PARTS_OF_SPEECH[part];
  if (!speech || !STEMS[language]) return '';
  const said = [];
  const take = (table) => {
    const letter = rest.shift();
    return letter && letter !== 'x' ? table[letter] : undefined;
  };
  if (part === 'V') {
    said.push(take(STEMS[language]), take(CONJUGATIONS));
  } else if (TYPES[part]) {
    said.push(take(TYPES[part]));
  }
  // Person, gender and number as one phrase, and the state after it; a participle takes no person.
  const person = part === 'V' && /[rsac]/.test(code[3]) ? undefined : /[123]/.test(rest[0] ?? '') ? take(PERSONS) : undefined;
  const agreement = [person, take(GENDERS), take(NUMBERS)].filter(Boolean).join(' ');
  said.push(agreement, take(STATES));
  const head = `${language === 'A' ? 'Aramaic ' : ''}${speech}`;
  const text = [head, ...said.filter(Boolean)].join(', ');
  return text[0].toUpperCase() + text.slice(1);
}
