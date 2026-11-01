import CoreText
import ExpoModulesCore
import UIKit

/// The reader: passages as paragraphs, each with its own direction, language and font, laid out as
/// one attributed string, in pages or one endless scroll. It fetches them from the core itself, from
/// the books the host added, so their text never passes through JS. A word can be tapped, reached
/// word by word or jumped to; JS learns only where the current word stands, never its text. It
/// reads aloud – chapters with recordings from them, the rest with the device's voices – from the
/// word it is at, and marks each word as it is said, keeping it in sight – unless it was scrolled
/// away from it by hand. The books' notes stand in the text as marks, each opening where it stands;
/// a cross reference's verses it jumps to, or tells JS of. Chapters open with a drop cap.
class ReaderView: ExpoView {
  /// Posted as the host adds or removes books: every reader shows what the library now holds.
  static let booksChanged = Notification.Name("ScripturaBooksChanged")
  /// Posted as the host adds or removes recordings: what is still to be read goes with them.
  static let recordingsChanged = Notification.Name("ScripturaRecordingsChanged")

  var passages: [PassageRecord] = []
  var fontSize = 28.0
  var paging = "scroll"
  var columns = 1
  var colors = ReaderColors()
  /// For text without a font of its own: "sans" or "serif", unless `fonts` names one for its language.
  var font = "sans"
  var fonts: [String: String] = [:]
  var lineSpacing = 1.0
  var margin = 16.0
  var versePerLine = false
  /// Other editions of the passages' books, read along: "inline", a verse and then the same verse
  /// in each, or "columns", side by side.
  var companions: [String] = []
  var parallel = "inline"
  /// The books' notes as marks in the text, each opening where it stands; and chapters opening with
  /// a drop cap – their first letter set large, in the font the app names for it, if that font has
  /// the letter, such as one of ornamental initials.
  /// "marks", "inline" or "none".
  var notes = "marks"
  var dropCaps = true
  var dropCapFont: String?
  /// A voice per language for reading aloud, by identifier; otherwise the device's for it.
  var voices: [String: String] = [:]
  /// Read aloud, each verse is followed by the same verse in each book read along; otherwise only
  /// the passages' own books are.
  var speakAlong = false
  /// How fast the voices read, as a multiple of their own rate: from 0.5 to 2.
  var speechRate = 1.0
  /// The voices whose recordings are played, the first that has one for a chapter; with none named,
  /// any.
  var recordedVoices: [String]?
  /// What the system's media controls show while it reads aloud – which then goes on in the
  /// background; without it, they show nothing, and it pauses as the app goes to the background.
  var nowPlaying: NowPlayingRecord?

  let onWordChange = EventDispatcher()
  let onLaidOut = EventDispatcher()
  let onSpeechChange = EventDispatcher()
  /// A cross reference followed to verses the reader doesn't show: the app may.
  let onReference = EventDispatcher()

