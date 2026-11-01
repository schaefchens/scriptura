import type {
  Frame,
  LaidOut,
  MarkEnd,
  MarkTap,
  MoveStep,
  NoteRun,
  ReaderColors,
  ReaderOptions,
  ReferenceTarget,
  Selection as SelectedPlaces,
  SelectionFrame,
  SpeechChange,
  WordPosition,
} from '@schaefchens/scriptura';
import { palette, within } from '@schaefchens/scriptura';

import type { Block, Library, LibraryChange, NoteMark, PlacedMark, Target } from './library';
import { ReadAloud } from './readAloud';

export type WebReaderOptions = ReaderOptions & {
  library: Library;
  /** The word reached, by a tap, a move or a jump, or by the voice reading aloud: where it stands. */
  onWordChange?: (position: WordPosition) => void;
  onLaidOut?: (time: LaidOut) => void;
  onSpeechChange?: (change: SpeechChange) => void;
  /** A cross reference followed to verses the reader doesn't show: for the page to show them, if the library holds their book. */
  onReference?: (target: ReferenceTarget) => void;
  /**
   * The words or verses the page's selection covers in the reader – by a drag, a double click, a long press on a touch screen, a
   * screen reader's commands, or select() – or none, as it goes: where they stand, never their text. Reading aloud goes on from the
   * word marked, as before.
   */
  onSelectionChange?: (selection: SelectedPlaces | null) => void;
  /** A tap on marked words: the marks there, by id, and the word, which the tap reaches as any tap does. A mark's sign opens its note instead. */
  onMarkTap?: (tap: MarkTap) => void;
  /**
   * Where the selection shows in the reader, in pixels from its top left, as it settles – after a drag, a scroll or a change of
   * layout – and none while the pointer is down or the reader scrolls, or where none of it is in sight: for a panel of the page's
   * own beside it.
   */
  onSelectionFrame?: (frame: SelectionFrame | null) => void;
};

export type WebReader = {
  /** Shows other passages, or the same in another layout: the reader stays at the word it was at. */
  update(options: Partial<WebReaderOptions>): void;
  move(step: MoveStep): void;
  /** Brings the reader to a word by where it stands, as a tap would; to its verse's first word if the verse has no such word. False if the reader shows no such verse. */
  jump(position: WordPosition): boolean;
  /**
   * Reads aloud – chapters with recordings from them, the rest with the browser's voices – from the
   * word marked, or with none, the first in sight, on to the end, marking each word as it is said and
   * keeping it in sight, unless the reader was scrolled away from it by hand. A tap, a move or a jump
   * while it reads goes on from there.
   */
  play(): void;
  /** Pauses; play() goes on from the word reached – a recording where it paused. */
  pause(): void;
  stop(): void;
  /** Brings the word the voice is at – or, not reading aloud, the word marked – into sight, and keeps the words the voice comes to there. */
  follow(): void;
  /** Lays the text out anew, as the reader does by itself as its library's books change, and stops reading aloud. */
  refresh(): void;
  /** Turns to the next or previous page, or a screen down or up. */
  turn(forward: boolean): void;
  /**
   * Selects words or verses, as a drag would – from a word, or a verse's first, to a word, or a verse's last – or nothing: the page's
   * selection, reported through onSelectionChange like any.
   */
  select(selection: SelectedPlaces | null): void;
  destroy(): void;
};

/** Where a word stands: in which passage, in which book – the passage's, or one read along – and where in the scripture. */
type Place = { passage: number; book: string; chapter: number; verse: number; index: number };

/** A word of the text: where it stands, its paragraph, and its range in the paragraph's text. */
type Word = { place: Place; block: number; start: number; end: number };

/** A piece of a paragraph's text in the page: its text node, and where it starts in the paragraph's text. */
type Piece = { node: Text; start: number; length: number };

const INSET = 12;
/** How long after the last scroll by hand, in milliseconds, the reader follows the voice again when its word is in sight. */
const HAND_SETTLES = 700;
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']);
/** A pointer held this long, in milliseconds, is no tap. */
const LONG_PRESS = 500;
/** A pointer held still this long on a word, in milliseconds, selects it, as a long press does on iOS and Android. */
const PRESS = 450;
/** While a press takes the selection on: how near the top or bottom, in pixels, the reader scrolls on, and how near a page's side, held how long, turns it. */
const EDGE = 48;
const SIDE = 32;
const SIDE_REST = 500;
/** What screen readers read where a mark starts. */
const MARKED = 'Marked. ';
const DEFAULTS: Required<Omit<ReaderOptions, 'passages' | 'colors' | 'recordedVoices' | 'nowPlaying' | 'dropCapFont' | 'selectionStyle'>> = {
  fontSize: 28,
  paging: 'scroll',
  columns: 1,
  font: 'sans',
  fonts: {},
  lineSpacing: 1,
  sideMargin: 16,
  versePerLine: false,
  companions: [],
  parallel: 'inline',
  notes: 'marks',
  dropCaps: true,
  markNotes: 'sign',
  selectBy: 'word',
  voices: {},
  speakAlong: false,
  speechRate: 1,
};
/** What a note is called where screen readers announce its mark, and where it opens. */
const NOTE_NAMES = { footnote: 'Footnote', endnote: 'Endnote', crossReference: 'Cross reference', mark: 'Note' };
/** How wide a note opens at most, in pixels, and how much of the reader's height it may take. */
const NOTE_WIDTH = 360;
const NOTE_HEIGHT = 0.45;

let readers = 0;
/** The reader the browser's media controls show, by its number. */
let shownInControls: number | undefined;

/**
 * The reader on the web: passages from a library as paragraphs in the page, each in its language,
 * direction and font – running text or a verse per line, in one endless scroll or in pages with
 * columns, and books read along inline or side by side. A word can be tapped or reached word by
 * word, and is highlighted; screen readers read the paragraphs as they are.
 */
