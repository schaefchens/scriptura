import UIKit

/// The reader's text in pages turned one by one, each in columns the text flows through, or in one
/// endless scroll. TextKit 2 lays the whole text out once at a column's width, off the main thread –
/// a long book takes a tenth of a second, where TextKit 1 with a text container per column took
/// seconds – and the text is cut between lines into parts of a column's height. Each part shows in a
/// text view of its own, which breaks it into the same lines: as a column on a page, or stacked under
/// the part before it. A whole surah in a single text view would take seconds, as TextKit 2 lays out
/// and draws a paragraph as one piece. Only the parts around those in sight have views.
///
/// Books read side by side come in cells instead, a column for each book: every cell is a part,
/// level with the others in its row.
final class PagedText: UIScrollView, UIScrollViewDelegate {
  /// Paragraphs of the text that stand side by side with others: in a row, in a column of it.
  struct Cell {
    let range: NSRange
    let row: Int
    let column: Int
  }

  /// The text as last given; until it is laid out, the one before it stays in sight.
  private(set) var text = NSAttributedString()
  /// The character the reader is at: a word it was brought to, or after a scroll, the first on the
  /// page or of the line at the top. A new layout, after the device turned or the font grew, keeps
  /// it in sight.
  private(set) var anchor = 0
  var highlightColor = UIColor.yellow
  private var columns = 1
  private var cells: [Cell] = []
  private var continuous = false
  private var margin: CGFloat = 16
  /// The text's background, which shows with its layout.
  private var background = UIColor.white
  private var layout = Layout()
  /// The text laid out in lines at a column's width, which a new height only cuts anew; and the
  /// text and width lines are being laid out for on another thread.
  private var lines = Lines()
  private var linesUnderWay: (text: NSAttributedString, width: CGFloat)?
  /// The size the latest layout was asked for, and a count of the layouts begun, so one that a
  /// newer one replaced is dropped.
  private var requestedSize = CGSize.zero
  private var generation = 0
  private var highlighted: NSRange?
  /// The views in sight, by page – or in one endless scroll, by part.
  private var views: [Int: [PartView]] = [:]

  /// A tapped character, by its index in the text.
  var onTap: ((Int) -> Void)?
  /// The whole text is laid out, into this many pages, or parts in one endless scroll.
  var onPaginated: ((Int) -> Void)?

  /// Above and below the text.
  private static let inset: CGFloat = 12
  private var gap: CGFloat { max(margin, 16) }

