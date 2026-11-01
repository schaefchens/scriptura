import UIKit

/// The reader's text in pages turned one by one, each in columns the text flows through, or in one
/// endless scroll. TextKit 2 lays the text out at a column's width, off the main thread, and it is
/// cut between lines into parts of a column's height. Each part shows in a text view of its own,
/// which breaks it into the same lines: as a column on a page, or stacked under the part before it.
/// A whole surah in a single text view would take seconds, as TextKit 2 lays out and draws a
/// paragraph as one piece. Only the parts around those in sight have views.
///
/// The text comes in sections, each laid out at its own width: text that flows, or books read along
/// side by side, in cells, a column for each book, each row level. In pages, each section starts a
/// page. A section is laid out in chunks of whole paragraphs, which TextKit breaks into the same lines
/// as the whole: the pages up to the reader's place show first, and the rest is laid out on all cores.
final class PagedText: UIScrollView, UIScrollViewDelegate {
  /// Paragraphs of the text that stand side by side with others: in a row, in a column of it, and
  /// whether they are headings, which go on a page only with the row after them.
  struct Cell {
    let range: NSRange
    let row: Int
    let column: Int
    let heading: Bool
  }

  /// Paragraphs of the text laid out on their own terms: flowing through a page's columns, or in
  /// cells side by side.
  struct Section {
    let range: NSRange
    /// None for text that flows.
    let cells: [Cell]
  }

  /// A drop cap: a chapter's number and first letter set large at the start of a paragraph, over its
  /// first two lines. The paragraph's range, the glyphs to draw, in which font and color, the space
  /// they take on the paragraph's leading side – its width with the gap after it, and its height –
  /// and how far the paragraph's lines advance, for a paragraph of a single line.
  struct DropCapSpec {
    let range: NSRange
    let text: String
    let font: UIFont
    let color: UIColor
    let width: CGFloat
    let height: CGFloat
    let lineAdvance: CGFloat
    /// How far above the second line's baseline the letter's baseline sits: for a letter with
    /// something hanging below it, so that stays within the second line.
    let baselineLift: CGFloat
    let rightToLeft: Bool
  }

  /// A host's mark as it is drawn over the text: its range, a fill behind its words, a line under
  /// them, and the sign of its note after its last word, which is tapped to open the note.
  struct Decoration {
    let range: NSRange
    let fill: UIColor?
    let line: UIColor?
    let sign: Sign?
    let rightToLeft: Bool
  }

  /// The sign of a mark's note: what it is, drawn small and raised in a color, after words of `size`.
  struct Sign {
    let id: String
    let text: String
    let color: UIColor
    let size: CGFloat
  }

  /// The text as last given; until it is laid out, the one before it stays in sight.
  private(set) var text = NSAttributedString()
  /// The character the reader is at: a word it was brought to, or during and after a scroll by hand,
  /// the first on the page or of the line at the top. A new layout, after the device turned or the
  /// font grew, keeps it in sight.
  private(set) var anchor = 0
  var highlightColor = UIColor.yellow
  /// The columns of a page that flowing text runs through.
  private var columns = 1
  private var sections: [Section] = []
  private var dropCaps: [DropCapSpec] = []
  private var continuous = false
  private var margin: CGFloat = 16
  /// The text's background, which shows with its layout.
  private var background = UIColor.white
  private var layout = Layout()
  /// The text laid out in lines, each section at its width – so far, or all of it – which a new
  /// height only cuts anew; and the text and widths lines are being laid out for on other threads.
  private var lines = Lines()
  private var linesUnderWay: (text: NSAttributedString, widths: [CGFloat])?
  /// The size the latest layout was asked for, and a count of the layouts begun, so one that a
  /// newer one replaced is dropped.
  private var requestedSize = CGSize.zero
  private var generation = 0
  private var highlighted: NSRange?
  /// The marks drawn over the text, and the words selected, behind it: a range per paragraph.
  private var decorations: [Decoration] = []
  private var selection: [NSRange] = []
  private var selectionColor = UIColor.systemBlue.withAlphaComponent(0.4)
  /// A character to bring into sight once the text is laid out that far.
  private var pendingSight: Int?
  /// The views in sight, by page – or in one endless scroll, by part.
  private var views: [Int: [PartView]] = [:]

  /// A tapped character, by its index in the text.
  var onTap: ((Int) -> Void)?
  /// A tap where no character is.
  var onTapElsewhere: (() -> Void)?
  /// A tap on the sign of a mark's note, by the mark's id.
  var onTapSign: ((String) -> Void)?
  /// A long press on a character, or beside the text; then, the finger still down, each character it
  /// moves over; and the finger lifting. The text doesn't scroll meanwhile.
  var onLongPress: ((Int?) -> Void)?
  var onDrag: ((Int?) -> Void)?
  var onRelease: (() -> Void)?
  /// A scroll the reader asked for, to bring something into sight, has come to rest.
  var onSettled: (() -> Void)?
  /// A scroll or a page turn by hand begins – or by a screen reader, or by turn(forward:).
  var onScrollByHand: (() -> Void)?
  /// The first pages show, before all of the text is laid out.
  var onFirstPages: (() -> Void)?
  /// The whole text is laid out, into this many pages, or parts in one endless scroll.
  var onPaginated: ((Int) -> Void)?

  /// Above and below the text.
  private static let inset: CGFloat = 12
  /// How far past the reader's place the text is laid out before it shows, and how much a chunk holds.
  private static let firstPages = 8000
  private static let chunkLength = 12000
  private var gap: CGFloat { max(margin, 16) }