export function createReader(element: HTMLElement, initial: WebReaderOptions): WebReader {
  injectStyles();
  const id = ++readers;
  let options = { ...DEFAULTS, colors: palette('light', 21) as ReaderColors, ...initial };
  const root = document.createElement('div');
  const content = document.createElement('div');
  const live = document.createElement('div');
  const highlightStyle = document.createElement('style');
  const marksStyle = document.createElement('style');
  root.className = `scriptura scriptura-${id}`;
  root.tabIndex = 0;
  content.className = 'scriptura-content';
  live.className = 'scriptura-live';
  live.setAttribute('aria-live', 'polite');
  root.append(content, live);
  element.append(root, highlightStyle, marksStyle);

  let blocks: Block[] = [];
  let paragraphs: HTMLElement[] = [];
  let pieces: Piece[][] = [];
  let words: Word[] = [];
  /** Each word's index in `words`, by where it stands. */
  let indices = new Map<string, number>();
  let current: number | undefined;
  /** The note open, and the mark it opened at. */
  let opened: { note: HTMLElement; mark: HTMLElement } | undefined;
  const readAloud = new ReadAloud(
    (part, word) => reached({ passage: part.passage, book: part.book, chapter: word.chapter, verse: word.verse, index: word.index }),
    // While it speaks, with whether the reader follows it. The browser's media controls show it too.
    (change) => {
      options.onSpeechChange?.(change.state === 'speaking' ? { ...change, following } : change);
      showInControls(change.state);
    },
  );
  /** Whether the word the voice comes to is brought into sight: not after a scroll by hand away from it, until it is in sight again. */
  let following = true;
  /** When the reader was last scrolled by hand, or glided after it. */
  let scrolledAt = -Infinity;
  /** What is read aloud along with the passages, and from which recordings; and how fast. */
  let readAs = '';
  let rateAs = 1;
  let page = 0;
  let pageCount = 1;
  let shownPassages = '';
  let layout: Layout = { kind: 'scroll' };
  let destroyed = false;
  /** Fonts waited for, once each: until they come, others stand in and are measured instead. */
  const awaited = new Set<string>();
  const highlightName = `scriptura-word-${id}`;
  /** A long press: the words it started on and those the pointer is on – each a range of words, a verse's for its number – where the pointer is, and since when it rests at a page's side. */
  let pressed: { anchor: [number, number]; focus: [number, number]; x: number; y: number; sideSince?: number } | undefined;
  let pressTimer: number | undefined;
  let edgeFrame: number | undefined;
  const pressedName = `scriptura-pressed-${id}`;
  /** The marks' highlights, by name, one per look. */
  let markNames: string[] = [];
  /**
   * What a pen that erases takes its look off: the words selected, and the mark of the pen's look they all lie in – found as the words
   * or the style change, and kept as the marks change after, as the pen erases; and what the marks were last drawn for.
   */
  let erasing: { key: string; selection?: SelectedPlaces; mark?: string } = { key: '' };
  let marksErasing = '';
  /** The selection as last reported, and where it showed, so only changes are; and a report of where to come. */
  let reportedSelection = 'null';
  let reportedFrame = 'null';
  let frameTimer: number | undefined;

  function render() {
    const started = performance.now();
    const { library, passages, fontSize, versePerLine, companions, parallel, colors } = options;
    // The same passages in another layout keep the reader at the word it was at, the word it
    // marked, and the words selected; if a word is gone, as a book is no longer read along, the
    // last before it still there.
    const staying = JSON.stringify(passages) === shownPassages;
    const kept = staying ? words : [];
    const anchorAt = staying ? wordInSight() : undefined;
    const marked = staying && current !== undefined ? words[current].place : undefined;
    const selected = staying ? selectionOfPage() : null;
    if (!staying) readAloud.stop();
    shownPassages = JSON.stringify(passages);
    closeNote();

    blocks = library.blocks(passages, { fontSize, versePerLine, companions, notes: options.notes, dropCaps: options.dropCaps, markNotes: options.markNotes });
    const families = [...blocks.map(familyOf), ...(options.dropCapFont ? [`"${options.dropCapFont}"`] : [])];
    const loading = [...new Set(families)].filter((family) => !fontsLoaded(family) && !awaited.has(family));
    if (loading.length > 0) {
      loading.forEach((family) => awaited.add(family));
      Promise.all(loading.map((family) => document.fonts.load(`16px ${family}`))).then(() => destroyed || render());
    }
    const along = new Set(blocks.filter((block) => block.column > 0).map((block) => block.passage));
    const sideBySide = parallel === 'columns' && along.size > 0;
    const sizes = blocks.map((block) => block.letterHeight / letterHeight(block.letter, familyOf(block)));
    const numberColumn = numberColumnWidth(sizes);
    const indent = numberColumn > 0 ? numberColumn : Math.round(fontSize * 1.5);

    content.replaceChildren();
    paragraphs = [];
    pieces = [];
    words = [];
    current = undefined;
    const withWords = blocks.filter((block) => block.words.length > 0);
    const rightToLeft = withWords.length > 0 && withWords.every((block) => block.direction === 'rtl');
    blocks.forEach((block, index) => {
      const next = blocks[index + 1];
      const indented = along.has(block.passage) && !sideBySide && block.column > 0 ? indent : 0;
      const spacing = spacingAfter(block, next, along.has(block.passage), sideBySide) * sizes[index];
      const [element, blockPieces] = paragraph(block, index, sizes[index], spacing, indented, numberColumn);
      paragraphs.push(element);
      pieces.push(blockPieces);
      for (const word of block.words) {
        const { chapter, verse, index: wordIndex } = word;
        words.push({ place: { passage: block.passage, book: block.book, chapter, verse, index: wordIndex }, block: index, start: word.start, end: word.end });
      }
    });

    root.style.background = colors.background;
    root.style.color = colors.text;
    root.dataset.paging = options.paging;
    styleHighlights();
    layout = arrange(sectionsOf(along, sideBySide), rightToLeft);

    indices = new Map(words.map((word, index) => [key(word.place), index]));
    const anchor = anchorAt === undefined ? undefined : kept.slice(0, anchorAt + 1).reverse().map((word) => indices.get(key(word.place))).find((index) => index !== undefined);
    if (marked) {
      current = indices.get(key(marked));
      highlight();
    }
    drawMarks();
    // Other books read along or other recordings change what is read, and a new rate how: the voice goes on from the word it is at. A
    // recording takes a new rate as it plays.
    const read = JSON.stringify([companions, options.speakAlong, options.recordedVoices]);
    const changed = read !== readAs || (options.speechRate !== rateAs && !readAloud.setRate(options.speechRate));
    if (changed && readAloud.state !== 'stopped') {
      if (readAloud.state === 'speaking') play();
      else readAloud.stop();
    }
    readAs = read;
    rateAs = options.speechRate;
    showInControls(readAloud.state);
    if (anchor !== undefined) showWord(anchor, 'top');
    else goTo(0);
    if (selected) setSelection(selected);
    frameLater();
    const time = performance.now() - started;
    options.onLaidOut?.({ pages: options.paging === 'pages' ? pageCount : 0, milliseconds: time, all: time });
  }

  /**
   * A block as a paragraph in its language and direction, its runs colored by their roles, each
   * note's mark – and the sign of a mark's note – a button that opens it, and the drop cap – the
   * first letter – set large; and its text's pieces.
   */
  function paragraph(block: Block, index: number, size: number, spacing: number, indent: number, numberColumn: number): [HTMLElement, Piece[]] {
    const element = document.createElement('p');
    element.dir = block.direction;
    element.lang = block.language;
    if (block.kind === 'heading') {
      element.setAttribute('role', 'heading');
      element.setAttribute('aria-level', '2');
    }
    const family = familyOf(block);
    Object.assign(element.style, {
      fontFamily: family,
      fontSize: `${size}px`,
      lineHeight: String(lineHeight(family) * options.lineSpacing),
      marginBlockEnd: `${spacing}px`,
      marginInlineStart: `${indent}px`,
    });
    const hangs = block.kind === 'verse' && block.segments[0]?.text.endsWith('\t');
    if (hangs) {
      // The text starts past the widest number, and so do its lines after the first.
      Object.assign(element.style, { paddingInlineStart: `${numberColumn}px`, textIndent: `-${numberColumn}px` });
    }
    const blockPieces: Piece[] = [];
    let start = 0;
    const drop = block.dropCap;
    /**
     * Text from `at` on in the paragraph's text, as text nodes in `holder` – cut where a mark starts,
     * for the word screen readers read there, which nothing shows.
     */
    const emit = (text: string, holder: Node, at: number) => {
      const end = at + text.length;
      if (text.length === 0) {
        const node = document.createTextNode('');
        holder.appendChild(node);
        blockPieces.push({ node, start: at, length: 0 });
        return;
      }
      const starts = block.marks.filter((mark) => at < mark.start && mark.start < end).map((mark) => mark.start);
      const cuts = [...new Set([...starts, end])].sort((a, b) => a - b);
      if (block.marks.some((mark) => mark.start === at)) holder.appendChild(hiddenText(MARKED));
      let from = at;
      for (const cut of cuts) {
        if (cut > from) {
          const node = document.createTextNode(text.slice(from - at, cut - at));
          holder.appendChild(node);
          blockPieces.push({ node, start: from, length: cut - from });
        }
        if (cut < end) holder.appendChild(hiddenText(MARKED));
        from = cut;
      }
    };
    block.segments.forEach(({ text, role }, at) => {
      // A hanging number's tab becomes the width of the number column.
      const shown = hangs && at === 0 ? text.slice(0, -1) : text;
      if (role === 'note') {
        // A mark is a button that opens its note, named for screen readers; shown in full, the note
        // stands around it.
        const note = block.notes.findIndex((candidate) => candidate.start <= start && start < candidate.end);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scriptura-mark';
        button.style.color = options.colors.roles.note ?? '';
        button.dataset.block = String(index);
        button.dataset.note = String(note);
        if (note >= 0) button.setAttribute('aria-label', describe(block.notes[note]));
        const node = document.createTextNode(shown);
        button.append(node);
        element.append(button);
        blockPieces.push({ node, start, length: text.length });
        start += text.length;
        return;
      }
      let parent: HTMLElement = element;
      if (role || (hangs && at === 0)) {
        parent = document.createElement('span');
        if (role) parent.style.color = options.colors.roles[role] ?? '';
        if (hangs && at === 0) Object.assign(parent.style, { display: 'inline-block', inlineSize: `${numberColumn}px`, textIndent: '0' });
        element.append(parent);
      }
      // The first letter stands large, before the rest of the text.
      if (drop && start <= drop.letterStart && drop.letterEnd <= start + shown.length && drop.letterEnd > drop.letterStart) {
        const [before, letter, after] = [shown.slice(0, drop.letterStart - start), shown.slice(drop.letterStart - start, drop.letterEnd - start), shown.slice(drop.letterEnd - start)];
        const cap = document.createElement('span');
        cap.className = 'scriptura-drop';
        Object.assign(cap.style, dropCapStyle(letter, familyOf(block), size));
        for (const [piece, holder] of [[before, parent], [letter, cap], [after, parent]] as const) {
          if (holder === cap) parent.append(cap);
          if (!piece) continue;
          emit(piece, holder, start);
          start += piece.length;
        }
        return;
      }
      emit(shown, parent, start);
      start += text.length;
    });
    return [element, blockPieces];
  }

  /**
   * Draws the marks as highlights of the page, over the words of each: filled in its color, and
   * underlined in its line's – one highlight per look, below the word the voice is at. The mark a pen
   * erases shows as it will be: in its look before and after the words selected, and over them in
   * what is left of it.
   */
  function drawMarks() {
    for (const name of markNames) CSS.highlights?.delete(name);
    markNames = [];
    marksErasing = erasing.mark ? erasing.key : '';
    if (!('highlights' in CSS)) return;
    const looks = new Map<string, { fill?: string; line?: string; ranges: Range[] }>();
    const draw = (block: number, start: number, end: number, highlight: string | null, underline: string | null) => {
      const fill = highlight ? colorOf(highlight, options.colors.marks) : undefined;
      const line = underline ? colorOf(underline, options.colors.markLines) : undefined;
      const range = start < end ? drawnRange(block, start, end) : undefined;
      if ((!fill && !line) || !range) return;
      const look = `${fill ?? ''}|${line ?? ''}`;
      const entry = looks.get(look) ?? { fill, line, ranges: [] };
      entry.ranges.push(range);
      looks.set(look, entry);
    };
    const erased = erasedWords();
    const style = options.selectionStyle;
    blocks.forEach((block, index) => {
      for (const mark of block.marks) {
        const over = erased && mark.id === erasing.mark ? erased.over.get(index) : undefined;
        if (!erased || !over) {
          draw(index, mark.start, mark.end, mark.highlight, mark.underline);
          continue;
        }
        const { before, after } = erased;
        if (before?.block === index && before.start >= mark.start) draw(index, mark.start, before.end, mark.highlight, mark.underline);
        draw(index, Math.max(mark.start, over[0]), Math.min(mark.end, over[1]), style?.highlight ? null : mark.highlight, style?.underline ? null : mark.underline);
        if (after?.block === index && after.end <= mark.end) draw(index, after.start, mark.end, mark.highlight, mark.underline);
      }
    });
    let rules = '';
    [...looks.values()].forEach(({ fill, line, ranges }, at) => {
      const name = `scriptura-marks-${id}-${at}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      markNames.push(name);
      const styles = [fill && `background-color: ${fill};`, line && `text-decoration: underline ${line} 2px;`].filter(Boolean).join(' ');
      rules += `::highlight(${name}) { ${styles} }\n`;
    });
    marksStyle.textContent = rules;
  }

  /**
   * The first letter, floated at the paragraph's start as tall as two of its lines, sized so a
   * capital's top stands at the first line's digit height and its baseline on the second line's: a
   * drop cap. In a font of initials, if one is given and has the letter, the letter's own height
   * fills the two lines. Browsers set initial-letter only on a ::first-letter.
   */
  function dropCapStyle(letter: string, family: string, size: number) {
    const line = size * lineHeight(family) * options.lineSpacing;
    const ornate = options.dropCapFont && fontHasGlyph(options.dropCapFont, letter, family);
    const dropFamily = ornate ? `"${options.dropCapFont}", ${family}` : family;
    const dropSize = size + line / letterHeight(ornate ? letter : '0', ornate ? dropFamily : family);
    // A float's line box puts its baseline a half-leading plus the ascent down; the shift takes it
    // to where the second line's is.
    const [ascent, descent] = fontBox(family);
    const shift = line / 2 + ((size - dropSize) * (ascent - descent)) / 2;
    // A hair short of two lines, so the third line, which starts where the float ends, runs full width.
    return { fontFamily: dropFamily, fontSize: `${dropSize}px`, lineHeight: `${2 * line}px`, blockSize: `${2 * line - 0.5}px`, top: `${shift}px` };
  }

  /** A note as screen readers announce its mark: "Footnote 1", "Cross reference a" – the sign of a mark's note as "Note". */
  const describe = (note: NoteMark) => (note.kind === 'mark' ? NOTE_NAMES.mark : `${NOTE_NAMES[note.kind] ?? 'Note'} ${note.mark}`);

  /** What a note's mark opens: the note's runs, what it is called, and the verse it stands in. */
  type Opening = { runs: NoteRun[]; label: string; chapter: number; verse: number };

  function openingOf(mark: HTMLElement): [Block, Opening] | undefined {
    const block = blocks[Number(mark.dataset.block)];
    const note = block?.notes[Number(mark.dataset.note)];
    return note && [block, { runs: note.runs, label: describe(note), chapter: note.chapter, verse: note.verse }];
  }

  /**
   * Opens a note at its mark – below the mark's line, or above it where there is no room below –
   * as a dialog in the paragraph's font, its runs as they are: the verse it names, quotations and
   * emphasis in italics, words in other languages in their fonts, and each reference a button that
   * follows it. It stays until a tap elsewhere, the mark again, Escape, or a scroll.
   */
  function openNote(mark: HTMLElement) {
    closeNote();
    const opening = openingOf(mark);
    if (!opening) return;
    const [block, note] = opening;
    const dialog = document.createElement('div');
    dialog.className = 'scriptura-note';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', note.label);
    dialog.tabIndex = -1;
    dialog.dir = block.direction;
    dialog.lang = block.language;
    const { colors } = options;
    const size = parseFloat(paragraphs[Number(mark.dataset.block)].style.fontSize) || options.fontSize;
    Object.assign(dialog.style, {
      fontFamily: familyOf(block),
      fontSize: `${Math.max(14, Math.round(size * 0.7))}px`,
      lineHeight: String(lineHeight(familyOf(block)) * 1.15),
      background: colors.background,
      color: colors.text,
      width: `${Math.min(NOTE_WIDTH, root.clientWidth - 2 * options.sideMargin)}px`,
      maxHeight: `${Math.round(root.clientHeight * NOTE_HEIGHT)}px`,
    });
    // After a line break, a paragraph of its own, in the direction of its first letter: the verses a
    // note refers to may be in another script than the note.
    let paragraph: HTMLElement = dialog;
    for (const run of note.runs) {
      if (run.text === '\n') {
        paragraph = document.createElement('div');
        paragraph.dir = 'auto';
        dialog.append(paragraph);
        continue;
      }
      const piece = document.createElement(run.target ? 'button' : 'span');
      if (run.target) {
        const target = run.target;
        (piece as HTMLButtonElement).type = 'button';
        piece.className = 'scriptura-reference';
        piece.style.color = colors.roles.note ?? '';
        piece.addEventListener('click', () => followReference(target, note, block));
      }
      if (run.role === 'origin') piece.style.color = colors.roles.origin ?? '';
      if (run.role === 'number') piece.style.color = colors.roles.number ?? '';
      if (run.role === 'quotation' || run.role === 'emphasis') piece.style.fontStyle = 'italic';
      if (run.language) {
        piece.lang = run.language;
        piece.dir = 'auto';
        const family = options.fonts[run.language];
        if (family) piece.style.fontFamily = `"${family}", ${familyOf(block)}`;
      }
      piece.textContent = run.text;
      paragraph.append(piece);
    }
    root.append(dialog);
    const area = root.getBoundingClientRect();
    const at = mark.getBoundingClientRect();
    const height = dialog.offsetHeight;
    const below = at.bottom + 6 + height <= area.bottom - INSET;
    const left = Math.min(Math.max(at.left, area.left + options.sideMargin), area.right - options.sideMargin - dialog.offsetWidth);
    Object.assign(dialog.style, { left: `${Math.max(left, area.left)}px`, top: `${below ? at.bottom + 6 : Math.max(at.top - 6 - height, area.top)}px` });
    mark.setAttribute('aria-expanded', 'true');
    opened = { note: dialog, mark };
    dialog.focus({ preventScroll: true });
  }

  function closeNote() {
    if (!opened) return;
    const { note, mark } = opened;
    opened = undefined;
    const focused = note.contains(document.activeElement);
    note.remove();
    mark.removeAttribute('aria-expanded');
    if (focused && mark.isConnected) mark.focus({ preventScroll: true });
  }

  /**
   * Follows a reference: to the verses it names, if the reader shows them – in the same edition as
   * the note's book, or else in another – or, if not, tells the page, with the library's book of
   * them, if it holds one.
   */
  function followReference(target: Target, note: Opening, block: Block) {
    const books = library.books();
    const work = books.find((book) => book.id === block.book)?.work;
    const editions = books.filter((book) => book.code === target.book);
    const held = editions.find((book) => book.work === work) ?? editions[0];
    const codes = new Map(books.map((book) => [book.id, book.code]));
    const at = (word: Word) => word.place.chapter === target.chapter && (target.verse == null || word.place.verse === target.verse);
    let index = held ? words.findIndex((word) => word.place.book === held.id && at(word)) : -1;
    if (index < 0) index = words.findIndex((word) => codes.get(word.place.book) === target.book && at(word));
    closeNote();
    if (index >= 0) return select(index);
    options.onReference?.({
      book: held?.id ?? null,
      code: target.book,
      chapter: target.chapter,
      verse: target.verse ?? undefined,
      to: target.to ?? undefined,
      from: { passage: block.passage, book: block.book, chapter: note.chapter, verse: note.verse },
    });
  }

  type Layout = { kind: 'scroll' } | { kind: 'pages'; rightToLeft: boolean };

  /** Blocks from `start` to before `end` laid out on their own terms: flowing through a page's columns, or in rows of cells side by side. */
  type Section = { start: number; end: number; grid: boolean; columns: number };

  /**
   * The blocks in sections: all of them flowing – or with books side by side, each passage read
   * along in rows of cells, a column for each book, and passages read alone flowing as they would alone.
   */
  function sectionsOf(along: Set<number>, sideBySide: boolean): Section[] {
    const page = Math.max(options.columns, 1);
    if (!sideBySide) return [{ start: 0, end: blocks.length, grid: false, columns: page }];
    const sections: Section[] = [];
    let start = 0;
    while (start < blocks.length) {
      const passage = blocks[start].passage;
      let end = start;
      while (end < blocks.length && blocks[end].passage === passage) end++;
      const last = sections.at(-1);
      if (!along.has(passage) && last && !last.grid) last.end = end;
      else if (!along.has(passage)) sections.push({ start, end, grid: false, columns: page });
      else sections.push({ start, end, grid: true, columns: Math.max(...blocks.slice(start, end).map((block) => block.column)) + 1 });
      start = end;
    }
    return sections;
  }

  /**
   * Places the sections: in one endless scroll each under the one before, laid out as they come into
   * sight; in pages, each on pages of its own, all of them a page's width apart.
   */
  function arrange(sections: Section[], rightToLeft: boolean): Layout {
    const { paging, sideMargin: margin } = options;
    content.removeAttribute('style');
    // Pages and columns from the right: the scroll starts there too.
    root.dir = content.dir = rightToLeft ? 'rtl' : 'ltr';
    if (paging !== 'pages') {
      content.style.padding = `${INSET}px ${margin}px`;
      const width = root.clientWidth - 2 * margin;
      for (const section of sections) {
        const element = document.createElement('div');
        if (section.grid) {
          element.append(...rowsOf(section).map((row) => lazy(row.element, width / section.columns)));
        } else {
          element.append(...paragraphs.slice(section.start, section.end).map((paragraph) => lazy(paragraph, width)));
        }
        content.append(element);
      }
      pageCount = 1;
      return { kind: 'scroll' };
    }
    Object.assign(content.style, { display: 'flex', alignItems: 'flex-start', height: `${root.clientHeight}px` });
    pageCount = sections.reduce((pages, section) => pages + (section.grid ? gridPages(section) : flowPages(section)), 0);
    return { kind: 'pages', rightToLeft };
  }

  /** An element the browser lays out only as it comes near the sight, as tall as it is guessed to be till then, and then as it was. */
  function lazy(element: HTMLElement, width: number) {
    const characters = element.textContent?.length ?? 0;
    const size = parseFloat(element.style.fontSize || element.querySelector('p')?.style.fontSize || '20');
    const lines = Math.max(1, Math.ceil((characters * size * 0.5) / Math.max(width, 1)));
    Object.assign(element.style, { contentVisibility: 'auto', containIntrinsicSize: `auto ${Math.round(lines * size * 1.5 * options.lineSpacing)}px` });
    return element;
  }

  /**
   * A section's rows side by side: each a grid of its own, a column for each book, so a row is as
   * tall as its tallest cell; and whether it is of headings.
   */
  function rowsOf(section: Section) {
    const rows: { element: HTMLElement; heading: boolean }[] = [];
    let index = section.start;
    while (index < section.end) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))`,
        columnGap: `${Math.max(options.sideMargin, 16)}px`,
        alignItems: 'start',
      });
      const number = blocks[index].row;
      let heading = true;
      while (index < section.end && blocks[index].row === number) {
        const cell = document.createElement('div');
        const column = blocks[index].column;
        cell.style.gridColumn = String(column + 1);
        while (index < section.end && blocks[index].row === number && blocks[index].column === column) {
          heading &&= blocks[index].kind === 'heading';
          cell.append(paragraphs[index++]);
        }
        row.append(cell);
      }
      rows.push({ element: row, heading });
    }
    return rows;
  }

  /** A page of the section's own, as wide as the reader. */
  function newPage() {
    const page = document.createElement('div');
    Object.assign(page.style, { flex: 'none', boxSizing: 'border-box', width: `${root.clientWidth}px`, padding: `${INSET}px ${options.sideMargin}px` });
    return page;
  }

  /**
   * A section that flows, through the columns of its pages. CSS columns run on past the element's
   * width, a column's width and a gap apart; with gaps of two margins, a page's columns and its
   * margins come to the reader's width. Its pages counted, it is made as wide as they are.
   */
  function flowPages(section: Section) {
    const { sideMargin: margin } = options;
    const columns = section.columns;
    const element = document.createElement('div');
    Object.assign(element.style, {
      flex: 'none',
      boxSizing: 'content-box',
      width: `${root.clientWidth - 2 * margin}px`,
      height: `${root.clientHeight - 2 * INSET}px`,
      padding: `${INSET}px ${margin}px`,
      columnCount: String(columns),
      columnGap: `${2 * margin}px`,
      columnFill: 'auto',
    });
    element.append(...paragraphs.slice(section.start, section.end));
    content.append(element);
    const pages = Math.max(1, Math.ceil(element.scrollWidth / root.clientWidth - 0.01));
    Object.assign(element.style, { width: `${pages * root.clientWidth - 2 * margin}px`, columnCount: String(pages * columns) });
    return pages;
  }

  /**
   * A section's rows on pages of their own: as many rows as fit on each, and a row of headings only
   * with the row after it. A row that doesn't fit on a page, or below the headings it follows, runs
   * on over pages of its own, each cell through columns a page apart, so each goes on in its column
   * on the next page – the headings moved into its cells, to start them.
   */
  function gridPages(section: Section) {
    const rows = rowsOf(section);
    const height = root.clientHeight - 2 * INSET;
    // Measured on a page first.
    const measured = newPage();
    measured.append(...rows.map((row) => row.element));
    content.append(measured);
    const heights = rows.map((row) => row.element.offsetHeight);
    measured.remove();
    let pages = 0;
    let page = newPage();
    let used = 0;
    // The row of headings on this page that the next row goes on from.
    let headings: HTMLElement | undefined;
    const close = () => {
      content.append(page);
      pages++;
      page = newPage();
      used = 0;
    };
    rows.forEach(({ element: row, heading }, index) => {
      // Headings go on a page only with the row after them, as much of it as a page holds.
      const next = heading && index + 1 < rows.length ? Math.min(heights[index + 1], height) : 0;
      if (used > 0 && !headings && used + heights[index] + next > height) close();
      const above = headings;
      headings = heading ? row : undefined;
      if (used + heights[index] <= height) {
        page.append(row);
        used += heights[index];
        return;
      }
      if (above) startWith(row, above, used);
      headings = undefined;
      // In the page first, so its cells have their widths; then empty pages for it to run on through.
      page.append(row);
      close();
      const spilled = spill(row, height);
      for (let more = 1; more < spilled; more++) close();
    });
    if (used > 0) close();
    return pages;
  }

  /**
   * The headings a row goes on from, moved into the start of its cells, each column's as tall as
   * their row, so the cells go on alike below them.
   */
  function startWith(row: HTMLElement, headings: HTMLElement, height: number) {
    const columns = new Map([...(headings.children as HTMLCollectionOf<HTMLElement>)].map((cell) => [cell.style.gridColumn, cell]));
    for (const cell of row.children as HTMLCollectionOf<HTMLElement>) {
      const start = document.createElement('div');
      Object.assign(start.style, { display: 'flow-root', blockSize: `${height}px` });
      start.append(...(columns.get(cell.style.gridColumn)?.childNodes ?? []));
      columns.delete(cell.style.gridColumn);
      cell.prepend(start);
    }
    // Headings with nothing below them.
    row.append(...columns.values());
    headings.remove();
  }

  /** A row taller than a page: each cell in columns as tall as a page and a page apart. How many pages the row takes. */
  function spill(row: HTMLElement, height: number) {
    row.style.blockSize = `${height}px`;
    let pages = 1;
    for (const cell of row.children as HTMLCollectionOf<HTMLElement>) {
      const width = cell.getBoundingClientRect().width;
      Object.assign(cell.style, { blockSize: `${height}px`, columnWidth: `${width}px`, columnGap: `${root.clientWidth - width}px`, columnFill: 'auto' });
      pages = Math.max(pages, Math.ceil((cell.scrollWidth + root.clientWidth - width) / root.clientWidth - 0.01));
    }
    return pages;
  }

  /** The font a block is set in: its own, the one given for its language, or the system's. */
  function familyOf(block: Block) {
    const family = block.fontFamily ?? options.fonts[block.language];
    const system = options.font === 'serif' ? 'serif' : 'system-ui, sans-serif';
    return family ? `"${family}", ${system}` : system;
  }

  /** How far the text of verse lines starts, past the widest verse number before it. */
  function numberColumnWidth(sizes: number[]) {
    let widest = 0;
    blocks.forEach((block, index) => {
      if (block.kind !== 'verse' || !block.segments[0]?.text.endsWith('\t')) return;
      const width = measure(block.segments[0].text.trim(), familyOf(block), sizes[index]).width;
      widest = Math.max(widest, width + sizes[index] * 0.4);
    });
    return Math.ceil(widest);
  }

  /** The space after a paragraph, in ems, as the native readers have it. */
  function spacingAfter(block: Block, next: Block | undefined, along: boolean, sideBySide: boolean) {
    if (!next) return 0.5;
    if (along) return next.row === block.row && (!sideBySide || next.column === block.column) ? 0.2 : 0.6;
    return block.kind === 'verse' && next.kind === 'verse' ? 0.2 : 0.5;
  }

  /** The range of a word in the page. */
  const rangeOf = (word: Word) => rangeBetween(word.block, word.start, word.end);

  /**
   * The range of a part of a paragraph's text as it is drawn over – highlighted or marked – without
   * a drop cap's letter: it stands apart, over two lines, and isn't drawn over, as on iOS and Android.
   * None if nothing else is left.
   */
  function drawnRange(block: number, start: number, end: number) {
    const drop = blocks[block].dropCap;
    const from = drop && start >= drop.letterStart && start < drop.letterEnd ? drop.letterEnd : start;
    return from < end ? rangeBetween(block, from, end) : undefined;
  }

  /** The range in the page of a part of a paragraph's text. */
  function rangeBetween(block: number, start: number, end: number) {
    const range = document.createRange();
    const [startNode, startOffset] = position(block, start);
    const [endNode, endOffset] = position(block, end, true);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  /**
   * Where an offset in a paragraph's text is in the page: at the start of the piece it starts, or as
   * the `end` of a range, at the end of the piece it ends – so that a range stops before what the
   * page sets between them, such as the sign of a mark's note.
   */
  function position(block: number, offset: number, end = false): [Text, number] {
    const blockPieces = pieces[block];
    const piece = blockPieces.findLast((candidate) => (end ? candidate.start < offset : candidate.start <= offset)) ?? blockPieces[0];
    return [piece.node, Math.max(0, Math.min(offset - piece.start, piece.node.length))];
  }

  /**
   * Where the words a pen erases are: in each paragraph, from the start of the first to the end of the
   * last; and the words of their book just before and after them.
   */
  function erasedWords() {
    const selection = erasing.mark ? erasing.selection : undefined;
    const span = selection && wordsOf(selection);
    if (!selection || !span) return undefined;
    const inBook = (word: Word) => word.place.passage === selection.passage && word.place.book === selection.book;
    const [first, last] = span;
    const over = new Map<number, [number, number]>();
    for (let index = first; index <= last; index++) {
      const word = words[index];
      if (inBook(word)) over.set(word.block, [over.get(word.block)?.[0] ?? word.start, word.end]);
    }
    let before = first - 1;
    while (before >= 0 && !inBook(words[before])) before--;
    let after = last + 1;
    while (after < words.length && !inBook(words[after])) after++;
    return { over, before: words[before] as Word | undefined, after: words[after] as Word | undefined };
  }

  /**
   * What the selection erases: the mark its words all lie in, of the pen's look, by place, as the pen
   * finds it – the words a press has taken while it lasts. Found anew only as the words or the style
   * change: the pen changes the marks as it lets go, and the selection stays until it is done.
   */
  function erasingNow() {
    const selection = pressed ? pressedSelection(pressed) : selectionOfPage();
    const style = options.selectionStyle;
    const names = (['highlight', 'underline'] as const).filter((name) => style?.[name]);
    if (!selection || !style?.erases || names.length === 0) return (erasing = { key: '' });
    const key = JSON.stringify([selection.passage, selection.book, selection.from, selection.to, style]);
    if (key === erasing.key) return erasing;
    const mark = options.library
      .marks()
      .find((mark) => mark.book === selection.book && within(selection, mark) && names.every((name) => mark[name] === style[name]));
    return (erasing = { key, selection, mark: mark?.id });
  }

  /** Draws the marks and the selection's look anew where what the selection erases changed. */
  function followErasing() {
    const { key, mark } = erasingNow();
    if ((mark ? key : '') === marksErasing) return;
    drawMarks();
    styleHighlights();
  }

  /** The look of the word the voice is at, of the selection and of the words a press takes. */
  function styleHighlights() {
    const look = selectionLook();
    highlightStyle.textContent = `::highlight(${highlightName}) { background-color: ${options.colors.highlight}; }
      .scriptura-${id} ::selection { ${look} }
      ::highlight(${pressedName}) { ${look} }`;
  }

  /**
   * How the selection looks: in the selection's color, or – given a mark's look, as a pen's – as the
   * words would look marked so; or, as a pen erases them, as they will look: in the marks' look.
   */
  function selectionLook() {
    if (erasing.mark) return 'background-color: transparent;';
    const style = options.selectionStyle;
    const fill = style?.highlight ? colorOf(style.highlight, options.colors.marks) : undefined;
    const line = style?.underline ? colorOf(style.underline, options.colors.markLines) : undefined;
    if (!fill && !line) return `background-color: ${options.colors.selection ?? 'Highlight'};`;
    // An underline alone keeps a tint of its color behind the words, where a browser draws no line in a selection.
    return `background-color: ${fill ?? `color-mix(in srgb, ${line} 18%, transparent)`};${line ? ` text-decoration: underline ${line} 2px;` : ''}`;
  }

  /**
   * The words at a point in the page: the word there – selecting verses, its verse – or the words of
   * the verse whose number is there.
   */
  function wordsAt(x: number, y: number): [number, number] | undefined {
    const index = wordAt(x, y);
    if (index !== undefined) return options.selectBy === 'verse' ? verseOf(index) : [index, index];
    const caret = caretAt(x, y);
    const block = caret ? pieces.findIndex((blockPieces) => blockPieces.some((piece) => piece.node === caret.node)) : -1;
    if (!caret || block < 0) return undefined;
    const offset = pieces[block].find((piece) => piece.node === caret.node)!.start + caret.offset;
    const verse = blocks[block].verses.find((range) => range.start <= offset && offset < range.end);
    if (!verse) return undefined;
    const first = words.findIndex((word) => word.block === block && word.place.chapter === verse.chapter && word.place.verse === verse.verse);
    return first < 0 ? undefined : verseOf(first);
  }

  /** The words of a word's verse, from its first to its last, in however many paragraphs they stand. */
  function verseOf(index: number): [number, number] {
    let [first, last] = [index, index];
    while (first > 0 && sameVerse(words[first - 1].place, words[index].place)) first--;
    while (last < words.length - 1 && sameVerse(words[last + 1].place, words[index].place)) last++;
    return [first, last];
  }

  /** A press held still: the word there is selected, or the verse whose number it is, and the page's own selection is held off. */
  function beginPress(x: number, y: number, pointer: number) {
    const at = wordsAt(x, y);
    if (!at) return;
    pressed = { anchor: at, focus: at, x, y };
    closeNote();
    document.getSelection()?.removeAllRanges();
    root.classList.add('scriptura-pressing');
    if (root.hasPointerCapture?.(pointer) === false) root.setPointerCapture(pointer);
    drawPressed();
  }

  /**
   * The pointer, moving on, takes the selection to the word under it – selecting verses, to its verse,
   * or the verse whose number it is on – in the book it started in; between words, it stays.
   */
  function extendPress() {
    if (!pressed) return;
    const index = wordAt(pressed.x, pressed.y);
    const at = options.selectBy === 'verse' ? wordsAt(pressed.x, pressed.y) : index === undefined ? undefined : ([index, index] as [number, number]);
    if (at && sameBook(words[at[0]].place, words[pressed.anchor[0]].place)) pressed.focus = at;
    drawPressed();
  }

  /** The words a press has taken: from the first to the last of its anchor and its focus. */
  const pressedWords = (press: NonNullable<typeof pressed>): [number, number] => [Math.min(press.anchor[0], press.focus[0]), Math.max(press.anchor[1], press.focus[1])];

  /** The words a press has taken as a selection: those of the book it started in. */
  function pressedSelection(press: NonNullable<typeof pressed>): SelectedPlaces {
    const [first, last] = pressedWords(press);
    const book = words[press.anchor[0]].place;
    let end = last;
    while (!sameBook(words[end].place, book)) end--;
    return { passage: book.passage, book: book.book, from: endOf(first, true), to: endOf(end, false) };
  }

  /**
   * Draws the words a press has taken, those of its book, a paragraph at a time, in the selection's
   * look – or, as a pen erases them, not: the marks show them as they will be.
   */
  function drawPressed() {
    if (!('highlights' in CSS)) return;
    followErasing();
    if (!pressed || erasing.mark) return CSS.highlights.delete(pressedName);
    const [first, last] = pressedWords(pressed);
    const book = words[pressed.anchor[0]].place;
    const ranges: Range[] = [];
    for (let index = first; index <= last; index++) {
      if (!sameBook(words[index].place, book)) continue;
      let end = index;
      while (end < last && sameBook(words[end + 1].place, book) && words[end + 1].block === words[index].block) end++;
      const range = drawnRange(words[index].block, words[index].start, words[end].end);
      if (range) ranges.push(range);
      index = end;
    }
    const highlight = new Highlight(...ranges);
    highlight.priority = 2;
    CSS.highlights.set(pressedName, highlight);
  }

  /** The press lets go: its words become the page's selection – reported as any – and true; false where there was no press. */
  function endPress() {
    clearTimeout(pressTimer);
    root.classList.remove('scriptura-touching');
    if (!pressed) return false;
    const selection = pressedSelection(pressed);
    pressed = undefined;
    root.classList.remove('scriptura-pressing');
    // Selected first, so what the words erase stays as found while pressed.
    setSelection(selection);
    drawPressed();
    return true;
  }

  /**
   * While a press rests at an edge: in the scroll, near the top or bottom, the reader scrolls on, faster nearer it; in pages, resting
   * at a side, it turns the page – from the right in a book from the right – and again after another rest. The selection goes along.
   */
  function edgeStep() {
    edgeFrame = undefined;
    if (!pressed) return;
    const area = root.getBoundingClientRect();
    if (layout.kind === 'scroll') {
      const depth = pressed.y < area.top + EDGE ? pressed.y - area.top - EDGE : pressed.y > area.bottom - EDGE ? pressed.y - area.bottom + EDGE : 0;
      if (depth === 0) return;
      root.scrollTop += Math.sign(depth) * Math.max(1, Math.min(1, (Math.abs(depth) / EDGE) ** 2) * 8);
    } else {
      const side = pressed.x < area.left + SIDE ? -1 : pressed.x > area.right - SIDE ? 1 : 0;
      if (side === 0) return void (pressed.sideSince = undefined);
      const now = performance.now();
      pressed.sideSince ??= now;
      if (now - pressed.sideSince >= SIDE_REST) {
        turn(side > 0 !== layout.rightToLeft);
        pressed.sideSince = now;
      }
    }
    extendPress();
    edgeFrame = requestAnimationFrame(edgeStep);
  }

  /** The word at a point in the page, if a paragraph holds one there. */
  function wordAt(x: number, y: number) {
    const caret = caretAt(x, y);
    if (!caret) return undefined;
    const block = pieces.findIndex((blockPieces) => blockPieces.some((piece) => piece.node === caret.node));
    if (block < 0) return undefined;
    // Only within the paragraph: a tap beside the text is on none of its words.
    const bounds = paragraphs[block].getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return undefined;
    const piece = pieces[block].find((candidate) => candidate.node === caret.node)!;
    const offset = piece.start + caret.offset;
    const index = words.findIndex((word) => word.block === block && word.start <= offset && offset <= word.end);
    return index < 0 ? undefined : index;
  }

  /** The first word in sight: the first on the page, or of the first line at the top. */
  function wordInSight() {
    if (words.length === 0) return undefined;
    const area = root.getBoundingClientRect();
    const right = content.dir === 'rtl';
    for (let y = area.top + INSET + 2; y < area.bottom; y += 8) {
      const x = right ? area.right - options.sideMargin - 2 : area.left + options.sideMargin + 2;
      const caret = caretAt(x, y);
      if (!caret) continue;
      const block = pieces.findIndex((blockPieces) => blockPieces.some((piece) => piece.node === caret.node));
      if (block < 0) continue;
      const index = words.findIndex((word) => word.block >= block);
      if (index >= 0) return index;
    }
    return undefined;
  }

  /** Marks a word reached by a tap, a move or a jump. While reading aloud, the voice goes on from it. */
  function select(index: number) {
    closeNote();
    following = true;
    mark(index);
    live.textContent = rangeOf(words[index]).toString();
    if (readAloud.state === 'speaking') play();
  }

  /**
   * Marks the word the voice comes to, and keeps it in sight – unless the reader was scrolled away from it, until it is in sight
   * again. Voices report some punctuation apart, as a word of its own: it is still the word it belongs to.
   */
  function reached(place: Place) {
    const index = indices.get(key(place));
    if (index === undefined || index === current) return;
    if (!following && performance.now() - scrolledAt > HAND_SETTLES && inSight(index)) setFollowing(true);
    mark(index, following);
  }

  /** While the voice reads, a scroll by hand leaves it be: the reader no longer follows it. */
  function scrolledByHand() {
    scrolledAt = performance.now();
    if (readAloud.state === 'speaking') setFollowing(false);
  }

  function setFollowing(value: boolean) {
    if (value === following) return;
    following = value;
    if (readAloud.state === 'speaking') options.onSpeechChange?.({ state: 'speaking', following });
  }

  function follow() {
    setFollowing(true);
    if (current !== undefined) showWord(current, 'third');
  }

  function mark(index: number, show = true) {
    current = index;
    highlight();
    if (show) showWord(index, 'third');
    const { place } = words[index];
    options.onWordChange?.({ passage: place.passage, book: place.book, chapter: place.chapter, verse: place.verse, word: place.index });
  }

  function jump({ passage, book, chapter, verse, word }: WordPosition) {
    const place = { passage, book, chapter, verse, index: word };
    const inVerse = (other: Place) => other.passage === passage && other.book === book && other.chapter === chapter && other.verse === verse;
    const index = indices.get(key(place)) ?? words.findIndex((candidate) => inVerse(candidate.place));
    if (index < 0) return false;
    select(index);
    return true;
  }

  function play() {
    readAloud.voices = options.voices;
    readAloud.rate = options.speechRate;
    following = true;
    const { library, passages, companions, speakAlong, recordedVoices } = options;
    readAloud.play(library, passages, companions, speakAlong, readingStart(), recordedVoices);
  }

  /** The word reading starts at: the one marked, or the first in sight – none at the very start, where reading starts with the first heading. */
  function readingStart(): WordPosition | undefined {
    const atStart = layout.kind === 'scroll' ? root.scrollTop <= 0 : page === 0 && Math.abs(root.scrollLeft) < 1;
    const index = current ?? (atStart ? undefined : wordInSight());
    if (index === undefined) return undefined;
    const { place } = words[index];
    return { passage: place.passage, book: place.book, chapter: place.chapter, verse: place.verse, word: place.index };
  }

  function highlight() {
    if (!('highlights' in CSS)) return;
    const range = current === undefined ? undefined : drawnRange(words[current].block, words[current].start, words[current].end);
    if (!range) return CSS.highlights.delete(highlightName);
    // Over the marks, so the word the voice is at shows on a marked verse.
    const word = new Highlight(range);
    word.priority = 1;
    CSS.highlights.set(highlightName, word);
  }

  /**
   * The words the page's selection covers, if it lies in this reader – of the first word's passage
   * and book, where it runs on into another: from the first word, or its verse where the selection
   * starts at its first word, to the last, or its verse. None where it covers no word.
   */
  function selectionOfPage(): SelectedPlaces | null {
    const selected = wordsSelected();
    if (!selected) return null;
    const { passage, book } = words[selected.first].place;
    const found = { passage, book, from: endOf(selected.first, true), to: endOf(selected.last, false) };
    return options.selectBy === 'verse' ? wholeVerses(found) : found;
  }

  /** The first and the last word the page's selection covers in the reader, both of the first's passage and book. */
  function wordsSelected() {
    const selected = document.getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed || words.length === 0) return undefined;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return undefined;
    // The words are in the page's order: the first that ends after the selection starts, and the last that starts before it ends.
    const first = lowest((index) => range.compareBoundaryPoints(Range.END_TO_START, rangeOf(words[index])) < 0);
    let last = lowest((index) => range.compareBoundaryPoints(Range.START_TO_END, rangeOf(words[index])) <= 0) - 1;
    if (first >= words.length || last < first) return undefined;
    while (!sameBook(words[last].place, words[first].place)) last--;
    return { first, last };
  }

  /**
   * Where the selection shows in the reader: the words of it in sight, of its book, the line of the first of them and of the last,
   * each from the first word on it to the last – none where none is in sight.
   */
  function frameOfSelection(): SelectionFrame | null {
    const selected = wordsSelected();
    if (!selected) return null;
    const area = root.getBoundingClientRect();
    const rects: DOMRect[] = [];
    for (let index = selected.first; index <= selected.last; index++) {
      const word = words[index];
      if (!sameBook(word.place, words[selected.first].place)) continue;
      const rect = (drawnRange(word.block, word.start, word.end) ?? rangeOf(word)).getBoundingClientRect();
      if (rect.width > 0 && rect.bottom > area.top && rect.top < area.bottom && rect.right > area.left && rect.left < area.right) rects.push(rect);
    }
    if (rects.length === 0) return null;
    // A line's words follow each other at one height.
    const line = (from: number, step: number): Frame => {
      const same = [rects[from]];
      for (let at = from + step; at >= 0 && at < rects.length && Math.abs(rects[at].top - rects[from].top) < rects[from].height / 2; at += step) same.push(rects[at]);
      const [left, top] = [Math.min(...same.map((rect) => rect.left)), Math.min(...same.map((rect) => rect.top))];
      const [right, bottom] = [Math.max(...same.map((rect) => rect.right)), Math.max(...same.map((rect) => rect.bottom))];
      return [left - area.left, top - area.top, right - left, bottom - top];
    };
    return { first: line(0, 1), last: line(rects.length - 1, -1) };
  }

  /** Tells the page where the selection shows, if that changed – none while the pointer is down. */
  function reportFrame() {
    const frame = down ? null : frameOfSelection();
    const reported = JSON.stringify(frame);
    if (reported === reportedFrame) return;
    reportedFrame = reported;
    options.onSelectionFrame?.(frame);
  }

  /** Reports where the selection shows once the page has drawn it – or, after a scroll, once the scroll has come to rest. */
  function frameLater(wait = 0) {
    clearTimeout(frameTimer);
    frameTimer = window.setTimeout(() => requestAnimationFrame(() => destroyed || reportFrame()), wait);
  }

  /** The least index of a word for which `holds` holds – it holds from some word on – or the number of words. */
  function lowest(holds: (index: number) => boolean) {
    let [low, high] = [0, words.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (holds(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /** A word as an end of a selection: its verse, where the word is the verse's first or last, as asked; else the word itself. */
  function endOf(index: number, first: boolean): MarkEnd {
    const { place } = words[index];
    const next = words[index + 1];
    const whole = first ? place.index === 0 : next === undefined || !sameVerse(next.place, place);
    return whole ? { chapter: place.chapter, verse: place.verse } : { chapter: place.chapter, verse: place.verse, word: place.index };
  }

  function selectionChanged() {
    frameLater();
    followErasing();
    const selection = selectionOfPage();
    const reported = JSON.stringify(selection);
    if (reported === reportedSelection) return;
    reportedSelection = reported;
    options.onSelectionChange?.(selection);
  }

  /**
   * Selects words or verses as a drag would – from a word, or a verse's first, to a word, or a verse's
   * last; selecting verses, the whole verses – or nothing.
   */
  function setSelection(selection: SelectedPlaces | null) {
    const selected = document.getSelection();
    if (!selected) return;
    if (!selection) {
      if (selectionOfPage()) selected.removeAllRanges();
      return;
    }
    const span = wordsOf(options.selectBy === 'verse' ? wholeVerses(selection) : selection);
    if (!span) return;
    const [first, last] = span;
    const range = document.createRange();
    range.setStart(...position(words[first].block, words[first].start));
    range.setEnd(...position(words[last].block, words[last].end, true));
    selected.removeAllRanges();
    selected.addRange(range);
  }

  /** The first and the last word of a selection in the reader: from a word, or a verse's first, to a word, or a verse's last. */
  function wordsOf(selection: SelectedPlaces): [number, number] | undefined {
    const inBook = (word: Word) => word.place.passage === selection.passage && word.place.book === selection.book;
    const first = words.findIndex((word) => inBook(word) && compare(word.place, selection.from, false) >= 0);
    const last = words.findLastIndex((word) => inBook(word) && compare(word.place, selection.to, true) <= 0);
    return first < 0 || last < first ? undefined : [first, last];
  }

  /** The marks on a word, by id – those whose words it is among – reported with the word. */
  function reportMarkTap(index: number) {
    const word = words[index];
    const ids = blocks[word.block].marks.filter((mark) => mark.start <= word.start && word.end <= mark.end).map((mark) => mark.id);
    if (ids.length > 0) options.onMarkTap?.({ ids, ...positionOf(word.place) });
  }

  /** Whether a word is in sight: on the page shown, or in one endless scroll, wholly in view. */
  function inSight(index: number) {
    const rect = rangeOf(words[index]).getBoundingClientRect();
    const area = root.getBoundingClientRect();
    if (layout.kind === 'scroll') return rect.top >= area.top && rect.bottom <= area.bottom;
    return rect.left >= area.left && rect.right <= area.right;
  }

  /**
   * Brings a word into sight: turns to its page, or scrolls it to the top or a third of the way
   * down. In a scroll, paragraphs out of sight are laid out only as guessed until they come near:
   * a long way off, the word lands elsewhere at first, so the scroll is checked and set again over
   * the frames after, until it holds.
   */
  function showWord(index: number, where: 'top' | 'third', tries = 6) {
    const rect = rangeOf(words[index]).getBoundingClientRect();
    const area = root.getBoundingClientRect();
    if (layout.kind === 'scroll') {
      if (where === 'third' && rect.top >= area.top && rect.bottom <= area.bottom) return;
      const offset = where === 'top' ? INSET : root.clientHeight / 3;
      const far = Math.abs(rect.top - area.top - offset) > root.clientHeight;
      root.scrollTo({ top: root.scrollTop + rect.top - area.top - offset, behavior: where === 'top' || far ? 'instant' : 'smooth' });
      if (far && tries > 0) requestAnimationFrame(() => destroyed || words[index] === undefined || showWord(index, where, tries - 1));
      return;
    }
    // Every page is as wide as the reader, wherever a section's columns run.
    const x = layout.rightToLeft ? area.right - rect.right + Math.abs(root.scrollLeft) : rect.left - area.left + root.scrollLeft;
    goTo(Math.floor(x / root.clientWidth));
  }

  function goTo(target: number) {
    page = Math.min(Math.max(target, 0), pageCount - 1);
    if (layout.kind === 'scroll') {
      if (target === 0) root.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    root.scrollTo({ left: (layout.rightToLeft ? -1 : 1) * page * root.clientWidth, behavior: 'instant' });
  }

  function turn(forward: boolean) {
    scrolledByHand();
    if (layout.kind === 'scroll') {
      root.scrollBy({ top: (forward ? 1 : -1) * (root.clientHeight - 2 * INSET), behavior: 'smooth' });
      return;
    }
    // From the page in sight, however it came there.
    goTo(Math.round(Math.abs(root.scrollLeft) / root.clientWidth) + (forward ? 1 : -1));
  }

  function move(step: MoveStep) {
    if (words.length === 0) return;
    if (current === undefined) return select(0);
    const verseStart = (index: number) => {
      let start = index;
      while (start > 0 && sameVerse(words[start - 1].place, words[index].place)) start--;
      return start;
    };
    const last = words.length - 1;
    const steps: Record<MoveStep, () => number> = {
      'word+1': () => Math.min(current! + 1, last),
      'word-1': () => Math.max(current! - 1, 0),
      'word+10': () => Math.min(current! + 10, last),
      'word-10': () => Math.max(current! - 10, 0),
      'verse+1': () => words.findIndex((word, index) => index > current! && !sameVerse(word.place, words[current!].place)),
      'verse-1': () => {
        const start = verseStart(current!);
        return start === 0 ? 0 : verseStart(start - 1);
      },
    };
    const target = steps[step]();
    select(target < 0 ? current : target);
  }

  // A tap selects the word there – the first after a selection only ends it; in pages, a finger's
  // swipe or the arrow keys turn them. In one endless scroll, the browser scrolls: by the wheel, a
  // finger, the keys or the scroll bar. A press held still selects the word, as on iOS and Android,
  // and moving on takes the selection along word by word; a drag or a double click select text, as
  // the browser has it.
  let down: { x: number; y: number; at: number; selected: boolean } | undefined;
  root.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY, at: performance.now(), selected: selectionOfPage() !== null };
    reportFrame();
    const area = root.getBoundingClientRect();
    if (event.clientX - area.left >= root.clientLeft + root.clientWidth) scrolledByHand();
    clearTimeout(pressTimer);
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.scriptura-mark, .scriptura-note'))) return;
    // A finger's long press is the reader's, not the browser's selection with its handles.
    if (event.pointerType === 'touch') root.classList.add('scriptura-touching');
    const [x, y, pointer] = [event.clientX, event.clientY, event.pointerId];
    pressTimer = window.setTimeout(() => down && beginPress(x, y, pointer), PRESS);
  });
  root.addEventListener('pointermove', (event) => {
    if (!pressed) {
      // Moved before it was held: no press – the browser's own selection, or a scroll.
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 8) clearTimeout(pressTimer);
      return;
    }
    pressed.x = event.clientX;
    pressed.y = event.clientY;
    extendPress();
    edgeFrame ??= requestAnimationFrame(edgeStep);
  });
  root.addEventListener('touchmove', (event) => {
    // While a press takes the selection on, the finger moves no text.
    if (pressed && event.cancelable) event.preventDefault();
    else scrolledByHand();
  }, { passive: false });
  root.addEventListener('contextmenu', (event) => {
    if (pressed || root.classList.contains('scriptura-touching')) event.preventDefault();
  });
  root.addEventListener('pointercancel', () => {
    if (endPress()) frameLater();
    down = undefined;
  });
  // Once the reader no longer follows the voice, every scroll is a hand's, or its gliding on. A
  // note open stands where its mark was: it closes.
  root.addEventListener('scroll', () => {
    if (!following) scrolledAt = performance.now();
    closeNote();
    // While the reader moves, the selection is nowhere to stay beside; once it rests, it is somewhere again.
    if (reportedFrame !== 'null') {
      reportedFrame = 'null';
      options.onSelectionFrame?.(null);
    }
    frameLater(150);
  }, { passive: true });
  root.addEventListener('pointerup', (event) => {
    const pressedHere = endPress();
    if (!down) return;
    const [dx, dy, held, selected] = [event.clientX - down.x, event.clientY - down.y, performance.now() - down.at, down.selected];
    down = undefined;
    frameLater();
    if (pressedHere) return;
    // Selecting verses, the page's own selection – a quick drag, a double click – takes in its verses, once the browser is done with it.
    if (options.selectBy === 'verse') setTimeout(() => setSelection(selectionOfPage()));
    const target = event.target instanceof Element ? event.target : null;
    if (opened && target && opened.note.contains(target)) return;
    if (Math.hypot(dx, dy) < 8 && held < LONG_PRESS && selected) return closeNote();
    if (Math.hypot(dx, dy) < 8 && held < LONG_PRESS) {
      const mark = target?.closest<HTMLElement>('.scriptura-mark');
      if (mark) {
        if (opened?.mark === mark) closeNote();
        else openNote(mark);
        return;
      }
      closeNote();
      const index = wordAt(event.clientX, event.clientY);
      if (index !== undefined) {
        select(index);
        reportMarkTap(index);
      }
    } else if (event.pointerType === 'touch' && layout.kind !== 'scroll' && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      // A swipe to the left turns forward; in pages from the right, back.
      turn(dx < 0 !== (layout.rightToLeft ?? false));
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      return closeNote();
    }
    if (layout.kind === 'scroll') {
      if (SCROLL_KEYS.has(event.key)) scrolledByHand();
      return;
    }
    const forward = { ArrowRight: true, ArrowLeft: false, PageDown: true, PageUp: false }[event.key];
    if (forward === undefined) return;
    event.preventDefault();
    const rightToLeft = layout.rightToLeft && event.key.startsWith('Arrow');
    turn(forward !== rightToLeft);
  });
  root.addEventListener('wheel', (event) => {
    if (layout.kind === 'scroll') return scrolledByHand();
    if (Math.abs(event.deltaX) + Math.abs(event.deltaY) < 20) return;
    event.preventDefault();
    turn((Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) > 0);
  }, { passive: false });

  /**
   * The browser's media controls show the reader while it reads aloud, playing or paused, if it has something to show there; their
   * buttons play, pause and move it by a verse. Browsers show them while an audio element plays: for recordings, not voices.
   */
  function showInControls(state: SpeechChange['state']) {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const shown = options.nowPlaying;
    if (shown && state !== 'stopped') {
      shownInControls = id;
      session.metadata = new MediaMetadata({ title: shown.title, artist: shown.subtitle ?? '' });
      session.playbackState = state === 'speaking' ? 'playing' : 'paused';
      session.setActionHandler('play', () => play());
      session.setActionHandler('pause', () => readAloud.pause(readingStart()));
      session.setActionHandler('nexttrack', () => move('verse+1'));
      session.setActionHandler('previoustrack', () => move('verse-1'));
    } else if (shownInControls === id) {
      shownInControls = undefined;
      session.metadata = null;
      session.playbackState = 'none';
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) session.setActionHandler(action, null);
    }
  }

  // Reading aloud pauses as the page is hidden, unless the media controls may show it.
  const hidden = () => {
    if (document.visibilityState === 'hidden' && !options.nowPlaying && readAloud.state === 'speaking') readAloud.pause(readingStart());
  };
  document.addEventListener('visibilitychange', hidden);
  document.addEventListener('selectionchange', selectionChanged);

  // New books lay the text out anew, and new marks are drawn, the reading on; what was still to be
  // read goes with the books or recordings that change.
  let library = options.library;
  const followed = (change: LibraryChange) => {
    if (change === 'marks') return render();
    readAloud.stop();
    if (change === 'books') render();
  };
  let unfollow = library.onChange(followed);

  // A new size lays the text out anew, at the word it was at.
  let size = '';
  const resizes = new ResizeObserver(() => {
    const now = `${root.clientWidth}x${root.clientHeight}`;
    if (now !== size && size !== '') render();
    size = now;
  });
  resizes.observe(root);

  render();
  return {
    update(changes) {
      options = { ...options, ...changes };
      if (options.library !== library) {
        unfollow();
        library = options.library;
        unfollow = library.onChange(followed);
      }
      render();
    },
    move,
    jump,
    play,
    pause: () => readAloud.pause(readingStart()),
    stop: () => readAloud.stop(),
    follow,
    refresh() {
      readAloud.stop();
      render();
    },
    turn,
    select: setSelection,
    destroy() {
      destroyed = true;
      clearTimeout(frameTimer);
      closeNote();
      unfollow();
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('selectionchange', selectionChanged);
      readAloud.stop();
      resizes.disconnect();
      CSS.highlights?.delete(highlightName);
      CSS.highlights?.delete(pressedName);
      clearTimeout(pressTimer);
      if (edgeFrame !== undefined) cancelAnimationFrame(edgeFrame);
      for (const name of markNames) CSS.highlights?.delete(name);
      root.remove();
      highlightStyle.remove();
      marksStyle.remove();
    },
  };
}

