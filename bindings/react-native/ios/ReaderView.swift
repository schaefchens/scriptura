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
/// a cross reference's verses it jumps to, or tells JS of. Chapters open with a drop cap. The host's
/// marks are drawn over their words, the signs of their notes standing in the text as the notes'
/// marks do; words or verses are selected by a long press and a drag, or by VoiceOver, and reported by
/// where they stand. A double tap on a word tagged with a number in a lexicon opens its entry where it
/// stands, and the numbers can stand in the text, small marks that open it too.
class ReaderView: ExpoView {
  /// Posted as the host adds or removes books: every reader shows what the library now holds.
  static let booksChanged = Notification.Name("ScripturaBooksChanged")
  /// Posted as the host adds or removes recordings: what is still to be read goes with them.
  static let recordingsChanged = Notification.Name("ScripturaRecordingsChanged")
  /// Posted as the host adds or removes marks: every reader draws what the library now holds, its
  /// layout kept.
  static let marksChanged = Notification.Name("ScripturaMarksChanged")
  /// Posted as the host adds or removes lexicons: every reader lays its text out anew, at its word, as
  /// the words that open entries change.
  static let lexiconsChanged = Notification.Name("ScripturaLexiconsChanged")

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
  /// The host's marks' notes: "sign", a sign where each mark ends, or "inline", the note in full there.
  var markNotes = "sign"
  /// How the selection is drawn: as a mark of this look would be – a pen's, marking as it goes – or,
  /// none given, in the selection's own color. See SelectionStyle.
  var selectionStyle: SelectionStyle? {
    didSet { applyMarks() }
  }
  /// How a long press and a drag select: "word", word by word, or "verse", by whole verses – and so
  /// does JS's select().
  var selectBy = "word"
  /// What the numbers of tagged words do, where a lexicon holds their entries: "entries", a double tap
  /// on a word opens its entry; "numbers", that, and each number stands in the text after its word; or
  /// "none". Only in `lexiconBooks`, by id, where given.
  var lexicon = "entries"
  var lexiconBooks: [String]?
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
  /// The words or verses selected, or none, as the selection goes; and a tap on marked words.
  let onSelectionChange = EventDispatcher()
  let onMarkTap = EventDispatcher()
  /// Where the selection shows, as it settles, for a panel of the app's own beside it; or nowhere.
  let onSelectionFrame = EventDispatcher()
  let onVerseInSight = EventDispatcher()