  override init(frame: CGRect) {
    super.init(frame: frame)
    showsHorizontalScrollIndicator = false
    delegate = self
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed))
    press.minimumPressDuration = 0.45
    // A finger lifting after a long press is no tap.
    tap.require(toFail: press)
    addGestureRecognizer(tap)
    addGestureRecognizer(press)
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  private var pageCount: Int { layout.pages.count }

  /// Shows `text` from the character at `anchor` on, in its sections. Right-to-left text such as a
  /// surah opens on the right and runs its pages and columns from the right, as such books do: the
  /// view is mirrored, and each part mirrored back.
  func show(_ text: NSAttributedString, background: UIColor, columns: Int, sections: [Section], dropCaps: [DropCapSpec], rightToLeft: Bool,
            continuous: Bool, margin: CGFloat, from anchor: Int) {
    self.text = text
    self.background = background
    self.anchor = anchor
    self.sections = sections
    self.dropCaps = dropCaps.sorted { $0.range.location < $1.range.location }
    self.columns = continuous ? 1 : max(columns, 1)
    self.continuous = continuous
    self.margin = margin
    isPagingEnabled = !continuous
    showsVerticalScrollIndicator = continuous
    highlighted = nil
    decorations = []
    selection = []
    pendingSight = nil
    transform = rightToLeft ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    // A layout under way is of the text before.
    generation += 1
    linesUnderWay = nil
    requestedSize = .zero
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard !isHidden, bounds.width > 0, bounds.height > 0 else { return }
    if bounds.size != requestedSize {
      layOut()
    }
    // Until the text is laid out for this size, what is in sight stays as it is.
    if layout.size == bounds.size {
      showPartsInSight()
    }
  }

  /// The width of a section's columns: a page's, or a book's side by side.
  private func width(of section: Section) -> CGFloat {
    let columns = section.cells.isEmpty ? self.columns : (section.cells.map(\.column).max() ?? 0) + 1
    let width = (bounds.width - 2 * margin - CGFloat(columns - 1) * gap) / CGFloat(columns)
    return max(width.rounded(.down), 1)
  }

  /// A column's height; in one endless scroll, a screen's.
  private var columnHeight: CGFloat { max(bounds.height - 2 * Self.inset, 1) }

  /// Lays the sections out in lines at their widths, on other threads – unless that is done or
  /// under way: a new height alone, as the view settles into its place, only cuts them anew.
  private func layOut() {
    requestedSize = bounds.size
    let widths = sections.map(width(of:))
    if lines.text === text && lines.widths == widths {
      return cut()
    }
    if let underWay = linesUnderWay, underWay.text === text, underWay.widths == widths {
      return
    }
    generation += 1
    let (run, text, background, sections, first) = (generation, text, background, sections, anchor + Self.firstPages)
    let dropCaps = dropCaps
    linesUnderWay = (text, widths)
    DispatchQueue.global(qos: .userInitiated).async {
      Self.lines(of: text, sections: sections, widths: widths, background: background, first: first, dropCaps: dropCaps) { lines in
        DispatchQueue.main.async { [weak self] in
          guard let self, run == generation else { return }
          if lines.complete {
            linesUnderWay = nil
          }
          self.lines = lines
          cut()
        }
      }
    }
  }

  /// The sections laid out in chunks of whole paragraphs: first those up to `first`, the reader's
  /// place and a little after, then all the others side by side. Each time, all laid out so far is
  /// handed over. A paragraph with a drop cap starts a chunk of its own, so the drop cap's space is
  /// at the chunk's top.
  private static func lines(of text: NSAttributedString, sections: [Section], widths: [CGFloat], background: UIColor, first: Int,
                            dropCaps: [DropCapSpec], deliver: (Lines) -> Void) {
    let string = text.string as NSString
    var chunks: [(section: Int, range: NSRange)] = []
    for (index, section) in sections.enumerated() {
      var start = section.range.location
      while start < NSMaxRange(section.range) {
        var end = min(start + chunkLength, NSMaxRange(section.range))
        if end < NSMaxRange(section.range) {
          // To the end of the paragraph there, without its newline.
          end = min(NSMaxRange(string.paragraphRange(for: NSRange(location: end, length: 0))) - 1, NSMaxRange(section.range))
        }
        // Up to the newline before the next drop cap, if one comes sooner.
        if let next = dropCaps.first(where: { $0.range.location - 1 > start && $0.range.location - 1 < end }) {
          end = next.range.location - 1
        }
        chunks.append((index, NSRange(location: start, length: end - start)))
        start = end + 1
      }
    }
    // Each chunk in a slot of its own, filled on whichever thread lays it out.
    let laid = UnsafeMutableBufferPointer<Chunk>.allocate(capacity: chunks.count)
    laid.initialize(repeating: Chunk())
    defer {
      laid.baseAddress?.deinitialize(count: chunks.count)
      laid.deallocate()
    }
    let layOut = { (indices: Range<Int>) in
      DispatchQueue.concurrentPerform(iterations: indices.count) { offset in
        let (section, range) = chunks[indices.lowerBound + offset]
        let dropCap = dropCaps.first { $0.range.location == range.location }
        laid[indices.lowerBound + offset] = chunk(of: text, in: range, width: widths[section], dropCap: dropCap)
      }
    }
    let lines = { (count: Int) in
      var lines = Lines(text: text, background: background, widths: widths, complete: count == chunks.count)
      for index in 0..<count {
        let (section, range) = chunks[index]
        if lines.sections.last?.section != section {
          lines.sections.append(SectionLines(section: section, start: range.location))
        }
        let offset = lines.sections[lines.sections.count - 1].height
        lines.sections[lines.sections.count - 1].lines += laid[index].lines.map {
          Line(location: $0.location, top: $0.top + offset, bottom: $0.bottom + offset, keepWithPrevious: $0.keepWithPrevious)
        }
        if let dropCap = laid[index].dropCap {
          let top = (laid[index].lines.first?.top ?? 0) + offset
          lines.sections[lines.sections.count - 1].dropCaps.append(DropCapPlaced(spec: dropCap.spec, top: top, baseline: dropCap.baseline + offset))
        }
        lines.sections[lines.sections.count - 1].height += laid[index].height
        lines.sections[lines.sections.count - 1].end = NSMaxRange(range)
        lines.end = NSMaxRange(range)
      }
      return lines
    }
    let shownFirst = (chunks.firstIndex { NSMaxRange($0.range) >= first } ?? chunks.count - 1) + 1
    layOut(0..<shownFirst)
    if shownFirst < chunks.count {
      deliver(lines(shownFirst))
      layOut(shownFirst..<chunks.count)
    }
    deliver(lines(chunks.count))
  }

  /// Whole paragraphs laid out on their own, which TextKit breaks into the lines it does in the whole
  /// text: where each line starts and stands, from the chunk's top. A chunk that opens with a drop
  /// cap keeps its space clear, and finds the baseline the drop cap stands on: the second line's.
  private static func chunk(of text: NSAttributedString, in range: NSRange, width: CGFloat, dropCap: DropCapSpec?) -> Chunk {
    let content = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    content.addTextLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: width, height: 0))
    container.lineFragmentPadding = 0
    if let dropCap {
      container.exclusionPaths = [UIBezierPath(rect: Self.exclusion(of: dropCap, width: width))]
    }
    manager.textContainer = container
    content.attributedString = text.attributedSubstring(from: range)
    var lines: [Line] = []
    var baseline: CGFloat?
    var opening = dropCap != nil
    manager.enumerateTextLayoutFragments(from: content.documentRange.location, options: [.ensuresLayout]) { fragment in
      let paragraphStart = range.location + content.offset(from: content.documentRange.location, to: fragment.rangeInElement.location)
      let fragmentTop = fragment.layoutFragmentFrame.minY
      for (index, line) in fragment.textLineFragments.enumerated() {
        let bounds = line.typographicBounds
        // The two lines beside a drop cap stay together.
        lines.append(Line(location: paragraphStart + line.characterRange.location, top: fragmentTop + bounds.minY, bottom: fragmentTop + bounds.maxY,
                          keepWithPrevious: opening && index == 1))
        if opening, index <= 1, let dropCap {
          // The second line's baseline – or, for a paragraph of one line, a line's advance below the first's.
          let lineBaseline = fragmentTop + bounds.minY + line.glyphOrigin.y
          baseline = index == 1 ? lineBaseline : lineBaseline + dropCap.lineAdvance
        }
      }
      opening = false
      return true
    }
    // The next chunk's first line stands below this one's last as far as its paragraph's spacing asks.
    let style = range.length > 0 ? text.attribute(.paragraphStyle, at: NSMaxRange(range) - 1, effectiveRange: nil) as? NSParagraphStyle : nil
    let placed = dropCap.map { DropCapPlaced(spec: $0, top: 0, baseline: baseline ?? $0.lineAdvance) }
    return Chunk(lines: lines, height: (lines.last?.bottom ?? 0) + (style?.paragraphSpacing ?? 0), dropCap: placed)
  }

  /// The space a drop cap takes at the top of a column `width` wide: on the leading side.
  private static func exclusion(of dropCap: DropCapSpec, width: CGFloat) -> CGRect {
    CGRect(x: dropCap.rightToLeft ? width - dropCap.width : 0, y: 0, width: dropCap.width, height: dropCap.height)
  }

  /// Places the lines laid out so far: each section's on pages of its own – flowing through the
  /// columns, or in rows of cells side by side – or, in one endless scroll, each under the one before.
  private func cut() {
    let widths = sections.map(width(of:))
    guard lines.text === text, lines.widths == widths else { return }
    var parts: [Part] = []
    var (page, top) = (0, CGFloat(0))
    for laid in lines.sections {
      let (width, cells) = (widths[laid.section], sections[laid.section].cells)
      let placed = cells.isEmpty ? flow(laid, width: width, page: page, top: top) : grid(laid, cells: cells, width: width, page: page, top: top)
      parts += placed.parts
      (page, top) = (placed.page, placed.top)
    }
    if continuous {
      // In one endless scroll, each part is a page of its own.
      parts = parts.enumerated().map { Part(range: $1.range, top: $1.top, page: $0, frame: $1.frame) }
    }
    var pages = [[Int]](repeating: [], count: (parts.map(\.page).max() ?? -1) + 1)
    for (index, part) in parts.enumerated() {
      pages[part.page].append(index)
    }
    use(Layout(text: lines.text, background: lines.background, size: bounds.size, continuous: continuous, parts: parts, pages: pages,
               lines: lines.sections.flatMap(\.lines), dropCaps: lines.sections.flatMap(\.dropCaps), height: top, end: lines.end, complete: lines.complete))
  }

  private func use(_ layout: Layout) {
    self.layout = layout
    backgroundColor = layout.background
    views.values.joined().forEach { $0.removeFromSuperview() }
    views = [:]
    contentSize = continuous
      ? CGSize(width: bounds.width, height: layout.height + 2 * Self.inset)
      : CGSize(width: bounds.width * CGFloat(pageCount), height: bounds.height)
    // Not by setting contentOffset, which leaves a scroll under way running on.
    setContentOffset(offset(showing: anchor), animated: false)
    showPartsInSight()
    if let pending = pendingSight, pending < layout.end || layout.complete {
      pendingSight = nil
      show(characterAt: pending)
    }
    if layout.complete {
      onPaginated?(pageCount)
    } else {
      onFirstPages?()
    }
    UIAccessibility.post(notification: .layoutChanged, argument: nil)
  }

  /// A section that flows, cut wherever the next line would overflow a column: through the columns
  /// of pages from `page` on, or in one endless scroll, cut at a screen's height, from `top` down.
  private func flow(_ laid: SectionLines, width: CGFloat, page first: Int, top: CGFloat) -> (parts: [Part], page: Int, top: CGFloat) {
    let pieces = Self.pieces(of: laid.lines[...], from: laid.start, to: laid.end, height: columnHeight)
    let parts = pieces.enumerated().map { index, piece -> Part in
      guard !continuous else {
        return Part(range: piece.range, top: piece.top, page: 0, frame: CGRect(x: margin, y: Self.inset + top + piece.top, width: width, height: piece.height))
      }
      let page = first + index / columns
      return Part(range: piece.range, top: piece.top, page: page,
                  frame: CGRect(x: CGFloat(page) * bounds.width + left(ofColumn: index % columns, width: width), y: Self.inset, width: width, height: piece.height))
    }
    return (parts, first + (pieces.count + columns - 1) / columns, top + laid.height)
  }

  /// A section's cells in their rows, each row as tall as its tallest cell. On pages from `page` on,
  /// a page holds the rows that fit, and a row of headings only with the row after it. A row that
  /// doesn't fit on a page, or below the headings it follows, is cut between lines and runs on over
  /// the pages after. In one endless scroll, the rows stand under each other from `top` down. Only
  /// rows laid out to their end show.
  private func grid(_ laid: SectionLines, cells: [Cell], width: CGFloat, page first: Int, top start: CGFloat) -> (parts: [Part], page: Int, top: CGFloat) {
    var rows: [(cells: ArraySlice<Cell>, lines: [ArraySlice<Line>], heights: [CGFloat], height: CGFloat, spacing: CGFloat, heading: Bool)] = []
    var (cell, line) = (0, 0)
    while cell < cells.count {
      let row = cells[cell...].prefix { $0.row == cells[cell].row }
      guard let last = row.last, NSMaxRange(last.range) <= laid.end else { break }
      cell += row.count
      // Each cell's lines, which follow each other as the cells do.
      let rowLines = row.map { cell -> ArraySlice<Line> in
        while line < laid.lines.count && laid.lines[line].location < cell.range.location { line += 1 }
        let first = line
        while line < laid.lines.count && laid.lines[line].location < NSMaxRange(cell.range) { line += 1 }
        return laid.lines[first..<line]
      }
      let heights = rowLines.map { ($0.last?.bottom ?? 0) - ($0.first?.top ?? 0) }
      // As far apart as the paragraphs at the cells' ends ask.
      let spacing = row.map { cell in
        (text.attribute(.paragraphStyle, at: NSMaxRange(cell.range) - 1, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacing ?? 0
      }.max() ?? 0
      rows.append((row, rowLines, heights, heights.max() ?? 0, spacing, row.allSatisfy(\.heading)))
    }
    var parts: [Part] = []
    var (page, top) = (first, continuous ? start : 0)
    // Whether the row before is of headings on this page, which this one goes on from.
    var underHeadings = false
    for (at, row) in rows.enumerated() {
      // Headings go on a page only with the row after them, as much of it as a page holds.
      let next = row.heading && at + 1 < rows.count ? row.spacing + min(rows[at + 1].height, columnHeight) : 0
      if !continuous && top > 0 && !underHeadings && top + row.height + next > columnHeight {
        (page, top) = (page + 1, 0)
      }
      underHeadings = row.heading
      if continuous || top + row.height <= columnHeight {
        for ((cell, cellLines), cellHeight) in zip(zip(row.cells, row.lines), row.heights) {
          let x = (continuous ? 0 : CGFloat(page) * bounds.width) + left(ofColumn: cell.column, width: width)
          parts.append(Part(range: cell.range, top: cellLines.first?.top ?? 0, page: page,
                            frame: CGRect(x: x, y: Self.inset + top, width: width, height: cellHeight)))
        }
        top += row.height + row.spacing
        continue
      }
      // Cut between lines: on this page below what stands on it, then on pages of its own.
      var pages = 1
      for (cell, cellLines) in zip(row.cells, row.lines) {
        let pieces = Self.pieces(of: cellLines, from: cell.range.location, to: NSMaxRange(cell.range), height: columnHeight, first: columnHeight - top)
        for (index, piece) in pieces.enumerated() {
          parts.append(Part(range: piece.range, top: piece.top, page: page + index,
                            frame: CGRect(x: CGFloat(page + index) * bounds.width + left(ofColumn: cell.column, width: width), y: Self.inset + (index == 0 ? top : 0),
                                          width: width, height: piece.height)))
        }
        pages = max(pages, pieces.count)
      }
      // The next row starts on a page of its own.
      (page, top) = (page + pages, 0)
      underHeadings = false
    }
    // In pages, the next section starts on a page of its own.
    return (parts, continuous || top == 0 ? page : page + 1, top)
  }

  /// Lines cut wherever the next would overflow `height` – the first piece's, `first`: where each
  /// piece starts and ends, from `start` to `end`, how far down it is laid out, and how tall it is.
  /// A line that stays with the one before it – the second beside a drop cap – takes it along.
  private static func pieces(of lines: ArraySlice<Line>, from start: Int, to end: Int, height: CGFloat, first: CGFloat? = nil) -> [Piece] {
    var pieces: [Piece] = []
    var (start, top) = (start, lines.first?.top ?? 0)
    var (bottom, limit) = (top, first ?? height)
    var index = lines.startIndex
    while index < lines.endIndex {
      let line = lines[index]
      if line.bottom - top > limit && line.location > start {
        var at = index
        if line.keepWithPrevious, index > lines.startIndex, lines[index - 1].location > start {
          at = index - 1
        }
        let cut = lines[at]
        let above = at > lines.startIndex ? lines[at - 1].bottom : top
        pieces.append(Piece(range: NSRange(location: start, length: cut.location - start), top: top, height: above - top))
        (start, top, limit) = (cut.location, cut.top, height)
        bottom = top
        index = at
        continue
      }
      bottom = line.bottom
      index += 1
    }
    pieces.append(Piece(range: NSRange(location: start, length: end - start), top: top, height: bottom - top))
    return pieces
  }

  /// How far from a page's left a column of `width` starts.
  private func left(ofColumn column: Int, width: CGFloat) -> CGFloat {
    margin + CGFloat(column) * (width + gap)
  }

  /// The pages in sight and next to it, or in one endless scroll the parts a screen around it – as
  /// the layout shown was cut, which a new way of paging doesn't change until its own layout comes.
  private var wanted: Set<Int> {
    if layout.continuous {
      let sight = (bounds.minY - bounds.height)...(bounds.maxY + bounds.height)
      return Set(layout.parts.indices.filter { sight.overlaps(layout.parts[$0].frame.minY...layout.parts[$0].frame.maxY) })
    }
    let page = Int((contentOffset.x / bounds.width).rounded(.down))
    return Set((page - 1...page + 1).filter { (0..<pageCount).contains($0) })
  }

  private func showPartsInSight() {
    let wanted = wanted
    for (key, views) in views where !wanted.contains(key) {
      views.forEach { $0.removeFromSuperview() }
      self.views[key] = nil
    }
    for key in wanted where views[key] == nil {
      views[key] = makeViews(key)
    }
  }

  /// A page's parts: its columns or cells, or in one endless scroll, a part. A part's view is a
  /// little taller than its lines, so rounding never clips the last; the views are transparent.
  private func makeViews(_ page: Int) -> [PartView] {
    guard layout.pages.indices.contains(page) else { return [] }
    return layout.pages[page].map { index in
      let part = layout.parts[index]
      let frame = CGRect(origin: part.frame.origin, size: CGSize(width: part.frame.width, height: part.frame.height + Self.inset / 2))
      // The drop caps whose paragraphs start in this part, where they stand in it.
      let dropCaps = layout.dropCaps.filter { NSLocationInRange($0.spec.range.location, part.range) && $0.top >= part.top - 0.5 }.map {
        DropCapDraw(spec: $0.spec, rect: Self.exclusion(of: $0.spec, width: part.frame.width).offsetBy(dx: 0, dy: $0.top - part.top), baseline: $0.baseline - part.top)
      }
      let view = PartView(frame: frame, text: textOfPart(part.range), part: part, dropCaps: dropCaps)
      view.transform = transform
      view.highlight(highlighted, color: highlightColor)
      addSubview(view)
      view.decorate(decorations, selection: selection, color: selectionColor)
      return view
    }
  }

  /// A part's text. One that starts within a paragraph starts with a line that isn't the
  /// paragraph's first: it is indented as such, as where a verse's number hangs.
  private func textOfPart(_ range: NSRange) -> NSAttributedString {
    let part = layout.text.attributedSubstring(from: range)
    guard range.location > 0,
          (layout.text.string as NSString).character(at: range.location - 1) != 0x0A,
          let style = part.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle,
          style.firstLineHeadIndent != style.headIndent,
          let continued = style.mutableCopy() as? NSMutableParagraphStyle
    else { return part }
    continued.firstLineHeadIndent = style.headIndent
    let indented = NSMutableAttributedString(attributedString: part)
    indented.addAttribute(.paragraphStyle, value: continued, range: (part.string as NSString).paragraphRange(for: NSRange(location: 0, length: 0)))
    return indented
  }

  /// Highlights the text in `range`, or nothing, wherever it shows.
  func highlight(_ range: NSRange?) {
    highlighted = range
    views.values.joined().forEach { $0.highlight(range, color: highlightColor) }
  }

  /// Draws the marks over the text, wherever it shows, and the selection – in `color` – behind it.
  func decorate(_ decorations: [Decoration], selection: [NSRange], color: UIColor) {
    self.decorations = decorations
    self.selection = selection
    selectionColor = color
    guard layout.text === text else { return }
    views.values.joined().forEach { $0.decorate(decorations, selection: selection, color: color) }
  }

  /// Draws the selection over the text in `ranges`, or none, the marks as they are.
  func select(_ ranges: [NSRange]) {
    decorate(decorations, selection: ranges, color: selectionColor)
  }

  /// The sign of a mark's note at a point in this view's content, by the mark's id, if a part in
  /// sight draws one there or near it.
  func sign(at point: CGPoint) -> String? {
    guard layout.text === text else { return nil }
    for view in views.values.joined() {
      if let id = view.sign(at: view.convert(point, from: self)) { return id }
    }
    return nil
  }

  /// The character at a point in this view's content, if a part holds one there – or a little way
  /// around it, the nearest.
  func characterIndex(at point: CGPoint) -> Int? {
    guard layout.text === text else { return nil }
    let near = views.values.joined().filter { $0.part.frame.insetBy(dx: -gap / 2, dy: -Self.inset).contains(point) }
    guard let view = near.min(by: { distance(from: point, to: $0.part.frame) < distance(from: point, to: $1.part.frame) }),
          let position = view.closestPosition(to: view.convert(point, from: self))
    else { return nil }
    return view.range.location + view.offset(from: view.beginningOfDocument, to: position)
  }

  /// Where the characters in `range` show in this view's content – on their first line, from the
  /// first glyph to the last – if a part in sight holds them.
  func rect(for range: NSRange) -> CGRect? {
    guard layout.text === text, let view = views.values.joined().first(where: { NSLocationInRange(range.location, $0.range) }) else { return nil }
    let local = NSRange(location: range.location - view.range.location, length: min(range.length, NSMaxRange(view.range) - range.location))
    guard let from = view.position(from: view.beginningOfDocument, offset: local.location),
          let to = view.position(from: from, offset: local.length),
          let textRange = view.textRange(from: from, to: to)
    else { return nil }
    let rect = view.firstRect(for: textRange)
    guard !rect.isNull, !rect.isInfinite, rect.width.isFinite else { return nil }
    return convert(rect, from: view)
  }

  /// Brings the character at `index` into sight: turns to its page, or in one endless scroll moves
  /// it a third of the way down, if it is out of sight.
  func show(characterAt index: Int) {
    guard layout.text === text else { return }
    anchor = index
    // Until the text is laid out that far, it comes into sight once it is.
    guard index < layout.end || layout.complete else {
      pendingSight = index
      return
    }
    guard let part = layout.parts.lastIndex(atOrBefore: index, \.range.location) else { return }
    guard continuous else {
      setContentOffset(CGPoint(x: CGFloat(layout.parts[part].page) * bounds.width, y: 0), animated: true)
      return
    }
    let line = contentRect(for: NSRange(location: index, length: 0))
    guard !bounds.contains(line) else { return }
    let lowest = max(contentSize.height - bounds.height, 0)
    setContentOffset(CGPoint(x: 0, y: min(max(line.minY - bounds.height / 3, 0), lowest)), animated: true)
  }

  /// Whether the character at `index` is in sight: on the page shown, or in one endless scroll, its
  /// line wholly in view.
  func isInSight(characterAt index: Int) -> Bool {
    guard layout.text === text, index < layout.end || layout.complete,
          let part = layout.parts.lastIndex(atOrBefore: index, \.range.location)
    else { return false }
    guard continuous else {
      return layout.parts[part].page == Int((contentOffset.x / bounds.width).rounded())
    }
    return bounds.contains(contentRect(for: NSRange(location: index, length: 0)))
  }

  /// Whether a finger moves the text, or it still glides after one.
  var isScrollingByHand: Bool { isTracking || isDragging || isDecelerating }

  /// Turns to the next or previous page, or scrolls a screen down or up, as a hand would: the page
  /// turned to – in one endless scroll, 0 – or nil at the first or last page, or the top or bottom.
  @discardableResult
  func turn(forward: Bool) -> Int? {
    if continuous {
      let lowest = max(contentSize.height - bounds.height, 0)
      let step = (bounds.height - 2 * Self.inset) * (forward ? 1 : -1)
      let target = min(max(contentOffset.y + step, 0), lowest)
      guard target != contentOffset.y else { return nil }
      onScrollByHand?()
      anchor = character(below: target - 1) ?? anchor
      setContentOffset(CGPoint(x: 0, y: target), animated: true)
      return 0
    }
    let current = Int((contentOffset.x / bounds.width).rounded())
    let page = min(max(current + (forward ? 1 : -1), 0), max(pageCount - 1, 0))
    guard page != current else { return nil }
    onScrollByHand?()
    anchor = firstCharacter(onPage: page)
    setContentOffset(CGPoint(x: CGFloat(page) * bounds.width, y: 0), animated: true)
    return page
  }

  /// Where the text in `range` shows in this view's content, the whole width of its column: from
  /// its first line to its last in the part it starts in.
  func contentRect(for range: NSRange) -> CGRect {
    guard layout.text === text, range.location < layout.end || layout.complete,
          let index = layout.parts.lastIndex(atOrBefore: range.location, \.range.location),
          let first = layout.lines.lastIndex(atOrBefore: range.location, \.location)
    else { return .zero }
    let part = layout.parts[index]
    let end = max(min(NSMaxRange(range), NSMaxRange(part.range)) - 1, range.location)
    let last = layout.lines.lastIndex(atOrBefore: end, \.location) ?? first
    let (top, bottom) = (layout.lines[first].top - part.top, layout.lines[last].bottom - part.top)
    return CGRect(x: part.frame.minX, y: part.frame.minY + top, width: part.frame.width, height: bottom - top)
  }

  /// Where the reader is: the first character on the page, or of the first whole line in sight.
  private var characterInSight: Int {
    if continuous {
      return character(below: contentOffset.y - 1) ?? 0
    }
    return firstCharacter(onPage: Int((contentOffset.x / bounds.width).rounded()))
  }

  private func firstCharacter(onPage page: Int) -> Int {
    let page = min(max(page, 0), max(pageCount - 1, 0))
    return layout.pages.indices.contains(page) ? layout.pages[page].first.map { layout.parts[$0].range.location } ?? 0 : 0
  }

  /// The first character, in the text's order, of a line that shows below `top` in this view's content.
  private func character(below top: CGFloat) -> Int? {
    for part in layout.parts where part.frame.maxY > top {
      var line = layout.lines.lastIndex(atOrBefore: part.range.location, \.location) ?? 0
      while line < layout.lines.count && layout.lines[line].location < NSMaxRange(part.range) {
        if part.frame.minY + layout.lines[line].top - part.top >= top { return layout.lines[line].location }
        line += 1
      }
    }
    return nil
  }

  private func offset(showing index: Int) -> CGPoint {
    if continuous {
      let lowest = max(contentSize.height - bounds.height, 0)
      return CGPoint(x: 0, y: min(max(contentRect(for: NSRange(location: index, length: 0)).minY - Self.inset, 0), lowest))
    }
    let part = layout.parts.lastIndex(atOrBefore: index, \.range.location) ?? 0
    return CGPoint(x: CGFloat(layout.parts.indices.contains(part) ? layout.parts[part].page : 0) * bounds.width, y: 0)
  }

  /// During a scroll by hand, and once it has come to rest, the reader is where it is – unless a new
  /// text is still being laid out.
  private func keepAnchor() {
    if layout.text === text && !layout.parts.isEmpty {
      anchor = characterInSight
    }
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    onScrollByHand?()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if isTracking {
      keepAnchor()
    }
  }

  /// Once the finger lifts, the reader is where the text comes to rest.
  func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    guard layout.text === text, !layout.parts.isEmpty else { return }
    let target = targetContentOffset.pointee
    anchor = continuous ? character(below: target.y - 1) ?? anchor : firstCharacter(onPage: Int((target.x / bounds.width).rounded()))
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    keepAnchor()
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    onSettled?()
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate {
      keepAnchor()
    }
  }

  /// VoiceOver's three-finger swipes, and its turns when it reads on: a page forward or back, or a
  /// screen up or down. The direction is where the view scrolls to – a swipe to the left scrolls
  /// right – and pages from the right turn forward to the left.
  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    let forward: Bool
    switch direction {
    case .next, .down: forward = true
    case .previous, .up: forward = false
    case .right where !continuous: forward = transform.a > 0
    case .left where !continuous: forward = transform.a < 0
    default: return false
    }
    guard let page = turn(forward: forward) else { return false }
    UIAccessibility.post(notification: .pageScrolled, argument: continuous ? nil : "Page \(page + 1) of \(pageCount)")
    return true
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: self)
    if let id = sign(at: point) {
      onTapSign?(id)
    } else if let index = characterIndex(at: point) {
      onTap?(index)
    } else {
      onTapElsewhere?()
    }
  }

  /// A long press, and the finger dragging on from it: the text stays put under it meanwhile.
  @objc private func pressed(_ gesture: UILongPressGestureRecognizer) {
    let index = characterIndex(at: gesture.location(in: self))
    switch gesture.state {
    case .began:
      isScrollEnabled = false
      onLongPress?(index)
    case .changed:
      onDrag?(index)
    case .ended, .cancelled, .failed:
      isScrollEnabled = true
      onRelease?()
    default:
      break
    }
  }
}

