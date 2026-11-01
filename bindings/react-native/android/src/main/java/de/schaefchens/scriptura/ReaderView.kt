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
import android.text.style.LineHeightSpan
import android.text.style.LocaleSpan
import android.text.style.StyleSpan
import android.text.style.TabStopSpan
import android.text.style.TypefaceSpan
import android.util.TypedValue
import android.view.View
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
import de.schaefchens.scriptura.core.NoteMark
import de.schaefchens.scriptura.core.Notes
import de.schaefchens.scriptura.core.Reference
import de.schaefchens.scriptura.core.Target
import de.schaefchens.scriptura.core.books
import de.schaefchens.scriptura.core.VerseRange
import de.schaefchens.scriptura.core.Word
import de.schaefchens.scriptura.core.WordPosition
import de.schaefchens.scriptura.core.readerBlocks
import java.util.WeakHashMap

/**
 * The reader: passages as paragraphs, each with its own direction, language and font, laid out as
 * one spanned string, in pages or one endless scroll. It fetches them from the core itself, from the
 * books the host added, so their text never passes through JS. A word can be tapped, reached word by
 * word or jumped to; JS learns only where the current word stands, never its text. It reads aloud –
 * chapters with recordings from them, the rest with the device's voices – from the word it is at, and
 * marks each word as it is said, keeping it in sight – unless it was scrolled away from it by hand.
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

  /** The notes' marks in the text, in its order, and the index of the note open, if one is. */
  private var marks: List<ReaderNote> = emptyList()
  private var opened: Int? = null
  private var shownParagraphs: List<Paragraph> = emptyList()
  private var roleColors: Map<String, Int> = emptyMap()
  private var textColor = Color.BLACK
  private var backgroundColor = Color.WHITE

  init {
    pages.onTap = ::selectWord
    pages.onMarkTap = ::openNote
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
    readAloud.release()
  }

  fun render() {
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
    val references = passages.map { Reference(it.book, it.chapter?.toUInt(), it.from?.toUInt(), it.to?.toUInt()) }
    // The same passages in another layout – a new font size, theme or line spacing, other books read
    // along – keep the reader at the word it was at, and the word it marked: the text may change,
    // its words don't.
    val staying = references == shownReferences
    val kept = if (staying) words else emptyList()
    // At the very start, before the first word, it stays there, its heading in sight.
    val anchorAt = if (pages.anchor > 0) kept.indexOfFirst { it.end > pages.anchor } else -1
    val marked = if (staying) current?.let { words[it].place } else null
    if (!staying) readAloud.stop()
    shownReferences = references
    val roleColors = colors.roles.mapValues { ColorCompat.toArgb(it.value) }
    this.roleColors = roleColors
    val shownNotes = when (notes) { "none" -> Notes.NONE; "inline" -> Notes.INLINE; else -> Notes.MARKS }
    val blocks = readerBlocks(references, fontSize, versePerLine, companions, shownNotes, dropCaps)
    val paragraphs = blocks.map { Paragraph(it, roleColors, fontSize(it)) }
    shownParagraphs = paragraphs
    // The passages read along with other books, in rows.
    val along = paragraphs.filter { it.column > 0 }.map { it.passage }.toSet()
    val sideBySide = parallel == "columns" && along.isNotEmpty()
    val readerWords = mutableListOf<ReaderWord>()
    val readerNotes = mutableListOf<ReaderNote>()
    val readables = mutableListOf<Readable>()
    val paragraphRanges = mutableListOf<Pair<Int, Int>>()
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
        paragraph.words.mapTo(readerWords) { word -> ReaderWord(paragraph.passage, paragraph.book, word, textStart) }
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
      Mark(note.start, note.end, note.passage, note.book, note.note.chapter.toInt(), note.note.verse.toInt(), note.note.mark, note.note.kind, note.language, index)
    }
    val rightToLeft = withWords.isNotEmpty() && withWords.all { it.rightToLeft }
    val sections = if (sideBySide) sectionsOf(paragraphs, paragraphRanges, along) else listOf(Section(0, text.length))
    val format = TextFormat(background, columns, rightToLeft, paging != "pages", paint, lineSpacing.toFloat(), pixels(margin), sections)
    pages.show(text, format, anchor)
    marked?.let(indices::get)?.let {
      current = it
      pages.highlight(words[it].start, words[it].end)
    }
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
  fun tap(x: Float, y: Float) {
    selectWord(pages.offsetAt(x - pages.left, y - pages.top))
  }

  /** The headings, verses and notes' marks a screen reader finds in sight, by where they stand, never their text. */
  fun accessibilityElementsInSight() = pages.accessibilityElementsInSight()

  /** A tap at a character: on a note's mark, it opens the note – or closes it, if it is the one open; elsewhere, it selects the word. */
  private fun selectWord(offset: Int?) {
    if (offset == null) return closeNote()
    val note = marks.indexOfFirst { offset in it.start..it.end }
    if (note >= 0) {
      if (opened == note) closeNote() else openNote(note)
      return
    }
    closeNote()
    words.indexOfFirst { offset in it.start..it.end }.takeIf { it >= 0 }?.let(::select)
  }

  /**
   * Opens a note where its mark stands – below the mark's line, or above it – in its paragraph's
   * font: see [NoteView]. The note open before closes.
   */
  private fun openNote(index: Int) {
    val note = marks.getOrNull(index) ?: return
    val anchor = pages.rectOf(note.start, note.end) ?: return
    anchor.offset(pages.left, pages.top)
    val paragraph = shownParagraphs.getOrNull(note.paragraph) ?: return
    val typeface = familyOf(paragraph)?.let(::typeface) ?: baseTypeface
    val size = maxOf(pixels(paragraph.fontSize) * 0.7f, pixels(14.0))
    opened = index
    noteView.show(noteText(note), typeface, size, textColor, backgroundColor, anchor, Rect(0, 0, width, height), pixels(margin).roundToInt(), paragraph.rightToLeft)
    requestLayout()
  }

  private fun closeNote() {
    if (opened == null) return
    opened = null
    noteView.hide()
  }

  /**
   * A note's runs as text with spans: the verse it names in the "origin" color, quotations and
   * emphasis in italics, words in other languages in their fonts and locales, and each reference a
   * link that follows it.
   */
  private fun noteText(note: ReaderNote): CharSequence {
    val builder = SpannableStringBuilder()
    val linkColor = roleColors["note"] ?: textColor
    val originColor = roleColors["origin"] ?: ColorUtils.setAlphaComponent(textColor, 153)
    val flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
    for (run in note.note.runs) {
      if (run.text == "\n") {
        builder.append("\n")
        continue
      }
      val start = builder.length
      builder.append(run.text)
      val end = builder.length
      when (run.role) {
        "origin" -> builder.setSpan(ForegroundColorSpan(originColor), start, end, flags)
        "quotation", "emphasis" -> builder.setSpan(StyleSpan(Typeface.ITALIC), start, end, flags)
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
    val from = mapOf("passage" to note.passage, "book" to note.book, "chapter" to note.note.chapter.toInt(), "verse" to note.note.verse.toInt())
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

  private fun verseStart(index: Int): Int {
    var start = index
    while (start > 0 && words[start - 1].isInVerseOf(words[index])) start--
    return start
  }

  // expo-font copies the fonts to assets/fonts, named after their PostScript names.
  private fun typeface(family: String) = typefaces.getOrPut(family) {
    runCatching { Typeface.createFromAsset(context.assets, "fonts/$family.ttf") }.getOrDefault(Typeface.DEFAULT)
  }

  /** A word of the reader's text: where it stands in the scripture, and where it is in the text. */
  private class ReaderWord(passage: Int, book: String, word: Word, textStart: Int) {
    val place = WordPlace(passage, book, word.chapter.toInt(), word.verse.toInt(), word.index.toInt())
    val start = textStart + word.start.toInt()
    val end = textStart + word.end.toInt()

    fun isInVerseOf(other: ReaderWord) = with(other.place) {
      passage == place.passage && book == place.book && chapter == place.chapter && verse == place.verse
    }
  }

  /** A note's mark in the reader's text: where it is, in which paragraph, on which verse of which book, and the note it opens. */
  private class ReaderNote(val passage: Int, val book: String, val language: String, val note: NoteMark, textStart: Int, val paragraph: Int) {
    val start = textStart + note.start.toInt()
    val end = textStart + note.end.toInt()
  }

  /** Where a word stands: in which passage, in which book – the passage's, or one read along with it – and where in the scripture. */
  data class WordPlace(val passage: Int, val book: String, val chapter: Int, val verse: Int, val index: Int)

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
    )

    /** A verse line whose number comes first, followed by a tab: the number hangs before the text. */
    val numberHangs get() = kind == "verse" && runs.firstOrNull()?.text?.endsWith("\t") == true

    /** What screen readers read of it, its text running from [start] to [end]: the heading, or each verse. */
    fun readables(start: Int, end: Int, firstWord: Int): List<Readable> {
      if (kind == "heading") return listOf(Readable(start, end, language, passage, book, 0, null, firstWord))
      // Verses and words both run in the text's order: each verse's first word is found walking on.
      var word = 0
      return verses.map { verse ->
        while (word < words.size && words[word].start < verse.start) word++
        Readable(start + verse.start.toInt(), start + verse.end.toInt(), language, passage, book, verse.chapter.toInt(), verse.verse.toInt(), firstWord + word)
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

  /** Space below a paragraph, like iOS's paragraphSpacing. */
  private class ParagraphSpacingSpan(private val spacing: Int) : LineHeightSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
      if (end == (text as Spanned).getSpanEnd(this)) {
        fm.descent += spacing
        fm.bottom += spacing
      }
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

    private const val LEFT_TO_RIGHT_MARK = "\u200E"
    private const val RIGHT_TO_LEFT_MARK = "\u200F"
    private const val HIGHLIGHT = 0xFFFFE082.toInt()
  }
}
