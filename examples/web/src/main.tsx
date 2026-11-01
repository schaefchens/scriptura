import {
  addScriptFonts,
  Library,
  loadScriptura,
  type Mark,
  MARK_COLORS,
  type MarkEnd,
  type MoveStep,
  type Passage,
  palette,
  Reader,
  type ReaderHandle,
  type ReferenceTarget,
  SCRIPT_FONTS,
  type Selection,
  type SpeechChange,
  type WordPosition,
} from '@schaefchens/scriptura-react';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// The books, recordings and fonts the import tool fetched: npm run texts.
await loadScriptura();
const library = new Library();
await library.fetch('/texts/books.json');
await library.fetchRecordings('/recordings/recordings.json');
addScriptFonts('/fonts/');
// A font of ornamental initials for the drop caps, Cinzel Decorative (OFL), fetched with the others.
const ORNATE_FONT = 'CinzelDecorative-Regular';
document.fonts.add(new FontFace(ORNATE_FONT, `url(/fonts/${ORNATE_FONT}.ttf)`));

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
  // Who reads a recording, by the name its voice has.
  const voiceNames = useMemo(() => new Map(library.recordings().map(({ voice, name }) => [voice, name ?? voice])), []);
  // Chapters with a recording of this voice are played from it; the rest, or all with none, the browser's voices read.
  const [recited, setRecited] = useState(() => [...voiceNames.keys()][0] ?? '');
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
  const [goTo, setGoTo] = useState('2:1');
  // Notes as marks that open where they stand, shown in full there, or left out.
  const [notes, setNotes] = useState<'marks' | 'inline' | 'none'>('marks');
  // Drop caps: none, the first letter in the text's font, or in the font of ornamental initials.
  const [dropCaps, setDropCaps] = useState<'off' | 'on' | 'ornate'>('on');
  // A cross reference to a book the library doesn't hold; and a verse to jump to once its book shows.
  const [missing, setMissing] = useState<string>();
  const pending = useRef<WordPosition>(undefined);
  const reader = useRef<ReaderHandle>(null);
  // The page's marks, kept here with their notes as an app would keep them, and given to the library to draw; the words selected,
  // to mark; a note for the next mark; and the marks tapped last, by id, to delete.
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [note, setNote] = useState('');
  const [tapped, setTapped] = useState<string[]>([]);

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
  // A cross reference the reader couldn't follow itself: its book shown, if the library holds it, and the verse jumped to.
  const onReference = (target: ReferenceTarget) => {
    const where = `${target.code} ${target.chapter}${target.verse ? `:${target.verse}` : ''}`;
    if (!target.book) return setMissing(`${where} – the library holds no such book`);
    setMissing(undefined);
    pending.current = { passage: 0, book: target.book, chapter: target.chapter, verse: target.verse ?? 1, word: 0 };
    setBook(target.book);
  };
  useEffect(() => {
    if (pending.current?.book === book) reader.current?.jump(pending.current);
    pending.current = undefined;
  }, [book]);
  // A mark on the words selected, with the note typed, if any: the selection then goes.
  const mark = (style: Pick<Mark, 'highlight' | 'underline'>) => {
    if (!selection) return;
    const made: Mark = { id: `mark-${Date.now()}`, book: selection.book, from: selection.from, to: selection.to, ...style };
    if (note.trim()) made.note = [{ text: note.trim() }];
    setMarks([...marks, made]);
    library.addMarks([made]);
    setNote('');
    cancel();
  };
  // The page's selection goes as the note is typed: the words selected last stay to be marked, until cancelled.
  const cancel = () => {
    reader.current?.select(null);
    setSelection(null);
  };
  const remove = (ids: string[]) => {
    setMarks(marks.filter((mark) => !ids.includes(mark.id)));
    library.removeMarks(ids);
    setTapped([]);
  };
  const tappedNotes = marks.filter((mark) => tapped.includes(mark.id) && mark.note).map((mark) => mark.note!.map((run) => run.text).join(''));

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
        <button onClick={() => setNotes({ marks: 'inline', inline: 'none', none: 'marks' }[notes] as typeof notes)}>
          {{ marks: 'Notes as marks', inline: 'Notes inline', none: 'No notes' }[notes]}
        </button>
        <button onClick={() => setDropCaps({ off: 'on', on: 'ornate', ornate: 'off' }[dropCaps] as typeof dropCaps)}>
          {{ off: 'No drop caps', on: 'Drop caps', ornate: 'Ornate drop caps' }[dropCaps]}
        </button>
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
        <select value={recited} onChange={(event) => setRecited(event.target.value)}>
          <option value="">Voices of the browser</option>
          {[...voiceNames].map(([voice, name]) => (
            <option key={voice} value={voice}>{name}</option>
          ))}
        </select>
        {speech.state === 'speaking' && speech.following === false && <button onClick={() => reader.current?.follow()}>Back to the voice</button>}
        <output dir="auto">
          {position ? `${title(position.book)}‎ ${position.chapter}:${position.verse} · word ${position.word + 1}` : 'Tap a word'}
          {missing && ` · ${missing}`}
          {speech.state === 'speaking' && speech.recording && ` · ${voiceNames.get(speech.recording)}`}
          {speech.firstSound !== undefined && ` · first sound after ${Math.round(speech.firstSound)} ms`}
          {speech.unvoiced?.length ? ` · no voice for ${speech.unvoiced.join(', ')}` : ''}
        </output>
      </header>
      {/* A row of its own, always there, so the reader keeps its height as a selection comes and goes. */}
      <div className="marking">
        {selection ? (
          <>
            Mark {describeSelection(selection)}:
            {Object.keys(MARK_COLORS).map((color) => (
              <button key={color} onClick={() => mark({ highlight: color })} style={{ background: colors.marks[color] }}>{color}</button>
            ))}
            <button onClick={() => mark({ underline: 'blue' })}>Underline</button>
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="with a note" size={14} />
            <button onClick={cancel}>Cancel</button>
          </>
        ) : tapped.length > 0 ? (
          <>
            {tappedNotes.length > 0 ? `Marked: ${tappedNotes.join(' · ')}` : 'Marked'}
            <button onClick={() => remove(tapped)}>Delete {tapped.length > 1 ? 'marks' : 'mark'}</button>
          </>
        ) : (
          'Select words to mark them; tap a mark to delete it, its sign to read its note.'
        )}
      </div>
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
        notes={notes}
        dropCaps={dropCaps !== 'off'}
        dropCapFont={dropCaps === 'ornate' ? ORNATE_FONT : undefined}
        speakAlong={speakAlong}
        speechRate={rate}
        recordedVoices={recited ? [recited] : []}
        onWordChange={(word) => {
          setPosition(word);
          setTapped([]);
        }}
        onSpeechChange={onSpeechChange}
        onReference={onReference}
        onSelectionChange={(selected) => selected && setSelection(selected)}
        onMarkTap={(tap) => setTapped(tap.ids)}
      />
      <footer>
        World English Bible, Luther 1912 and Smith &amp; Van Dyck, public domain; the Westminster Leningrad Codex from the{' '}
        <a href="https://github.com/openscriptures/morphhb">Open Scriptures Hebrew Bible</a>; the SBLGNT, © 2010 Society of Biblical
        Literature and Logos Bible Software, CC BY 4.0; the Quran from <a href="https://tanzil.net">Tanzil</a> (CC BY 3.0) with{' '}
        <a href="https://github.com/cpfair/quran-tajweed">quran-tajweed</a>'s rules (CC BY 4.0). Recited by Mishary Rashid Alafasy and Maher Al-Muaiqly, from{' '}
        <a href="https://everyayah.com">EveryAyah</a>; their words timed by <a href="https://github.com/cpfair/quran-align">quran-align</a>, ©
        2016 Collin Fair, and <a href="https://huggingface.co/datasets/quranlab/quran-audio">QuranLab</a>, CC BY 4.0.
      </footer>
    </main>
  );
}

/** A selection as "1:17–2:1", a word as "1:17·4". */
const describeSelection = ({ from, to }: Selection) => `${describeEnd(from)}–${describeEnd(to)}`;
const describeEnd = (end: MarkEnd) => `${end.chapter}:${end.verse}${end.word === undefined ? '' : `·${end.word + 1}`}`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