/// The text laid out in lines, section by section at their widths, so far or all of it: up to `end`.
private struct Lines {
  var text = NSAttributedString()
  var background = UIColor.white
  var widths: [CGFloat] = []
  var sections: [SectionLines] = []
  var end = 0
  var complete = false
}

/// A section's lines so far, from its top, up to `end`, and how tall they are, the spacing after the
/// last included; and its drop caps, placed.
private struct SectionLines {
  let section: Int
  let start: Int
  var lines: [Line] = []
  var dropCaps: [DropCapPlaced] = []
  var height: CGFloat = 0
  var end = 0
}

/// Whole paragraphs laid out on their own: their lines from the top, how far down the next start,
/// and the drop cap the chunk opens with, if it does.
private struct Chunk {
  var lines: [Line] = []
  var height: CGFloat = 0
  var dropCap: DropCapPlaced?
}

/// A drop cap laid out: its paragraph's first line's top, and the baseline it stands on, both from
/// the top of its section – or, as a chunk has it, of the chunk.
private struct DropCapPlaced {
  let spec: PagedText.DropCapSpec
  let top: CGFloat
  let baseline: CGFloat
}

/// A drop cap as a part draws it: the space it takes and the baseline it stands on, in the part's
/// coordinates.
private struct DropCapDraw {
  let spec: PagedText.DropCapSpec
  let rect: CGRect
  let baseline: CGFloat
}

