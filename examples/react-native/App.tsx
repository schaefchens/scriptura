import {
  addBooks,
  addMarks,
  addRecordings,
  type BookInfo,
  books,
  type Mark,
  MARK_COLORS,
  type MarkEnd,
  type MoveStep,
  palette,
  Reader,
  type ReaderHandle,
  recordings,
  type ReferenceTarget,
  removeMarks,
  SCRIPT_FONTS,
  type Selection,
  type SpeechChange,
  type WordPosition,
} from '@schaefchens/scriptura-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
  // A cross reference to a book the library doesn't hold; and a verse to jump to once its book shows.
  const [missing, setMissing] = useState<string>();
  const pending = useRef<WordPosition>(undefined);
  const reader = useRef<ReaderHandle>(null);
  // The app's marks, kept here with their notes, and given to the reader to draw – as JSON, from JS: an app keeps the text of its
  // notes out of JS by adding them from a file; the words selected, to mark; a note for the next mark; and the marks tapped last.
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [note, setNote] = useState('');
  const [tapped, setTapped] = useState<string[]>([]);

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
  // A mark on the words selected, with the note typed, if any: the selection then goes.
  const mark = (style: Pick<Mark, 'highlight' | 'underline'>) => {
    if (!selection) return;
    const made: Mark = { id: `mark-${Date.now()}`, book: selection.book, from: selection.from, to: selection.to, ...style };
    if (note.trim()) made.note = [{ text: note.trim() }];
    setMarks([...marks, made]);
    addMarks({ json: JSON.stringify([made]) });
    setNote('');
    reader.current?.select(null);
  };
  const remove = (ids: string[]) => {
    setMarks(marks.filter((mark) => !ids.includes(mark.id)));
    removeMarks(ids);
    setTapped([]);
  };
  const tappedNotes = marks.filter((mark) => tapped.includes(mark.id) && mark.note).map((mark) => mark.note!.map((run) => run.text).join(''));

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
          {editions.map(({ id, work }) => button(work, () => toggle(id), along.includes(id)))}
          {along.length > 0 && button(parallel === 'inline' ? 'Side by side' : 'Inline', () => setParallel(parallel === 'inline' ? 'columns' : 'inline'))}
          {along.length > 0 && button('Speak along', () => setSpeakAlong(!speakAlong), speakAlong)}
          {MOVES.map(([step, label]) => button(label, () => reader.current?.move(step)))}
          <TextInput value={goTo} onChangeText={setGoTo} onSubmitEditing={jump} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
          {button('Go', jump)}
          {speech.state === 'speaking' ? button('Pause', () => reader.current?.pause()) : button('Read aloud', () => reader.current?.play())}
          {speech.state !== 'stopped' && button('Stop', () => reader.current?.stop())}
          {button(`${rate}×`, () => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length]))}
          {button(recited ? (voiceNames.get(recited) ?? recited) : 'Device voices', () => {
            // On to the next voice, and after the last to the device's.
            const voices = [...voiceNames.keys()];
            setRecited(voices[recited ? voices.indexOf(recited) + 1 : 0]);
          })}
          {speech.state === 'speaking' && speech.following === false && button('Back to the voice', () => reader.current?.follow())}
        </View>
        {selection && (
          <View style={styles.row}>
            <Text style={{ color: colors.text }}>Mark {describeSelection(selection)}:</Text>
            {Object.keys(MARK_COLORS).map((color) => (
              <Pressable key={color} onPress={() => mark({ highlight: color })} style={[styles.button, { borderColor: colors.border, backgroundColor: colors.marks[color] }]}>
                <Text style={{ color: colors.text }}>{color}</Text>
              </Pressable>
            ))}
            {button('Underline', () => mark({ underline: 'blue' }))}
            <TextInput value={note} onChangeText={setNote} placeholder="with a note" placeholderTextColor={colors.secondary} style={[styles.input, { color: colors.text, borderColor: colors.border }]} />
            {button('Cancel', () => reader.current?.select(null))}
          </View>
        )}
        {tapped.length > 0 && (
          <View style={styles.row}>
            <Text style={{ color: colors.text }}>{tappedNotes.length > 0 ? `Marked: ${tappedNotes.join(' · ')}` : 'Marked'}</Text>
            {button(tapped.length > 1 ? 'Delete marks' : 'Delete mark', () => remove(tapped))}
          </View>
        )}
        <Text style={[styles.position, { color: colors.text }]}>
          {position ? `‎${title(position.book)}‎ ${position.chapter}:${position.verse} · word ${position.word + 1}` : 'Tap a word'}
          {missing ? ` · ${missing}` : ''}
          {speech.state === 'speaking' && speech.recording ? ` · ${voiceNames.get(speech.recording)}` : ''}
          {speech.firstSound !== undefined && ` · first sound after ${Math.round(speech.firstSound)} ms`}
          {speech.unvoiced?.length ? ` · no voice for ${speech.unvoiced.join(', ')}` : ''}
        </Text>
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
          dropCaps={dropCaps !== 'off'}
          dropCapFont={dropCaps === 'ornate' ? 'CinzelDecorative-Regular' : undefined}
          speakAlong={speakAlong}
          speechRate={rate}
          recordedVoices={recited ? [recited] : []}
          onWordChange={(word) => {
            setPosition(word);
            setTapped([]);
          }}
          onSpeechChange={onSpeechChange}
          onReference={onReference}
          onSelectionChange={setSelection}
          onMarkTap={(tap) => setTapped(tap.ids)}
        />
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
  sources: { fontSize: 10, padding: 6 },
});
