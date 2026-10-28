import type { LaidOut, MoveStep, ReaderColors, ReaderOptions, WordPosition } from '@schaefchens/scriptura';
import { palette } from '@schaefchens/scriptura';

import type { Block, Library } from './library';

export type WebReaderOptions = ReaderOptions & {
  library: Library;
  /** The word reached, by a tap or a move: where it stands. */
  onWordChange?: (position: WordPosition) => void;
  onLaidOut?: (time: LaidOut) => void;
};

export type WebReader = {
  /** Shows other passages, or the same in another layout: the reader stays at the word it was at. */
  update(options: Partial<WebReaderOptions>): void;
  move(step: MoveStep): void;
  /** Shows what the library now holds, after books were added or removed. */
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
const DEFAULTS: Required<Omit<ReaderOptions, 'passages' | 'colors'>> = {
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
  let current: number | undefined;
  let page = 0;
  let pageCount = 1;
  let shownPassages = '';
  let layout: Layout = { kind: 'scroll' };
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
    shownPassages = JSON.stringify(passages);

    blocks = library.blocks(passages, { fontSize, versePerLine, companions });
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
    layout = arrange(sideBySide, rightToLeft);

    const keys = new Map(words.map((word, index) => [key(word.place), index]));
    const anchor = anchorAt === undefined ? undefined : kept.slice(0, anchorAt + 1).reverse().map((word) => keys.get(key(word.place))).find((index) => index !== undefined);
    if (marked) {
      current = keys.get(key(marked));
      highlight();
    }
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

  type Layout = { kind: 'scroll' } | { kind: 'columns'; stride: number; rightToLeft: boolean } | { kind: 'grid pages'; rightToLeft: boolean };

  /** Places the paragraphs: flowing, or side by side in rows; in one endless scroll, or in pages. */
  function arrange(sideBySide: boolean, rightToLeft: boolean): Layout {
    const { paging, sideMargin: margin } = options;
    const gap = Math.max(margin, 16);
    content.removeAttribute('style');
    // Pages and columns from the right: the scroll starts there too.
    root.dir = content.dir = rightToLeft ? 'rtl' : 'ltr';
    content.style.padding = `${INSET}px ${margin}px`;
    if (sideBySide) {
      const cells = gridCells();
      const columns = Math.max(...blocks.map((block) => block.column)) + 1;
      if (paging !== 'pages') {
        Object.assign(content.style, grid(columns, gap));
        content.append(...cells.map(({ element }) => element));
        pageCount = 1;
        return { kind: 'scroll' };
      }
      return gridPages(cells, columns, gap, rightToLeft);
    }
    content.append(...paragraphs);
    if (paging !== 'pages') {
      pageCount = 1;
      return { kind: 'scroll' };
    }
    // The text flows through the columns of a page, and on through the next page's.
    const width = root.clientWidth - 2 * margin;
    Object.assign(content.style, {
      height: `${root.clientHeight}px`,
      columnCount: String(Math.max(options.columns, 1)),
      columnGap: `${gap}px`,
      columnFill: 'auto',
    });
    const stride = width + gap;
    pageCount = Math.max(1, Math.ceil((content.scrollWidth - 2 * margin + gap) / stride - 0.01));
    return { kind: 'columns', stride, rightToLeft };
  }

  /** The paragraphs side by side: each book's in a row is a cell, in the book's column. */
  function gridCells() {
    const cells: { row: number; column: number; element: HTMLElement }[] = [];
    blocks.forEach((block, index) => {
      const last = cells.at(-1);
      if (last && last.row === block.row && last.column === block.column) {
        last.element.append(paragraphs[index]);
        return;
      }
      const element = document.createElement('div');
      element.style.gridColumn = String(block.column + 1);
      element.append(paragraphs[index]);
      cells.push({ row: block.row, column: block.column, element });
    });
    // Rows numbered from 1 on, as the grid counts them.
    const rows = [...new Set(cells.map(({ row }) => row))];
    const numbers = new Map(rows.map((row, index) => [row, index + 1]));
    for (const cell of cells) cell.element.style.gridRow = String(numbers.get(cell.row));
    return cells;
  }

  function grid(columns: number, gap: number) {
    return { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: `${gap}px`, alignItems: 'start' };
  }

  /** Rows side by side in pages: as many rows as fit on each, a row taller than a page on one of its own that scrolls. */
  function gridPages(cells: { row: number; element: HTMLElement }[], columns: number, gap: number, rightToLeft: boolean): Layout {
    // Measured in one grid first.
    Object.assign(content.style, grid(columns, gap));
    content.append(...cells.map(({ element }) => element));
    const height = root.clientHeight - 2 * INSET;
    const rows = new Map<number, { top: number; bottom: number; cells: HTMLElement[] }>();
    for (const { row, element } of cells) {
      const style = getComputedStyle(element.lastElementChild ?? element);
      const bottom = element.offsetTop + element.offsetHeight + parseFloat(style.marginBlockEnd || '0');
      const known = rows.get(row);
      if (known) {
        known.bottom = Math.max(known.bottom, bottom);
        known.cells.push(element);
      } else {
        rows.set(row, { top: element.offsetTop, bottom, cells: [element] });
      }
    }
    const pages: HTMLElement[][] = [[]];
    let used = 0;
    for (const { top, bottom, cells: rowCells } of rows.values()) {
      const rowHeight = bottom - top;
      if (used > 0 && used + rowHeight > height) {
        pages.push([]);
        used = 0;
      }
      pages.at(-1)!.push(...rowCells);
      used += rowHeight;
    }
    content.replaceChildren();
    content.removeAttribute('style');
    Object.assign(content.style, { display: 'flex', height: `${root.clientHeight}px` });
    for (const pageCells of pages) {
      const element = document.createElement('div');
      Object.assign(element.style, grid(columns, gap), {
        flex: `0 0 ${root.clientWidth}px`,
        boxSizing: 'border-box',
        padding: `${INSET}px ${options.sideMargin}px`,
        overflowY: 'auto',
        alignContent: 'start',
      });
      // Rows numbered anew on each page.
      const first = Math.min(...pageCells.map((cell) => Number(cell.style.gridRow)));
      for (const cell of pageCells) cell.style.gridRow = String(Number(cell.style.gridRow) - first + 1);
      element.append(...pageCells);
      content.append(element);
    }
    pageCount = pages.length;
    return { kind: 'grid pages', rightToLeft };
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

  function select(index: number) {
    current = index;
    highlight();
    showWord(index, 'third');
    const { place } = words[index];
    options.onWordChange?.({ passage: place.passage, book: place.book, chapter: place.chapter, verse: place.verse, word: place.index });
    live.textContent = rangeOf(words[index]).toString();
  }

  function highlight() {
    if (!('highlights' in CSS)) return;
    if (current === undefined) CSS.highlights.delete(highlightName);
    else CSS.highlights.set(highlightName, new Highlight(rangeOf(words[current])));
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
    if (layout.kind === 'columns') {
      const x = layout.rightToLeft ? area.right - rect.right - Math.abs(root.scrollLeft) : rect.left - area.left + root.scrollLeft;
      goTo(Math.floor((x - options.sideMargin + 1) / layout.stride));
      return;
    }
    const pageElement = paragraphs[words[index].block].closest<HTMLElement>('.scriptura-content > div');
    goTo(pageElement ? [...content.children].indexOf(pageElement) : 0);
  }

  function goTo(target: number) {
    page = Math.min(Math.max(target, 0), pageCount - 1);
    if (layout.kind === 'scroll') {
      if (target === 0) root.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const stride = layout.kind === 'columns' ? layout.stride : root.clientWidth;
    root.scrollTo({ left: (layout.rightToLeft ? -1 : 1) * page * stride, behavior: 'instant' });
  }

  function turn(forward: boolean) {
    if (layout.kind === 'scroll') {
      root.scrollBy({ top: (forward ? 1 : -1) * (root.clientHeight - 2 * INSET), behavior: 'smooth' });
      return;
    }
    goTo(page + (forward ? 1 : -1));
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

  // A tap selects the word there; in pages, a swipe or the arrow keys turn them.
  let down: { x: number; y: number } | undefined;
  root.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
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
    if (layout.kind === 'scroll') return;
    const forward = { ArrowRight: true, ArrowLeft: false, PageDown: true, PageUp: false }[event.key];
    if (forward === undefined) return;
    event.preventDefault();
    const rightToLeft = layout.rightToLeft && event.key.startsWith('Arrow');
    turn(forward !== rightToLeft);
  });
  root.addEventListener('wheel', (event) => {
    if (layout.kind === 'scroll' || Math.abs(event.deltaX) + Math.abs(event.deltaY) < 20) return;
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
    refresh: render,
    turn,
    destroy() {
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

/** How tall `letter` is drawn in `family`, per pixel of the font's size – in the font the browser takes for it. */
function letterHeight(letter: string, family: string) {
  const known = heights.get(`${family} ${letter}`);
  if (known) return known;
  const metrics = measure(letter, family, 100);
  const height = (metrics.actualBoundingBoxAscent - Math.max(-metrics.actualBoundingBoxDescent, 0)) / 100 || 0.5;
  heights.set(`${family} ${letter}`, height);
  return height;
}

/** A font's own line height, per pixel of its size: as a multiple of it, lines keep each font's spacing, as on iOS and Android. */
function lineHeight(family: string) {
  const known = lineHeights.get(family);
  if (known) return known;
  const metrics = measure('x', family, 100);
  const height = (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 100 || 1.2;
  lineHeights.set(family, height);
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