const key = ({ passage, book, chapter, verse, index }: Place) => `${passage} ${book} ${chapter}:${verse} ${index}`;

const sameBook = (a: Place, b: Place) => a.passage === b.passage && a.book === b.book;

const sameVerse = (a: Place, b: Place) => a.passage === b.passage && a.book === b.book && a.chapter === b.chapter && a.verse === b.verse;

const positionOf = ({ passage, book, chapter, verse, index }: Place): WordPosition => ({ passage, book, chapter, verse, word: index });

/** Where a word stands against an end of a selection: before, at or after it – a whole verse reaching from its first word, as a start, to its last, as an end. */
function compare(place: Place, end: MarkEnd, last: boolean) {
  const ends = [end.chapter, end.verse, end.word ?? (last ? Infinity : 0)];
  return [place.chapter, place.verse, place.index].map((value, at) => Math.sign(value - ends[at])).find((sign) => sign !== 0) ?? 0;
}

/** A selection's whole verses: from its first verse's first word to its last verse's last. */
const wholeVerses = ({ passage, book, from, to }: SelectedPlaces): SelectedPlaces => ({
  passage,
  book,
  from: { chapter: from.chapter, verse: from.verse },
  to: { chapter: to.chapter, verse: to.verse },
});

/** A mark's color: the palette's, by the name the mark gives – or the name itself, as a color. */
const colorOf = (name: string, named: Record<string, string> | undefined) => named?.[name] ?? name;