  private let pages = PagedText()
  private var words: [ReaderWord] = []
  /// Each word's index in `words`, by where it stands.
  private var indices: [WordPlace: Int] = [:]
  private var current: Int?
  /// The paragraphs shown, and the notes' marks in them, in the text's order.
  private var paragraphs: [Paragraph] = []
  private var marks: [ReaderNote] = []
  /// The note open, by its mark's index, the verses its links refer to, and what VoiceOver was on
  /// when it opened; and a note to open once its mark has scrolled into sight.
  private let noteView = NoteView()
  private var openNote: Int?
  private var pendingNote: (index: Int, from: Any?)?
  private var openLinks: [Target] = []
  private var openedFrom: Any?
  private let readAloud = ReadAloud()
  /// Whether the word the voice comes to is brought into sight: not after a scroll by hand away
  /// from it, until it is in sight again.
  private var following = true
  /// The passages the text is of: given them again, in another layout, the reader stays where it is.
  private var shownReferences: [Reference] = []
  /// What is read aloud along with them, and from which recordings; and how fast.
  private var readAs: ([String], Bool, [String]?) = ([], false, nil)
  private var rateAs = 1.0
  private var observers: [NSObjectProtocol] = []
  /// How tall a letter is in a font, per point of its size, by font and letter.
  private var letterHeights: [String: Double] = [:]
  private var renderStarted: CFTimeInterval = 0
  /// When the first pages of this text showed, and whether its layout is yet to be reported: once,
  /// as a new size lays it out again.
  private var firstShown: Double?
  private var reportPending = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    pages.onTap = { [weak self] index in self?.selectWord(atCharacter: index) }
    pages.onFirstPages = { [weak self] in
      guard let self, reportPending, firstShown == nil else { return }
      firstShown = milliseconds(since: renderStarted)
    }
    pages.onPaginated = { [weak self] count in
      guard let self, reportPending else { return }
      reportPending = false
      let time = milliseconds(since: renderStarted)
      onLaidOut(["pages": paging == "pages" ? count : 0, "milliseconds": firstShown ?? time, "all": time])
    }
    readAloud.onWord = { [weak self] place in self?.reached(place) }
    readAloud.onChange = { [weak self] change in self?.speechChanged(change) }
    pages.onScrollByHand = { [weak self] in self?.scrolledByHand() }
    pages.onTapElsewhere = { [weak self] in self?.closeNote() }
    pages.onSettled = { [weak self] in self?.openPendingNote() }
    noteView.onLink = { [weak self] url in self?.followLink(url) }
    noteView.onEscape = { [weak self] in self?.closeNote() }
    addSubview(pages)
    addSubview(noteView)
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: Self.booksChanged, object: nil, queue: .main) { [weak self] _ in
        // What is still to be read goes with the books.
        self?.readAloud.stop()
        self?.render()
      },
      center.addObserver(forName: Self.recordingsChanged, object: nil, queue: .main) { [weak self] _ in
        self?.readAloud.stop()
      },
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        guard let self, nowPlaying == nil, readAloud.state == "speaking" else { return }
        pause()
      },
    ]
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    readAloud.stop()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      readAloud.stop()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if pages.frame != bounds {
      pages.frame = bounds
      closeNote()
    }
  }

  func render() {
    closeNote()
    pendingNote = nil
    renderStarted = CACurrentMediaTime()
    firstShown = nil
    reportPending = true
    pages.highlightColor = colors.highlight
    let references = passages.map {
      Reference(book: $0.book, chapter: $0.chapter.map(UInt32.init), from: $0.from.map(UInt32.init), to: $0.to.map(UInt32.init))
    }
    // The same passages in another layout – a new font size, theme or line spacing, other books read
    // along – keep the reader at the word it was at, and the word it marked: the text may change,
    // its words don't.
    let staying = references == shownReferences
    let kept = staying ? words : []
    // At the very start, before the first word, it stays there, its heading in sight.
    let anchorAt = pages.anchor > 0 ? kept.firstIndex { NSMaxRange($0.range) > pages.anchor } : nil
    let marked = staying ? current.map { words[$0].place } : nil
    if !staying {
      readAloud.stop()
    }
    shownReferences = references
    let shownNotes: Notes = notes == "none" ? .none : notes == "inline" ? .inline : .marks
    let blocks = readerBlocks(references: references, fontSize: fontSize, versePerLine: versePerLine, companions: companions, notes: shownNotes, dropCaps: dropCaps)
    let paragraphs = blocks.map { Paragraph($0, colors: colors, fontSize: fontSize(for: $0)) }
    // The passages read along with other books, in rows.
    let along = Set(paragraphs.filter { $0.column > 0 }.map(\.passage))
    let sideBySide = parallel == "columns" && !along.isEmpty
    let text = NSMutableAttributedString()
    var paragraphRanges: [NSRange] = []
    var readables: [Readable] = []
    var dropCapSpecs: [PagedText.DropCapSpec] = []
    words = []
    marks = []
    current = nil
    self.paragraphs = paragraphs
    let numberColumn = numberColumnWidth(paragraphs)
    for (index, paragraph) in paragraphs.enumerated() {
      let font = font(of: paragraph)
      let next = index + 1 < paragraphs.count ? paragraphs[index + 1] : nil
      let style = style(of: paragraph, before: next, numberColumn: numberColumn, along: along.contains(paragraph.passage), sideBySide: sideBySide)
      let start = text.length
      var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: style]
      // A note's mark is small and raised; it doesn't make the line taller.
      let markAttributes: [NSAttributedString.Key: Any] = [
        .font: font.withSize(paragraph.fontSize * 0.6), .baselineOffset: paragraph.fontSize * 0.33, .paragraphStyle: style,
      ]
      for run in paragraph.runs {
        attributes[.foregroundColor] = run.color ?? colors.text
        if run.role == "note" {
          text.append(NSAttributedString(string: run.text, attributes: markAttributes.merging([.foregroundColor: run.color ?? colors.text]) { $1 }))
        } else {
          text.append(NSAttributedString(string: run.text, attributes: attributes))
        }
      }
      let range = NSRange(location: start, length: text.length - start)
      let firstMark = marks.count
      marks += paragraph.notes.map { note in
        ReaderNote(paragraph: index, note: note, range: NSRange(location: start + Int(note.start), length: Int(note.end - note.start)))
      }
      readables += paragraph.readables(at: range, firstWord: words.count, firstMark: firstMark)
      words += paragraph.words.map { word in
        ReaderWord(place: WordPlace(passage: paragraph.passage, book: paragraph.book, chapter: word.chapter, verse: word.verse, index: word.index),
                   range: NSRange(location: start + Int(word.start), length: Int(word.end - word.start)))
      }
      if let dropCap = paragraph.dropCap, let spec = dropCapSpec(dropCap, of: paragraph, at: range, in: text, font: font) {
        dropCapSpecs.append(spec)
      }
      paragraphRanges.append(range)
      if index < paragraphs.count - 1 {
        text.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style]))
      }
    }
    let withWords = paragraphs.filter { !$0.words.isEmpty }
    let rightToLeft = !withWords.isEmpty && withWords.allSatisfy(\.rightToLeft)
    let indices = Dictionary(words.indices.map { (words[$0].place, $0) }, uniquingKeysWith: min)
    self.indices = indices
    // The word the reader was at – or if it is gone, as a book is no longer read along, the last
    // before it that is still there.
    let anchorWord = anchorAt.flatMap { at in kept[...at].reversed().lazy.compactMap { indices[$0.place] }.first }
    let anchor = anchorWord.map { words[$0].range.location } ?? 0
    let whole = [PagedText.Section(range: NSRange(location: 0, length: text.length), cells: [])]
    let sections = sideBySide ? Self.sections(of: paragraphs, at: paragraphRanges, along: along) : whole
    // Unchangeable, as it is laid out on other threads.
    pages.show(NSAttributedString(attributedString: text), background: colors.background, columns: columns, sections: sections, dropCaps: dropCapSpecs,
               rightToLeft: rightToLeft, continuous: paging != "pages", margin: margin, from: anchor)
    pages.accessibilityElements = Readable.namingChapters(readables).map { ReadableElement(reader: self, pages: pages, readable: $0) }
    if let marked, let index = indices[marked] {
      current = index
      pages.highlight(words[index].range)
    }
    // Other books read along or other recordings change what is read, and a new rate how: the voice
    // goes on from the word it is at. A recording takes a new rate as it plays.
    let changed = readAs != (companions, speakAlong, recordedVoices) || (speechRate != rateAs && !readAloud.setRate(speechRate))
    if changed, readAloud.state != "stopped" {
      readAloud.state == "speaking" ? play() : readAloud.stop()
    }
    readAs = (companions, speakAlong, recordedVoices)
    rateAs = speechRate
    readAloud.inAppSession = nowPlaying != nil
    showNowPlaying(readAloud.state)
  }

  /// A chapter's drop cap: the first letter of its text set large over the first two lines of the
  /// paragraph, laid out at `range` in `text`. The letter stays in the text, where VoiceOver and
  /// the words find it, but invisible and without advance – in its font: TextKit takes a line's
  /// height from its first character's – and is drawn large instead: in the paragraph's font, so
  /// large that a digit's top would stand at the first line's digit height and its baseline on the
  /// second line's; or in the app's font for initials, if it has the letter, sized by the letter's
  /// own height, so an ornament fills the two lines. Nothing, for a letter the text doesn't hold.
  private func dropCapSpec(_ dropCap: DropCap, of paragraph: Paragraph, at range: NSRange, in text: NSMutableAttributedString, font: UIFont) -> PagedText.DropCapSpec? {
    let letterRange = NSRange(location: range.location + Int(dropCap.letterStart), length: Int(dropCap.letterEnd - dropCap.letterStart))
    guard letterRange.length > 0, NSMaxRange(letterRange) <= NSMaxRange(range) else { return nil }
    text.addAttribute(.foregroundColor, value: UIColor.clear, range: letterRange)
    let string = text.string as NSString
    var at = letterRange.location
    while at < NSMaxRange(letterRange) {
      // Each character with its marks, kerned back by its own width.
      let cluster = string.rangeOfComposedCharacterSequence(at: at)
      let width = (string.substring(with: cluster) as NSString).size(withAttributes: [.font: font]).width
      text.addAttribute(.kern, value: -width, range: NSRange(location: cluster.location, length: 1))
      at = NSMaxRange(cluster)
    }
    let letter = string.substring(with: letterRange)
    let advance = font.lineHeight * lineSpacing
    var family = paragraph.fontFamily ?? fonts[paragraph.language]
    var measured = font
    if let initials = dropCapFont, let initialsFont = UIFont(name: initials, size: 100), Self.has(letter, initialsFont) {
      family = initials
      measured = initialsFont
    }
    // A letter's marks above it, such as an Arabic vowel, count too: they stay within the two lines.
    let (above, below) = Self.reach(of: letter, in: measured)
    let height = family == dropCapFont ? above : max(letterHeight("0", in: font), above)
    var dropFont = self.font(family: family, size: paragraph.fontSize + advance / height)
    // What reaches below the baseline – a Hebrew letter's points, an initial's tail – must stay
    // within the second line: if it wouldn't, the letter is set smaller, from the first line's digit
    // height down to the second line's bottom, its baseline lifted by what hangs below it.
    let room = advance - font.ascender * lineSpacing
    var lift: CGFloat = 0
    if below * dropFont.pointSize > room {
      let top = paragraph.fontSize * letterHeight("0", in: font)
      dropFont = self.font(family: family, size: (top + advance + room) / (above + below))
      lift = below * dropFont.pointSize - room
    }
    let width = (letter as NSString).size(withAttributes: [.font: dropFont]).width + paragraph.fontSize * 0.14
    return PagedText.DropCapSpec(range: range, text: letter, font: dropFont, color: colors.text, width: width.rounded(.up),
                                 height: 2 * advance - 1, lineAdvance: advance, baselineLift: lift, rightToLeft: paragraph.rightToLeft)
  }

  /// How far the glyphs of `letter` reach above and below the baseline in `font`, per point of its size.
  private static func reach(of letter: String, in font: UIFont) -> (above: Double, below: Double) {
    var characters = Array(letter.utf16)
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count)
    let bounds = CTFontGetBoundingRectsForGlyphs(font, .horizontal, glyphs, nil, glyphs.count)
    let size = Double(font.pointSize)
    return (max(Double(bounds.maxY) / size, 0.1), max(-Double(bounds.minY) / size, 0))
  }

  /// Whether a font has a glyph of its own for the first character of `letter`.
  private static func has(_ letter: String, _ font: UIFont) -> Bool {
    guard let first = letter.first else { return false }
    var characters = Array(String(first).utf16)
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    return CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count)
  }

  /// A paragraph's font: its own, or the one the app brings for its language, or the system's.
  private func font(of paragraph: Paragraph) -> UIFont {
    font(family: paragraph.fontFamily ?? fonts[paragraph.language], size: paragraph.fontSize)
  }

  private func font(family: String?, size: Double) -> UIFont {
    family.flatMap { UIFont(name: $0, size: size) } ?? textFont(size: size)
  }

  /// The size at which a block's font draws the block's typical letter as tall as it asks: the
  /// system's fonts and the app's own differ in how large they look at the same size.
  private func fontSize(for block: Block) -> Double {
    block.letterHeight / letterHeight(block.letter, in: font(family: block.fontFamily ?? fonts[block.language], size: 100))
  }

  /// How tall `letter` is drawn in `font`, per point of its size – by the font the system draws it
  /// with, which for a script the font lacks is another.
  private func letterHeight(_ letter: String, in font: UIFont) -> Double {
    let key = "\(font.fontName) \(letter)"
    if let height = letterHeights[key] { return height }
    let string = letter as CFString
    let drawn = CTFontCreateForString(font, string, CFRange(location: 0, length: CFStringGetLength(string)))
    var characters = Array(letter.utf16)
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    CTFontGetGlyphsForCharacters(drawn, &characters, &glyphs, characters.count)
    let bounds = CTFontGetBoundingRectsForGlyphs(drawn, .horizontal, glyphs, nil, glyphs.count)
    let measured = Double(bounds.maxY - max(bounds.minY, 0)) / Double(CTFontGetSize(drawn))
    let height = measured > 0 ? measured : 0.5
    letterHeights[key] = height
    return height
  }

  private func textFont(size: Double) -> UIFont {
    let system = UIFont.systemFont(ofSize: size)
    guard font == "serif", let serif = system.fontDescriptor.withDesign(.serif) else { return system }
    return UIFont(descriptor: serif, size: size)
  }

  private func style(of paragraph: Paragraph, before next: Paragraph?, numberColumn: CGFloat, along: Bool, sideBySide: Bool) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.baseWritingDirection = paragraph.rightToLeft ? .rightToLeft : .leftToRight
    style.alignment = paragraph.rightToLeft ? .right : .left
    style.lineHeightMultiple = lineSpacing
    style.paragraphSpacing = paragraph.fontSize * spacing(after: paragraph, before: next, along: along, sideBySide: sideBySide)
    // Plain line breaking, without moving words to avoid a short last line: a page's column,
    // laid out on its own, then breaks into the same lines as the whole text.
    style.lineBreakStrategy = []
    // Read along inline, the other books stand indented under the passage's.
    let indent = along && !sideBySide && paragraph.column > 0 ? (numberColumn > 0 ? numberColumn : (fontSize * 1.5).rounded()) : 0
    style.firstLineHeadIndent = indent
    style.headIndent = indent
    if paragraph.numberHangs {
      // The text starts at a tab past the widest number, and so do its lines after the first.
      style.headIndent = indent + numberColumn
      style.tabStops = [NSTextTab(textAlignment: .natural, location: indent + numberColumn)]
      style.defaultTabInterval = numberColumn
    }
    return style
  }

  /// The space after a paragraph, in ems. Verse lines run closer together than paragraphs. Read
  /// along, so do the books of a row – side by side, the verses of a cell – and rows stand further
  /// apart.
  private func spacing(after paragraph: Paragraph, before next: Paragraph?, along: Bool, sideBySide: Bool) -> Double {
    guard let next else { return 0.5 }
    if along {
      return next.row == paragraph.row && (!sideBySide || next.column == paragraph.column) ? 0.2 : 0.6
    }
    return paragraph.kind == "verse" && next.kind == "verse" ? 0.2 : 0.5
  }

  /// Books read along side by side, each passage a section of its own: cells in rows, or, for a
  /// passage read alone, text that flows as it would alone.
  private static func sections(of paragraphs: [Paragraph], at ranges: [NSRange], along: Set<UInt32>) -> [PagedText.Section] {
    var sections: [PagedText.Section] = []
    var start = 0
    while start < paragraphs.count {
      let passage = paragraphs[start].passage
      let end = paragraphs[start...].firstIndex { $0.passage != passage } ?? paragraphs.count
      let range = NSUnionRange(ranges[start], ranges[end - 1])
      if !along.contains(passage), let last = sections.last, last.cells.isEmpty {
        // Passages read alone, one after the other, flow on as one.
        sections[sections.count - 1] = PagedText.Section(range: NSUnionRange(last.range, range), cells: [])
      } else {
        let cells = along.contains(passage) ? Self.cells(of: Array(paragraphs[start..<end]), at: Array(ranges[start..<end])) : []
        sections.append(PagedText.Section(range: range, cells: cells))
      }
      start = end
    }
    return sections
  }

  /// The paragraphs side by side: each book's in a row is a cell, in the book's column.
  private static func cells(of paragraphs: [Paragraph], at ranges: [NSRange]) -> [PagedText.Cell] {
    var cells: [PagedText.Cell] = []
    for (paragraph, range) in zip(paragraphs, ranges) {
      let (row, column) = (Int(paragraph.row), Int(paragraph.column))
      if let last = cells.last, last.row == row, last.column == column {
        cells[cells.count - 1] = PagedText.Cell(range: NSUnionRange(last.range, range), row: row, column: column, heading: last.heading && paragraph.kind == "heading")
      } else {
        cells.append(PagedText.Cell(range: range, row: row, column: column, heading: paragraph.kind == "heading"))
      }
    }
    return cells
  }

  /// How far the text of verse lines starts, past the widest verse number before it.
  private func numberColumnWidth(_ paragraphs: [Paragraph]) -> CGFloat {
    var widths: [String: CGFloat] = [:]
    var widest: CGFloat = 0
    for paragraph in paragraphs where paragraph.numberHangs {
      let number = paragraph.runs[0].text.trimmingCharacters(in: .whitespaces)
      let font = font(of: paragraph)
      let key = "\(font.fontName) \(font.pointSize) \(number)"
      let width = widths[key] ?? (number as NSString).size(withAttributes: [.font: font]).width
      widths[key] = width
      widest = max(widest, width + paragraph.fontSize * 0.4)
    }
    return widest.rounded(.up)
  }

  /// One step through the words: "word+1", "word-1", "word+10", "word-10", "verse+1" or "verse-1".
  func move(_ step: String) {
    guard !words.isEmpty else { return }
    guard let index = current else { return select(0) }
    switch step {
    case "word+1": select(min(index + 1, words.count - 1))
    case "word-1": select(max(index - 1, 0))
    case "word+10": select(min(index + 10, words.count - 1))
    case "word-10": select(max(index - 10, 0))
    case "verse+1": select(words.indices.first { $0 > index && !words[$0].isInVerse(of: words[index]) } ?? index)
    case "verse-1":
      let start = verseStart(index)
      select(start == 0 ? 0 : verseStart(start - 1))
    default: break
    }
  }

  /// A move from a heading or verse VoiceOver is on: from the word the reader marked, if it is in
  /// that verse, or else to the verse's first word.
  fileprivate func move(_ step: String, from word: Int) {
    guard word < words.count else { return }
    if let current, words[current].isInVerse(of: words[word]) {
      move(step)
    } else {
      select(word)
    }
  }

  fileprivate func moveActions(from word: Int) -> [UIAccessibilityCustomAction] {
    [("Next word", "word+1"), ("Previous word", "word-1"), ("Next verse", "verse+1"), ("Previous verse", "verse-1")].map { name, step in
      UIAccessibilityCustomAction(name: name) { [weak self] _ in
        self?.move(step, from: word)
        return true
      }
    }
  }

  /// VoiceOver's actions opening the notes of a verse, from the element it is on.
  fileprivate func noteActions(for notes: [Int], from element: Any) -> [UIAccessibilityCustomAction] {
    notes.map { index in
      UIAccessibilityCustomAction(name: Self.name(of: marks[index].note)) { [weak self] _ in
        self?.openNote(index, from: element)
        return true
      }
    }
  }

  /// A note as VoiceOver names it: "Footnote 1", "Cross reference a".
  fileprivate static func name(of note: NoteMark) -> String {
    let kind = ["footnote": "Footnote", "endnote": "Endnote", "crossReference": "Cross reference"][note.kind] ?? "Note"
    return "\(kind) \(note.mark)"
  }

  /// The headings and verses VoiceOver finds in sight, and the notes' marks: where they stand and
  /// where they are, in this view's points, but not their text, which JS never gets.
  func accessibilityElementsInSight() -> [[String: Any]] {
    guard let elements = pages.accessibilityElements as? [ReadableElement] else { return [] }
    let sight = screenRect(bounds, in: self)
    let frame = { (frame: CGRect) -> [Double] in
      let local = frame.offsetBy(dx: -sight.minX, dy: -sight.minY)
      return [local.minX, local.minY, local.width, local.height].map { (value: CGFloat) -> Double in Double((value * 10).rounded() / 10) }
    }
    let readables: [[String: Any]] = elements.compactMap { (element: ReadableElement) -> [String: Any]? in
      guard element.accessibilityFrame.intersects(sight) else { return nil }
      var found: [String: Any] = [
        "passage": element.readable.passage, "book": element.readable.book, "chapter": element.readable.chapter,
        "language": element.readable.language, "frame": frame(element.accessibilityFrame),
      ]
      found["verse"] = element.readable.verse
      return found
    }
    let notes: [[String: Any]] = marks.compactMap { (mark: ReaderNote) -> [String: Any]? in
      guard let rect = pages.rect(for: mark.range) else { return nil }
      let shown = screenRect(rect, in: pages)
      guard shown.intersects(sight) else { return nil }
      let paragraph = paragraphs[mark.paragraph]
      return [
        "passage": paragraph.passage, "book": paragraph.book, "chapter": mark.note.chapter, "verse": mark.note.verse,
        "note": mark.note.mark, "kind": mark.note.kind, "language": paragraph.language, "frame": frame(shown),
      ]
    }
    return readables + notes
  }

  /// Opens a note – a footnote's text, a cross reference's verses – where its mark stands, and
  /// tells VoiceOver; `from` is what VoiceOver was on. The mark is brought into sight first.
  fileprivate func openNote(_ index: Int, from element: Any? = nil) {
    closeNote()
    let mark = marks[index]
    // Out of sight – as from a VoiceOver action on a verse further on – it opens once it is in sight.
    guard pages.isInSight(characterAt: mark.range.location), let rect = pages.rect(for: mark.range) else {
      pendingNote = (index, element)
      pages.show(characterAt: mark.range.location)
      return
    }
    let paragraph = paragraphs[mark.paragraph]
    var links: [Target] = []
    let text = noteText(mark.note, in: paragraph, links: &links)
    openNote = index
    openLinks = links
    openedFrom = element
    let area = bounds.insetBy(dx: margin, dy: 12)
    noteView.show(text, at: convert(rect, from: pages), in: area, maxWidth: 360, maxHeight: (bounds.height * 0.45).rounded(),
                  background: colors.background, border: colors.text.withAlphaComponent(0.25), linkColor: colors.roles["note"] ?? colors.text)
    UIAccessibility.post(notification: .screenChanged, argument: noteView.textView)
  }

  /// Opens the note that waited for its mark to come into sight.
  private func openPendingNote() {
    guard let (index, element) = pendingNote, index < marks.count, pages.isInSight(characterAt: marks[index].range.location) else { return }
    pendingNote = nil
    openNote(index, from: element)
  }

  private func closeNote() {
    guard openNote != nil else { return }
    openNote = nil
    openLinks = []
    noteView.isHidden = true
    if UIAccessibility.isVoiceOverRunning {
      UIAccessibility.post(notification: .layoutChanged, argument: openedFrom ?? pages)
    }
    openedFrom = nil
  }

  /// A note's runs as text in the paragraph's font, a little smaller: the verse it names in its
  /// color, quotations and emphasis in italics, words in other languages in their fonts, and the
  /// verses it refers to as links, numbered in `links`.
  private func noteText(_ note: NoteMark, in paragraph: Paragraph, links: inout [Target]) -> NSAttributedString {
    let size = max(14, paragraph.fontSize * 0.7)
    let font = font(family: paragraph.fontFamily ?? fonts[paragraph.language], size: size)
    let style = NSMutableParagraphStyle()
    style.baseWritingDirection = paragraph.rightToLeft ? .rightToLeft : .leftToRight
    style.alignment = .natural
    let text = NSMutableAttributedString()
    // The verses a note refers to stand in paragraphs of their own, each in the direction of its
    // first letter: an Arabic verse under an English note runs from the right.
    let natural = NSMutableParagraphStyle()
    natural.baseWritingDirection = .natural
    natural.alignment = .natural
    for run in note.runs {
      var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: colors.text, .paragraphStyle: style]
      if run.role == "origin" {
        attributes[.foregroundColor] = colors.roles["origin"] ?? colors.text.withAlphaComponent(0.6)
      }
      if run.role == "number" {
        attributes[.foregroundColor] = colors.roles["number"] ?? colors.text.withAlphaComponent(0.6)
      }
      if run.role == "preview" || run.role == "number" {
        attributes[.paragraphStyle] = natural
      }
      if run.role == "quotation" || run.role == "emphasis", let italic = font.fontDescriptor.withSymbolicTraits(.traitItalic) {
        // The font's own italic, if it has one; not another font's.
        let italicFont = UIFont(descriptor: italic, size: size)
        if italicFont.familyName == font.familyName {
          attributes[.font] = italicFont
        }
      }
      if let language = run.language {
        attributes[.font] = self.font(family: fonts[language], size: size)
        attributes[.accessibilitySpeechLanguage] = language
      }
      if let target = run.target {
        attributes[.link] = URL(string: "scriptura://reference/\(links.count)")!
        links.append(target)
      }
      text.append(NSAttributedString(string: run.text, attributes: attributes))
    }
    return text
  }

  private func followLink(_ url: URL) {
    guard url.host == "reference", let index = Int(url.lastPathComponent), index < openLinks.count, let open = openNote else { return }
    followReference(openLinks[index], from: marks[open])
  }

  /// Follows a reference: to the verses it names, if the reader shows them – in the same edition as
  /// the note's book, or else in another – or, if not, tells JS, with the library's book of them, if
  /// it holds one.
  private func followReference(_ target: Target, from mark: ReaderNote) {
    let paragraph = paragraphs[mark.paragraph]
    let library = books()
    let work = library.first { $0.id == paragraph.book }?.work
    let editions = library.filter { $0.code == target.book }
    let held = editions.first { $0.work == work } ?? editions.first
    let codes = Dictionary(library.compactMap { book in book.code.map { (book.id, $0) } }, uniquingKeysWith: { first, _ in first })
    let at = { (word: ReaderWord) in word.place.chapter == target.chapter && target.verse.map { $0 == word.place.verse } ?? true }
    var index = held.flatMap { held in words.firstIndex { $0.place.book == held.id && at($0) } }
    if index == nil {
      index = words.firstIndex { codes[$0.place.book] == target.book && at($0) }
    }
    closeNote()
    if let index {
      return select(index)
    }
    var event: [String: Any] = [
      "book": held?.id ?? NSNull(), "code": target.book, "chapter": target.chapter,
      "from": ["passage": paragraph.passage, "book": paragraph.book, "chapter": mark.note.chapter, "verse": mark.note.verse],
    ]
    if let verse = target.verse {
      event["verse"] = verse
    }
    if let to = target.to {
      event["to"] = to
    }
    onReference(event)
  }

  /// Brings the reader to a word by where it stands and marks it, as a tap would – or if its verse
  /// has no such word, the verse's first. False if the reader shows no such verse.
  func jump(to place: WordPlace) -> Bool {
    let inVerse = { (word: ReaderWord) in
      word.place.passage == place.passage && word.place.book == place.book && word.place.chapter == place.chapter && word.place.verse == place.verse
    }
    guard let index = indices[place] ?? words.firstIndex(where: inVerse) else { return false }
    select(index)
    return true
  }

  /// Reads aloud from the word marked – or, with none, the first in sight – on to the end; a voice
  /// or a recording paused at that word goes on.
  func play() {
    readAloud.voices = voices
    readAloud.rate = speechRate
    following = true
    readAloud.play(shownReferences, companions: companions, along: speakAlong, from: readingStart().map(position(of:)), recorded: recordedVoices)
  }

  /// Brings the word the voice is at – or, not reading aloud, the word marked – into sight, and
  /// keeps the words the voice comes to there.
  func follow() {
    setFollowing(true)
    if let current {
      pages.show(characterAt: words[current].range.location)
    }
  }

  /// Plays if it doesn't, or pauses: as the media controls' one button does.
  func playOrPause() {
    readAloud.state == "speaking" ? pause() : play()
  }

  /// Turns to the next or previous page, or a screen down or up, as a hand would.
  func turn(forward: Bool) {
    pages.turn(forward: forward)
  }

  func pause() {
    readAloud.pause(at: current.map { position(of: words[$0].place) })
  }

  func stop() {
    readAloud.stop()
  }

  /// The word reading starts at: the one marked, or the first in sight – none at the very start,
  /// where reading starts with the first heading.
  private func readingStart() -> WordPlace? {
    if let current {
      return words[current].place
    }
    guard pages.anchor > 0 else { return nil }
    return words.first { NSMaxRange($0.range) > pages.anchor }?.place
  }

  private func position(of place: WordPlace) -> WordPosition {
    WordPosition(passage: place.passage, book: place.book, chapter: place.chapter, verse: place.verse, word: place.index)
  }

  /// Selects the word at a point in this view's coordinates, as a tap there would.
  func tap(at point: CGPoint) {
    pages.characterIndex(at: pages.convert(point, from: self)).map(selectWord(atCharacter:))
  }

  /// A tap on a note's mark opens the note, or closes it if it is the one open; a tap on a word
  /// selects it.
  private func selectWord(atCharacter offset: Int) {
    if let note = marks.firstIndex(where: { $0.range.location <= offset && offset <= NSMaxRange($0.range) }) {
      openNote == note ? closeNote() : openNote(note)
      return
    }
    closeNote()
    if let index = words.firstIndex(where: { $0.range.location <= offset && offset <= NSMaxRange($0.range) }) {
      select(index)
    }
  }

  /// Marks a word reached by a tap, a move or a jump. While reading aloud, the voice goes on from it.
  private func select(_ index: Int) {
    closeNote()
    following = true
    mark(index)
    if UIAccessibility.isVoiceOverRunning {
      // Without a note's mark within it.
      let range = words[index].range
      var spoken = (pages.text.string as NSString).substring(with: range)
      for mark in marks.reversed() where mark.range.location > range.location && NSMaxRange(mark.range) < NSMaxRange(range) {
        spoken = (spoken as NSString).replacingCharacters(in: NSRange(location: mark.range.location - range.location, length: mark.range.length), with: "")
      }
      UIAccessibility.post(notification: .announcement, argument: spoken)
    }
    if readAloud.state == "speaking" {
      play()
    }
  }

  /// Marks the word the voice comes to, and keeps it in sight – unless the reader was scrolled away
  /// from it, until it is in sight again. Voices report some punctuation apart, as a word of its
  /// own: it is still the word it belongs to.
  private func reached(_ place: WordPlace) {
    guard let index = indices[place], index != current else { return }
    if !following, !pages.isScrollingByHand, pages.isInSight(characterAt: words[index].range.location) {
      setFollowing(true)
    }
    mark(index, show: following)
  }

  /// While the voice reads, a scroll by hand leaves it be: the reader no longer follows it. A note
  /// open stands where its mark was: it closes.
  private func scrolledByHand() {
    closeNote()
    if readAloud.state == "speaking" {
      setFollowing(false)
    }
  }

  private func setFollowing(_ following: Bool) {
    guard following != self.following else { return }
    self.following = following
    if readAloud.state == "speaking" {
      onSpeechChange(["state": "speaking", "following": following])
    }
  }

  /// The voice's news for JS; while it speaks, with whether the reader follows it.
  private func speechChanged(_ change: [String: Any]) {
    var change = change
    if change["state"] as? String == "speaking" {
      change["following"] = following
    }
    onSpeechChange(change)
    showNowPlaying(change["state"] as? String ?? "stopped")
  }

  /// The system's media controls show the reader while it reads aloud, playing or paused, if it has
  /// something to show there.
  private func showNowPlaying(_ state: String) {
    if let nowPlaying, state != "stopped" {
      NowPlaying.shared.show(nowPlaying, playing: state == "speaking", for: self)
    } else {
      NowPlaying.shared.hide(for: self)
    }
  }

  private func mark(_ index: Int, show: Bool = true) {
    let word = words[index]
    pages.highlight(word.range)
    if show {
      // The text moving on under a note open leaves the note behind: it closes.
      if !pages.isInSight(characterAt: word.range.location) {
        closeNote()
      }
      pages.show(characterAt: word.range.location)
    }
    current = index
    let place = word.place
    onWordChange(["passage": place.passage, "book": place.book, "chapter": place.chapter, "verse": place.verse, "word": place.index])
  }

  private func verseStart(_ index: Int) -> Int {
    var start = index
    while start > 0 && words[start - 1].isInVerse(of: words[index]) { start -= 1 }
    return start
  }

  // VoiceOver reads heading by heading and verse by verse, each in its own language, with actions
  // to move through the words and to open the notes; a note open comes first.
  override var accessibilityElements: [Any]? {
    get { noteView.isHidden ? [pages] : [noteView, pages] }
    set {}
  }
}