/// The text cut into parts, and the parts on each page – in one endless scroll, a part is a page –
/// the lines it was laid out in, how tall it is in one endless scroll, how far it is laid out, and
/// the size of the view it was cut for.
private struct Layout {
  var text = NSAttributedString()
  var background = UIColor.white
  var size = CGSize.zero
  /// Whether it was cut for one endless scroll, or for pages.
  var continuous = false
  var parts: [Part] = []
  var pages: [[Int]] = []
  var lines: [Line] = []
  var dropCaps: [DropCapPlaced] = []
  var height: CGFloat = 0
  var end = 0
  var complete = true
}

/// A part of the text: where it starts and ends, how far down its first line is laid out in its
/// section, and where it shows: on which page, and where its lines are in this view's content.
private struct Part {
  let range: NSRange
  let top: CGFloat
  let page: Int
  let frame: CGRect
}

/// Lines of the text: where they start and end, how far down they are laid out, and how tall.
private struct Piece {
  let range: NSRange
  let top: CGFloat
  let height: CGFloat
}

/// A line of the text: the character it starts with, how far down it is laid out, and whether it
/// stays in a column with the line before it.
private struct Line {
  let location: Int
  let top: CGFloat
  let bottom: CGFloat
  var keepWithPrevious = false
}

private extension Array {
  /// The last element whose `key` is at most `value`, in an array sorted by it.
  func lastIndex(atOrBefore value: Int, _ key: KeyPath<Element, Int>) -> Int? {
    var (low, high) = (0, count)
    while low < high {
      let middle = (low + high) / 2
      if self[middle][keyPath: key] <= value { low = middle + 1 } else { high = middle }
    }
    return low > 0 ? low - 1 : nil
  }
}

