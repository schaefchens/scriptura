import type { LaidOut, MoveStep, ReaderColors, ReaderOptions, SpeechChange, WordPosition } from '@schaefchens/scriptura';
import { palette } from '@schaefchens/scriptura';

import type { Block, Library } from './library';
import { ReadAloud } from './readAloud';

export type WebReaderOptions = ReaderOptions & {
  library: Library;
  /** The word reached, by a tap, a move or a jump, or by the voice reading aloud: where it stands. */
  onWordChange?: (position: WordPosition) => void;
  onLaidOut?: (time: LaidOut) => void;
  onSpeechChange?: (change: SpeechChange) => void;
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
  /** Shows what the library now holds, after books or recordings were added or removed. */
  refresh(): void;
  /** Turns to the next or previous page, or a screen down or up. */
  turn(forward: boolean): void;
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
const DEFAULTS: Required<Omit<ReaderOptions, 'passages' | 'colors' | 'recordedVoices'>> = {
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
  voices: {},
  speakAlong: false,
  speechRate: 1,
};

let readers = 0;

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
  root.className = 'scriptura';
  root.tabIndex = 0;
  content.className = 'scriptura-content';
  live.className = 'scriptura-live';
  live.setAttribute('aria-live', 'polite');
  root.append(content, live);
  element.append(root, highlightStyle);

  let blocks: Block[] = [];
  let paragraphs: HTMLElement[] = [];
  let pieces: Piece[][] = [];
  let words: Word[] = [];
  /** Each word's index in `words`, by where it stands. */
  let indices = new Map<string, number>();
  let current: number | undefined;
  const readAloud = new ReadAloud(
    (part, word) => reached({ passage: part.passage, book: part.book, chapter: word.chapter, verse: word.verse, index: word.index }),
    // While it speaks, with whether the reader follows it.
    (change) => options.onSpeechChange?.(change.state === 'speaking' ? { ...change, following } : change),
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

  function render() {
    const started = performance.now();
    const { library, passages, fontSize, versePerLine, companions, parallel, colors } = options;
    // The same passages in another layout keep the reader at the word it was at, and the word it
    // marked; if a word is gone, as a book is no longer read along, the last before it still there.
    const staying = JSON.stringify(passages) === shownPassages;
    const kept = staying ? words : [];
    const anchorAt = staying ? wordInSight() : undefined;
    const marked = staying && current !== undefined ? words[current].place : undefined;
    if (!staying) readAloud.stop();
    shownPassages = JSON.stringify(passages);

    blocks = library.blocks(passages, { fontSize, versePerLine, companions });
    const loading = [...new Set(blocks.map(familyOf))].filter((family) => !fontsLoaded(family) && !awaited.has(family));
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
      const [element, blockPieces] = paragraph(block, sizes[index], spacing, indented, numberColumn);
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
    highlightStyle.textContent = `::highlight(${highlightName}) { background-color: ${colors.highlight}; }`;
    layout = arrange(sectionsOf(along, sideBySide), rightToLeft);

    indices = new Map(words.map((word, index) => [key(word.place), index]));
    const anchor = anchorAt === undefined ? undefined : kept.slice(0, anchorAt + 1).reverse().map((word) => indices.get(key(word.place))).find((index) => index !== undefined);
    if (marked) {
      current = indices.get(key(marked));
      highlight();
    }
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
    if (anchor !== undefined) showWord(anchor, 'top');
    else goTo(0);
    const time = performance.now() - started;
    options.onLaidOut?.({ pages: options.paging === 'pages' ? pageCount : 0, milliseconds: time, all: time });
  }

  /** A block as a paragraph in its language and direction, its runs colored by their roles; and its text's pieces. */
  function paragraph(block: Block, size: number, spacing: number, indent: number, numberColumn: number): [HTMLElement, Piece[]] {
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
    block.segments.forEach(({ text, role }, index) => {
      // A hanging number's tab becomes the width of the number column.
      const shown = hangs && index === 0 ? text.slice(0, -1) : text;
      const node = document.createTextNode(shown);
      if (role || (hangs && index === 0)) {
        const span = document.createElement('span');
        if (role) span.style.color = options.colors.roles[role] ?? '';
        if (hangs && index === 0) Object.assign(span.style, { display: 'inline-block', inlineSize: `${numberColumn}px`, textIndent: '0' });
        span.append(node);
        element.append(span);
      } else {
        element.append(node);
      }
      blockPieces.push({ node, start, length: text.length });
      start += text.length;
    });
    return [element, blockPieces];
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
  function rangeOf(word: Word) {
    const range = document.createRange();
    const [startNode, startOffset] = position(word.block, word.start);
    const [endNode, endOffset] = position(word.block, word.end);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  /** Where an offset in a paragraph's text is in the page. */
  function position(block: number, offset: number): [Text, number] {
    const blockPieces = pieces[block];
    const piece = blockPieces.findLast((candidate) => candidate.start <= offset) ?? blockPieces[0];
    return [piece.node, Math.min(offset - piece.start, piece.node.length)];
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
    if (current === undefined) CSS.highlights.delete(highlightName);
    else CSS.highlights.set(highlightName, new Highlight(rangeOf(words[current])));
  }

  /** Whether a word is in sight: on the page shown, or in one endless scroll, wholly in view. */
  function inSight(index: number) {
    const rect = rangeOf(words[index]).getBoundingClientRect();
    const area = root.getBoundingClientRect();
    if (layout.kind === 'scroll') return rect.top >= area.top && rect.bottom <= area.bottom;
    return rect.left >= area.left && rect.right <= area.right;
  }

  /** Brings a word into sight: turns to its page, or scrolls it to the top or a third of the way down. */
  function showWord(index: number, where: 'top' | 'third') {
    const rect = rangeOf(words[index]).getBoundingClientRect();
    const area = root.getBoundingClientRect();
    if (layout.kind === 'scroll') {
      if (where === 'third' && rect.top >= area.top && rect.bottom <= area.bottom) return;
      const offset = where === 'top' ? INSET : root.clientHeight / 3;
      root.scrollTo({ top: root.scrollTop + rect.top - area.top - offset, behavior: where === 'top' ? 'instant' : 'smooth' });
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
    const sameVerse = (a: Place, b: Place) => a.passage === b.passage && a.book === b.book && a.chapter === b.chapter && a.verse === b.verse;
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

  // A tap selects the word there; in pages, a swipe or the arrow keys turn them. In one endless
  // scroll, the browser scrolls: by the wheel, a finger, the keys or the scroll bar.
  let down: { x: number; y: number } | undefined;
  root.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY };
    const area = root.getBoundingClientRect();
    if (event.clientX - area.left >= root.clientLeft + root.clientWidth) scrolledByHand();
  });
  root.addEventListener('touchmove', () => scrolledByHand(), { passive: true });
  // Once the reader no longer follows the voice, every scroll is a hand's, or its gliding on.
  root.addEventListener('scroll', () => {
    if (!following) scrolledAt = performance.now();
  }, { passive: true });
  root.addEventListener('pointerup', (event) => {
    if (!down) return;
    const [dx, dy] = [event.clientX - down.x, event.clientY - down.y];
    down = undefined;
    if (Math.hypot(dx, dy) < 8) {
      const index = wordAt(event.clientX, event.clientY);
      if (index !== undefined) select(index);
    } else if (layout.kind !== 'scroll' && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      // A swipe to the left turns forward; in pages from the right, back.
      turn(dx < 0 !== (layout.rightToLeft ?? false));
    }
  });
  root.addEventListener('keydown', (event) => {
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
      render();
    },
    move,
    jump,
    play,
    pause: () => readAloud.pause(readingStart()),
    stop: () => readAloud.stop(),
    follow,
    refresh() {
      // What is still to be said goes with the books.
      readAloud.stop();
      render();
    },
    turn,
    destroy() {
      destroyed = true;
      readAloud.stop();
      resizes.disconnect();
      CSS.highlights?.delete(highlightName);
      root.remove();
      highlightStyle.remove();
    },
  };
}

const key = ({ passage, book, chapter, verse, index }: Place) => `${passage} ${book} ${chapter}:${verse} ${index}`;

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
const lineHeights = new Map<string, number>();

function measure(text: string, family: string, size: number) {
  canvas.font = `${size}px ${family}`;
  return canvas.measureText(text);
}

/** Whether the fonts of `family` are loaded – or none need to be – so its letters measure as they show. */
const fontsLoaded = (family: string) => document.fonts.check(`16px ${family}`);

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
  const known = lineHeights.get(family);
  if (known) return known;
  const metrics = measure('x', family, 100);
  const height = (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 100 || 1.2;
  if (fontsLoaded(family)) lineHeights.set(family, height);
  return height;
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
.scriptura-live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
  document.head.append(style);
}