/// A note's mark in the reader's text: in which paragraph, and where in the text.
private struct ReaderNote {
  let paragraph: Int
  let note: NoteMark
  let range: NSRange
}

/// A word of the reader's text: where it stands in the scripture, and where it is in the text.
private struct ReaderWord {
  let place: WordPlace
  let range: NSRange

  func isInVerse(of other: ReaderWord) -> Bool {
    let (place, other) = (place, other.place)
    return place.passage == other.passage && place.book == other.book && place.chapter == other.chapter && place.verse == other.verse
  }
}

/// Where a word stands: in which passage, in which book – the passage's, or one read along with it –
/// and where in the scripture.
struct WordPlace: Hashable {
  let passage: UInt32
  let book: String
  let chapter: UInt32
  let verse: UInt32
  let index: UInt32
}

/// A paragraph as the core made it, sized and colored for the reader.
private struct Paragraph {
  struct Run {
    let text: String
    let role: String?
    let color: UIColor?
  }

  let passage: UInt32
  let book: String
  /// Where it stands, read along with other books: see the core's Block.
  let row: UInt32
  let column: UInt32
  /// "heading", "text" or "verse": see the core's Block.
  let kind: String
  let rightToLeft: Bool
  let language: String
  let fontFamily: String?
  let fontSize: Double
  let runs: [Run]
  let verses: [VerseRange]
  let words: [Word]
  let notes: [NoteMark]
  let dropCap: DropCap?