private func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
  hypot(max(rect.minX - point.x, 0, point.x - rect.maxX), max(rect.minY - point.y, 0, point.y - rect.maxY))
}

/// A part's text, in a text view of its own, and the part. A drop cap in it has its space kept clear
/// and its glyphs drawn in a view of their own. The marks' fills and lines and the selection are
/// drawn in a view behind the text – the word the voice is at, a background of the text itself, shows
/// over them – and the marks' signs in one over it.
private final class PartView: UITextView {
  let part: Part
  var range: NSRange { part.range }
  private let underlay = DecorationView(reach: 0)
  /// A mark's sign at a line's end may stand a little past the part.
  private let overlay = DecorationView(reach: 24)

  init(frame: CGRect, text: NSAttributedString, part: Part, dropCaps: [DropCapDraw]) {
    self.part = part
    super.init(frame: frame, textContainer: nil)
    isEditable = false
    isSelectable = false
    isScrollEnabled = false
    isUserInteractionEnabled = false
    backgroundColor = .clear
    clipsToBounds = false
    textContainerInset = .zero
    textContainer.lineFragmentPadding = 0
    textContainer.exclusionPaths = dropCaps.map { UIBezierPath(rect: $0.rect) }
    attributedText = text
    insertSubview(underlay, at: 0)
    dropCaps.forEach { addSubview(DropCapView($0)) }
    addSubview(overlay)
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // The text's own views come as they are needed: behind them, and over them, still.
    underlay.frame = bounds
    overlay.frame = bounds.insetBy(dx: -overlay.reach, dy: -overlay.reach)
    sendSubviewToBack(underlay)
    bringSubviewToFront(overlay)
  }