  private let pages = PagedText()
  private var words: [ReaderWord] = []
  /// Each word's index in `words`, by where it stands.
  private var indices: [WordPlace: Int] = [:]
  private var current: Int?
  /// The paragraphs shown, each's range in the text, their verses, and the notes' marks in them, in
  /// the text's order.
  private var paragraphs: [Paragraph] = []
  private var paragraphRanges: [NSRange] = []
  private var verses: [ReaderVerse] = []
  private var marks: [ReaderNote] = []
  /// The host's marks in the text.
  private var placedMarks: [ReaderMark] = []
  /// The width the text was last laid out for, where the hanging verse numbers of books side by side
  /// depend on it.
  private var numbersWidth: CGFloat?
  /// How the notes and the marks' notes were asked for, so the marks can be asked for anew as they
  /// change.
  private var shownNotes: Notes = .marks
  private var shownMarkNotes: MarkNotes = .sign
  private var shownLexicon: LexiconUse = .entries
  /// Where the selection showed as last reported to JS, so that only changes are.
  private var reportedFrame = ""
  /// The verse in sight as last reported to JS, so that only changes are.
  private var reportedVerse = ""
  /// The words selected – by a long press and a drag, by VoiceOver or by JS – in one passage's book;
  /// while a finger drags, the words it started from; and the selection as last reported to JS, so
  /// that only changes are.
  private var selected: Selected?
  private var anchorWords: ClosedRange<Int>?
  private var reportedSelection = ""
  /// What a pen that erases takes its look off: the mark of its look the words selected all lie in –
  /// and what it was found for, the words and the style.
  private var erasing: (key: String, mark: String?) = ("", nil)
  private let feedback = UISelectionFeedbackGenerator()
  /// The note open – an edition's, or a host's mark's – the verses its links refer to, and what
  /// VoiceOver was on when it opened; and a note to open once its mark has scrolled into sight.
  private let noteView = NoteView()
  private var openNote: ReaderNote?
  private var pendingNote: (note: ReaderNote, from: Any?)?
  private var openLinks: [Target] = []
  private var openedFrom: Any?
  /// The last tap on a word: which, and when – a second on it soon after opens its lexicon entry.
  private var lastTap: (word: Int, time: CFTimeInterval)?
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
    pages.onTapElsewhere = { [weak self] in
      self?.closeNote()
      self?.setSelected(nil)
    }
    pages.onLongPress = { [weak self] index in self?.beginSelection(atCharacter: index) }
    pages.onDrag = { [weak self] index in self?.extendSelection(toCharacter: index) }
    pages.onRelease = { [weak self] in self?.endSelection() }
    pages.onSettled = { [weak self] in self?.openPendingNote() }
    pages.onMove = { [weak self] _ in self?.reportFrame() }
    pages.onShown = { [weak self] in
      self?.reportFrame()
      self?.reportVerse()
    }
    pages.onScrolled = { [weak self] in self?.reportVerse() }
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
      center.addObserver(forName: Self.marksChanged, object: nil, queue: .main) { [weak self] _ in
        self?.refreshMarks()
      },
      center.addObserver(forName: Self.lexiconsChanged, object: nil, queue: .main) { [weak self] _ in
        // Reading aloud goes on: no word is spoken otherwise.
        self?.render()
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
    // Books side by side hang their verse numbers by the width of their columns.
    if let numbersWidth, numbersWidth != bounds.width {
      render()
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
    // along – keep the reader at the word it was at, the word it marked and the words selected: the
    // text may change, its words don't.
    let staying = references == shownReferences
    let kept = staying ? words : []
    // At the very start, before the first word, it stays there, its heading in sight.
    let anchorAt = pages.anchor > 0 ? kept.firstIndex { NSMaxRange($0.range) > pages.anchor } : nil
    let marked = staying ? current.map { words[$0].place } : nil
    let selectedPlaces = staying ? selected.map { (words[$0.words.lowerBound].place, words[$0.words.upperBound].place) } : nil
    anchorWords = nil
    if !staying {
      readAloud.stop()
    }
    shownReferences = references
    shownNotes = notes == "none" ? .none : notes == "inline" ? .inline : .marks
    shownMarkNotes = markNotes == "inline" ? .inline : .sign
    shownLexicon = lexicon == "none" ? .none : lexicon == "numbers" ? .numbers : .entries
    let blocks = readerBlocks(references: references, options: shownOptions())
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
    verses = []
    current = nil
    self.paragraphs = paragraphs
    let numberColumns = numberColumnWidths(paragraphs, sideBySide: sideBySide, along: along)
    numbersWidth = sideBySide && paragraphs.contains { $0.numberHangs && along.contains($0.passage) } ? bounds.width : nil
    for (index, paragraph) in paragraphs.enumerated() {
      let font = font(of: paragraph)
      let next = index + 1 < paragraphs.count ? paragraphs[index + 1] : nil
      let numberColumn = numberColumns[Self.numberColumn(of: paragraph, sideBySide: sideBySide, along: along)] ?? 0
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
        ReaderNote(paragraph: index, range: NSRange(location: start + Int(note.start), length: Int(note.end - note.start)), runs: note.runs,
                   label: Self.name(of: note), kind: note.kind, mark: note.mark, id: note.id, chapter: note.chapter, verse: note.verse, word: note.word)
      }
      readables += paragraph.readables(at: range, firstWord: words.count, firstMark: firstMark)
      let firstWord = words.count
      words += paragraph.words.map { word in
        ReaderWord(place: WordPlace(passage: paragraph.passage, book: paragraph.book, chapter: word.chapter, verse: word.verse, index: word.index),
                   range: NSRange(location: start + Int(word.start), length: Int(word.end - word.start)), paragraph: index, entry: word.entry)
      }
      verses += paragraph.verses.map { verse in
        let inVerse = paragraph.words.indices.filter { verse.start <= paragraph.words[$0].start && paragraph.words[$0].start < verse.end }
        return ReaderVerse(range: NSRange(location: start + Int(verse.start), length: Int(verse.end - verse.start)),
                           words: inVerse.first.map { (firstWord + $0)...(firstWord + inVerse.last!) })
      }
      if let dropCap = paragraph.dropCap, let spec = dropCapSpec(dropCap, of: paragraph, at: range, in: text, font: font) {
        dropCapSpecs.append(spec)
      }
      paragraphRanges.append(range)
      if index < paragraphs.count - 1 {
        text.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style]))
      }
    }
    self.paragraphRanges = paragraphRanges
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
    // The words selected, if they are still there; JS hears if they aren't.
    selected = selectedPlaces.flatMap { places in
      indices[places.0].flatMap { first in
        indices[places.1].flatMap { last in first <= last ? Selected(words: first...last, passage: places.0.passage, book: places.0.book) : nil }
      }
    }
    placedMarks = placedMarks(from: paragraphs.map(\.marks))
    applyMarks()
    reportSelection()
    // Where the selection now shows, JS hears once the new layout is in use.
    if selected == nil {
      reportFrame()
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

  /// The host's marks, placed in the paragraphs by the core, as they stand in the text: their colors
  /// by the names they give, from the palette, or as the colors they are.
  private func placedMarks(from marks: [[PlacedMark]]) -> [ReaderMark] {
    zip(marks, paragraphRanges).enumerated().flatMap { index, placed in
      placed.0.map { mark in
        ReaderMark(id: mark.id, paragraph: index, range: NSRange(location: placed.1.location + Int(mark.start), length: Int(mark.end - mark.start)),
                   fill: mark.highlight.flatMap { Self.color($0, in: colors.marks, or: Self.markFills) },
                   line: mark.underline.flatMap { Self.color($0, in: colors.markLines, or: Self.markLines) })
      }
    }
  }

  /// A mark's color: the app's, by the name the mark gives, or the light palette's, or the name
  /// itself, as a color.
  private static func color(_ name: String, in named: [String: UIColor], or defaults: [String: UIColor]) -> UIColor? {
    named[name] ?? defaults[name] ?? UIColor(hex: name)
  }

  /// The colors marks name, as the light palette has them, for an app that gives none: their fills,
  /// and their lines.
  private static let markFills = colors(["yellow": "#FFEDB6", "green": "#B9EABB", "blue": "#B8DFFF", "pink": "#FFD4E2"])
  private static let markLines = colors(["yellow": "#F9A825", "green": "#2E7D32", "blue": "#1565C0", "pink": "#AD1457"])

  private static func colors(_ hex: [String: String]) -> [String: UIColor] {
    hex.compactMapValues { UIColor(hex: $0) }
  }

  /// How the core is asked for the paragraphs, as last shown: their notes, the marks' notes, and what the
  /// words' numbers do, in which books.
  private func shownOptions() -> ReaderOptions {
    ReaderOptions(fontSize: fontSize, versePerLine: versePerLine, companions: companions, notes: shownNotes, dropCaps: dropCaps,
                  markNotes: shownMarkNotes, lexicon: shownLexicon, lexiconBooks: lexiconBooks)
  }

  /// Draws the host's marks anew as they change: the same paragraphs, their marks asked for again,
  /// the layout kept – unless the signs of their notes changed, which stand in the text: then the
  /// text is laid out anew, the reader staying at its word, the selection kept.
  private func refreshMarks() {
    guard !paragraphs.isEmpty else { return }
    let placed = readerMarks(references: shownReferences, options: shownOptions())
    let signed = placed.count == paragraphs.count && zip(placed, paragraphs).allSatisfy { $0.signs == $1.notes.filter { $0.kind == Self.signKind } }
    guard signed else { return render() }
    placedMarks = placedMarks(from: placed.map(\.marks))
    applyMarks()
  }

  /// Draws the marks and the selection over the text: the selection in its color, or – given a
  /// selection style – over the marks as the words would look marked so; or, as a pen erases them, as
  /// they will look: the mark cut around them, what is left of its look on them.
  private func applyMarks() {
    var selection = selected.map(textRanges(of:)) ?? []
    let erased = erasedMark()
    var decorations = placedMarks.flatMap { mark -> [PagedText.Decoration] in
      let over = selection.first { NSIntersectionRange($0, mark.range).length > 0 }
      guard mark.id == erased, let over, let selected, let selectionStyle else {
        return [PagedText.Decoration(range: mark.range, fill: mark.fill, line: mark.line)]
      }
      return cut(mark, over: over, selected: selected, style: selectionStyle)
    }
    if let style = selectionStyle, style.highlight != nil || style.underline != nil {
      let fill = style.highlight.flatMap { Self.color($0, in: colors.marks, or: Self.markFills) }
      let line = style.underline.flatMap { Self.color($0, in: colors.markLines, or: Self.markLines) }
      if erased == nil {
        decorations += selection.map { PagedText.Decoration(range: $0, fill: fill, line: line) }
      }
      selection = []
    }
    pages.decorate(decorations, selection: selection, color: colors.selection.withAlphaComponent(0.4))
  }

  /// A mark a pen erases words of, as it will be: in its look before and after them, over them in
  /// what is left of it – `over` where they are in the mark's paragraph.
  private func cut(_ mark: ReaderMark, over: NSRange, selected: Selected, style: SelectionStyle) -> [PagedText.Decoration] {
    let inMark = { (word: ReaderWord) in mark.range.location <= word.range.location && NSMaxRange(word.range) <= NSMaxRange(mark.range) }
    let before = words[..<selected.words.lowerBound].last(where: selected.holds).flatMap { inMark($0) ? $0 : nil }
    let after = words[(selected.words.upperBound + 1)...].first(where: selected.holds).flatMap { inMark($0) ? $0 : nil }
    let (fill, line) = (style.highlight == nil ? mark.fill : nil, style.underline == nil ? mark.line : nil)
    var parts: [PagedText.Decoration] = []
    if let before {
      parts.append(PagedText.Decoration(range: NSRange(location: mark.range.location, length: NSMaxRange(before.range) - mark.range.location),
                                        fill: mark.fill, line: mark.line))
    }
    if fill != nil || line != nil {
      parts.append(PagedText.Decoration(range: NSIntersectionRange(mark.range, over), fill: fill, line: line))
    }
    if let after {
      parts.append(PagedText.Decoration(range: NSRange(location: after.range.location, length: NSMaxRange(mark.range) - after.range.location),
                                        fill: mark.fill, line: mark.line))
    }
    return parts
  }

  /// What the selection erases: the mark its words all lie in, of the pen's look, by place, as the
  /// pen finds it. Found anew only as the words or the style change: the pen changes the marks as it
  /// lets go, and the selection stays until it is done.
  private func erasedMark() -> String? {
    guard let selected, let style = selectionStyle, style.erases, style.highlight != nil || style.underline != nil else {
      erasing = ("", nil)
      return nil
    }
    let (from, to) = ends(of: selected)
    let key = "\(selected.passage) \(selected.book) \(from) \(to) \(style)"
    guard key != erasing.key else { return erasing.mark }
    // A whole verse starts before its first word and ends after its last.
    let start = { (end: MarkEnd) in (end.chapter, end.verse, end.word.map { Int64($0) } ?? -1) }
    let finish = { (end: MarkEnd) in (end.chapter, end.verse, end.word.map { Int64($0) } ?? .max) }
    let mark = ScripturaReactNative.marks().first { mark in
      mark.book == selected.book && start(mark.from) <= start(from) && finish(to) <= finish(mark.to)
        && (style.highlight == nil || mark.highlight == style.highlight) && (style.underline == nil || mark.underline == style.underline)
    }
    erasing = (key, mark?.id)
    return erasing.mark
  }

  /// The kind of a note's mark that is the sign of a host's mark's note.
  private static let signKind = "mark"

  /// Whether a verse VoiceOver reads has marks on it.
  fileprivate func isMarked(_ readable: Readable) -> Bool {
    readable.verse != nil && placedMarks.contains { NSIntersectionRange($0.range, readable.range).length > 0 }
  }

  /// Where the words selected are in the text: per paragraph of their book, from its first word
  /// selected to its last – in books read along inline, not over the other books' verses between.
  private func textRanges(of selected: Selected) -> [NSRange] {
    var ranges: [NSRange] = []
    var paragraph = -1
    for index in selected.words where selected.holds(words[index]) {
      let word = words[index]
      if word.paragraph == paragraph, let last = ranges.last {
        ranges[ranges.count - 1] = NSUnionRange(last, word.range)
      } else {
        paragraph = word.paragraph
        ranges.append(word.range)
      }
    }
    return ranges
  }

  /// The words of `span` in the passage and book of the word at `start`, from the first of them to the
  /// last: a selection stays in the book it started in, the books read along between left out.
  private func selection(_ span: ClosedRange<Int>, of start: Int) -> Selected {
    let place = words[start].place
    let book = Selected(words: start...start, passage: place.passage, book: place.book)
    let first = span.first { book.holds(words[$0]) } ?? start
    let last = span.last { book.holds(words[$0]) } ?? start
    return Selected(words: first...last, passage: place.passage, book: place.book)
  }

  /// The word at a character of the text, if one holds it.
  private func word(atCharacter offset: Int) -> Int? {
    var (low, high) = (0, words.count)
    while low < high {
      let middle = (low + high) / 2
      if words[middle].range.location <= offset { low = middle + 1 } else { high = middle }
    }
    guard low > 0, offset <= NSMaxRange(words[low - 1].range) else { return nil }
    return low - 1
  }

  /// The words a finger is on: the word under it – selecting verses, its verse – or the verse whose
  /// number it is on.
  private func wordsUnder(_ offset: Int?) -> ClosedRange<Int>? {
    guard let offset else { return nil }
    if let index = word(atCharacter: offset) {
      return selectBy == "verse" ? wholeVerses(index...index) : index...index
    }
    return verses.first { NSLocationInRange(offset, $0.range) }?.words.map(wholeVerses)
  }

  /// The words of the verses of a span's first and last words: from the first word of the one to the
  /// last of the other, in however many paragraphs they stand.
  private func wholeVerses(_ span: ClosedRange<Int>) -> ClosedRange<Int> {
    var (first, last) = (span.lowerBound, span.upperBound)
    while first > 0, words[first - 1].isInVerse(of: words[span.lowerBound]) { first -= 1 }
    while last < words.count - 1, words[last + 1].isInVerse(of: words[span.upperBound]) { last += 1 }
    return first...last
  }

  /// A long press starts a selection: the word under the finger, or the verse whose number it is on.
  /// The word marked, and reading aloud, stay as they are.
  private func beginSelection(atCharacter offset: Int?) {
    guard let anchor = wordsUnder(offset) else { return anchorWords = nil }
    closeNote()
    anchorWords = anchor
    feedback.selectionChanged()
    setSelected(selection(anchor, of: anchor.lowerBound), report: false)
  }

  /// The finger, still down, extends the selection to the word under it, in either direction –
  /// within the passage and book it started in. Over a verse's number, or beside the words, it stays
  /// as it was: only a long press selects a verse by its number. Selecting verses, it takes in the
  /// verse of the word, or the verse whose number it is on.
  private func extendSelection(toCharacter offset: Int?) {
    guard let anchor = anchorWords, let offset else { return }
    let focus = selectBy == "verse" ? wordsUnder(offset) : word(atCharacter: offset).map { $0...$0 }
    guard let focus else { return }
    let span = min(anchor.lowerBound, focus.lowerBound)...max(anchor.upperBound, focus.upperBound)
    setSelected(selection(span, of: anchor.lowerBound), report: false)
  }

  /// The finger lifts: JS hears what is selected, and where it shows.
  private func endSelection() {
    guard anchorWords != nil else { return }
    anchorWords = nil
    reportSelection()
    reportFrame()
  }

  /// Selects words or verses as JS asks – from a word, or a verse's first, to a word, or a verse's
  /// last; selecting verses, the whole verses – and brings them into sight, unless some of them are;
  /// or nothing.
  func select(_ selection: SelectionRecord?) {
    guard let selection else { return setSelected(nil) }
    let inBook = { (word: ReaderWord) in word.place.passage == UInt32(selection.passage) && word.place.book == selection.book }
    let from = (UInt32(selection.from.chapter), UInt32(selection.from.verse), selection.from.word.map(UInt32.init) ?? 0)
    let to = (UInt32(selection.to.chapter), UInt32(selection.to.verse), selection.to.word.map(UInt32.init) ?? UInt32.max)
    let key = { (word: ReaderWord) in (word.place.chapter, word.place.verse, word.place.index) }
    guard let first = words.firstIndex(where: { inBook($0) && key($0) >= from }),
          let last = words.lastIndex(where: { inBook($0) && key($0) <= to }), first <= last
    else { return setSelected(nil) }
    let chosen = Selected(words: selectBy == "verse" ? wholeVerses(first...last) : first...last, passage: UInt32(selection.passage), book: selection.book)
    setSelected(chosen)
    if !textRanges(of: chosen).contains(where: pages.isInSight(range:)) {
      pages.show(characterAt: words[chosen.words.lowerBound].range.location)
    }
  }

  /// VoiceOver's actions on a verse: selecting it, and extending the selection to it – within the
  /// book the selection is in, the books read along between left out.
  fileprivate func selectionActions(for readable: Readable) -> [UIAccessibilityCustomAction] {
    guard let verseWords = verses.first(where: { $0.range == readable.range })?.words.map(wholeVerses) else { return [] }
    return [
      UIAccessibilityCustomAction(name: "Select verse") { [weak self] _ in
        guard let self else { return false }
        setSelected(selection(verseWords, of: verseWords.lowerBound))
        return true
      },
      UIAccessibilityCustomAction(name: "Extend selection to this verse") { [weak self] _ in
        guard let self else { return false }
        let selected = self.selected?.words ?? verseWords
        let span = min(selected.lowerBound, verseWords.lowerBound)...max(selected.upperBound, verseWords.upperBound)
        setSelected(selection(span, of: selected.lowerBound))
        return true
      },
    ]
  }

  /// Draws the words selected, or none, and – unless a finger is still choosing them – tells JS; and
  /// where they show, or that they show nowhere while a finger chooses them.
  private func setSelected(_ selected: Selected?, report: Bool = true) {
    self.selected = selected
    applyMarks()
    if report {
      reportSelection()
    }
    reportFrame()
  }

  /// Tells JS where the selection shows, if that changed: the part of its first line in sight and of
  /// its last, in points from the reader's top left – none while a finger chooses words or the text
  /// moves, or where none of the selection is in sight.
  private func reportFrame() {
    let frame = selectionFrame()
    let key = frame.map { "\($0.first) \($0.last)" } ?? ""
    guard key != reportedFrame else { return }
    reportedFrame = key
    guard let frame else { return onSelectionFrame(["frame": NSNull()]) }
    onSelectionFrame(["frame": ["first": Self.numbers(frame.first), "last": Self.numbers(frame.last)]])
  }

  /// Where the selection shows in sight, in this view's coordinates: the line of its first words in
  /// sight, from the first to the last of them on it, and the line of its last.
  private func selectionFrame() -> (first: CGRect, last: CGRect)? {
    guard let selected, anchorWords == nil, !pages.isMoving, !pages.isScrollingByHand else { return nil }
    let lines = pages.lineRects(for: textRanges(of: selected)).map { pages.convert($0, to: self) }.filter { $0.width > 0 && $0.intersects(bounds) }
    guard let first = lines.first, let last = lines.last else { return nil }
    // A line may come in pieces – a part's last line given twice, text of both directions: those at
    // its height, one after the other, are one.
    let line = { (rect: CGRect, pieces: [CGRect]) in
      pieces.prefix { abs($0.midY - rect.midY) < rect.height / 2 }.reduce(rect) { $0.union($1) }
    }
    return (line(first, Array(lines.dropFirst())), line(last, Array(lines.dropLast().reversed())))
  }

  /// Tells JS the verse in sight, if it changed: the verse of the first word on the page, or of the
  /// first whole line in sight.
  private func reportVerse() {
    guard let character = pages.characterShown else { return }
    var (low, high) = (0, words.count)
    while low < high {
      let middle = (low + high) / 2
      if NSMaxRange(words[middle].range) <= character { low = middle + 1 } else { high = middle }
    }
    guard low < words.count else { return }
    let place = words[low].place
    let key = "\(place.passage) \(place.book) \(place.chapter):\(place.verse)"
    guard key != reportedVerse else { return }
    reportedVerse = key
    onVerseInSight(["passage": place.passage, "book": place.book, "chapter": place.chapter, "verse": place.verse])
  }

  /// A rectangle as JS gets it: x, y, width and height, to half a point.
  private static func numbers(_ rect: CGRect) -> [Double] {
    [rect.minX, rect.minY, rect.width, rect.height].map { (Double($0) * 2).rounded() / 2 }
  }

  /// Tells JS what is selected, if that changed: the first and last words as the selection's ends –
  /// a whole verse where they are its first or last word – or none.
  private func reportSelection() {
    guard let selected else {
      if reportedSelection != "" {
        reportedSelection = ""
        onSelectionChange(["selection": NSNull()])
      }
      return
    }
    let (from, to) = ends(of: selected)
    let key = "\(selected.passage) \(selected.book) \(from) \(to)"
    guard key != reportedSelection else { return }
    reportedSelection = key
    let record = { (end: MarkEnd) -> [String: Any] in
      var record: [String: Any] = ["chapter": end.chapter, "verse": end.verse]
      if let word = end.word { record["word"] = word }
      return record
    }
    onSelectionChange(["selection": ["passage": selected.passage, "book": selected.book, "from": record(from), "to": record(to)]])
  }

  /// The ends of the words selected, as JS hears of them: the first and the last word – a whole verse
  /// where they are its first or last word.
  private func ends(of selected: Selected) -> (from: MarkEnd, to: MarkEnd) {
    let (first, last) = (words[selected.words.lowerBound], words[selected.words.upperBound])
    let next = selected.words.upperBound + 1
    let lastIsWord = next < words.count && words[next].isInVerse(of: last)
    return (MarkEnd(chapter: first.place.chapter, verse: first.place.verse, word: first.place.index == 0 ? nil : first.place.index),
            MarkEnd(chapter: last.place.chapter, verse: last.place.verse, word: lastIsWord ? last.place.index : nil))
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

  /// How far the text of verse lines starts, past the widest verse number before it: by the column
  /// of books side by side – each book its own, and in a column narrow for its numbers, at most a
  /// quarter of it, so its lines keep room for their words – and for the text that flows, of `-1`.
  private func numberColumnWidths(_ paragraphs: [Paragraph], sideBySide: Bool, along: Set<UInt32>) -> [Int: CGFloat] {
    var widths: [String: CGFloat] = [:]
    var widest: [Int: CGFloat] = [:]
    for paragraph in paragraphs where paragraph.numberHangs {
      let number = paragraph.runs[0].text.trimmingCharacters(in: .whitespaces)
      let font = font(of: paragraph)
      let key = "\(font.fontName) \(font.pointSize) \(number)"
      let width = widths[key] ?? (number as NSString).size(withAttributes: [.font: font]).width
      widths[key] = width
      let column = Self.numberColumn(of: paragraph, sideBySide: sideBySide, along: along)
      widest[column] = max(widest[column] ?? 0, width + paragraph.fontSize * 0.4)
    }
    // As wide as the reader lays the columns of books side by side out.
    let columns = CGFloat((paragraphs.filter { along.contains($0.passage) }.map(\.column).max() ?? 0) + 1)
    let gap = max(margin, 16)
    let cell = (bounds.width - 2 * margin - (columns - 1) * gap) / columns
    return Dictionary(uniqueKeysWithValues: widest.map { column, width in
      (column, (column >= 0 && bounds.width > 0 ? min(width, cell / 4) : width).rounded(.up))
    })
  }

  /// The column whose verse numbers a paragraph's hang by: its book's, side by side, or else `-1`, the
  /// text that flows.
  private static func numberColumn(of paragraph: Paragraph, sideBySide: Bool, along: Set<UInt32>) -> Int {
    sideBySide && along.contains(paragraph.passage) ? Int(paragraph.column) : -1
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
      UIAccessibilityCustomAction(name: marks[index].label) { [weak self] _ in
        guard let self else { return false }
        openNote(marks[index], from: element)
        return true
      }
    }
  }

  /// A note as VoiceOver names it: "Footnote 1", "Cross reference a" – the sign of a host's mark's
  /// note as "Note", a word's number as "Lexicon entry 1961".
  fileprivate static func name(of note: NoteMark) -> String {
    guard note.kind != signKind else { return "Note" }
    let kind = ["footnote": "Footnote", "endnote": "Endnote", "crossReference": "Cross reference", entryKind: entryName][note.kind] ?? "Note"
    return "\(kind) \(note.mark)"
  }

  /// The kind of a note's mark that is a word's number, and what an entry is called where it opens.
  fileprivate static let entryKind = "entry"
  fileprivate static let entryName = "Lexicon entry"

  /// The words of a verse VoiceOver is on, by their indices in the reader's words; none for a heading.
  private func verseWords(of readable: Readable) -> ClosedRange<Int>? {
    readable.verse == nil ? nil : verses.first { $0.range == readable.range }?.words
  }

  /// Whether a verse VoiceOver is on has words that open lexicon entries.
  fileprivate func hasEntries(_ readable: Readable) -> Bool {
    verseWords(of: readable).map { $0.contains { words[$0].entry } } ?? false
  }

  /// VoiceOver's action opening a lexicon entry from a verse: of the word the reader marked, if it is in
  /// that verse and has one, or else of the verse's first word that has one.
  fileprivate func entryActions(for readable: Readable, from element: Any) -> [UIAccessibilityCustomAction] {
    guard let inVerse = verseWords(of: readable), inVerse.contains(where: { words[$0].entry }) else { return [] }
    return [
      UIAccessibilityCustomAction(name: Self.entryName) { [weak self] _ in
        guard let self else { return false }
        let words = self.words
        let index = current.flatMap { inVerse.contains($0) && words[$0].entry ? $0 : nil } ?? inVerse.first { words[$0].entry }
        guard let index else { return false }
        openEntry(index, from: element)
        return true
      },
    ]
  }

  /// Opens a word's lexicon entry where the word stands, as a double tap on it does.
  private func openEntry(_ index: Int, from element: Any? = nil) {
    let word = words[index]
    openNote(ReaderNote(paragraph: word.paragraph, range: word.range, runs: [], label: Self.entryName, kind: Self.entryKind, mark: "", id: nil,
                        chapter: word.place.chapter, verse: word.place.verse, word: word.place.index), from: element)
  }

  /// The headings and verses VoiceOver finds in sight, and the notes' marks – the signs of the host's
  /// marks' notes by their marks' ids: where they stand and where they are, in this view's points, but
  /// not their text, which JS never gets.
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
      if isMarked(element.readable) {
        found["marked"] = true
      }
      if hasEntries(element.readable) {
        found["entries"] = true
      }
      return found
    }
    let notes: [[String: Any]] = marks.compactMap { (mark: ReaderNote) -> [String: Any]? in
      guard let rect = pages.rect(for: mark.range) else { return nil }
      let shown = screenRect(rect, in: pages)
      guard shown.intersects(sight) else { return nil }
      let paragraph = paragraphs[mark.paragraph]
      var found: [String: Any] = [
        "passage": paragraph.passage, "book": paragraph.book, "chapter": mark.chapter, "verse": mark.verse,
        "kind": mark.kind, "language": paragraph.language, "frame": frame(shown),
      ]
      if mark.kind == Self.signKind {
        found["mark"] = mark.id
      } else {
        found["note"] = mark.mark
      }
      return found
    }
    return readables + notes
  }

  /// Opens a note – a footnote's text, a cross reference's verses, a host's mark's note – where its
  /// mark stands, and tells VoiceOver; `from` is what VoiceOver was on. The mark is brought into sight
  /// first.
  fileprivate func openNote(_ mark: ReaderNote, from element: Any? = nil) {
    closeNote()
    // Out of sight – as from a VoiceOver action on a verse further on – it opens once it is in sight.
    guard pages.isInSight(characterAt: mark.range.location), let rect = pages.rect(for: mark.range) else {
      pendingNote = (mark, element)
      pages.show(characterAt: mark.range.location)
      return
    }
    let paragraph = paragraphs[mark.paragraph]
    var links: [Target] = []
    let size = max(14, paragraph.fontSize * 0.7)
    let text: NSAttributedString
    if mark.kind == Self.entryKind {
      // A word's entry, from the core: in its lexicon's language and direction, in the reader's font for it.
      guard let word = mark.word, let entry = readerEntry(book: paragraph.book, chapter: mark.chapter, verse: mark.verse, word: word) else { return }
      text = noteText(entry.runs, family: fonts[entry.language], size: size, rightToLeft: entry.direction == "rtl", links: &links)
    } else {
      text = noteText(mark.runs, family: paragraph.fontFamily ?? fonts[paragraph.language], size: size, rightToLeft: paragraph.rightToLeft, links: &links)
    }
    openNote = mark
    openLinks = links
    openedFrom = element
    let area = bounds.insetBy(dx: margin, dy: 12)
    noteView.show(text, at: convert(rect, from: pages), in: area, maxWidth: 360, maxHeight: (bounds.height * 0.45).rounded(),
                  background: colors.background, border: colors.text.withAlphaComponent(0.25), linkColor: colors.roles["note"] ?? colors.text)
    UIAccessibility.post(notification: .screenChanged, argument: noteView.textView)
  }

  /// Opens the note that waited for its mark to come into sight.
  private func openPendingNote() {
    guard let (note, element) = pendingNote, pages.isInSight(characterAt: note.range.location) else { return }
    pendingNote = nil
    openNote(note, from: element)
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

  /// A note's runs as text in a font – a note's, its paragraph's, a little smaller; an entry's, the
  /// reader's for its lexicon's language – in its direction: the verse it names in its color,
  /// quotations and emphasis in italics, strong words in bold, words in other languages in their fonts,
  /// and the verses it refers to as links, numbered in `links`.
  private func noteText(_ runs: [NoteRun], family: String?, size: Double, rightToLeft: Bool, links: inout [Target]) -> NSAttributedString {
    let font = font(family: family, size: size)
    let style = NSMutableParagraphStyle()
    style.baseWritingDirection = rightToLeft ? .rightToLeft : .leftToRight
    style.alignment = .natural
    let text = NSMutableAttributedString()
    // The verses a note refers to stand in paragraphs of their own, each in the direction of its
    // first letter: an Arabic verse under an English note runs from the right.
    let natural = NSMutableParagraphStyle()
    natural.baseWritingDirection = .natural
    natural.alignment = .natural
    for run in runs {
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
      if run.role == "strong", let runFont = attributes[.font] as? UIFont {
        // The font's own bold, if it has one; else its strokes drawn thicker.
        if let bold = runFont.fontDescriptor.withSymbolicTraits(.traitBold), UIFont(descriptor: bold, size: size).familyName == runFont.familyName {
          attributes[.font] = UIFont(descriptor: bold, size: size)
        } else {
          attributes[.strokeWidth] = -3.0
          attributes[.strokeColor] = attributes[.foregroundColor]
        }
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
    followReference(openLinks[index], from: open)
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
      "from": ["passage": paragraph.passage, "book": paragraph.book, "chapter": mark.chapter, "verse": mark.verse],
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

  /// How soon after a tap on a word a second one opens its lexicon entry, in seconds.
  private static let doubleTap = 0.35

  /// A tap on a note's mark opens the note, or closes it if it is the one open – a word's number, its
  /// entry; a tap on a word selects it, and names the marks on it to JS, and a second soon after opens
  /// its lexicon entry. The first tap after a selection only ends it.
  private func selectWord(atCharacter offset: Int) {
    if selected != nil {
      closeNote()
      return setSelected(nil)
    }
    // Where a word's number starts, the word ends: a tap there is the word's.
    let onMark = { (mark: ReaderNote) in
      mark.range.location <= offset && offset <= NSMaxRange(mark.range)
        && !(mark.kind == Self.entryKind && offset == mark.range.location && self.word(atCharacter: offset) != nil)
    }
    if let note = marks.first(where: onMark) {
      openNote?.range == note.range ? closeNote() : openNote(note)
      return
    }
    closeNote()
    guard let index = word(atCharacter: offset) else { return }
    // A second tap on the word soon after the first opens its entry, if it has one; the first reached it at once.
    let now = CACurrentMediaTime()
    let again = lastTap.map { $0.word == index && now - $0.time < Self.doubleTap } ?? false
    lastTap = again ? nil : (index, now)
    if again, words[index].entry {
      return openEntry(index)
    }
    select(index)
    let word = words[index]
    let ids = placedMarks.filter { $0.range.location <= word.range.location && NSMaxRange(word.range) <= NSMaxRange($0.range) }.map(\.id)
    if !ids.isEmpty {
      let place = word.place
      onMarkTap(["ids": ids, "passage": place.passage, "book": place.book, "chapter": place.chapter, "verse": place.verse, "word": place.index])
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

/// A note's mark in the reader's text – an edition's, or the sign of a host's mark's note: in which
/// paragraph, where in the text, the note's runs, what VoiceOver calls it, its kind, its mark, the
/// host's mark's id for a sign, and the verse it stands in.
private struct ReaderNote {
  let paragraph: Int
  let range: NSRange
  let runs: [NoteRun]
  let label: String
  let kind: String
  let mark: String
  let id: String?
  let chapter: UInt32
  let verse: UInt32
  /// For a word's number, or its entry opened at it: the word, by its index in the verse.
  let word: UInt32?
}

/// A host's mark in the reader's text: in which paragraph, where in the text – its words – and how it
/// is drawn.
private struct ReaderMark {
  let id: String
  let paragraph: Int
  let range: NSRange
  let fill: UIColor?
  let line: UIColor?
}

/// A verse of the reader's text: where it is, its number included, and its words – none for a verse
/// without any.
private struct ReaderVerse {
  let range: NSRange
  let words: ClosedRange<Int>?
}

/// How the selection is drawn, given a mark's look – a highlight and an underline, by the names or
/// colors a mark gives: as words marked so would look, for a pen that marks as it goes. A pen that
/// erases too takes its look off words that all lie in one mark of it, by place: those look as they
/// will then.
struct SelectionStyle: Equatable {
  let highlight: String?
  let underline: String?
  let erases: Bool
}

/// Words selected, of one passage's book: from the first to the last, by their index in the reader's
/// words, which in books read along inline enclose the other books' words between.
private struct Selected {
  let words: ClosedRange<Int>
  let passage: UInt32
  let book: String

  func holds(_ word: ReaderWord) -> Bool {
    word.place.passage == passage && word.place.book == book
  }
}

/// A word of the reader's text: where it stands in the scripture, where it is in the text, in which
/// paragraph, and whether it opens a lexicon entry.
private struct ReaderWord {
  let place: WordPlace
  let range: NSRange
  let paragraph: Int
  let entry: Bool

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
  let marks: [PlacedMark]

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
    marks = block.marks
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
      // The sign of a host's mark's note shown in full is read as what it is.
      text = text.replacingOccurrences(of: "\u{270E}", with: "note")
      let label = NSMutableAttributedString()
      // A verse with marks on it is announced as marked, before its text.
      if reader?.isMarked(readable) == true {
        label.append(NSAttributedString(string: "Marked. "))
      }
      label.append(NSAttributedString(string: text, attributes: [.accessibilitySpeechLanguage: readable.language]))
      return label
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
    get {
      guard let reader else { return [] }
      return reader.moveActions(from: readable.firstWord) + reader.noteActions(for: readable.marks.map(\.index), from: self)
        + reader.entryActions(for: readable, from: self) + reader.selectionActions(for: readable)
    }
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

private extension UIColor {
  /// A color from "#RRGGBB" or "#RRGGBBAA"; nil for anything else.
  convenience init?(hex: String) {
    var digits = Substring(hex)
    if digits.hasPrefix("#") {
      digits = digits.dropFirst()
    }
    guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
    let alpha = digits.count == 8 ? CGFloat(value & 0xFF) / 255 : 1
    let rgb = digits.count == 8 ? value >> 8 : value
    self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
  }
}