/** Text screen readers read and nothing shows. */
function hiddenText(text: string) {
  const span = document.createElement('span');
  span.className = 'scriptura-hidden';
  span.textContent = text;
  return span;
}

/** The caret position at a point in the page, as each browser has it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  if ('caretPositionFromPoint' in document) {
    const caret = (document as Document & { caretPositionFromPoint(x: number, y: number): { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(x, y);
    return caret ? { node: caret.offsetNode, offset: caret.offset } : undefined;
  }
  const range = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
}

const canvas = document.createElement('canvas').getContext('2d')!;
const heights = new Map<string, number>();
const lineHeights = new Map<string, [number, number]>();

function measure(text: string, family: string, size: number) {
  canvas.font = `${size}px ${family}`;
  return canvas.measureText(text);
}

/** Whether the fonts of `family` are loaded – or none need to be – so its letters measure as they show. */
const fontsLoaded = (family: string) => document.fonts.check(`16px ${family}`);

/** Whether a font the page has loaded, by family, draws `text` itself: set before `fallback`, the text comes out another width than in the fallback alone. */
function fontHasGlyph(family: string, text: string, fallback: string) {
  if (!fontsLoaded(`"${family}"`)) return false;
  return measure(text, `"${family}", ${fallback}`, 100).width !== measure(text, fallback, 100).width;
}