  /// Highlights the part of `range`, in the whole text, that falls in this part.
  func highlight(_ whole: NSRange?, color: UIColor) {
    textStorage.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: textStorage.length))
    guard let overlap = whole?.intersection(range) else { return }
    let local = NSRange(location: overlap.location - range.location, length: overlap.length)
    textStorage.addAttribute(.backgroundColor, value: color, range: local)
  }

  /// Draws the parts of the marks, and of the selection, that fall in this part: each mark's fill
  /// on every line its words take, its line a little under their baselines, and its sign after its
  /// last word – before it, in a right-to-left paragraph – raised like a note's mark.
  func decorate(_ decorations: [PagedText.Decoration], selection: [NSRange], color: UIColor) {
    var fills: [DecorationView.Fill] = []
    var signs: [DecorationView.SignDraw] = []
    for decoration in decorations {
      guard let overlap = decoration.range.intersection(range), overlap.length > 0 else { continue }
      let lines = lines(of: NSRange(location: overlap.location - range.location, length: overlap.length))
      for line in lines {
        if let fill = decoration.fill {
          fills.append(DecorationView.Fill(rect: line.frame, color: fill))
        }
        if let under = decoration.line {
          let y = line.frame.minY + line.baseline + 2
          fills.append(DecorationView.Fill(rect: CGRect(x: line.frame.minX, y: y, width: line.frame.width, height: 2), color: under))
        }
      }
      // The sign stands where the mark ends, in the part that holds its last word: small and raised,
      // as a note's mark is.
      if let sign = decoration.sign, let last = lines.last, NSMaxRange(overlap) == NSMaxRange(decoration.range) {
        let font = UIFont.systemFont(ofSize: sign.size * 0.6)
        let text = NSAttributedString(string: sign.text, attributes: [.font: font, .foregroundColor: sign.color])
        let size = text.size()
        let x = decoration.rightToLeft ? last.frame.minX - 1 - size.width : last.frame.maxX + 1
        let y = last.frame.minY + last.baseline - sign.size * 0.33 - font.ascender
        signs.append(DecorationView.SignDraw(id: sign.id, rect: CGRect(origin: CGPoint(x: x, y: y), size: size), text: text))
      }
    }
    for selected in selection {
      guard let overlap = selected.intersection(range), overlap.length > 0 else { continue }
      for line in lines(of: NSRange(location: overlap.location - range.location, length: overlap.length)) {
        fills.append(DecorationView.Fill(rect: line.frame, color: color))
      }
    }
    underlay.fills = fills
    overlay.signs = signs
  }

  /// The sign drawn at a point in this view, or near it, by its mark's id.
  func sign(at point: CGPoint) -> String? {
    overlay.signs.first { $0.rect.insetBy(dx: -8, dy: -6).contains(point) }?.id
  }

  /// The lines the characters in `local` – a range in this part's text – stand on: each line's
  /// rectangle over them, without the spaces at its ends, and its baseline from the rectangle's top,
  /// in this view's coordinates.
  private func lines(of local: NSRange) -> [(frame: CGRect, baseline: CGFloat)] {
    var lines: [(frame: CGRect, baseline: CGFloat)] = []
    for segment in segments(of: local) {
      let trimmed = trimmed(segment.range)
      guard trimmed.length > 0 else { continue }
      let pieces = trimmed == segment.range ? [(segment.frame, segment.baseline)] : segments(of: trimmed).map { ($0.frame, $0.baseline) }
      for (frame, baseline) in pieces {
        // A line given twice – as TextKit gives a part's last line, the range running on past it – is
        // drawn once: a fill drawn twice would come out darker.
        let same = lines.firstIndex { abs($0.frame.minY - frame.minY) < 0.5 && $0.frame.maxX >= frame.minX && frame.maxX >= $0.frame.minX }
        if let same {
          lines[same].frame = lines[same].frame.union(frame)
        } else {
          lines.append((frame, baseline))
        }
      }
    }
    return lines
  }

  /// The pieces the characters in `local` are laid out in – a line's, or in text of both directions,
  /// a run's – with their ranges in this part's text.
  private func segments(of local: NSRange) -> [(range: NSRange, frame: CGRect, baseline: CGFloat)] {
    guard let manager = textLayoutManager,
          let start = manager.location(manager.documentRange.location, offsetBy: local.location),
          let end = manager.location(start, offsetBy: local.length),
          let textRange = NSTextRange(location: start, end: end)
    else { return [] }
    manager.ensureLayout(for: textRange)
    let origin = manager.documentRange.location
    var segments: [(NSRange, CGRect, CGFloat)] = []
    manager.enumerateTextSegments(in: textRange, type: .standard, options: []) { range, frame, baseline, _ in
      let found = range.map { NSRange(location: manager.offset(from: origin, to: $0.location), length: manager.offset(from: $0.location, to: $0.endLocation)) }
      segments.append((found ?? local, frame.offsetBy(dx: textContainerInset.left, dy: textContainerInset.top), baseline))
      return true
    }
    return segments
  }

  /// A range of this part's text without the spaces at its ends.
  private func trimmed(_ range: NSRange) -> NSRange {
    let string = textStorage.string as NSString
    let isSpace = { (index: Int) in Unicode.Scalar(string.character(at: index)).map(CharacterSet.whitespacesAndNewlines.contains) ?? false }
    var (start, end) = (range.location, NSMaxRange(range))
    while start < end, isSpace(start) { start += 1 }
    while end > start, isSpace(end - 1) { end -= 1 }
    return NSRange(location: start, length: end - start)
  }
}

