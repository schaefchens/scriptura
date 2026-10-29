import {
  addScriptFonts,
  Library,
  loadScriptura,
  type MoveStep,
  type Passage,
  palette,
  Reader,
  type ReaderHandle,
  SCRIPT_FONTS,
  type SpeechChange,
  type WordPosition,
} from '@schaefchens/scriptura-react';
import { StrictMode, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// The books, recordings and fonts the import tool fetched: npm run texts.
await loadScriptura();
const library = new Library();
await library.fetch('/texts/books.json');
await library.fetchRecordings('/recordings/recordings.json');
addScriptFonts('/fonts/');

/** Passages of several books on one page: those read along each in rows, the surah as it is. */
const SIGN_OF_JONAH: Passage[] = [
  { book: 'jonah-he', chapter: 2, from: 1, to: 3 },
  { book: 'matthew-el', chapter: 12, from: 39, to: 41 },
  { book: 'quran-37', from: 139, to: 144 },
];

/** How fast the voice reads, as a multiple of its own rate. */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const MOVES: [MoveStep, string][] = [
  ['verse-1', '◀ verse'],
  ['word-1', '◀ word'],
  ['word+1', 'word ▶'],
  ['verse+1', 'verse ▶'],
];

function App() {
  const books = useMemo(() => library.books(), []);
  const [book, setBook] = useState(books[0]?.id ?? '');
  const [size, setSize] = useState(24);
  const [paging, setPaging] = useState<'scroll' | 'pages'>('scroll');
  const [dark, setDark] = useState(false);
  const [versePerLine, setVersePerLine] = useState(false);
  const [companions, setCompanions] = useState<string[]>([]);
  const [parallel, setParallel] = useState<'inline' | 'columns'>('inline');
  const [position, setPosition] = useState<WordPosition>();
  const [speech, setSpeech] = useState<SpeechChange>({ state: 'stopped' });
  const [speakAlong, setSpeakAlong] = useState(false);
  const [rate, setRate] = useState(1);
  // Chapters with a recording are played from it, or else read by the browser's voices too.
  const [recited, setRecited] = useState(true);
  const [goTo, setGoTo] = useState('2:1');
  const reader = useRef<ReaderHandle>(null);

  const passages = useMemo(() => (book === 'sign' ? SIGN_OF_JONAH : [{ book }]), [book]);
  // Other editions of the passages' books, which can be read along with them.
  const codes = new Set(passages.map((passage) => books.find(({ id }) => id === passage.book)?.code));
  const editions = books.filter(({ id, code }) => code && codes.has(code) && !passages.some((passage) => passage.book === id));
  const along = companions.filter((id) => editions.some((edition) => edition.id === id));
  const colors = useMemo(() => palette(dark ? 'dark' : 'light', 21), [dark]);
  const title = (id: string) => books.find((candidate) => candidate.id === id)?.title;
  const toggle = (id: string) => setCompanions(along.includes(id) ? along.filter((other) => other !== id) : [...along, id]);
  // A chapter and verse of the first passage's book, such as 2:1, to jump to: its first word.
  const jump = () => {
    const [chapter, verse] = goTo.split(':').map(Number);
    reader.current?.jump({ passage: 0, book: passages[0].book, chapter, verse, word: 0 });
  };
  // Each change tells what is new; while the voice speaks, what it told before still holds.
  const onSpeechChange = (change: SpeechChange) => setSpeech((last) => (change.state === 'speaking' ? { ...last, ...change } : change));

  return (
    <main style={{ background: colors.background, color: colors.text }}>
      <header>
        <select value={book} onChange={(event) => setBook(event.target.value)}>
          <option value="sign">The sign of Jonah</option>
          {books.map(({ id, title, work }) => (
            <option key={id} value={id}>{`${title} · ${work}`}</option>
          ))}
        </select>
        <button onClick={() => setSize(Math.max(12, size - 4))}>A−</button>
        <button onClick={() => setSize(Math.min(56, size + 4))}>A+</button>
        <button onClick={() => setPaging(paging === 'scroll' ? 'pages' : 'scroll')}>{paging === 'scroll' ? 'Pages' : 'Scroll'}</button>
        <button onClick={() => setDark(!dark)}>{dark ? 'Light' : 'Dark'}</button>
        <button onClick={() => setVersePerLine(!versePerLine)}>{versePerLine ? 'Running text' : 'Verse per line'}</button>
        {editions.map(({ id, title, work }) => (
          <label key={id}>
            <input type="checkbox" checked={along.includes(id)} onChange={() => toggle(id)} /> {passages.length > 1 ? `${title} · ${work}` : work}
          </label>
        ))}
        {along.length > 0 && (
          <button onClick={() => setParallel(parallel === 'inline' ? 'columns' : 'inline')}>{parallel === 'inline' ? 'Side by side' : 'Inline'}</button>
        )}
        {along.length > 0 && (
          <label>
            <input type="checkbox" checked={speakAlong} onChange={() => setSpeakAlong(!speakAlong)} /> Speak along
          </label>
        )}
        {MOVES.map(([step, label]) => (
          <button key={step} onClick={() => reader.current?.move(step)}>{label}</button>
        ))}
        <form onSubmit={(event) => { event.preventDefault(); jump(); }}>
          <input value={goTo} onChange={(event) => setGoTo(event.target.value)} size={5} /> <button>Go</button>
        </form>
        {speech.state === 'speaking' ? (
          <button onClick={() => reader.current?.pause()}>Pause</button>
        ) : (
          <button onClick={() => reader.current?.play()}>Read aloud</button>
        )}
        {speech.state !== 'stopped' && <button onClick={() => reader.current?.stop()}>Stop</button>}
        <button onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])}>{rate}×</button>
        <label>
          <input type="checkbox" checked={recited} onChange={() => setRecited(!recited)} /> Recordings
        </label>
        {speech.state === 'speaking' && speech.following === false && <button onClick={() => reader.current?.follow()}>Back to the voice</button>}
        <output dir="auto">
          {position ? `${title(position.book)}‎ ${position.chapter}:${position.verse} · word ${position.word + 1}` : 'Tap a word'}
          {speech.state === 'speaking' && speech.recording && ` · ${speech.recording}`}
          {speech.firstSound !== undefined && ` · first sound after ${Math.round(speech.firstSound)} ms`}
          {speech.unvoiced?.length ? ` · no voice for ${speech.unvoiced.join(', ')}` : ''}
        </output>
      </header>
      <Reader
        ref={reader}
        className="reader"
        library={library}
        passages={passages}
        fontSize={size}
        paging={paging}
        columns={paging === 'pages' ? 2 : 1}
        colors={colors}
        fonts={SCRIPT_FONTS}
        versePerLine={versePerLine}
        companions={along}
        parallel={parallel}
        speakAlong={speakAlong}
        speechRate={rate}
        recordedVoices={recited ? undefined : []}
        onWordChange={setPosition}
        onSpeechChange={onSpeechChange}
      />
      <footer>
        World English Bible, Luther 1912 and Smith &amp; Van Dyck, public domain; the Westminster Leningrad Codex from the{' '}
        <a href="https://github.com/openscriptures/morphhb">Open Scriptures Hebrew Bible</a>; the SBLGNT, © 2010 Society of Biblical
        Literature and Logos Bible Software, CC BY 4.0; the Quran from <a href="https://tanzil.net">Tanzil</a> (CC BY 3.0) with{' '}
        <a href="https://github.com/cpfair/quran-tajweed">quran-tajweed</a>'s rules (CC BY 4.0). Recited by Mishary Rashid Alafasy, from{' '}
        <a href="https://everyayah.com">EveryAyah</a>; its words timed by <a href="https://github.com/cpfair/quran-align">quran-align</a>, ©
        2016 Collin Fair, CC BY 4.0.
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
