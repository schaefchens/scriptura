import {
  addScriptFonts,
  Library,
  loadScriptura,
  type Mark,
  MARK_COLORS,
  type MarkEnd,
  cutOut,
  marksTouching,
  type MoveStep,
  type Passage,
  palette,
  Reader,
  type ReaderHandle,
  type ReferenceTarget,
  SCRIPT_FONTS,
  type Selection,
  type SelectionFrame,
  spanOf,
  type SpeechChange,
  within,
  type VersePosition,
  type WordPosition,
} from '@schaefchens/scriptura-react';
import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  // The verse in sight, as the reader scrolls or turns: where an index of books and chapters would stand.
  const [inSight, setInSight] = useState<VersePosition>();
  const [speech, setSpeech] = useState<SpeechChange>({ state: 'stopped' });
  const [speakAlong, setSpeakAlong] = useState(false);
  const [rate, setRate] = useState(1);
  const [goTo, setGoTo] = useState('2:1');
  // Notes as marks that open where they stand, shown in full there, or left out.
  const [notes, setNotes] = useState<'marks' | 'inline' | 'none'>('marks');
  // Drop caps: none, the first letter in the text's font, or in the font of ornamental initials.
  const [dropCaps, setDropCaps] = useState<'off' | 'on' | 'ornate'>('on');
  // The page's own notes: a sign where each mark ends, or shown in full there.
  const [markNotes, setMarkNotes] = useState<'sign' | 'inline'>('sign');
  const [selectBy, setSelectBy] = useState<'word' | 'verse'>('word');
  // A cross reference to a book the library doesn't hold; and a verse to jump to once its book shows.
  const [missing, setMissing] = useState<string>();
  const pending = useRef<WordPosition>(undefined);
  const reader = useRef<ReaderHandle>(null);
  // The page's marks, kept here with their notes as an app would keep them, and given to the library to draw; the words selected,
  // to mark or to change the marks they touch; and the note in the making, which shows the touched marks' note as the selection
  // changes.
  const [marks, setMarks] = useState<Mark[]>([]);
  // The pen: while it is on, each selection is marked in its style as it settles, and the panel stays shut – or, where all of it is
  // marked so already, the style comes off it. Its style is the panel's as it is taken up, else the last given there; its bar
  // changes it.
  const [pen, setPen] = useState<PenStyle | null>(null);
  // The reader draws the selection as the pen will leave it: marked so, or with the style taken off.
  const penLook = useMemo(() => (pen ? { ...pen, erases: true } : undefined), [pen]);
  const lastStyle = useRef<PenStyle>({ highlight: 'yellow' });
  const marksNow = useRef(marks);
  marksNow.current = marks;

  const [selection, setSelection] = useState<Selection | null>(null);
  const [note, setNote] = useState('');
  const touching = useMemo(() => (selection ? marksTouching(marks, selection) : []), [marks, selection]);
  const style = { highlight: touching.find((mark) => mark.highlight)?.highlight, underline: touching.find((mark) => mark.underline)?.underline };
  // A selection that touches marks – a long press on one, say – takes in the whole of them, once: what a style or Delete changes.
  const widened = useRef('');
  // Where the selection shows in the reader, which the panel stands beside – kept while the note is typed – and where the panel
  // stands, once measured.
  const [frame, setFrame] = useState<SelectionFrame | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!frame || !panel.current || !area.current) return setPlace(undefined);
    setPlace(panelPlace(frame, panel.current.offsetWidth, panel.current.offsetHeight, area.current.clientWidth, area.current.clientHeight));
  }, [JSON.stringify(frame), selection !== null, touching.length]);
  useEffect(() => {
    setNote(noteOf(touching));
    if (pen || !selection || touching.length === 0) return;
    const span = spanOf([selection, ...touching]);
    const key = JSON.stringify([selection.passage, selection.book, span]);
    if ((sameEnd(span.from, selection.from) && sameEnd(span.to, selection.to)) || widened.current === key) return;
    widened.current = key;
    reader.current?.select({ passage: selection.passage, book: selection.book, ...span });
  }, [JSON.stringify(selection)]);

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
  /**
   * Marks the words selected with a color, an underline and the note: one mark over them and the marks they touch, keeping those
   * marks' style where none is given anew; a color given again is taken off, and a mark left with none and no note goes. The
   * selection then shows the whole mark, for more changes.
   */
  const mark = (change: Partial<Pick<Mark, 'highlight' | 'underline'>>) => {
    if (!selection) return;
    const next = { ...style };
    for (const key of ['highlight', 'underline'] as const) {
      if (change[key] !== undefined) next[key] = next[key] === change[key] ? undefined : change[key];
    }
    if (next.highlight || next.underline) lastStyle.current = { highlight: next.highlight, underline: next.underline };
    const ids = touching.map((mark) => mark.id);
    const kept = marks.filter((mark) => !ids.includes(mark.id));
    const range = spanOf([selection, ...touching]);
    if (!next.highlight && !next.underline && !note.trim()) {
      setMarks(kept);
      library.removeMarks(ids);
      return;
    }
    const made: Mark = { id: ids[0] ?? newMarkId(), book: selection.book, ...range, ...next, ...(note.trim() ? { note: [{ text: note.trim() }] } : {}) };
    setMarks([...kept, made]);
    if (ids.length > 1) library.removeMarks(ids.slice(1));
    library.addMarks([made]);
    reader.current?.select({ passage: selection.passage, book: selection.book, ...range });
  };
  // The page's selection goes as the note is typed: the words selected last stay to be marked, until done.
  const done = () => {
    reader.current?.select(null);
    setSelection(null);
    setFrame(null);
  };
  /**
   * Marks words with the pen: where all of them lie in one mark that has its style, the style comes off them – the mark cut around
   * them, its other style left on them, its note with the part left last; else one mark over them and the marks they touch, in its
   * style.
   */
  const penMark = (pen: PenStyle, on: Selection) => {
    const keys = (['highlight', 'underline'] as const).filter((key) => pen[key]);
    const touched = marksTouching(marksNow.current, on);
    const holder = touched.find((mark) => within(on, mark) && keys.every((key) => mark[key] === pen[key]));
    if (holder) {
      const outside: Mark[] = cutOut(holder, on).map((part) => ({ ...holder, ...part, id: newMarkId(), note: undefined }));
      const middle: Mark = { ...holder, from: on.from, to: on.to, id: newMarkId(), note: undefined };
      for (const key of keys) middle[key] = undefined;
      const keeper = outside.at(-1) ?? middle;
      [keeper.id, keeper.note] = [holder.id, holder.note];
      return replaceMarks([holder.id], [...outside, middle].filter((mark) => mark.highlight || mark.underline || mark.note?.length));
    }
    const text = noteOf(touched);
    const made: Mark = {
      id: touched[0]?.id ?? newMarkId(),
      book: on.book,
      ...spanOf([on, ...touched]),
      highlight: pen.highlight ?? touched.find((mark) => mark.highlight)?.highlight,
      underline: pen.underline ?? touched.find((mark) => mark.underline)?.underline,
      ...(text ? { note: [{ text }] } : {}),
    };
    replaceMarks(touched.map((mark) => mark.id), [made]);
  };
  /** Takes marks away and sets others; one of an id taken away takes its place. */
  const replaceMarks = (gone: string[], made: Mark[]) => {
    const ids = new Set(made.map((mark) => mark.id));
    setMarks([...marksNow.current.filter((mark) => !gone.includes(mark.id) && !ids.has(mark.id)), ...made]);
    const removed = gone.filter((id) => !ids.has(id));
    if (removed.length > 0) library.removeMarks(removed);
    if (made.length > 0) library.addMarks(made);
  };
  // With the pen up, a selection is marked as it settles – once the reader says where it shows – and goes.
  useEffect(() => {
    if (!pen || !selection || !frame) return;
    penMark(pen, selection);
    reader.current?.select(null);
  }, [JSON.stringify(selection), frame !== null, pen]);
  // The pen taken up from the panel: in the style of the marks selected, else the last given; words selected unmarked get it.
  const takePen = () => {
    const chosen = style.highlight || style.underline ? { ...style } : { ...lastStyle.current };
    if (selection && touching.length === 0) penMark(chosen, selection);
    setPen(chosen);
    reader.current?.select(null);
  };
  const remove = () => {
    const ids = touching.map((mark) => mark.id);
    setMarks(marks.filter((mark) => !ids.includes(mark.id)));
    library.removeMarks(ids);
    done();
  };


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
        <button onClick={() => setMarkNotes(markNotes === 'sign' ? 'inline' : 'sign')}>{markNotes === 'sign' ? 'My notes as signs' : 'My notes in full'}</button>
        <button onClick={() => setSelectBy(selectBy === 'word' ? 'verse' : 'word')}>{selectBy === 'word' ? 'Selecting words' : 'Selecting verses'}</button>
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
        <button onClick={() => setPen(pen ? null : { ...lastStyle.current })}>{pen ? 'Pen on' : 'Pen'}</button>
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
          {inSight && ` · in sight: ${title(inSight.book)}‎ ${inSight.chapter}:${inSight.verse}`}
          {missing && ` · ${missing}`}
          {speech.state === 'speaking' && speech.recording && ` · ${voiceNames.get(speech.recording)}`}
          {speech.firstSound !== undefined && ` · first sound after ${Math.round(speech.firstSound)} ms`}
          {speech.unvoiced?.length ? ` · no voice for ${speech.unvoiced.join(', ')}` : ''}
        </output>
      </header>
      <div className="reader-area" ref={area}>
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
        markNotes={markNotes}
        selectBy={selectBy}
        // While the pen is up, the words being selected look as they will marked.
        selectionStyle={penLook}
        dropCaps={dropCaps !== 'off'}
        dropCapFont={dropCaps === 'ornate' ? ORNATE_FONT : undefined}
        speakAlong={speakAlong}
        speechRate={rate}
        recordedVoices={recited ? [recited] : []}
        onWordChange={setPosition}
        onVerseInSight={setInSight}
        onSpeechChange={onSpeechChange}
        onReference={onReference}
        // Typing the note moves the page's selection into its field: the words selected stay to be marked. A tap in the text ends them.
        onSelectionChange={(selected) => (selected || !document.activeElement?.closest('.marking')) && setSelection(selected)}
        onSelectionFrame={(shown) => (shown || !document.activeElement?.closest('.marking')) && setFrame(shown)}
      />
      {!pen && selection && frame && (
        <div
          className="marking"
          role="toolbar"
          aria-label="Mark"
          ref={panel}
          style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden', background: colors.background, color: colors.text }}
        >
          <div>
            {touching.length > 0 ? 'Marked' : 'Mark'} {describeSelection(selection)}
          </div>
          <div className="row">
            {COLOR_NAMES.map((color) => (
              <button
                key={`fill-${color}`}
                className={style.highlight === color ? 'dot chosen' : 'dot'}
                aria-label={`Highlight ${color}`}
                aria-pressed={style.highlight === color}
                onClick={() => mark({ highlight: color })}
                style={{ background: colors.marks[color] }}
              />
            ))}
            {COLOR_NAMES.map((color) => (
              <button
                key={`line-${color}`}
                className={style.underline === color ? 'line chosen' : 'line'}
                aria-label={`Underline ${color}`}
                aria-pressed={style.underline === color}
                onClick={() => mark({ underline: color })}
                style={{ borderBottomColor: colors.markLines[color], color: colors.text }}
              >
                A
              </button>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              mark({});
            }}
          >
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" size={16} />
            <button>Save</button>
          </form>
          <div className="row">
            {touching.length > 0 && <button onClick={remove}>Delete</button>}
            <button onClick={takePen}>Pen</button>
            <button onClick={done}>Done</button>
          </div>
        </div>
      )}
      {pen && (
        <div className="marking pen" role="toolbar" aria-label="Pen" style={{ background: colors.background, color: colors.text }}>
          <div className="row">
            <span aria-hidden="true">✎</span>
            {COLOR_NAMES.map((color) => (
              <button
                key={`pen-fill-${color}`}
                className={pen.highlight === color ? 'dot chosen' : 'dot'}
                aria-label={`Pen highlight ${color}`}
                aria-pressed={pen.highlight === color}
                onClick={() => setPen(penWith(pen, 'highlight', color))}
                style={{ background: colors.marks[color] }}
              />
            ))}
            {COLOR_NAMES.map((color) => (
              <button
                key={`pen-line-${color}`}
                className={pen.underline === color ? 'line chosen' : 'line'}
                aria-label={`Pen underline ${color}`}
                aria-pressed={pen.underline === color}
                onClick={() => setPen(penWith(pen, 'underline', color))}
                style={{ borderBottomColor: colors.markLines[color], color: colors.text }}
              >
                A
              </button>
            ))}
            <button aria-label="Put the pen away" onClick={() => setPen(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
      </div>
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

/** The colors marks name, which the palette tunes. */
const COLOR_NAMES = Object.keys(MARK_COLORS);

/** The notes of marks, as one text. */
const noteOf = (marks: Mark[]) =>
  marks
    .map((mark) => mark.note?.map((run) => run.text).join('') ?? '')
    .filter(Boolean)
    .join(' · ');

/**
 * Where a panel of `width` and `height` stands beside a selection in an area: above its first line, or below its last where there is
 * no room above, or else at the area's top.
 */
function panelPlace(frame: SelectionFrame, width: number, height: number, areaWidth: number, areaHeight: number) {
  const margin = 8;
  const left = Math.min(Math.max(frame.first[0], margin), Math.max(margin, areaWidth - width - margin));
  const above = frame.first[1] - height - margin;
  const below = frame.last[1] + frame.last[3] + margin;
  return { left, top: above >= margin ? above : below + height <= areaHeight - margin ? below : margin };
}

/** A pen's style: a highlight, an underline, or both. */
type PenStyle = Pick<Mark, 'highlight' | 'underline'>;

/** A pen's style with a color taken up or put down – at least one kept. */
const penWith = (pen: PenStyle, key: 'highlight' | 'underline', color: string): PenStyle => {
  const next = { ...pen, [key]: pen[key] === color ? undefined : color };
  return next.highlight || next.underline ? next : pen;
};

let marksMade = 0;
const newMarkId = () => `mark-${Date.now()}-${marksMade++}`;

const sameEnd = (a: MarkEnd, b: MarkEnd) => a.chapter === b.chapter && a.verse === b.verse && a.word === b.word;

/** A selection as "1:17–2:1", a word as "1:17·4". */
const describeSelection = ({ from, to }: Selection) => `${describeEnd(from)}–${describeEnd(to)}`;
const describeEnd = (end: MarkEnd) => `${end.chapter}:${end.verse}${end.word === undefined ? '' : `·${end.word + 1}`}`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