/// What is drawn around a part's text: fills – a mark's, its line, the selection – or the signs of
/// the marks' notes.
private final class DecorationView: UIView {
  struct Fill {
    let rect: CGRect
    let color: UIColor
  }

  /// A sign where it is drawn, by its mark's id.
  struct SignDraw {
    let id: String
    let rect: CGRect
    let text: NSAttributedString
  }

  var fills: [Fill] = [] { didSet { setNeedsDisplay() } }
  var signs: [SignDraw] = [] { didSet { setNeedsDisplay() } }
  /// How far it reaches past its part on every side; what it draws is placed in the part's coordinates.
  let reach: CGFloat

  init(reach: CGFloat) {
    self.reach = reach
    super.init(frame: .zero)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.translateBy(x: reach, y: reach)
    // Each color as one shape: where the lines of a fill meet or overlap, it is drawn once – without
    // a seam, and a see-through selection no darker there.
    var shapes: [(color: UIColor, path: CGMutablePath)] = []
    for fill in fills {
      if let shape = shapes.first(where: { $0.color == fill.color }) {
        shape.path.addRect(fill.rect)
      } else {
        let path = CGMutablePath()
        path.addRect(fill.rect)
        shapes.append((fill.color, path))
      }
    }
    for (color, path) in shapes {
      context.addPath(path)
      context.setFillColor(color.cgColor)
      context.fillPath(using: .winding)
    }
    for sign in signs {
      sign.text.draw(at: sign.rect.origin)
    }
  }
}