/** How tall `letter` is drawn in `family`, per pixel of the font's size – in the font the browser takes for it. */
function letterHeight(letter: string, family: string) {
  const known = heights.get(`${family} ${letter}`);
  if (known) return known;
  const metrics = measure(letter, family, 100);
  const height = (metrics.actualBoundingBoxAscent - Math.max(-metrics.actualBoundingBoxDescent, 0)) / 100 || 0.5;
  if (fontsLoaded(family)) heights.set(`${family} ${letter}`, height);
  return height;
}

/** A font's own line height, per pixel of its size: as a multiple of it, lines keep each font's spacing, as on iOS and Android. */
function lineHeight(family: string) {
  const [ascent, descent] = fontBox(family);
  return ascent + descent || 1.2;
}

/** A font's ascent and descent, per pixel of its size, which its line box has above and below the baseline. */
function fontBox(family: string): [number, number] {
  const known = lineHeights.get(family);
  if (known) return known;
  const metrics = measure('x', family, 100);
  const box: [number, number] = [metrics.fontBoundingBoxAscent / 100 || 0.9, metrics.fontBoundingBoxDescent / 100 || 0.3];
  if (fontsLoaded(family)) lineHeights.set(family, box);
  return box;
}

let styled = false;

function injectStyles() {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = `
.scriptura { position: relative; box-sizing: border-box; height: 100%; overflow: hidden auto; outline: none; }
.scriptura[data-paging="pages"] { overflow: hidden; }
.scriptura-content { box-sizing: border-box; }
.scriptura p { margin-block-start: 0; margin-inline-end: 0; overflow-wrap: break-word; }
.scriptura-pressing, .scriptura-touching { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.scriptura-live, .scriptura-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; user-select: none; }
.scriptura-mark { all: unset; cursor: pointer; font-size: 0.6em; line-height: 0; vertical-align: super; padding-inline: 0.08em; }
.scriptura-mark:focus-visible, .scriptura-reference:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.scriptura-drop { float: inline-start; position: relative; margin-inline-end: 0.14em; white-space: nowrap; }
.scriptura .scriptura-drop::selection { background-color: transparent; }
.scriptura-note { position: fixed; z-index: 10; box-sizing: border-box; padding: 10px 14px; border-radius: 8px; overflow: auto; outline: none;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
.scriptura-reference { all: unset; cursor: pointer; text-decoration: underline; }
`;
  document.head.append(style);
}
