import {
  addBooks,
  type BookInfo,
  books,
  type MoveStep,
  palette,
  Reader,
  type ReaderHandle,
  SCRIPT_FONTS,
  type WordPosition,
} from '@schaefchens/scriptura-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const MOVES: [MoveStep, string][] = [
  ['verse-1', '◀ verse'],
  ['word-1', '◀ word'],
  ['word+1', 'word ▶'],
  ['verse+1', 'verse ▶'],
];

export default function App() {
  const [library, setLibrary] = useState<BookInfo[]>([]);
  const [book, setBook] = useState('');
  const [size, setSize] = useState(24);
  const [paging, setPaging] = useState<'scroll' | 'pages'>('scroll');
  const [dark, setDark] = useState(false);
  const [versePerLine, setVersePerLine] = useState(false);
  const [companions, setCompanions] = useState<string[]>([]);
  const [parallel, setParallel] = useState<'inline' | 'columns'>('inline');
  const [position, setPosition] = useState<WordPosition>();
  const reader = useRef<ReaderHandle>(null);

  // The books the app bundles, read natively: their text never passes through JS.
  useEffect(() => {
    addBooks({ asset: 'books.json' }).then(() => {
      setLibrary(books());
      setBook((current) => current || books()[0]?.id || '');
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
          {editions.map(({ id, work }) => button(work, () => toggle(id), along.includes(id)))}
          {along.length > 0 && button(parallel === 'inline' ? 'Side by side' : 'Inline', () => setParallel(parallel === 'inline' ? 'columns' : 'inline'))}
          {MOVES.map(([step, label]) => button(label, () => reader.current?.move(step)))}
        </View>
        <Text style={[styles.position, { color: colors.text }]}>
          {position ? `‎${title(position.book)}‎ ${position.chapter}:${position.verse} · word ${position.word + 1}` : 'Tap a word'}
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
          onWordChange={setPosition}
        />
        <Text style={[styles.sources, { color: colors.secondary }]}>
          World English Bible, Luther 1912 and Smith & Van Dyck, public domain; the Westminster Leningrad Codex from the Open
          Scriptures Hebrew Bible; the SBLGNT, © 2010 Society of Biblical Literature and Logos Bible Software, CC BY 4.0; the Quran
          from Tanzil (tanzil.net, CC BY 3.0) with quran-tajweed's rules (CC BY 4.0).
        </Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { flexGrow: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 6, alignItems: 'center' },
  button: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  position: { paddingHorizontal: 8, fontWeight: '600' },
  reader: { flex: 1 },
  sources: { fontSize: 10, padding: 6 },
});