/// A drop cap's glyphs: the chapter's number and first letter, drawn with their baseline on the
/// second line's – on the left, or for right-to-left text on the right, of the space kept for them.
private final class DropCapView: UIView {
  private let cap: DropCapDraw

  init(_ cap: DropCapDraw) {
    self.cap = cap
    // Room above and below the space, for glyphs that reach past it.
    let reach = cap.spec.font.pointSize
    super.init(frame: CGRect(x: cap.rect.minX, y: cap.rect.minY - reach, width: cap.rect.width, height: cap.rect.height + 2 * reach))
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  override func draw(_ rect: CGRect) {
    let style = NSMutableParagraphStyle()
    style.baseWritingDirection = cap.spec.rightToLeft ? .rightToLeft : .leftToRight
    let attributes: [NSAttributedString.Key: Any] = [.font: cap.spec.font, .foregroundColor: cap.spec.color, .paragraphStyle: style]
    let text = cap.spec.text as NSString
    let width = text.size(withAttributes: attributes).width
    let x = cap.spec.rightToLeft ? bounds.width - width : 0
    let baseline = cap.baseline - cap.spec.baselineLift
    text.draw(at: CGPoint(x: x, y: baseline - cap.rect.minY + cap.spec.font.pointSize - cap.spec.font.ascender), withAttributes: attributes)
  }
}
