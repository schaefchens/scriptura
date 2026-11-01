import {
  addBooks,
  addMarks,
  addRecordings,
  type BookInfo,
  books,
  type Mark,
  MARK_COLORS,
  type MarkEnd,
  cutOut,
  marksTouching,
  type MoveStep,
  palette,
  Reader,
  type ReaderHandle,
  recordings,
  type ReferenceTarget,
  removeMarks,
  SCRIPT_FONTS,
  type Selection,
  type SelectionFrame,
  spanOf,
  type SpeechChange,
  within,
  type WordPosition,
} from '@schaefchens/scriptura-react-native';
import { type ComponentRef, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

/** How fast the voice reads, as a multiple of its own rate. */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const MOVES: [MoveStep, string][] = [
  ['verse-1', '◀ verse'],
  ['word-1', '◀ word'],
  ['word+1', 'word ▶'],
  ['verse+1', 'verse ▶'],
];

export default function App() {
  const [library, setLibrary] = useState<BookInfo[]>([]);
  // Who reads a recording, by the name its voice has.
  const [voiceNames, setVoiceNames] = useState(new Map<string, string>());
  const [book, setBook] = useState('');
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
  // Chapters with a recording of this voice are played from it; the rest, or all with none, the device's voices read.
  const [recited, setRecited] = useState<string>();
  const [goTo, setGoTo] = useState('2:1');
  // Notes as marks that open where they stand, shown in full there, or left out.
  const [notes, setNotes] = useState<'marks' | 'inline' | 'none'>('marks');
  // Drop caps: none, the first letter in the text's font, or in a font of ornamental initials the app bundles.
  const [dropCaps, setDropCaps] = useState<'off' | 'on' | 'ornate'>('on');
  // The app's own notes: a sign where each mark ends, or shown in full there.
  const [markNotes, setMarkNotes] = useState<'sign' | 'inline'>('sign');
  // A cross reference to a book the library doesn't hold; and a verse to jump to once its book shows.
  const [missing, setMissing] = useState<string>();
  const pending = useRef<WordPosition>(undefined);
  const reader = useRef<ReaderHandle>(null);
  // The app's marks, kept here with their notes, and given to the reader to draw – as JSON, from JS: an app keeps the text of its
  // notes out of JS by adding them from a file; the words selected, to mark or to change the marks they touch; and the note in
  // the making, which shows the touched marks' note as the selection changes.
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
  // Where the selection shows in the reader, which the panel stands beside; the reader's area, its top in the window, the panel's
  // size once laid out, and the keyboard's top while it shows, which the panel keeps above.
  const [frame, setFrame] = useState<SelectionFrame | null>(null);
  const readerArea = useRef<ComponentRef<typeof View>>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [areaTop, setAreaTop] = useState(0);
  const [panelSize, setPanelSize] = useState<{ width: number; height: number }>();
  const [keyboardTop, setKeyboardTop] = useState<number>();
  const panelTitle = useRef<ComponentRef<typeof Text>>(null);
  const onAreaLayout = ({ nativeEvent }: { nativeEvent: { layout: { width: number; height: number } } }) => {
    setArea(nativeEvent.layout);
    readerArea.current?.measureInWindow((_x, y) => setAreaTop(y));
  };
  useEffect(() => {
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', (event) => setKeyboardTop(event.endCoordinates.screenY)),
      Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(undefined)),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  const place = useMemo(() => {
    if (!frame || !panelSize) return { left: 8, top: 8 };
    const placed = panelPlace(frame, panelSize.width, panelSize.height, area.width, area.height);
    return keyboardTop === undefined ? placed : { ...placed, top: Math.min(placed.top, keyboardTop - areaTop - panelSize.height - 8) };
  }, [frame, panelSize, area, areaTop, keyboardTop]);
  // As the panel opens, a screen reader goes to it; as it closes, it is measured anew the next time.
  const panelOpen = !pen && selection !== null && frame !== null;
  useEffect(() => {
    if (!panelOpen) return setPanelSize(undefined);
    AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      const tag = panelTitle.current && findNodeHandle(panelTitle.current);
      if (on && tag) AccessibilityInfo.setAccessibilityFocus(tag);
    });
  }, [panelOpen]);
  useEffect(() => {
    setNote(noteOf(touching));
    if (pen || !selection || touching.length === 0) return;
    const span = spanOf([selection, ...touching]);
    const key = JSON.stringify([selection.passage, selection.book, span]);
    if ((sameEnd(span.from, selection.from) && sameEnd(span.to, selection.to)) || widened.current === key) return;
    widened.current = key;
    reader.current?.select({ passage: selection.passage, book: selection.book, ...span });
  }, [JSON.stringify(selection)]);

  // The books and recordings the app bundles, read natively: their text never passes through JS.
  useEffect(() => {
    addBooks({ asset: 'books.json' }).then(() => {
      setLibrary(books());
      setBook((current) => current || books()[0]?.id || '');
    });
    addRecordings({ asset: 'recordings.json' }).then(() => {
      const names = new Map(recordings().map(({ voice, name }) => [voice, name ?? voice]));
      setVoiceNames(names);
      setRecited([...names.keys()][0]);
    });
  }, []);

  const selected = library.find(({ id }) => id === book);
  // Other editions of the book, which can be read along with it.
  const editions = library.filter(({ id, code }) => code && code === selected?.code && id !== book);
  const along = companions.filter((id) => editions.some((edition) => edition.id === id));
  const colors = useMemo(() => palette(dark ? 'dark' : 'light', 21), [dark]);
  const passages = useMemo(() => [{ book }], [book]);
  const title = (id: string) => library.find((candidate) => candidate.id === id)?.title;
  const toggle = (id: string) => setCompanions(along.includes(id) ? along.filter((other) => other !== id) : [...along, id]);
  // A chapter and verse of the book, such as 2:1, to jump to: its first word.
  const jump = () => {
    const [chapter, verse] = goTo.split(':').map(Number);
    reader.current?.jump({ passage: 0, book, chapter, verse, word: 0 });
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
  // Once the book shows: the native reader lays it out first.
  useEffect(() => {
    if (pending.current?.book !== book) return;
    const timer = setTimeout(() => reader.current?.jump(pending.current!).then(() => (pending.current = undefined)), 300);
    return () => clearTimeout(timer);
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
      removeMarks(ids);
      return;
    }
    const made: Mark = { id: ids[0] ?? newMarkId(), book: selection.book, ...range, ...next, ...(note.trim() ? { note: [{ text: note.trim() }] } : {}) };
    setMarks([...kept, made]);
    if (ids.length > 1) removeMarks(ids.slice(1));
    addMarks({ json: JSON.stringify([made]) });
    reader.current?.select({ passage: selection.passage, book: selection.book, ...range });
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
    if (removed.length > 0) removeMarks(removed);
    if (made.length > 0) addMarks({ json: JSON.stringify(made) });
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
    removeMarks(ids);
    reader.current?.select(null);
  };


  const button = (label: string, onPress: () => void, selectedButton = false) => (
    <Pressable key={label} onPress={onPress} style={[styles.button, { borderColor: colors.border }, selectedButton && { backgroundColor: colors.text }]}>
      <Text style={{ color: selectedButton ? colors.background : colors.text }}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScrollView horizontal style={styles.bar} contentContainerStyle={styles.row}>
          {library.map(({ id, title: name, work }) => button(`${name} · ${work}`, () => setBook(id), id === book))}
        </ScrollView>
        <View style={styles.row}>
          {button('A−', () => setSize(Math.max(12, size - 4)))}
          {button('A+', () => setSize(Math.min(56, size + 4)))}
          {button(paging === 'scroll' ? 'Pages' : 'Scroll', () => setPaging(paging === 'scroll' ? 'pages' : 'scroll'))}
          {button(dark ? 'Light' : 'Dark', () => setDark(!dark))}
          {button(versePerLine ? 'Running text' : 'Verse per line', () => setVersePerLine(!versePerLine))}
          {button({ marks: 'Notes as marks', inline: 'Notes inline', none: 'No notes' }[notes], () => setNotes({ marks: 'inline', inline: 'none', none: 'marks' }[notes] as typeof notes))}
          {button({ off: 'No drop caps', on: 'Drop caps', ornate: 'Ornate drop caps' }[dropCaps], () => setDropCaps({ off: 'on', on: 'ornate', ornate: 'off' }[dropCaps] as typeof dropCaps))}
          {button(markNotes === 'sign' ? 'My notes as signs' : 'My notes in full', () => setMarkNotes(markNotes === 'sign' ? 'inline' : 'sign'))}
          {editions.map(({ id, work }) => button(work, () => toggle(id), along.includes(id)))}
          {along.length > 0 && button(parallel === 'inline' ? 'Side by side' : 'Inline', () => setParallel(parallel === 'inline' ? 'columns' : 'inline'))}
          {along.length > 0 && button('Speak along', () => setSpeakAlong(!speakAlong), speakAlong)}
          {MOVES.map(([step, label]) => button(label, () => reader.current?.move(step)))}
          <TextInput value={goTo} onChangeText={setGoTo} onSubmitEditing={jump} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
          {button('Go', jump)}
          {speech.state === 'speaking' ? button('Pause', () => reader.current?.pause()) : button('Read aloud', () => reader.current?.play())}
          {speech.state !== 'stopped' && button('Stop', () => reader.current?.stop())}
          {button('Pen', () => setPen(pen ? null : { ...lastStyle.current }), pen !== null)}
          {button(`${rate}×`, () => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]))}
          {button(recited ? (voiceNames.get(recited) ?? recited) : 'Device voices', () => {
            // On to the next voice, and after the last to the device's.
            const voices = [...voiceNames.keys()];
            setRecited(voices[recited ? voices.indexOf(recited) + 1 : 0]);
          })}
          {speech.state === 'speaking' && speech.following === false && button('Back to the voice', () => reader.current?.follow())}
        </View>
        <Text style={[styles.position, { color: colors.text }]}>
          {position ? `‎${title(position.book)}‎ ${position.chapter}:${position.verse} · word ${position.word + 1}` : 'Tap a word'}
          {missing ? ` · ${missing}` : ''}
          {speech.state === 'speaking' && speech.recording ? ` · ${voiceNames.get(speech.recording)}` : ''}
          {speech.firstSound !== undefined && ` · first sound after ${Math.round(speech.firstSound)} ms`}
          {speech.unvoiced?.length ? ` · no voice for ${speech.unvoiced.join(', ')}` : ''}
        </Text>
        <View ref={readerArea} style={styles.reader} onLayout={onAreaLayout}>
        <Reader
          ref={reader}
          style={styles.reader}
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
          // While the pen is up, the words being selected look as they will marked.
          selectionStyle={penLook}
          dropCaps={dropCaps !== 'off'}
          dropCapFont={dropCaps === 'ornate' ? 'CinzelDecorative-Regular' : undefined}
          speakAlong={speakAlong}
          speechRate={rate}
          recordedVoices={recited ? [recited] : []}
          onWordChange={setPosition}
          onSpeechChange={onSpeechChange}
          onReference={onReference}
          onSelectionChange={setSelection}
          onSelectionFrame={setFrame}
        />
        {panelOpen && (
          <View
            style={[
              styles.panel,
              { left: place.left, top: place.top, maxWidth: Math.max(area.width - 16, 0), opacity: panelSize ? 1 : 0 },
              { backgroundColor: colors.background, borderColor: colors.border },
            ]}
            onLayout={(event) => setPanelSize(event.nativeEvent.layout)}
          >
            <Text ref={panelTitle} accessibilityRole="header" style={{ color: colors.text }}>
              {touching.length > 0 ? 'Marked' : 'Mark'} {describeSelection(selection!)}
            </Text>
            <View style={styles.swatches}>
              {COLOR_NAMES.map((color) => (
                <Pressable
                  key={`fill-${color}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Highlight ${color}`}
                  accessibilityState={{ selected: style.highlight === color }}
                  onPress={() => mark({ highlight: color })}
                  style={[styles.dot, { backgroundColor: colors.marks[color], borderColor: style.highlight === color ? colors.text : colors.border }]}
                >
                  <Text style={{ color: colors.text }}>{style.highlight === color ? '✓' : ''}</Text>
                </Pressable>
              ))}
              {COLOR_NAMES.map((color) => (
                <Pressable
                  key={`line-${color}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Underline ${color}`}
                  accessibilityState={{ selected: style.underline === color }}
                  onPress={() => mark({ underline: color })}
                  style={[styles.line, { borderBottomColor: colors.markLines[color], borderColor: style.underline === color ? colors.text : colors.border }]}
                >
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{style.underline === color ? '✓' : 'A'}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.swatches}>
              <TextInput
                value={note}
                onChangeText={setNote}
                onSubmitEditing={() => mark({})}
                placeholder="Note"
                placeholderTextColor={colors.secondary}
                style={[styles.input, { color: colors.text, borderColor: colors.border, minWidth: 150 }]}
              />
              {button('Save', () => mark({}))}
              {touching.length > 0 && button('Delete', remove)}
              {button('Pen', takePen)}
              {button('Done', () => reader.current?.select(null))}
            </View>
          </View>
        )}
        {pen && (
          <View style={[styles.panel, styles.penBar, { backgroundColor: colors.background, borderColor: colors.border, maxWidth: Math.max(area.width - 16, 0) }]}>
            <Text accessibilityLabel="Pen" style={{ color: colors.text, fontWeight: '600' }}>
              ✎
            </Text>
            {COLOR_NAMES.map((color) => (
              <Pressable
                key={`pen-fill-${color}`}
                accessibilityRole="button"
                accessibilityLabel={`Pen highlight ${color}`}
                accessibilityState={{ selected: pen.highlight === color }}
                onPress={() => setPen(penWith(pen, 'highlight', color))}
                style={[styles.dot, styles.small, { backgroundColor: colors.marks[color], borderColor: pen.highlight === color ? colors.text : colors.border }]}
              >
                <Text style={{ color: colors.text }}>{pen.highlight === color ? '✓' : ''}</Text>
              </Pressable>
            ))}
            {COLOR_NAMES.map((color) => (
              <Pressable
                key={`pen-line-${color}`}
                accessibilityRole="button"
                accessibilityLabel={`Pen underline ${color}`}
                accessibilityState={{ selected: pen.underline === color }}
                onPress={() => setPen(penWith(pen, 'underline', color))}
                style={[styles.line, styles.small, { borderBottomColor: colors.markLines[color], borderColor: pen.underline === color ? colors.text : colors.border }]}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{pen.underline === color ? '✓' : 'A'}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel="Put the pen away" onPress={() => setPen(null)} style={[styles.dot, styles.small, { borderColor: colors.border }]}>
              <Text style={{ color: colors.text }}>✕</Text>
            </Pressable>
          </View>
        )}
        </View>
        <Text style={[styles.sources, { color: colors.secondary }]}>
          World English Bible, Luther 1912 and Smith & Van Dyck, public domain; the Westminster Leningrad Codex from the Open
          Scriptures Hebrew Bible; the SBLGNT, © 2010 Society of Biblical Literature and Logos Bible Software, CC BY 4.0; the Quran
          from Tanzil (tanzil.net, CC BY 3.0) with quran-tajweed's rules (CC BY 4.0). Recited by Mishary Rashid Alafasy and Maher Al-Muaiqly, from
          EveryAyah (everyayah.com); their words timed by quran-align, © 2016 Collin Fair, and QuranLab, CC BY 4.0.
        </Text>
      </SafeAreaView>
    </SafeAreaProvider>
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { flexGrow: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 6, alignItems: 'center' },
  button: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, minWidth: 56 },
  position: { paddingHorizontal: 8, fontWeight: '600' },
  reader: { flex: 1 },
  // Floating over the reader beside the selection, with a shadow.
  panel: {
    position: 'absolute',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  dot: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  line: { width: 32, height: 32, borderRadius: 4, borderWidth: 1, borderBottomWidth: 5, alignItems: 'center', justifyContent: 'center' },
  small: { width: 28, height: 28 },
  // The pen's bar, at the reader's foot.
  penBar: { left: 8, bottom: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, padding: 6 },
  sources: { fontSize: 10, padding: 6 },
});