  init(_ block: Block, colors: ReaderColors, fontSize: Double) {
    passage = block.passage
    book = block.book
    row = block.row
    column = block.column
    kind = block.kind
    rightToLeft = block.direction == "rtl"
    language = block.language
    fontFamily = block.fontFamily
    self.fontSize = fontSize
    runs = block.segments.map { Run(text: $0.text, role: $0.role, color: $0.role.flatMap { colors.roles[$0] }) }
    verses = block.verses
    words = block.words
    notes = block.notes
    dropCap = block.dropCap
  }

  /// A verse line whose number comes first, followed by a tab: the number hangs before the text.
  var numberHangs: Bool { kind == "verse" && runs.first?.text.hasSuffix("\t") == true }

  /// What VoiceOver reads of it, laid out at `range`: the heading, or each verse, with the marks in
  /// it – the paragraph's notes count on from `firstMark` in the reader's.
  func readables(at range: NSRange, firstWord: Int, firstMark: Int) -> [Readable] {
    if kind == "heading" {
      return [Readable(range: range, language: language, passage: passage, book: book, chapter: 0, verse: nil, firstWord: firstWord, marks: [])]
    }
    // Verses and words both run in the text's order: each verse's first word is found walking on.
    var word = 0
    return verses.map { verse in
      while word < words.count && words[word].start < verse.start { word += 1 }
      let marks = notes.enumerated().filter { verse.start <= $0.element.start && $0.element.end <= verse.end }.map { offset, note in
        Readable.Mark(index: firstMark + offset, range: NSRange(location: range.location + Int(note.start), length: Int(note.end - note.start)), note: note)
      }
      return Readable(range: NSRange(location: range.location + Int(verse.start), length: Int(verse.end - verse.start)),
                      language: language, passage: passage, book: book, chapter: verse.chapter, verse: verse.verse, firstWord: firstWord + word, marks: marks)
    }
  }
}