  override init(frame: CGRect) {
    super.init(frame: frame)
    showsHorizontalScrollIndicator = false
    delegate = self
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  private var pageCount: Int { layout.pages.count }

  /// Shows `text` from the character at `anchor` on: flowing through the columns – or with `cells`,
  /// in their rows, a column for each. Right-to-left text such as a surah opens on the right and
  /// runs its pages and columns from the right, as such books do: the view is mirrored, and each
  /// part mirrored back.
  func show(_ text: NSAttributedString, background: UIColor, columns: Int, cells: [Cell], rightToLeft: Bool, continuous: Bool, margin: CGFloat, from anchor: Int) {
    self.text = text
    self.background = background
    self.anchor = anchor
    self.cells = cells
    self.columns = cells.isEmpty ? (continuous ? 1 : max(columns, 1)) : (cells.map(\.column).max() ?? 0) + 1
    self.continuous = continuous
    self.margin = margin
    isPagingEnabled = !continuous
    showsVerticalScrollIndicator = continuous
    highlighted = nil
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
    if layout.partSize == partSize {
      showPartsInSight()
    }
  }

  /// Lays the text out in lines at a column's width, on another thread – unless that is done or
  /// under way: a new height alone, as the view settles into its place, only cuts them anew.
  private func layOut() {
    requestedSize = bounds.size
    let width = partSize.width
    if lines.text === text && lines.width == width {
      return cut()
    }
    if let underWay = linesUnderWay, underWay.text === text, underWay.width == width {
      return
    }
    generation += 1
    let (run, text, background) = (generation, text, background)
    linesUnderWay = (text, width)
    DispatchQueue.global(qos: .userInitiated).async {
      let lines = Self.lines(of: text, width: width, background: background)
      DispatchQueue.main.async { [weak self] in
        guard let self, run == generation else { return }
        linesUnderWay = nil
        self.lines = lines
        cut()
      }
    }
  }

  /// Cuts the lines into parts of the height in sight, or into cells.
  private func cut() {
    let size = partSize
    guard lines.width == size.width else { return }
    let (parts, height) = cells.isEmpty ? flow(lines, size: size) : grid(lines, size: size)
    var pages = [[Int]](repeating: [], count: (parts.map(\.page).max() ?? -1) + 1)
    for (index, part) in parts.enumerated() {
      pages[part.page].append(index)
    }
    use(Layout(text: lines.text, background: lines.background, partSize: size, parts: parts, pages: pages, lines: lines.lines, height: height))
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
    onPaginated?(pageCount)
    UIAccessibility.post(notification: .layoutChanged, argument: nil)
  }

  /// The text laid out once at a column's width: where each line starts, and where it stands.
  private static func lines(of text: NSAttributedString, width: CGFloat, background: UIColor) -> Lines {
    let content = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    content.addTextLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: width, height: 0))
    container.lineFragmentPadding = 0
    manager.textContainer = container
    content.attributedString = text
    var lines = Lines(text: text, background: background, width: width)
    manager.enumerateTextLayoutFragments(from: content.documentRange.location, options: [.ensuresLayout]) { fragment in
      let paragraphStart = content.offset(from: content.documentRange.location, to: fragment.rangeInElement.location)
      let fragmentTop = fragment.layoutFragmentFrame.minY
      for line in fragment.textLineFragments {
        let bounds = line.typographicBounds
        lines.lines.append(Line(location: paragraphStart + line.characterRange.location, top: fragmentTop + bounds.minY, bottom: fragmentTop + bounds.maxY))
        lines.height = fragmentTop + bounds.maxY
      }
      return true
    }
    return lines
  }

  /// The text flowing through the columns of pages, cut wherever the next line would overflow one;
  /// in one endless scroll, cut at a screen's height, each part under the one before.
  private func flow(_ lines: Lines, size: CGSize) -> ([Part], CGFloat) {
    let pieces = Self.pieces(of: lines.lines[...], from: 0, to: lines.text.length, height: size.height)
    let parts = pieces.enumerated().map { index, piece -> Part in
      let frame = CGRect(x: margin, y: Self.inset + piece.top, width: size.width, height: piece.height)
      guard !continuous else { return Part(range: piece.range, top: piece.top, page: index, frame: frame) }
      let page = index / columns
      return Part(range: piece.range, top: piece.top, page: page,
                  frame: CGRect(x: CGFloat(page) * bounds.width + left(ofColumn: index % columns, size: size), y: Self.inset, width: size.width, height: piece.height))
    }
    return (parts, lines.height)
  }

  /// The cells in their rows, each row as tall as its tallest cell. On pages, a page holds the rows
  /// that fit; a row taller than a page is cut between lines, over pages of its own.
  private func grid(_ lines: Lines, size: CGSize) -> ([Part], CGFloat) {
    var parts: [Part] = []
    var (page, top) = (0, CGFloat(0))
    var (cell, line) = (0, 0)
    while cell < cells.count {
      let row = cells[cell...].prefix { $0.row == cells[cell].row }
      cell += row.count
      // Each cell's lines, which follow each other as the cells do.
      let rowLines = row.map { cell -> ArraySlice<Line> in
        while line < lines.lines.count && lines.lines[line].location < cell.range.location { line += 1 }
        let first = line
        while line < lines.lines.count && lines.lines[line].location < NSMaxRange(cell.range) { line += 1 }
        return lines.lines[first..<line]
      }
      let heights = rowLines.map { ($0.last?.bottom ?? 0) - ($0.first?.top ?? 0) }
      let height = heights.max() ?? 0
      // As far apart as the paragraphs at the cells' ends ask.
      let spacing = row.map { cell in
        (lines.text.attribute(.paragraphStyle, at: NSMaxRange(cell.range) - 1, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacing ?? 0
      }.max() ?? 0
      if !continuous && top > 0 && top + height > size.height {
        (page, top) = (page + 1, 0)
      }
      if continuous || height <= size.height {
        for ((cell, cellLines), cellHeight) in zip(zip(row, rowLines), heights) {
          // In one endless scroll, each part is a page of its own.
          parts.append(Part(range: cell.range, top: cellLines.first?.top ?? 0, page: continuous ? parts.count : page,
                            frame: CGRect(x: CGFloat(page) * bounds.width + left(ofColumn: cell.column, size: size), y: Self.inset + top,
                                          width: size.width, height: cellHeight)))
        }
        top += height + spacing
        continue
      }
      var pages = 1
      for (cell, cellLines) in zip(row, rowLines) {
        let pieces = Self.pieces(of: cellLines, from: cell.range.location, to: NSMaxRange(cell.range), height: size.height)
        for (index, piece) in pieces.enumerated() {
          parts.append(Part(range: piece.range, top: piece.top, page: page + index,
                            frame: CGRect(x: CGFloat(page + index) * bounds.width + left(ofColumn: cell.column, size: size), y: Self.inset,
                                          width: size.width, height: piece.height)))
        }
        pages = max(pages, pieces.count)
      }
      // The next row starts on a page of its own.
      (page, top) = (page + pages, 0)
    }
    return (parts, top)
  }

  /// Lines cut wherever the next would overflow `height`: where each piece starts and ends, from
  /// `start` to `end`, how far down it is laid out, and how tall it is.
  private static func pieces(of lines: ArraySlice<Line>, from start: Int, to end: Int, height: CGFloat) -> [Piece] {
    var pieces: [Piece] = []
    var (start, top) = (start, lines.first?.top ?? 0)
    var bottom = top
    for line in lines {
      if line.bottom - top > height && line.location > start {
        pieces.append(Piece(range: NSRange(location: start, length: line.location - start), top: top, height: bottom - top))
        (start, top) = (line.location, line.top)
      }
      bottom = line.bottom
    }
    pieces.append(Piece(range: NSRange(location: start, length: end - start), top: top, height: bottom - top))
    return pieces
  }

  /// How far from a page's left a column starts.
  private func left(ofColumn column: Int, size: CGSize) -> CGFloat {
    margin + CGFloat(column) * (size.width + gap)
  }

  /// A column's size; in one endless scroll a part fills the width and a screen's height.
  private var partSize: CGSize {
    let width = (bounds.width - 2 * margin - CGFloat(columns - 1) * gap) / CGFloat(columns)
    return CGSize(width: max(width.rounded(.down), 1), height: max(bounds.height - 2 * Self.inset, 1))
  }

  /// The pages in sight and next to it, or in one endless scroll the parts a screen around it.
  private var wanted: Set<Int> {
    if continuous {
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
    layout.pages[page].map { index in
      let part = layout.parts[index]
      let frame = CGRect(origin: part.frame.origin, size: CGSize(width: part.frame.width, height: part.frame.height + Self.inset / 2))
      let view = PartView(frame: frame, text: textOfPart(part.range), part: part)
      view.transform = transform
      view.highlight(highlighted, color: highlightColor)
      addSubview(view)
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

  /// Brings the character at `index` into sight: turns to its page, or in one endless scroll moves
  /// it a third of the way down, if it is out of sight.
  func show(characterAt index: Int) {
    guard layout.text === text, let part = layout.parts.lastIndex(atOrBefore: index, \.range.location) else { return }
    anchor = index
    guard continuous else {
      setContentOffset(CGPoint(x: CGFloat(layout.parts[part].page) * bounds.width, y: 0), animated: true)
      return
    }
    let line = contentRect(for: NSRange(location: index, length: 0))
    guard !bounds.contains(line) else { return }
    let lowest = max(contentSize.height - bounds.height, 0)
    setContentOffset(CGPoint(x: 0, y: min(max(line.minY - bounds.height / 3, 0), lowest)), animated: true)
  }

  /// Where the text in `range` shows in this view's content, the whole width of its column: from
  /// its first line to its last in the part it starts in.
  func contentRect(for range: NSRange) -> CGRect {
    guard layout.text === text,
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
    return layout.pages.indices.contains(page) ? layout.parts[layout.pages[page][0]].range.location : 0
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

  /// Once a scroll by hand has come to rest, the reader is where it ended – unless a new text is
  /// still being laid out.
  private func keepAnchor() {
    if layout.text === text && !layout.parts.isEmpty {
      anchor = characterInSight
    }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    keepAnchor()
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
    if continuous {
      let lowest = max(contentSize.height - bounds.height, 0)
      let step = (bounds.height - 2 * Self.inset) * (forward ? 1 : -1)
      let target = min(max(contentOffset.y + step, 0), lowest)
      anchor = character(below: target - 1) ?? anchor
      setContentOffset(CGPoint(x: 0, y: target), animated: true)
      UIAccessibility.post(notification: .pageScrolled, argument: nil)
      return true
    }
    let current = Int((contentOffset.x / bounds.width).rounded())
    let page = min(max(current + (forward ? 1 : -1), 0), max(pageCount - 1, 0))
    guard page != current else { return false }
    anchor = firstCharacter(onPage: page)
    setContentOffset(CGPoint(x: CGFloat(page) * bounds.width, y: 0), animated: true)
    UIAccessibility.post(notification: .pageScrolled, argument: "Page \(page + 1) of \(pageCount)")
    return true
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    if let index = characterIndex(at: gesture.location(in: self)) {
      onTap?(index)
    }
  }
}

/// The text laid out at a column's width: its lines, and how tall it is.
private struct Lines {
  var text = NSAttributedString()
  var background = UIColor.white
  var width: CGFloat = 0
  var lines: [Line] = []
  var height: CGFloat = 0
}

/// The text cut into parts, and the parts on each page – in one endless scroll, a part is a page –
/// the lines it was laid out in, how tall it is in one endless scroll, and the size of a part it
/// was cut for.
private struct Layout {
  var text = NSAttributedString()
  var background = UIColor.white
  var partSize = CGSize.zero
  var parts: [Part] = []
  var pages: [[Int]] = []
  var lines: [Line] = []
  var height: CGFloat = 0
}

/// A part of the text: where it starts and ends, how far down its first line is laid out in the
/// whole text, and where it shows: on which page, and where its lines are in this view's content.
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

/// A line of the text: the character it starts with, and how far down it is laid out.
private struct Line {
  let location: Int
  let top: CGFloat
  let bottom: CGFloat
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

/// A part's text, in a text view of its own, and the part.
private final class PartView: UITextView {
  let part: Part
  var range: NSRange { part.range }

  init(frame: CGRect, text: NSAttributedString, part: Part) {
    self.part = part
    super.init(frame: frame, textContainer: nil)
    isEditable = false
    isSelectable = false
    isScrollEnabled = false
    isUserInteractionEnabled = false
    backgroundColor = .clear
    textContainerInset = .zero
    textContainer.lineFragmentPadding = 0
    attributedText = text
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  /// Highlights the part of `range`, in the whole text, that falls in this part.
  func highlight(_ whole: NSRange?, color: UIColor) {
    textStorage.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: textStorage.length))
    guard let overlap = whole?.intersection(range) else { return }
    let local = NSRange(location: overlap.location - range.location, length: overlap.length)
    textStorage.addAttribute(.backgroundColor, value: color, range: local)
  }
}
