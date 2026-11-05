package de.schaefchens.scriptura

import android.content.Context
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.AbsoluteSizeSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.LocaleSpan
import android.text.style.StyleSpan
import android.text.style.TabStopSpan
import android.text.style.TypefaceSpan
import android.util.TypedValue
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.graphics.ColorUtils
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.types.ColorCompat
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.IdentityHashMap
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt
import de.schaefchens.scriptura.core.Block
import de.schaefchens.scriptura.core.DropCap
import de.schaefchens.scriptura.core.LexiconUse
import de.schaefchens.scriptura.core.MarkEnd
import de.schaefchens.scriptura.core.MarkNotes
import de.schaefchens.scriptura.core.NoteMark
import de.schaefchens.scriptura.core.NoteRun
import de.schaefchens.scriptura.core.Notes
import de.schaefchens.scriptura.core.PlacedMark
import de.schaefchens.scriptura.core.ReaderOptions
import de.schaefchens.scriptura.core.Reference
import de.schaefchens.scriptura.core.Target
import de.schaefchens.scriptura.core.books
import de.schaefchens.scriptura.core.VerseRange
import de.schaefchens.scriptura.core.Word
import de.schaefchens.scriptura.core.WordPosition
import de.schaefchens.scriptura.core.marks as libraryMarks
import de.schaefchens.scriptura.core.readerBlocks
import de.schaefchens.scriptura.core.readerEntry
import de.schaefchens.scriptura.core.readerMarks
import java.util.WeakHashMap

/**
 * The reader: passages as paragraphs, each with its own direction, language and font, laid out as
 * one spanned string, in pages or one endless scroll. It fetches them from the core itself, from the
 * books the host added, so their text never passes through JS. A word can be tapped, reached word by
 * word or jumped to; JS learns only where the current word stands, never its text. It reads aloud –
 * chapters with recordings from them, the rest with the device's voices – from the word it is at, and
 * marks each word as it is said, keeping it in sight – unless it was scrolled away from it by hand.
 * The host's marks are drawn over their words, the signs of their notes standing in the text as notes'
 * marks; words or verses are selected by a long press and a drag, or by TalkBack, and reported by where
 * they stand. A double tap on a word tagged with a number in a lexicon opens its entry where it stands,
 * as a note opens; the numbers can stand in the text too, each a mark that opens its word's entry.
 */