/// A heading or a verse for VoiceOver: where it is in the text, in which language, where it stands
/// in the scripture – a heading in the chapter it opens – its first word, and the notes' marks in it.
private struct Readable {
  /// A note's mark in a verse: its index in the reader's marks, its range in the text, and the note.
  struct Mark {
    let index: Int
    let range: NSRange
    let note: NoteMark
  }

  let range: NSRange
  let language: String
  let passage: UInt32
  let book: String
  var chapter: UInt32
  let verse: UInt32?
  let firstWord: Int
  let marks: [Mark]

  /// Each heading takes the chapter of the next verse of its book.
  static func namingChapters(_ readables: [Readable]) -> [Readable] {
    var named = readables
    var next: [String: UInt32] = [:]
    for index in named.indices.reversed() {
      let key = "\(named[index].passage) \(named[index].book)"
      if named[index].verse == nil {
        named[index].chapter = next[key] ?? named[index].chapter
      } else {
        next[key] = named[index].chapter
      }
    }
    return named
  }
}

/// A heading or a verse as VoiceOver reads it, in its own language, wherever it is laid out. As
/// VoiceOver comes to it, the reader turns to it.
private final class ReadableElement: UIAccessibilityElement {
  let readable: Readable
  private weak var reader: ReaderView?
  private weak var pages: PagedText?

  init(reader: ReaderView, pages: PagedText, readable: Readable) {
    self.readable = readable
    self.reader = reader
    self.pages = pages
    super.init(accessibilityContainer: pages)
    accessibilityLanguage = readable.language
    accessibilityTraits = readable.verse == nil ? .header : .staticText
  }

  override var accessibilityAttributedLabel: NSAttributedString? {
    get {
      guard let pages else { return nil }
      var text = (pages.text.string as NSString).substring(with: readable.range)
      // Each note's mark is announced for what it is: ", footnote 1, "; a note shown in full is
      // read as it stands.
      for mark in readable.marks.reversed() where mark.range.length == mark.note.mark.utf16.count {
        let local = NSRange(location: mark.range.location - readable.range.location, length: mark.range.length)
        text = (text as NSString).replacingCharacters(in: local, with: ", \(ReaderView.name(of: mark.note).lowercased()), ")
      }
      return NSAttributedString(string: text, attributes: [.accessibilitySpeechLanguage: readable.language])
    }
    set {}
  }

  override var accessibilityLabel: String? {
    get { accessibilityAttributedLabel?.string }
    set {}
  }

  override var accessibilityFrame: CGRect {
    get { pages.map { screenRect($0.contentRect(for: readable.range), in: $0) } ?? .zero }
    set {}
  }

  override var accessibilityCustomActions: [UIAccessibilityCustomAction]? {
    get { (reader?.moveActions(from: readable.firstWord) ?? []) + (reader?.noteActions(for: readable.marks.map(\.index), from: self) ?? []) }
    set {}
  }

  override func accessibilityElementDidBecomeFocused() {
    pages?.show(characterAt: readable.range.location)
  }
}

/// A rectangle in a view, in screen coordinates, as accessibility frames are. Not with
/// UIAccessibility.convertToScreenCoordinates: with no assistive technology running, as in a test,
/// it returned the rectangle unconverted.
private func screenRect(_ rect: CGRect, in view: UIView) -> CGRect {
  guard let window = view.window else { return .zero }
  return window.convert(view.convert(rect, to: window), to: window.screen.coordinateSpace)
}

private func milliseconds(since start: CFTimeInterval) -> Double {
  (CACurrentMediaTime() - start) * 1000
}