class ReaderView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Without it, React Native ignores the pages' requests for a new layout.
  override val shouldUseAndroidLayout = true

  var passages: List<PassageRecord> = emptyList()
  var fontSize = 28.0
  var paging = "scroll"
  var columns = 1
  var colors = ReaderColors()
  /** For text without a font of its own: "sans" or "serif", unless [fonts] names one for its language. */
  var font = "sans"
  var fonts: Map<String, String> = emptyMap()
  var lineSpacing = 1.0
  var margin = 16.0
  var versePerLine = false
  /** Other editions of the passages' books, read along: "inline", a verse and then the same verse in each, or "columns", side by side. */
  var companions: List<String> = emptyList()
  var parallel = "inline"

  /** The books' notes in the text: "marks", each opening where it stands, "inline", shown in full there, or "none"; and chapters opening with a drop cap. */
  var notes = "marks"
  var dropCaps = true

  /** The notes of the host's marks in the text: "sign", a sign where each mark ends, which opens the note, or "inline", the note shown in full there. */
  var markNotes = "sign"

  /**
   * What tagged words' numbers do, where a lexicon holds their entries: "entries", a double tap on such a word opens its entry;
   * "numbers", that, and each number stands in the text after its word, a mark that opens the entry too; or "none". In the books of
   * [lexiconBooks], by id – every book's without.
   */
  var lexicon = "entries"
  var lexiconBooks: List<String>? = null

  /** How the selection is drawn: as a mark of this look would be – a pen's, marking as it goes – or, none given, in the selection's own color. See [SelectionStyle]. */
  var selectionStyle: SelectionStyle? = null
    set(value) {
      field = value
      applyMarks()
    }

  /** How a long press and a drag select: "word", word by word, or "verse", by whole verses – and so does JS's select(). */
  var selectBy = "word"

  /** A font family for the drop cap's letter, such as one of ornamental initials; letters it lacks are set in the text's font. */
  var dropCapFont: String? = null

  /** A voice per language for reading aloud, by name; otherwise the engine's best for it. */
  var voices: Map<String, String> = emptyMap()

  /** Read aloud, each verse is followed by the same verse in each book read along; otherwise only the passages' own books are. */
  var speakAlong = false

  /** How fast the voices read, as a multiple of their own rate: from 0.5 to 2. */
  var speechRate = 1.0

  /** The voices whose recordings are played, the first that has one for a chapter; with none named, any. */
  var recordedVoices: List<String>? = null

  /** What the system's media controls show while it reads aloud – which then goes on in the background; without it, they show nothing, and it pauses as the app goes to the background. */
  var nowPlaying: NowPlayingRecord? = null

  private val onWordChange by EventDispatcher()
  private val onLaidOut by EventDispatcher()
  private val onSpeechChange by EventDispatcher()

  /** A cross reference followed to verses the reader doesn't show: the app may. */
  private val onReference by EventDispatcher()

  /** The words or verses selected, or none, as the selection goes; and a tap on marked words. */
  private val onSelectionChange by EventDispatcher()
  private val onMarkTap by EventDispatcher()

  /**
   * Where the selection shows, as it settles, or none; and as JS last heard of it, whether the text
   * moves meanwhile, and whether it is being laid out anew, its words not yet those selected.
   */
  private val onSelectionFrame by EventDispatcher()
  private val onVerseInSight by EventDispatcher()
  private var reportedFrame = ""
  private var moving = false
  private var rendering = false
  private var renderStarted = 0L
  private var firstShown = 0.0

  /** Whether this text's layout is yet to be reported: once, as a new size lays it out again. */
  private var reportPending = false

  /** The passages the text is of: given them again, in another layout, the reader stays where it is. */
  private var shownReferences: List<Reference> = emptyList()

  private val typefaces = mutableMapOf<String, Typeface>()

  /** How tall a letter is drawn in a typeface, per pixel of the text size, by typeface and letter. */
  private val letterHeights = mutableMapOf<Pair<Typeface, String>, Double>()
  private var words: List<ReaderWord> = emptyList()

  /** Each word's index in [words], by where it stands. */
  private var indices: Map<WordPlace, Int> = emptyMap()
  private var current: Int? = null
  private val readAloud = ReadAloud(context)

  /** Whether the word the voice comes to is brought into sight: not after a scroll by hand away from it, until it is in sight again. */
  private var following = true

  /** What is read aloud along with the passages, and from which recordings; and how fast. */
  private var readAs = Triple(emptyList<String>(), false, null as List<String>?)
  private var rateAs = 1.0

  private val pages = PagedText(context)

  /** A note opened where its mark stands, over the pages. */
  private val noteView = NoteView(context)

  /** While a note is open, the Back key closes it: React Native hands a back press on to the activity's dispatcher when JS doesn't take it. */
  private val backCloses = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() = closeNote()
  }

  /** The notes' marks in the text, in its order – words' numbers among them – and the note open – a note's, a host's mark's or a word's entry – if one is. */
  private var marks: List<ReaderNote> = emptyList()
  private var opened: ReaderNote? = null

  /** The word the last tap reached: a second tap on it, a double tap, opens its lexicon entry. */
  private var tappedWord: Int? = null
  private var shownParagraphs: List<Paragraph> = emptyList()
  private var roleColors: Map<String, Int> = emptyMap()
  private var textColor = Color.BLACK
  private var backgroundColor = Color.WHITE

  /** The host's marks in the text; the signs of their notes are among the notes' marks. */
  private var placedMarks: List<ReaderMark> = emptyList()

  /** The marks' colors by the names they give: the palette's, or else the light one's. ARGB. */
  private var markFills = MARK_FILLS
  private var markLines = MARK_LINES

  /** Where each paragraph's text starts in the whole text, and the verses, in the text's order. */
  private var paragraphStarts: List<Int> = emptyList()
  private var verses: List<ReaderVerse> = emptyList()

  /** What the paragraphs were asked of the core with, so their marks can be asked for anew as they change. */
  private var shownRequest: Pair<List<Reference>, ReaderOptions>? = null

  /**
   * The words selected – by a long press and a drag, by TalkBack or by JS – from the first to the last,
   * both of one passage's book; while a finger chooses them, the words it started on; and the
   * selection as JS last heard of it, so it hears only of changes.
   */
  private var selected: IntRange? = null
  private var anchorWords: IntRange? = null
  private var reportedSelection = ""

  /** The verse in sight as JS last heard of it, so it hears only of changes. */
  private var reportedVerse = ""

  /** What a pen that erases takes its look off: the mark of its look the words selected all lie in – and what it was found for, the words and the style. */
  private var erasing: Pair<String, String?> = "" to null

  init {
    pages.onTap = ::selectWord
    pages.onDoubleTap = ::doubleTapWord
    pages.onMarkTap = { index -> marks.getOrNull(index)?.let(::openNote) }
    pages.onAccessibilityEntry = ::openEntryIn
    pages.onSelectStart = ::beginSelection
    pages.onSelectMove = ::extendSelection
    pages.onSelectEnd = ::endSelection
    pages.onAccessibilitySelect = ::selectVerse
    (appContext.currentActivity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(backCloses)
    pages.onAccessibilityMove = { step, readable -> move(step, from = readable.firstWord) }
    pages.onFirstPages = { if (reportPending && firstShown == 0.0) firstShown = millisecondsSinceRender() }
    pages.onPaginated = { count ->
      if (reportPending) {
        reportPending = false
        onLaidOut(mapOf("pages" to count, "milliseconds" to firstShown, "all" to millisecondsSinceRender()))
      }
    }
    readAloud.onWord = ::reached
    readAloud.onChange = ::speechChanged
    pages.onScrollByHand = ::scrolledByHand
    pages.onMove = {
      moving = true
      reportFrame()
    }
    pages.onRest = {
      moving = false
      reportFrame()
      reportVerse()
    }
    pages.onScrolled = ::reportVerse
    addView(pages, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // Over the pages, laid out where its mark is; it takes no room in the row.
    addView(noteView, LayoutParams(0, 0))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    super.onLayout(changed, l, t, r, b)
    if (noteView.visibility == VISIBLE) noteView.place(Rect(0, 0, r - l, b - t))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    shown.add(this)
  }

  /** Reading aloud pauses as the app goes to the background, unless the media controls may show it – and the app declares their service. */
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    val onAway = nowPlaying != null && ReadingService.declared(context)
    if (visibility != VISIBLE && !onAway && readAloud.state == "speaking") pause()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    shown.remove(this)
    backCloses.remove()
    readAloud.release()
  }

  fun render() {
    rendering = true
    renderStarted = System.nanoTime()
    reportPending = true
    firstShown = 0.0
    closeNote()
    val textColor = colors.text?.let { ColorCompat.toArgb(it) } ?: Color.BLACK
    // On its own view, as React Native keeps this view's background.
    val background = colors.background?.let { ColorCompat.toArgb(it) } ?: Color.WHITE
    this.textColor = textColor
    backgroundColor = background
    pages.highlightColor = colors.highlight?.let { ColorCompat.toArgb(it) } ?: HIGHLIGHT
    pages.selectionColor = ColorUtils.setAlphaComponent(colors.selection?.let { ColorCompat.toArgb(it) } ?: SELECTION, 102)
    markFills = MARK_FILLS + colors.marks.mapValues { ColorCompat.toArgb(it.value) }
    markLines = MARK_LINES + colors.markLines.mapValues { ColorCompat.toArgb(it.value) }
    val references = passages.map { Reference(it.book, it.chapter?.toUInt(), it.from?.toUInt(), it.to?.toUInt()) }
    // The same passages in another layout – a new font size, theme or line spacing, other books read
    // along – keep the reader at the word it was at, the word it marked and the words selected: the
    // text may change, its words don't.
    val staying = references == shownReferences
    val kept = if (staying) words else emptyList()
    // At the very start, before the first word, it stays there, its heading in sight.
    val anchorAt = if (pages.anchor > 0) kept.indexOfFirst { it.end > pages.anchor } else -1
    val marked = if (staying) current?.let { words[it].place } else null
    val selectedPlaces = if (staying) selected?.let { words[it.first].place to words[it.last].place } else null
    anchorWords = null
    if (!staying) readAloud.stop()
    shownReferences = references
    val roleColors = colors.roles.mapValues { ColorCompat.toArgb(it.value) }
    this.roleColors = roleColors
    val shownNotes = when (notes) { "none" -> Notes.NONE; "inline" -> Notes.INLINE; else -> Notes.MARKS }
    val shownMarkNotes = if (markNotes == "inline") MarkNotes.INLINE else MarkNotes.SIGN
    val shownLexicon = when (lexicon) { "none" -> LexiconUse.NONE; "numbers" -> LexiconUse.NUMBERS; else -> LexiconUse.ENTRIES }
    val options = ReaderOptions(fontSize, versePerLine, companions, shownNotes, dropCaps, shownMarkNotes, shownLexicon, lexiconBooks)
    shownRequest = references to options
    tappedWord = null
    val blocks = readerBlocks(references, options)
    val paragraphs = blocks.map { Paragraph(it, roleColors, fontSize(it)) }
    shownParagraphs = paragraphs
    // The passages read along with other books, in rows.
    val along = paragraphs.filter { it.column > 0 }.map { it.passage }.toSet()
    val sideBySide = parallel == "columns" && along.isNotEmpty()
    val readerWords = mutableListOf<ReaderWord>()
    val readerNotes = mutableListOf<ReaderNote>()
    val readables = mutableListOf<Readable>()
    val paragraphRanges = mutableListOf<Pair<Int, Int>>()
    val starts = mutableListOf<Int>()
    val readerVerses = mutableListOf<ReaderVerse>()
    val numberColumn = numberColumnWidth(paragraphs)
    // Read along inline, the other books stand indented under the passage's.
    val indent = if (numberColumn > 0) numberColumn else (pixels(fontSize) * 1.5f).roundToInt()
    val text = SpannedText().apply {
      paragraphs.forEachIndexed { index, paragraph ->
        val start = length
        append(if (paragraph.rightToLeft) RIGHT_TO_LEFT_MARK else LEFT_TO_RIGHT_MARK)
        val textStart = length
        for (run in paragraph.runs) {
          val runStart = length
          append(run.text)
          // A note's mark stands small and raised; other runs take their role's color.
          if (run.role == "note") span(MarkSpan(run.color), runStart)
          else run.color?.let { span(ForegroundColorSpan(it), runStart) }
        }
        readables += paragraph.readables(textStart, length, firstWord = readerWords.size)
        starts += textStart
        paragraph.verses(textStart, firstWord = readerWords.size).let(readerVerses::addAll)
        paragraph.words.mapTo(readerWords) { word -> ReaderWord(paragraph.passage, paragraph.book, word, textStart, index) }
        paragraph.notes.mapTo(readerNotes) { note -> ReaderNote(paragraph.passage, paragraph.book, paragraph.language, note, textStart, index) }
        paragraphRanges += start to length
        if (index < paragraphs.lastIndex) append("\n")
        val fontSize = pixels(paragraph.fontSize)
        span(AbsoluteSizeSpan(fontSize.toInt()), start)
        val next = paragraphs.getOrNull(index + 1)
        span(ParagraphSpacingSpan((fontSize * spacing(paragraph, next, paragraph.passage in along, sideBySide)).toInt()), start)
        familyOf(paragraph)?.let { span(TypefaceSpan(typeface(it)), start) }
        val indented = if (paragraph.passage in along && !sideBySide && paragraph.column > 0) indent else 0
        if (paragraph.numberHangs) {
          // The text starts at a tab past the widest number, and so do its lines after the first.
          span(LeadingMarginSpan.Standard(indented, indented + numberColumn), start)
          span(TabStopSpan.Standard(numberColumn), start)
        } else if (indented > 0) {
          span(LeadingMarginSpan.Standard(indented), start)
        }
        // TalkBack reads a paragraph with the voice of its locale.
        if (paragraph.language.isNotEmpty()) span(LocaleSpan(Locale.forLanguageTag(paragraph.language)), start)
        // The first letter set large over the first two lines, kept in the text unseen: the lines
        // leave it a margin. In a font of initials, if it has the letter, the letter fills the lines.
        paragraph.dropCap?.let { drop ->
          val own = familyOf(paragraph)?.let(::typeface) ?: baseTypeface
          val letterStart = textStart + drop.letterStart.toInt()
          val letterEnd = textStart + drop.letterEnd.toInt()
          val letter = subSequence(letterStart, letterEnd).toString()
          val ornate = dropCapFont?.let(::typeface)?.takeIf { it != Typeface.DEFAULT && TextPaint().apply { this.typeface = it }.hasGlyph(letter) }
          val metrics = TextPaint().apply { this.typeface = own; textSize = fontSize }.fontMetrics
          val line = (metrics.descent - metrics.ascent) * lineSpacing.toFloat()
          // A capital reaches from the first line's digit height to the second line's baseline.
          val height = letterHeight(if (ornate != null) letter else "0", ornate ?: own).toFloat()
          val dropSize = fontSize + line / height
          val large = TextPaint().apply { this.typeface = ornate ?: own; textSize = dropSize }
          val width = (large.measureText(letter) + 0.14f * fontSize).roundToInt()
          span(DropCapSpan(letter, ornate ?: own, dropSize, width), start)
          span(HiddenSpan(), letterStart, letterEnd)
        }
      }
    }.build()
    words = readerWords
    marks = readerNotes
    paragraphStarts = starts
    verses = readerVerses
    current = null
    val withWords = paragraphs.filter { it.words.isNotEmpty() }
    // As a TextView's.
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      density = resources.displayMetrics.density
      color = textColor
      typeface = baseTypeface
      textSize = pixels(fontSize)
    }
    val indices = HashMap<WordPlace, Int>().apply { words.forEachIndexed { index, word -> putIfAbsent(word.place, index) } }
    this.indices = indices
    // The word the reader was at – or if it is gone, as a book is no longer read along, the last
    // before it that is still there.
    val anchorWord = if (anchorAt >= 0) (anchorAt downTo 0).firstNotNullOfOrNull { indices[kept[it].place] } else null
    val anchor = anchorWord?.let { words[it].start } ?: 0
    pages.readables = namingChapters(readables)
    pages.marks = marks.mapIndexed { index, note ->
      Mark(note.start, note.end, note.passage, note.book, note.chapter, note.verse, note.mark, note.kind, note.language, index, note.id)
    }
    val rightToLeft = withWords.isNotEmpty() && withWords.all { it.rightToLeft }
    val sections = if (sideBySide) sectionsOf(paragraphs, paragraphRanges, along) else listOf(Section(0, text.length))
    val format = TextFormat(background, columns, rightToLeft, paging != "pages", paint, lineSpacing.toFloat(), pixels(margin), sections)
    pages.show(text, format, anchor)
    marked?.let(indices::get)?.let {
      current = it
      pages.highlight(words[it].start, words[it].end)
    }
    // The words selected, if they are still there; JS hears if they aren't. Then the marks.
    selected = selectedPlaces?.let { (first, last) ->
      val (from, to) = indices[first] to indices[last]
      if (from != null && to != null && from <= to) from..to else null
    }
    placedMarks = placedMarksOf(paragraphs.map { it.marks })
    applyMarks()
    reportSelection()
    // Other books read along or other recordings change what is read, and a new rate how: the voice goes on from the word it is at. A
    // recording takes a new rate as it plays.
    val read = Triple(companions, speakAlong, recordedVoices)
    val changed = read != readAs || (speechRate != rateAs && !readAloud.changeRate(speechRate))
    if (changed && readAloud.state != "stopped") {
      if (readAloud.state == "speaking") play() else readAloud.stop()
    }
    readAs = read
    rateAs = speechRate
    ReadingService.show(context, this, nowPlaying, readAloud.state)
    rendering = false
    reportFrame()
  }

  private val baseTypeface get() = if (font == "serif") Typeface.SERIF else Typeface.DEFAULT

  /**
   * The space after a paragraph, in ems. Verse lines run closer together than paragraphs. Read
   * along, so do the books of a row – side by side, the verses of a cell – and rows stand further
   * apart.
   */
  private fun spacing(paragraph: Paragraph, next: Paragraph?, along: Boolean, sideBySide: Boolean) = when {
    next == null -> 0.5f
    along -> if (next.row == paragraph.row && (!sideBySide || next.column == paragraph.column)) 0.2f else 0.6f
    else -> if (paragraph.kind == "verse" && next.kind == "verse") 0.2f else 0.5f
  }

  /**
   * Books read along side by side, each passage a section of its own: cells in rows, or, for a
   * passage read alone, text that flows as it would alone.
   */
  private fun sectionsOf(paragraphs: List<Paragraph>, ranges: List<Pair<Int, Int>>, along: Set<Int>): List<Section> {
    val sections = mutableListOf<Section>()
    var start = 0
    while (start < paragraphs.size) {
      val passage = paragraphs[start].passage
      var end = start
      while (end < paragraphs.size && paragraphs[end].passage == passage) end++
      val last = sections.lastOrNull()
      if (passage !in along && last != null && last.cells.isEmpty()) {
        // Passages read alone, one after the other, flow on as one.
        sections[sections.lastIndex] = Section(last.start, ranges[end - 1].second)
      } else {
        val cells = if (passage in along) cellsOf(paragraphs.subList(start, end), ranges.subList(start, end)) else emptyList()
        sections += Section(ranges[start].first, ranges[end - 1].second, cells)
      }
      start = end
    }
    return sections
  }

  /** The paragraphs side by side, each running from the first offset of its range to the second: each book's in a row is a cell, in the book's column. */
  private fun cellsOf(paragraphs: List<Paragraph>, ranges: List<Pair<Int, Int>>): List<Cell> {
    val cells = mutableListOf<Cell>()
    for ((paragraph, range) in paragraphs.zip(ranges)) {
      val last = cells.lastOrNull()
      if (last != null && last.row == paragraph.row && last.column == paragraph.column) {
        cells[cells.lastIndex] = Cell(last.start, range.second, last.row, last.column, last.heading && paragraph.kind == "heading")
      } else {
        cells += Cell(range.first, range.second, paragraph.row, paragraph.column, paragraph.kind == "heading")
      }
    }
    return cells
  }

  /** Each heading takes the chapter of the next verse of its book. */
  private fun namingChapters(readables: List<Readable>): List<Readable> {
    val next = mutableMapOf<Pair<Int, String>, Int>()
    return readables.asReversed().map { readable ->
      val key = readable.passage to readable.book
      if (readable.verse == null) readable.copy(chapter = next[key] ?: readable.chapter) else readable.also { next[key] = it.chapter }
    }.asReversed()
  }

  /** A paragraph's font: its own, or the one the app brings for its language; or none, for the system's. */
  private fun familyOf(paragraph: Paragraph) = paragraph.fontFamily ?: fonts[paragraph.language]

  /**
   * The size, in sp, at which a block's font draws the block's typical letter as tall as it asks:
   * the system's fonts and the app's own differ in how large they look at the same size.
   */
  private fun fontSize(block: Block): Double {
    val typeface = (block.fontFamily ?: fonts[block.language])?.let(::typeface) ?: baseTypeface
    return block.letterHeight / letterHeight(block.letter, typeface)
  }

  /** How tall [letter] is drawn in [typeface], per pixel of the text size – by the font the system falls back to, if the typeface lacks it. */
  private fun letterHeight(letter: String, typeface: Typeface) = letterHeights.getOrPut(typeface to letter) {
    val bounds = Rect()
    TextPaint().apply { this.typeface = typeface; textSize = 100f }.getTextBounds(letter, 0, letter.length, bounds)
    ((-bounds.top - maxOf(-bounds.bottom, 0)) / 100.0).takeIf { it > 0 } ?: 0.5
  }

  private fun pixels(points: Double) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, points.toFloat(), resources.displayMetrics)

  /** How far the text of verse lines starts, past the widest verse number before it. */
  private fun numberColumnWidth(paragraphs: List<Paragraph>): Int {
    val paint = TextPaint()
    val widths = mutableMapOf<String, Float>()
    var widest = 0f
    for (paragraph in paragraphs.filter { it.numberHangs }) {
      paint.textSize = pixels(paragraph.fontSize)
      paint.typeface = familyOf(paragraph)?.let(::typeface) ?: baseTypeface
      val number = paragraph.runs[0].text.trim()
      val width = widths.getOrPut("${familyOf(paragraph)} ${paint.textSize} $number") { paint.measureText(number) }
      widest = maxOf(widest, width + paint.textSize * 0.4f)
    }
    return ceil(widest).toInt()
  }

  private fun millisecondsSinceRender() = (System.nanoTime() - renderStarted) / 1e6

  /** One step through the words: "word+1", "word-1", "word+10", "word-10", "verse+1" or "verse-1". */
  fun move(step: String) {
    if (words.isEmpty()) return
    val index = current ?: return select(0)
    when (step) {
      "word+1" -> select(minOf(index + 1, words.lastIndex))
      "word-1" -> select(maxOf(index - 1, 0))
      "word+10" -> select(minOf(index + 10, words.lastIndex))
      "word-10" -> select(maxOf(index - 10, 0))
      "verse+1" -> select((index + 1..words.lastIndex).firstOrNull { !words[it].isInVerseOf(words[index]) } ?: index)
      "verse-1" -> verseStart(index).let { start -> select(if (start == 0) 0 else verseStart(start - 1)) }
    }
  }

  /**
   * A move from a heading or verse a screen reader is on: from the word the reader marked, if it is
   * in that verse, or else to the verse's first word.
   */
  private fun move(step: String, from: Int) {
    if (from >= words.size) return
    val current = current
    if (current != null && words[current].isInVerseOf(words[from])) move(step) else select(from)
  }

  /** Brings the reader to a word by where it stands and marks it, as a tap would – or if its verse has no such word, the verse's first. False if the reader shows no such verse. */
  fun jump(place: WordPlace): Boolean {
    val inVerse = { word: ReaderWord -> word.place.copy(index = place.index) == place }
    val index = indices[place] ?: words.indexOfFirst(inVerse).takeIf { it >= 0 } ?: return false
    select(index)
    return true
  }

  /** Reads aloud from the word marked – or, with none, the first in sight – on to the end; a recording paused at that word goes on. */
  fun play() {
    readAloud.voices = voices
    readAloud.rate = speechRate
    following = true
    readAloud.play(shownReferences, companions, speakAlong, readingStart()?.let(::position), recordedVoices)
  }

  /** Brings the word the voice is at – or, not reading aloud, the word marked – into sight, and keeps the words the voice comes to there. */
  fun follow() {
    setFollowing(true)
    current?.let { pages.show(characterAt = words[it].start) }
  }

  /** Turns to the next or previous page, or a screen down or up, as a hand would. */
  fun turn(forward: Boolean) {
    pages.turn(forward)
  }

  fun pause() = readAloud.pause(current?.let { position(words[it].place) })

  fun stop() = readAloud.stop()

  /** The word reading starts at: the one marked, or the first in sight – none at the very start, where reading starts with the first heading. */
  private fun readingStart(): WordPlace? {
    current?.let { return words[it].place }
    if (pages.anchor <= 0) return null
    return words.firstOrNull { it.end > pages.anchor }?.place
  }

  private fun position(place: WordPlace) =
    WordPosition(place.passage.toUInt(), place.book, place.chapter.toUInt(), place.verse.toUInt(), place.index.toUInt())

  /** Selects the word at a point in this view's pixels, or opens the note whose mark is there, as a tap there would. */
  fun tap(x: Float, y: Float) = (x - pages.left to y - pages.top).let { (atX, atY) -> selectWord(pages.offsetAt(atX, atY), atX, atY) }

  /** A double tap at a point in this view's pixels: a tap, then a second one, which opens the lexicon entry of the word the first reached. */
  fun doubleTap(x: Float, y: Float) {
    tap(x, y)
    val (atX, atY) = x - pages.left to y - pages.top
    doubleTapWord(pages.offsetAt(atX, atY), atX, atY)
  }

  /** The headings, verses and notes' marks a screen reader finds in sight, by where they stand, never their text. */
  fun accessibilityElementsInSight() = pages.accessibilityElementsInSight()

  /**
   * A tap at a character – at a point in the pages' pixels: on a note's mark – the sign of a mark's note
   * too, and a word's number, where the finger is on it – it opens the note, or closes it, if it is the
   * one open; elsewhere, it selects the word, and names the host's marks on it to JS. The first tap
   * after a selection only ends it.
   */
  private fun selectWord(offset: Int?, x: Float, y: Float) {
    tappedWord = null
    if (selected != null) {
      closeNote()
      return setSelected(null)
    }
    if (offset == null) return closeNote()
    // A word's number follows its word straight away: only a finger on its digits takes it, not one at the word's end.
    val note = marks.firstOrNull { offset in it.start..it.end && (it.kind != ENTRY_KIND || isOn(it, x, y)) }
    if (note != null) {
      if (isOpen(note)) closeNote() else openNote(note)
      return
    }
    closeNote()
    val index = wordAt(offset) ?: return
    select(index)
    tappedWord = index
    val word = words[index]
    val ids = placedMarks.filter { it.start <= word.start && word.end <= it.end }.map { it.id }.distinct()
    if (ids.isEmpty()) return
    val place = word.place
    onMarkTap(mapOf("ids" to ids, "passage" to place.passage, "book" to place.book, "chapter" to place.chapter, "verse" to place.verse, "word" to place.index))
  }

  /** Whether a point in the pages' pixels is on a mark's glyphs – a little beside them too, as they are small. */
  private fun isOn(note: ReaderNote, x: Float, y: Float): Boolean {
    val rect = pages.rectOf(note.start, note.end) ?: return false
    val slack = (3 * resources.displayMetrics.density).roundToInt()
    rect.inset(-slack, 0)
    return rect.contains(x.roundToInt(), y.roundToInt())
  }

  /**
   * The second tap of a double tap: on the word the first reached, if it opens a lexicon entry, it opens
   * it; anywhere else it is a tap like any.
   */
  private fun doubleTapWord(offset: Int?, x: Float, y: Float) {
    val index = offset?.let(::wordAt)
    if (index != null && index == tappedWord && words[index].entry) {
      tappedWord = null
      return openEntry(index)
    }
    selectWord(offset, x, y)
  }

  /** Opens a word's lexicon entry where the word stands, as a note opens at its mark. */
  private fun openEntry(index: Int) {
    val word = words[index]
    val place = word.place
    val language = shownParagraphs.getOrNull(word.paragraph)?.language ?: ""
    openNote(ReaderNote(place.passage, place.book, language, word.start, word.end, word.paragraph, place.chapter, place.verse, emptyList(), ENTRY_KIND, "", null, place.index))
  }

  /** TalkBack's request for a verse's entry: of the word reached, if it is in the verse and has one, or else of the verse's first word with one. */
  private fun openEntryIn(readable: Readable) {
    val inVerse = { index: Int ->
      words.getOrNull(index)?.place?.let { it.passage == readable.passage && it.book == readable.book && it.chapter == readable.chapter && it.verse == readable.verse } == true
    }
    val reached = current?.takeIf { inVerse(it) && words[it].entry }
    val index = reached ?: generateSequence(readable.firstWord) { it + 1 }.takeWhile(inVerse).firstOrNull { words[it].entry } ?: return
    openEntry(index)
  }

  private fun isOpen(note: ReaderNote) = opened?.let { it.kind == note.kind && it.mark == note.mark && it.start == note.start } == true

  /**
   * Opens a note where its mark stands – below its line, or above it – in its paragraph's font: see
   * [NoteView]. A word's entry – by its number's mark, or by a double tap at the word – opens in its
   * lexicon's language and direction, in the reader's font for that language. The note open before closes.
   */
  private fun openNote(note: ReaderNote) {
    val anchor = pages.rectOf(note.start, note.end) ?: return
    anchor.offset(pages.left, pages.top)
    val paragraph = shownParagraphs.getOrNull(note.paragraph) ?: return
    val size = maxOf(pixels(paragraph.fontSize) * 0.7f, pixels(14.0))
    val bounds = Rect(0, 0, width, height)
    if (note.kind == ENTRY_KIND) {
      val word = note.word ?: return
      val entry = readerEntry(note.book, note.chapter.toUInt(), note.verse.toUInt(), word.toUInt()) ?: return
      val typeface = fonts[entry.language]?.let(::typeface) ?: baseTypeface
      opened = note
      noteView.show(noteText(note, entry.runs), typeface, size, textColor, backgroundColor, anchor, bounds, pixels(margin).roundToInt(), entry.direction == "rtl", oneDirection = true)
    } else {
      val typeface = familyOf(paragraph)?.let(::typeface) ?: baseTypeface
      opened = note
      noteView.show(noteText(note, note.runs), typeface, size, textColor, backgroundColor, anchor, bounds, pixels(margin).roundToInt(), paragraph.rightToLeft)
    }
    backCloses.isEnabled = true
    requestLayout()
  }

  private fun closeNote() {
    backCloses.isEnabled = false
    if (opened == null) return
    opened = null
    noteView.hide()
  }

  /**
   * A note's runs – or a word's entry's – as text with spans: the verse it names in the "origin" color,
   * quotations and emphasis in italics, what is strong in bold, words in other languages in their fonts
   * and locales, and each reference a link that follows it.
   */
  private fun noteText(note: ReaderNote, runs: List<NoteRun>): CharSequence {
    val builder = SpannableStringBuilder()
    val linkColor = roleColors["note"] ?: textColor
    val originColor = roleColors["origin"] ?: ColorUtils.setAlphaComponent(textColor, 153)
    val flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
    for (run in runs) {
      if (run.text == "\n") {
        builder.append("\n")
        continue
      }
      val start = builder.length
      builder.append(run.text)
      val end = builder.length
      when (run.role) {
        "origin" -> builder.setSpan(ForegroundColorSpan(originColor), start, end, flags)
        "number" -> builder.setSpan(ForegroundColorSpan(roleColors["number"] ?: originColor), start, end, flags)
        "quotation", "emphasis" -> builder.setSpan(StyleSpan(Typeface.ITALIC), start, end, flags)
        "strong" -> builder.setSpan(StyleSpan(Typeface.BOLD), start, end, flags)
      }
      run.language?.let { language ->
        builder.setSpan(LocaleSpan(Locale.forLanguageTag(language)), start, end, flags)
        fonts[language]?.let { builder.setSpan(TypefaceSpan(typeface(it)), start, end, flags) }
      }
      run.target?.let { target ->
        val link = object : ClickableSpan() {
          override fun onClick(widget: View) = followReference(target, note)

          override fun updateDrawState(ds: TextPaint) {
            ds.color = linkColor
            ds.isUnderlineText = true
          }
        }
        builder.setSpan(link, start, end, flags)
      }
    }
    return builder
  }

  /**
   * Follows a reference: to the verses it names, if the reader shows them – in the note's own
   * edition, or else in another of the book – or, if not, tells JS, with the library's book of them,
   * if it holds one: of the note's edition where it has it.
   */
  private fun followReference(target: Target, note: ReaderNote) {
    val library = books()
    val work = library.find { it.id == note.book }?.work
    val editions = library.filter { it.code == target.book }
    val held = editions.find { it.work == work } ?: editions.firstOrNull()
    val codes = library.associate { it.id to it.code }
    val verse = target.verse?.toInt()
    val at = { word: ReaderWord -> word.place.chapter == target.chapter.toInt() && (verse == null || word.place.verse == verse) }
    var index = held?.let { book -> words.indexOfFirst { it.place.book == book.id && at(it) } } ?: -1
    if (index < 0) index = words.indexOfFirst { codes[it.place.book] == target.book && at(it) }
    closeNote()
    if (index >= 0) return select(index)
    val from = mapOf("passage" to note.passage, "book" to note.book, "chapter" to note.chapter, "verse" to note.verse)
    val event = mutableMapOf<String, Any?>("book" to held?.id, "code" to target.book, "chapter" to target.chapter.toInt(), "from" to from)
    verse?.let { event["verse"] = it }
    target.to?.let { event["to"] = it.toInt() }
    // A book of null tells JS the library holds none; the dispatcher's map type allows no null, its converter does.
    @Suppress("UNCHECKED_CAST")
    onReference(event as Map<String, Any>)
  }

  /** Marks a word reached by a tap, a move or a jump. While reading aloud, the voice goes on from it. */
  private fun select(index: Int) {
    closeNote()
    following = true
    mark(index)
    pages.speak(words[index].start, words[index].end)
    if (readAloud.state == "speaking") play()
  }

  /**
   * Marks the word the voice comes to, and keeps it in sight – unless the reader was scrolled away from it, until it is in sight
   * again. Voices report some punctuation apart, as a word of its own: it is still the word it belongs to.
   */
  private fun reached(place: WordPlace) {
    val index = indices[place]?.takeIf { it != current } ?: return
    if (!following && !pages.isScrollingByHand && pages.isInSight(words[index].start)) setFollowing(true)
    mark(index, show = following)
  }

  /** While the voice reads, a scroll by hand leaves it be: the reader no longer follows it. A note open closes. */
  private fun scrolledByHand() {
    closeNote()
    if (readAloud.state == "speaking") setFollowing(false)
  }

  private fun setFollowing(following: Boolean) {
    if (following == this.following) return
    this.following = following
    if (readAloud.state == "speaking") onSpeechChange(mapOf("state" to "speaking", "following" to following))
  }

  /** The voice's news for JS; while it speaks, with whether the reader follows it. The media controls show it too. */
  private fun speechChanged(change: Map<String, Any>) {
    onSpeechChange(if (change["state"] == "speaking") change + ("following" to following) else change)
    ReadingService.show(context, this, nowPlaying, change["state"] as? String ?: "stopped")
  }

  private fun mark(index: Int, show: Boolean = true) {
    current = index
    val word = words[index]
    pages.highlight(word.start, word.end)
    if (show) pages.show(characterAt = word.start)
    val place = word.place
    onWordChange(mapOf("passage" to place.passage, "book" to place.book, "chapter" to place.chapter, "verse" to place.verse, "word" to place.index))
  }

  /** The word at a character of the text, or just after it, if one is there. */
  private fun wordAt(offset: Int): Int? {
    var (low, high) = 0 to words.size
    while (low < high) {
      val middle = (low + high) / 2
      if (words[middle].start <= offset) low = middle + 1 else high = middle
    }
    return (low - 1).takeIf { it >= 0 && offset <= words[it].end }
  }

  /** The verse whose text – its number included – holds a character, if one does. */
  private fun verseAt(offset: Int): ReaderVerse? {
    var (low, high) = 0 to verses.size
    while (low < high) {
      val middle = (low + high) / 2
      if (verses[middle].start <= offset) low = middle + 1 else high = middle
    }
    return verses.getOrNull(low - 1)?.takeIf { offset < it.end }
  }

  /** The host's marks as the core placed them in the paragraphs, where they stand in the text, their colors by the names they give. */
  private fun placedMarksOf(marks: List<List<PlacedMark>>) = marks.zip(paragraphStarts).flatMapIndexed { paragraph, (placed, start) ->
    placed.map { mark ->
      ReaderMark(
        mark.id, paragraph, start + mark.start.toInt(), start + mark.end.toInt(),
        mark.highlight?.let { colorOf(it, markFills) }, mark.underline?.let { colorOf(it, markLines) },
      )
    }
  }

  /**
   * Draws the host's marks anew as they change: the same paragraphs, their marks asked for again, the
   * layout kept – unless the signs of their notes changed, which stand in the text: then it is laid out
   * anew, the reader staying at its word and the words selected.
   */
  private fun refreshMarks() {
    val (references, options) = shownRequest ?: return
    val placed = readerMarks(references, options)
    val signsChanged = placed.size != shownParagraphs.size ||
      placed.zip(shownParagraphs).any { (marks, paragraph) -> marks.signs != paragraph.notes.filter { it.kind == Mark.SIGN_KIND } }
    if (signsChanged) return render()
    placedMarks = placedMarksOf(placed.map { it.marks })
    applyMarks()
  }

  /**
   * Draws the host's marks and the selection over the text: the selection in its color, or – given a selection style – over the marks
   * as the words would look marked so; or, as a pen erases them, as they will look: the mark cut around them, what is left of its look
   * on them.
   */
  private fun applyMarks() {
    val selected = selected
    val style = selectionStyle
    val stretches = selected?.let(::stretchesOf).orEmpty()
    val erased = erasedMark()
    val marks = placedMarks.flatMap { mark ->
      val over = stretches.firstOrNull { it.first < mark.end && mark.start < it.last }
      if (mark.id == erased && over != null && selected != null && style != null) cut(mark, over, selected, style)
      else listOf(Decoration(mark.start, mark.end, mark.fill, mark.line))
    }
    if (style == null || (style.highlight == null && style.underline == null)) {
      pages.decorate(marks)
      pages.select(stretches)
      return
    }
    val (fill, line) = style.highlight?.let { colorOf(it, markFills) } to style.underline?.let { colorOf(it, markLines) }
    pages.decorate(if (erased != null) marks else marks + stretches.map { Decoration(it.first, it.last, fill, line) })
    pages.select(emptyList())
  }

  /** A mark a pen erases words of, as it will be: in its look before and after them, over them – [over], in its paragraph – in what is left of it. */
  private fun cut(mark: ReaderMark, over: IntRange, selected: IntRange, style: SelectionStyle): List<Decoration> {
    val book = words[selected.first]
    val inMark = { word: ReaderWord -> mark.start <= word.start && word.end <= mark.end }
    val before = (selected.first - 1 downTo 0).firstOrNull { words[it].isInBookOf(book) }?.let(words::get)?.takeIf(inMark)
    val after = (selected.last + 1 until words.size).firstOrNull { words[it].isInBookOf(book) }?.let(words::get)?.takeIf(inMark)
    val (fill, line) = mark.fill.takeIf { style.highlight == null } to mark.line.takeIf { style.underline == null }
    return listOfNotNull(
      before?.let { Decoration(mark.start, it.end, mark.fill, mark.line) },
      Decoration(maxOf(mark.start, over.first), minOf(mark.end, over.last), fill, line).takeIf { fill != null || line != null },
      after?.let { Decoration(it.start, mark.end, mark.fill, mark.line) },
    )
  }

  /**
   * What the selection erases: the mark its words all lie in, of the pen's look, by place, as the pen finds it. Found anew only as the
   * words or the style change: the pen changes the marks as it lets go, and the selection stays until it is done.
   */
  private fun erasedMark(): String? {
    val selected = selected
    val style = selectionStyle
    if (selected == null || style == null || !style.erases || (style.highlight == null && style.underline == null)) {
      erasing = "" to null
      return null
    }
    val (from, to) = endsOf(selected)
    val place = words[selected.first].place
    val key = "${place.passage} ${place.book} $from $to $style"
    if (key == erasing.first) return erasing.second
    val endOf = { end: MarkEnd -> End(end.chapter.toInt(), end.verse.toInt(), end.word?.toInt()) }
    val mark = libraryMarks().firstOrNull { mark ->
      mark.book == place.book && order(endOf(mark.from).asStart(), from.asStart()) <= 0 && order(to.asEnd(), endOf(mark.to).asEnd()) <= 0 &&
        (style.highlight == null || mark.highlight == style.highlight) && (style.underline == null || mark.underline == style.underline)
    }
    erasing = key to mark?.id
    return erasing.second
  }

  /** Which of two places comes first – chapter, verse and word: before, the same or after. */
  private fun order(a: List<Long>, b: List<Long>) = a.zip(b).map { (x, y) -> x.compareTo(y) }.firstOrNull { it != 0 } ?: 0

  /** The words a finger is on: the word there – selecting verses, its verse – or the verse whose number it is on. */
  private fun wordsUnder(offset: Int): IntRange? =
    wordAt(offset)?.let { if (selectBy == "verse") wholeVerses(it..it) else it..it } ?: verseAt(offset)?.words?.let(::wholeVerses)

  /** The words of the verses of a span's first and last words: from the first word of the one to the last of the other, in however many paragraphs they stand. */
  private fun wholeVerses(span: IntRange): IntRange {
    var last = span.last
    while (last < words.size - 1 && words[last + 1].isInVerseOf(words[span.last])) last++
    return verseStart(span.first)..last
  }

  /** A long press starts a selection: the word there, or the verse whose number it is on. The word marked, and reading aloud, stay as they are. */
  private fun beginSelection(offset: Int?) {
    val anchor = offset?.let(::wordsUnder)
    anchorWords = anchor
    if (anchor == null) return
    closeNote()
    setSelected(anchor, report = false)
    reportFrame()
  }

  /**
   * The finger, still down, takes the selection on to the word under it, in either direction: the words
   * of the book it started in, from the first to the last of them between – of a book read along, those
   * between are left out. Between words, it stays. Selecting verses, it takes in the verse of the word,
   * or the verse whose number it is on.
   */
  private fun extendSelection(offset: Int?) {
    val anchor = anchorWords ?: return
    val focus = offset?.let { if (selectBy == "verse") wordsUnder(it) else wordAt(it)?.let { word -> word..word } } ?: return
    val book = words[anchor.first]
    val first = (minOf(anchor.first, focus.first)..anchor.first).first { words[it].isInBookOf(book) }
    val last = (maxOf(anchor.last, focus.last) downTo anchor.last).first { words[it].isInBookOf(book) }
    setSelected(first..last, report = false)
  }

  /** The finger lifts: JS hears what is selected. */
  private fun endSelection() {
    anchorWords ?: return
    anchorWords = null
    reportSelection()
  }

  /**
   * Selects words or verses as JS asks – from a word, or a verse's first, to a word, or a verse's last –
   * and brings them into sight, if none of them is; or nothing.
   */
  fun selectWords(selection: SelectionRecord?) {
    if (selection == null) return setSelected(null)
    val inBook = { word: ReaderWord -> word.place.passage == selection.passage && word.place.book == selection.book }
    val from = listOf(selection.from.chapter, selection.from.verse, selection.from.word ?: 0)
    val to = listOf(selection.to.chapter, selection.to.verse, selection.to.word ?: Int.MAX_VALUE)
    val first = words.indexOfFirst { inBook(it) && compareWith(it, from) >= 0 }
    val last = words.indexOfLast { inBook(it) && compareWith(it, to) <= 0 }
    if (first < 0 || last < first) return setSelected(null)
    val chosen = if (selectBy == "verse") wholeVerses(first..last) else first..last
    setSelected(chosen)
    if (!pages.isAnyInSight(words[chosen.first].start, words[chosen.last].end)) pages.show(characterAt = words[chosen.first].start)
  }

  /** Where a word stands against an end of a selection – chapter, verse and word – before it, at it or after it. */
  private fun compareWith(word: ReaderWord, end: List<Int>) =
    listOf(word.place.chapter, word.place.verse, word.place.index).zip(end).map { (a, b) -> a.compareTo(b) }.firstOrNull { it != 0 } ?: 0

  /** TalkBack selects a verse, or takes the selection on to it: from the selection's start, or the verse, to its end. */
  private fun selectVerse(readable: Readable, extend: Boolean) {
    val verse = verses.firstOrNull { it.start == readable.start }?.words?.let(::wholeVerses) ?: return
    val current = selected
    if (!extend || current == null || !words[current.first].isInBookOf(words[verse.first])) return setSelected(verse)
    setSelected(minOf(current.first, verse.first)..maxOf(current.last, verse.last))
  }

  /** Draws the words selected, or none, and – unless a finger is still choosing them – tells JS. */
  private fun setSelected(range: IntRange?, report: Boolean = true) {
    selected = range
    drawSelection()
    if (report) reportSelection()
  }

  /** Draws the words selected, or none – with the marks, in the selection's look. */
  private fun drawSelection() = applyMarks()

  /** Words selected as stretches of the text: those of their book, a paragraph at a time, each from its first character to before its last. */
  private fun stretchesOf(selected: IntRange): List<IntRange> {
    val book = words[selected.first]
    val stretches = mutableListOf<IntRange>()
    var index = selected.first
    while (index <= selected.last) {
      if (!words[index].isInBookOf(book)) {
        index++
        continue
      }
      val start = index
      while (index < selected.last && words[index + 1].isInBookOf(book) && words[index + 1].paragraph == words[start].paragraph) index++
      stretches += words[start].start..words[index].end
      index++
    }
    return stretches
  }

  /**
   * Tells JS where the selection shows, if that changed: the part of its first line in sight and of its
   * last, in dp from this view's top left – or none, while a finger chooses words or the text moves,
   * where none of it is in sight, or with none selected.
   */
  private fun reportFrame() {
    if (rendering) return
    val selected = selected?.takeIf { anchorWords == null && !moving }
    val lines = selected?.let { pages.linesInSight(stretchesOf(it)) }
    val frame = lines?.let { (first, last) -> mapOf("first" to dp(first), "last" to dp(last)) }
    val key = frame?.toString() ?: ""
    if (key == reportedFrame) return
    reportedFrame = key
    // A frame of null tells JS there is none; the dispatcher's map type allows no null, its converter does.
    @Suppress("UNCHECKED_CAST")
    onSelectionFrame(mapOf("frame" to frame) as Map<String, Any>)
  }

  /** Tells JS the verse in sight, if it changed: the verse of the first word on the page, or of the first whole line in sight. */
  private fun reportVerse() {
    if (rendering) return
    val character = pages.characterShown ?: return
    var (low, high) = 0 to words.size
    while (low < high) {
      val middle = (low + high) / 2
      if (words[middle].end <= character) low = middle + 1 else high = middle
    }
    val place = words.getOrNull(low)?.place ?: return
    val key = "${place.passage} ${place.book} ${place.chapter}:${place.verse}"
    if (key == reportedVerse) return
    reportedVerse = key
    onVerseInSight(mapOf("passage" to place.passage, "book" to place.book, "chapter" to place.chapter, "verse" to place.verse))
  }

  /** A rectangle in the pages' pixels as JS takes it: x, y, width and height in dp from this view's top left. */
  private fun dp(rect: android.graphics.RectF): List<Double> {
    val density = resources.displayMetrics.density
    return listOf(rect.left + pages.left, rect.top + pages.top, rect.width(), rect.height()).map { (it / density * 10).roundToInt() / 10.0 }
  }

  /** Tells JS what is selected, and where it shows, if either changed. */
  private fun reportSelection() {
    tellSelection()
    reportFrame()
  }

  /**
   * Tells JS what is selected, if that changed: the first and last words as the selection's ends – a
   * whole verse where they are its first or last word – or none.
   */
  private fun tellSelection() {
    val selected = selected
    if (selected == null) {
      if (reportedSelection.isEmpty()) return
      reportedSelection = ""
      // A selection of null tells JS there is none; the dispatcher's map type allows no null, its converter does.
      @Suppress("UNCHECKED_CAST")
      onSelectionChange(mapOf("selection" to null) as Map<String, Any>)
      return
    }
    val (from, to) = endsOf(selected)
    val place = words[selected.first].place
    val selection = mapOf("passage" to place.passage, "book" to place.book, "from" to from.record(), "to" to to.record())
    val key = selection.toString()
    if (key == reportedSelection) return
    reportedSelection = key
    onSelectionChange(mapOf("selection" to selection))
  }

  /** The ends of the words selected, as JS hears of them: the first and the last word – a whole verse where they are its first or last word. */
  private fun endsOf(selected: IntRange): Pair<End, End> {
    val (first, last) = words[selected.first] to words[selected.last]
    val lastIsWord = words.getOrNull(selected.last + 1)?.isInVerseOf(last) == true
    return End(first.place.chapter, first.place.verse, first.place.index.takeIf { it != 0 }) to
      End(last.place.chapter, last.place.verse, last.place.index.takeIf { lastIsWord })
  }

  private fun verseStart(index: Int): Int {
    var start = index
    while (start > 0 && words[start - 1].isInVerseOf(words[index])) start--
    return start
  }

  // expo-font copies the fonts to assets/fonts, named after their PostScript names.
  private fun typeface(family: String) = typefaces.getOrPut(family) {
    runCatching { Typeface.createFromAsset(context.assets, "fonts/$family.ttf") }.getOrDefault(Typeface.DEFAULT)
  }

  /** A word of the reader's text: where it stands in the scripture, where it is in the text – in which paragraph – and whether it opens a lexicon entry. */
  private class ReaderWord(passage: Int, book: String, word: Word, textStart: Int, val paragraph: Int) {
    val place = WordPlace(passage, book, word.chapter.toInt(), word.verse.toInt(), word.index.toInt())
    val start = textStart + word.start.toInt()
    val end = textStart + word.end.toInt()
    val entry = word.entry

    fun isInVerseOf(other: ReaderWord) = isInBookOf(other) && with(other.place) { chapter == place.chapter && verse == place.verse }

    fun isInBookOf(other: ReaderWord) = with(other.place) { passage == place.passage && book == place.book }
  }

  /**
   * A note's mark in the reader's text – an edition's, the sign of a host's mark's note, of the kind
   * "mark", or a word's number, of the kind "entry" – where it is, in which paragraph, on which verse of
   * which book, the note's runs, its kind and mark, for a sign the host's mark's id, and for a number
   * the word, by its index in the verse, whose entry it opens. A word's entry opened by a double tap
   * stands where the word does.
   */
  private class ReaderNote(
    val passage: Int,
    val book: String,
    val language: String,
    val start: Int,
    val end: Int,
    val paragraph: Int,
    val chapter: Int,
    val verse: Int,
    val runs: List<NoteRun>,
    val kind: String,
    val mark: String,
    val id: String?,
    val word: Int? = null,
  ) {
    constructor(passage: Int, book: String, language: String, note: NoteMark, textStart: Int, paragraph: Int) : this(
      passage, book, language, textStart + note.start.toInt(), textStart + note.end.toInt(), paragraph,
      note.chapter.toInt(), note.verse.toInt(), note.runs, note.kind, note.mark, note.id, note.word?.toInt(),
    )
  }

  /** A host's mark in the reader's text: its words, in which paragraph, and how it is drawn – ARGB. */
  private class ReaderMark(val id: String, val paragraph: Int, val start: Int, val end: Int, val fill: Int?, val line: Int?)

  /** A verse of the reader's text: where it is, its number included, and its words – none, for a verse without. */
  private class ReaderVerse(val start: Int, val end: Int, val words: IntRange?)

  /** Where a word stands: in which passage, in which book – the passage's, or one read along with it – and where in the scripture. */
  data class WordPlace(val passage: Int, val book: String, val chapter: Int, val verse: Int, val index: Int)

  /** An end of words selected or marked: a word, or – with none – a whole verse. */
  private data class End(val chapter: Int, val verse: Int, val word: Int?) {
    /** Where words from it start: a whole verse before its first word. */
    fun asStart() = listOf(chapter.toLong(), verse.toLong(), word?.toLong() ?: -1L)

    /** Where words to it end: a whole verse after its last word. */
    fun asEnd() = listOf(chapter.toLong(), verse.toLong(), word?.toLong() ?: Long.MAX_VALUE)

    /** As JS hears of it. */
    fun record() = listOfNotNull("chapter" to chapter, "verse" to verse, word?.let { "word" to it }).toMap()
  }

  /**
   * How the selection is drawn, given a mark's look – a highlight and an underline, by the names or colors a mark gives: as words marked
   * so would look, for a pen that marks as it goes. A pen that erases too takes its look off words that all lie in one mark of it, by
   * place: those look as they will then.
   */
  data class SelectionStyle(val highlight: String?, val underline: String?, val erases: Boolean)

  /** A paragraph as the core made it, sized and colored for the reader. Colors are ARGB. */
  private class Paragraph(
    val passage: Int,
    val book: String,
    /** Where it stands, read along with other books: see the core's Block. */
    val row: Int,
    val column: Int,
    /** "heading", "text" or "verse": see the core's Block. */
    val kind: String,
    val rightToLeft: Boolean,
    val language: String,
    val fontFamily: String?,
    val fontSize: Double,
    val runs: List<Run>,
    val verses: List<VerseRange>,
    val words: List<Word>,
    /** The notes on its verses, each at its mark in the text; and what opens the chapter, set large, if it opens one. */
    val notes: List<NoteMark>,
    val dropCap: DropCap?,
    /** The host's marks on its verses, each over its words. */
    val marks: List<PlacedMark>,
  ) {
    class Run(val text: String, val role: String?, val color: Int?)

    constructor(block: Block, roleColors: Map<String, Int>, fontSize: Double) : this(
      block.passage.toInt(),
      block.book,
      block.row.toInt(),
      block.column.toInt(),
      block.kind,
      block.direction == "rtl",
      block.language,
      block.fontFamily,
      fontSize,
      block.segments.map { segment -> Run(segment.text, segment.role, segment.role?.let(roleColors::get)) },
      block.verses,
      block.words,
      block.notes,
      block.dropCap,
      block.marks,
    )

    /** A verse line whose number comes first, followed by a tab: the number hangs before the text. */
    val numberHangs get() = kind == "verse" && runs.firstOrNull()?.text?.endsWith("\t") == true

    /** Its verses, its text starting at [start] in the reader's, each with its words, the first of them the reader's [firstWord]. */
    fun verses(start: Int, firstWord: Int): List<ReaderVerse> {
      // Verses and words both run in the text's order: each verse's words are found walking on.
      var word = 0
      return verses.map { verse ->
        while (word < words.size && words[word].start < verse.start) word++
        val first = word
        while (word < words.size && words[word].start < verse.end) word++
        ReaderVerse(start + verse.start.toInt(), start + verse.end.toInt(), if (word > first) (firstWord + first) until (firstWord + word) else null)
      }
    }

    /** What screen readers read of it, its text running from [start] to [end]: the heading, or each verse, and whether any of its words opens an entry. */
    fun readables(start: Int, end: Int, firstWord: Int): List<Readable> {
      if (kind == "heading") return listOf(Readable(start, end, language, passage, book, 0, null, firstWord))
      // Verses and words both run in the text's order: each verse's first word is found walking on.
      var word = 0
      return verses.map { verse ->
        while (word < words.size && words[word].start < verse.start) word++
        var last = word
        while (last < words.size && words[last].start < verse.end) last++
        val entries = (word until last).any { words[it].entry }
        Readable(start + verse.start.toInt(), start + verse.end.toInt(), language, passage, book, verse.chapter.toInt(), verse.verse.toInt(), firstWord + word, entries)
      }
    }
  }

  /**
   * Text and its spans, gathered first and handed over at once. A SpannableStringBuilder takes
   * spans one by one slowly – it sorts all of them again for each, and a long book has thousands –
   * but takes them all at once quickly, from another Spanned: this one.
   */
  private class SpannedText : Spanned {
    private val text = StringBuilder()
    private val spans = mutableListOf<Any>()
    private val ranges = IdentityHashMap<Any, IntArray>()

    override val length get() = text.length

    override fun get(index: Int) = text[index]

    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = text.subSequence(startIndex, endIndex)

    override fun toString() = text.toString()

    fun append(part: String) {
      text.append(part)
    }

    /** Spans the text from [start] to where it ends now, or to [end]. */
    fun span(span: Any, start: Int, end: Int = text.length) {
      spans += span
      ranges[span] = intArrayOf(start, end)
    }

    fun build() = SpannableStringBuilder(this)

    // As in Android's own: a span that only touches the range counts if it or the range is empty.
    override fun <T> getSpans(start: Int, end: Int, type: Class<T>?): Array<T> {
      val found = spans.filter { span ->
        val (spanStart, spanEnd) = ranges.getValue(span)
        (type == null || type.isInstance(span)) && spanStart <= end && spanEnd >= start &&
          (spanStart == spanEnd || start == end || (spanStart != end && spanEnd != start))
      }
      @Suppress("UNCHECKED_CAST")
      val array = java.lang.reflect.Array.newInstance(type ?: Any::class.java, found.size) as Array<T>
      found.forEachIndexed { index, span -> array[index] = span as T }
      return array
    }

    override fun getSpanStart(tag: Any?) = ranges[tag]?.get(0) ?: -1

    override fun getSpanEnd(tag: Any?) = ranges[tag]?.get(1) ?: -1

    override fun getSpanFlags(tag: Any?) = if (ranges.containsKey(tag)) Spanned.SPAN_EXCLUSIVE_EXCLUSIVE else 0

    override fun nextSpanTransition(start: Int, limit: Int, type: Class<*>?): Int {
      var next = limit
      for (span in spans) {
        if (type != null && !type.isInstance(span)) continue
        for (edge in ranges.getValue(span)) if (edge > start && edge < next) next = edge
      }
      return next
    }
  }

  companion object {
    /** The readers in sight, which show what the library holds as the host adds or removes books. */
    private val shown = java.util.Collections.newSetFromMap(WeakHashMap<ReaderView, Boolean>())

    /** On the main thread, after the host added or removed books: what is still to be read goes with them. */
    fun booksChanged() = shown.toList().forEach {
      it.readAloud.stop()
      it.render()
    }

    /** On the main thread, after the host added or removed recordings: what is still to be read goes with them. */
    fun recordingsChanged() = shown.toList().forEach { it.readAloud.stop() }

    /** On the main thread, after the host added or removed marks: every reader draws them anew, its layout kept. */
    fun marksChanged() = shown.toList().forEach { it.refreshMarks() }

    /** On the main thread, after the host added or removed lexicons: every reader lays its text out anew – its words open entries or not – at the word it was at, reading on. */
    fun lexiconsChanged() = shown.toList().forEach { it.render() }

    /** The kind of a note's mark that is a word's number, which opens the word's lexicon entry. */
    private const val ENTRY_KIND = "entry"

    /** The colors marks name, as the light palette has them: for an app that gives the reader no palette. */
    private val MARK_FILLS = mapOf("yellow" to 0xFFFFEDB6.toInt(), "green" to 0xFFB9EABB.toInt(), "blue" to 0xFFB8DFFF.toInt(), "pink" to 0xFFFFD4E2.toInt())
    private val MARK_LINES = mapOf("yellow" to 0xFFF9A825.toInt(), "green" to 0xFF2E7D32.toInt(), "blue" to 0xFF1565C0.toInt(), "pink" to 0xFFAD1457.toInt())
    private const val SELECTION = 0xFF64B5F6.toInt()

    /** A mark's color: the palette's, by the name the mark gives – or the name itself, as "#RRGGBB", "#RRGGBBAA" or a name Android knows. */
    private fun colorOf(name: String, named: Map<String, Int>): Int? = named[name] ?: runCatching {
      val hex = name.removePrefix("#")
      Color.parseColor(if (name.startsWith("#") && hex.length == 8) "#${hex.substring(6)}${hex.substring(0, 6)}" else name)
    }.getOrNull()

    private const val LEFT_TO_RIGHT_MARK = "\u200E"
    private const val RIGHT_TO_LEFT_MARK = "\u200F"
    private const val HIGHLIGHT = 0xFFFFE082.toInt()
  }
}
