package de.schaefchens.scriptura

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.SpannedString
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import android.text.style.LocaleSpan
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.OverScroller
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityEventCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat
import androidx.customview.widget.ExploreByTouchHelper
import java.util.Locale
import kotlin.concurrent.thread
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * A heading or a verse for screen readers: where it is in the text, its language, where it stands
 * in the scripture – a heading in the chapter it opens – and its first word.
 */
data class Readable(
  val start: Int,
  val end: Int,
  val language: String,
  val passage: Int,
  val book: String,
  val chapter: Int,
  val verse: Int?,
  val firstWord: Int,
)

/**
 * Paragraphs of the text, from [start] to [end], that stand side by side with others: in a row, in a
 * column of it, and whether they are headings, which go on a page only with the row after them.
 */
class Cell(val start: Int, val end: Int, val row: Int, val column: Int, val heading: Boolean = false)

/** Paragraphs of the text, from [start] to [end], laid out on their own terms: flowing through a page's columns, or in [cells] side by side. */
class Section(val start: Int, val end: Int, val cells: List<Cell> = emptyList())

/**
 * How the text shows: its background, its columns and whether they and the pages run from the
 * right, the way it scrolls, its paint, line spacing and side margin – and its sections.
 */
class TextFormat(
  val background: Int,
  columns: Int,
  val rightToLeft: Boolean,
  val continuous: Boolean,
  val paint: TextPaint,
  val lineSpacing: Float,
  val margin: Float,
  val sections: List<Section>,
) {
  /** The columns of a page that flowing text runs through; one endless scroll is one column. */
  val columns = if (continuous) 1 else maxOf(columns, 1)

  /** A section's columns: a page's, or a book's side by side. */
  fun columnsOf(section: Section) = if (section.cells.isEmpty()) columns else section.cells.maxOf { it.column } + 1
}

/**
 * The reader's text in pages turned one by one, each page in columns the text flows through, or in
 * one endless scroll. The text is laid out at a column's width and, in pages, cut into columns of
 * the view's height. The first pages come from laying out only the start of the text, to a
 * paragraph's end; the whole of it is laid out on another thread, so a long book shows without a
 * wait – and until then, what was in sight stays as it was. Only what is in sight is drawn. A page
 * follows the finger and settles; the scroll flings. Screen readers get each heading and verse in
 * sight, and turn the pages.
 *
 * The text comes in sections, each laid out at its own width: text that flows, or books read along
 * side by side, in cells, a column for each book, each row level. In pages, each section starts a
 * page.
 */
class PagedText(context: Context) : View(context) {
  /** A tapped character, by its offset in the text. */
  var onTap: ((Int) -> Unit)? = null

  /** The first pages show. */
  var onFirstPages: (() -> Unit)? = null

  /** All pages are laid out, this many – or in one endless scroll, 0. */
  var onPaginated: ((Int) -> Unit)? = null

  /** A screen reader's move through the words, such as "word+1", from a heading or verse. */
  var onAccessibilityMove: ((String, Readable) -> Unit)? = null

  /** A scroll or a page turn by hand begins – or by a screen reader, or by turn(). */
  var onScrollByHand: (() -> Unit)? = null

  /** The text as last given, which stays unchanged: the highlight is drawn instead. */
  var text: Spanned = SpannedString("")
    private set
  private var format = TextFormat(Color.WHITE, 1, false, false, TextPaint(), 1f, 0f, emptyList())

  /**
   * The character the reader is at: a word it was brought to, or during and after a scroll by hand,
   * the first on the page or of the line at the top – where the scroll comes to rest. A new layout,
   * after the device turned or the font grew, keeps it in sight.
   */
  var anchor = 0
    private set

  /** Whether the scroll under way, by hand or by a screen reader, moves the anchor when it ends. */
  private var scrollMovesAnchor = false

  /** What screen readers read, in the text's order. */
  var readables: List<Readable> = emptyList()

  var highlightColor: Int
    get() = highlightPaint.color
    set(value) {
      highlightPaint.color = value
    }

  /** The layout in sight, and the text, format and sections' widths the whole text is being laid out for on another thread. */
  private var shown: Shown? = null
  private var underWay: Triple<Spanned, TextFormat, List<Int>>? = null
  private val inset = 12 * resources.displayMetrics.density

  /** Counts the layouts begun, so one that a newer one replaced is dropped. */
  private var generation = 0
  private var highlight: IntRange? = null
  /** A character to bring into sight once the layout reaches it. */
  private var pendingSight: Int? = null
  private val highlightPath = Path()
  private val highlightPaint = Paint()
  private val scroller = OverScroller(context)
  private var flung = false
  /** Whether a finger is on the text, and whether it moved it since it came down. */
  private var touching = false
  private var moved = false

  /** The headings and verses in sight, each cut to a column: what screen readers find. */
  private var pieces: List<Piece> = emptyList()
  private val screenReaders = ScreenReaders()
  /** The word last reached, which the piece holding it gives screen readers as its state. */
  private var spoken: IntRange? = null
  private var focusSpokenOnSettle = false

  init {
    ViewCompat.setAccessibilityDelegate(this, screenReaders)
  }

  /** The pages laid out so far; in one endless scroll, 0. */
  val pageCount get() = shown?.takeUnless { it.format.continuous }?.pageCount ?: 0

  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(event: MotionEvent): Boolean {
      scroller.forceFinished(true)
      flung = false
      moved = false
      scrollMovesAnchor = true
      return true
    }

    override fun onScroll(start: MotionEvent?, event: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
      val shown = shown ?: return false
      if (!moved) {
        moved = true
        onScrollByHand?.invoke()
      }
      parent?.requestDisallowInterceptTouchEvent(true)
      if (shown.format.continuous) {
        scrollTo(0, (scrollY + distanceY).roundToInt().coerceIn(0, shown.maxScrollY))
      } else {
        scrollTo((scrollX + distanceX).roundToInt().coerceIn(shown.scrollXRange), 0)
      }
      if (shown.text === text) anchor = characterInSight(shown)
      return true
    }

    override fun onFling(start: MotionEvent?, event: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
      val shown = shown ?: return false
      flung = true
      if (shown.format.continuous) {
        scroller.fling(0, scrollY, 0, -velocityY.toInt(), 0, 0, 0, shown.maxScrollY)
        if (shown.text === text) anchor = characterInSight(shown, y = scroller.finalY)
        postInvalidateOnAnimation()
      } else {
        // A fling to the left scrolls right: to the next page, or for pages from the right, the one before.
        val page = (scrollX / shown.width.toFloat()).let { if (velocityX < 0) ceil(it) else floor(it) }.toInt() * shown.width
        scrollSmoothly(page.coerceIn(shown.scrollXRange), 0)
      }
      return true
    }

    override fun onSingleTapUp(event: MotionEvent): Boolean {
      offsetAt(event.x, event.y)?.let { onTap?.invoke(it) }
      return true
    }
  })

  /** Shows [text] in [format], from the character at [anchor] on. */
  fun show(text: Spanned, format: TextFormat, anchor: Int) {
    this.text = text
    this.format = format
    this.anchor = anchor
    highlight = null
    spoken = null
    pendingSight = null
    if (width > 0 && height > 0) paginate()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    if (width > 0 && height > 0) paginate()
  }

  /**
   * Lays each section out at its width – a reader at the start sees the first pages at once, the
   * sections up to enough text for them, the last to a paragraph's end; the whole text is laid out
   * on another thread – unless that is done or under way: a new height alone, as the view settles
   * into its place, only cuts the lines into columns anew.
   */
  private fun paginate() {
    val (text, format) = text to format
    val widths = format.sections.map { columnWidth(format, width, it) }
    val shown = shown
    if (shown != null && shown.text === text && shown.format === format && shown.complete && shown.widths == widths) {
      use(Shown(text, format, widths, shown.laid, true, width, height))
      onPaginated?.invoke(pageCount)
      return
    }
    val underWay = underWay
    if (underWay != null && underWay.first === text && underWay.second === format && underWay.third == widths) return
    val run = ++generation
    // Paragraphs break into the same lines on their own as in the whole text. A reader further on
    // waits for the whole layout.
    if (anchor < FIRST_PAGES_LENGTH) {
      val first = firstSections(text, format, widths)
      val complete = first.size == format.sections.size && first.last().end == first.last().section.end
      use(Shown(text, format, widths, first, complete, width, height))
      onFirstPages?.invoke()
      if (complete) {
        onPaginated?.invoke(pageCount)
        return
      }
    }
    this.underWay = Triple(text, format, widths)
    // A copy of its own for the other thread, as this one reads the text meanwhile. Not a
    // SpannedString, which copies a span by comparing it with all the others, and looks spans up
    // by going through them all: with a verse per line, that took seconds.
    val copy = SpannableStringBuilder(text)
    thread {
      val laid = format.sections.mapIndexed { index, section -> LaidSection(section, widths[index], layoutOf(copy, section.start, section.end, format, widths[index]), section.end) }
      post {
        if (run != generation) return@post
        this.underWay = null
        if (this.shown?.text !== text) onFirstPages?.invoke()
        // Cut for the view as it is now: it may have changed in height meanwhile.
        use(Shown(text, format, widths, laid, true, width, height))
        onPaginated?.invoke(pageCount)
      }
    }
  }

  /** The sections up to [FIRST_PAGES_LENGTH] characters into the text, laid out – the last to the end of the paragraph there, without its newline. */
  private fun firstSections(text: Spanned, format: TextFormat, widths: List<Int>) = buildList {
    for ((index, section) in format.sections.withIndex()) {
      if (section.start >= FIRST_PAGES_LENGTH && isNotEmpty()) break
      val end = if (section.end <= FIRST_PAGES_LENGTH) section.end else text.indexOf('\n', FIRST_PAGES_LENGTH).takeIf { it in 0 until section.end } ?: section.end
      add(LaidSection(section, widths[index], layoutOf(text, section.start, end, format, widths[index]), end))
      if (end < section.end) break
    }
  }

  private fun columnWidth(format: TextFormat, width: Int, section: Section): Int {
    val columns = format.columnsOf(section)
    return ((width - 2 * format.margin - (columns - 1) * gap(format)) / columns).toInt().coerceAtLeast(1)
  }

  private fun gap(format: TextFormat) = maxOf(format.margin, 16 * resources.displayMetrics.density)

  // Each paragraph takes the direction of its first strong character, as in a TextView.
  private fun layoutOf(text: Spanned, start: Int, end: Int, format: TextFormat, width: Int) =
    StaticLayout.Builder.obtain(text, start, end, TextPaint(format.paint), width)
      .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
      .setLineSpacing(0f, format.lineSpacing)
      .build()

  private fun use(shown: Shown) {
    this.shown = shown
    setBackgroundColor(shown.format.background)
    scroller.forceFinished(true)
    val offset = minOf(anchor, shown.end)
    if (shown.format.continuous) scrollTo(0, shown.topOf(offset).coerceIn(0, shown.maxScrollY)) else scrollTo(shown.scrollXOf(shown.pageOf(offset)), 0)
    pendingSight?.let { index -> if (index < shown.end || shown.complete) show(characterAt = index) }
    updatePieces()
    invalidate()
  }

  /** Where the reader is, scrolled to [x] and [y]: the first character on the page, or of the first whole line in sight. */
  private fun characterInSight(shown: Shown, x: Int = scrollX, y: Int = scrollY): Int {
    if (!shown.format.continuous) return shown.pages.getOrNull(shown.pageAt(x))?.firstOrNull()?.start ?: 0
    // The first line, in the text's order, that starts in sight.
    val top = (y - inset).toInt()
    for (place in shown.placesBetween(top, top + height)) {
      val layout = place.layout
      val origin = place.top - layout.getLineTop(place.firstLine)
      var line = layout.getLineForVertical((top - origin).coerceAtLeast(0)).coerceIn(place.firstLine, place.endLine - 1)
      if (layout.getLineTop(line) + origin < top) line++
      if (line < place.endLine) return layout.getLineStart(line)
    }
    return anchor
  }

  override fun onDraw(canvas: Canvas) {
    val shown = shown ?: return
    // In the layout of the section it is in.
    val highlighted = highlight?.takeIf { shown.text === text && it.last <= shown.end }?.let { range ->
      shown.placeOf(range.first)?.layout?.also { it.getSelectionPath(range.first, range.last, highlightPath) }
    }
    if (shown.format.continuous) {
      val top = (scrollY - inset).toInt()
      canvas.save()
      canvas.clipRect(scrollX, scrollY, scrollX + width, scrollY + height)
      for (place in shown.placesBetween(top, top + height)) draw(canvas, place, 0, highlighted)
      canvas.restore()
      return
    }
    // The pages in sight: one, or two while turning.
    val position = scrollX / shown.width.toFloat()
    for (slot in floor(position).toInt()..ceil(position).toInt()) {
      val page = if (shown.format.rightToLeft) -slot else slot
      for (place in shown.pages.getOrNull(page).orEmpty()) draw(canvas, place, shown.scrollXOf(page), highlighted)
    }
  }

  /** Draws the lines of [place] on a page that starts [pageLeft] from the content's left – and the highlight, if it is in [highlighted]. */
  private fun draw(canvas: Canvas, place: Place, pageLeft: Int, highlighted: StaticLayout?) {
    val layout = place.layout
    val top = layout.getLineTop(place.firstLine)
    canvas.save()
    canvas.translate(pageLeft + place.left, inset + place.top - top)
    // Short of the next line's top: a layout draws the line that starts at the clip's bottom too,
    // and the marks above a line such as an Arabic one's would show here.
    canvas.clipRect(0, top, place.width, layout.getLineTop(place.endLine) - 1)
    if (layout === highlighted) canvas.drawPath(highlightPath, highlightPaint)
    layout.draw(canvas)
    canvas.restore()
  }

  /** The offset of the character at a point in this view's pixels, if the text holds one there – or a little way around it, the nearest. */
  fun offsetAt(x: Float, y: Float): Int? {
    val shown = shown?.takeIf { it.text === text } ?: return null
    val page = if (shown.format.continuous) 0 else shown.pageAt(scrollX)
    // From the page's left, and from where its text starts.
    val (pointX, pointY) = x + scrollX - shown.scrollXOf(page) to y + scrollY - inset
    val place = shown.pages.getOrNull(page).orEmpty()
      .filter { pointX >= it.left - shown.gap / 2 && pointX <= it.left + it.width + shown.gap / 2 && pointY >= it.top - inset && pointY <= it.top + it.height + inset }
      .minByOrNull { distance(pointX, pointY, it.left, it.top.toFloat(), it.left + it.width, (it.top + it.height).toFloat()) }
      ?: return null
    val layout = place.layout
    val origin = place.top - layout.getLineTop(place.firstLine)
    val line = layout.getLineForVertical((pointY - origin).toInt()).coerceIn(place.firstLine, place.endLine - 1)
    return layout.getOffsetForHorizontal(line, pointX - place.left)
  }

  /** Highlights the text from [start] to [end]. */
  fun highlight(start: Int, end: Int) {
    highlight = start..end
    invalidate()
  }

  /**
   * Brings the character at [characterAt] into sight, once it is laid out: turns to its page, or in
   * one endless scroll moves it a third of the way down, if it is out of sight.
   */
  fun show(characterAt: Int) {
    val shown = shown?.takeIf { it.text === text }
    if (shown == null || (characterAt >= shown.end && !shown.complete)) {
      pendingSight = characterAt
      return
    }
    pendingSight = null
    anchor = characterAt
    scrollMovesAnchor = false
    if (shown.format.continuous) {
      val layout = shown.placeOf(characterAt)?.layout ?: return
      val line = layout.getLineForOffset(characterAt)
      val top = (inset + shown.topOf(characterAt)).toInt()
      val bottom = top + layout.getLineBottom(line) - layout.getLineTop(line)
      if (top < scrollY || bottom > scrollY + height) scrollSmoothly(0, (top - height / 3).coerceIn(0, shown.maxScrollY))
    } else {
      scrollSmoothly(shown.scrollXOf(shown.pageOf(characterAt)), 0)
    }
  }

  /** Whether the character at [offset] is in sight: on the page shown, or in one endless scroll, its line wholly in view. */
  fun isInSight(offset: Int): Boolean {
    val shown = shown?.takeIf { it.text === text } ?: return false
    if (offset >= shown.end && !shown.complete) return false
    if (!shown.format.continuous) return shown.pageOf(offset) == shown.pageAt(scrollX)
    val layout = shown.placeOf(offset)?.layout ?: return false
    val line = layout.getLineForOffset(offset)
    val top = (inset + shown.topOf(offset)).toInt()
    val bottom = top + layout.getLineBottom(line) - layout.getLineTop(line)
    return top >= scrollY && bottom <= scrollY + height
  }

  /** Whether a finger moves the text, or it still glides or settles after one. */
  val isScrollingByHand get() = touching || (scrollMovesAnchor && !scroller.isFinished)

  /** Turns to the next or previous page, or scrolls a screen down or up, as a hand would. False at the first or last page, or the top or bottom. */
  fun turn(forward: Boolean): Boolean {
    val shown = shown ?: return false
    if (shown.format.continuous) {
      val target = (scrollY + (if (forward) 1 else -1) * (height - 2 * inset).toInt()).coerceIn(0, shown.maxScrollY)
      if (target == scrollY) return false
      onScrollByHand?.invoke()
      scrollMovesAnchor = true
      scrollSmoothly(0, target)
    } else {
      val page = shown.pageAt(scrollX) + if (forward) 1 else -1
      if (page !in 0 until shown.pageCount) return false
      onScrollByHand?.invoke()
      scrollMovesAnchor = true
      scrollSmoothly(shown.scrollXOf(page), 0)
    }
    return true
  }

  /** The word just reached, from [start] to [end], for screen readers: the piece that holds it says it, and gets their focus. */
  fun speak(start: Int, end: Int) {
    spoken = start until end
    val manager = context.getSystemService(AccessibilityManager::class.java)
    if (manager?.isTouchExplorationEnabled != true) return
    focusSpokenOnSettle = !focusSpoken()
  }

  private fun focusSpoken(): Boolean {
    val spoken = spoken ?: return true
    val piece = pieces.indexOfFirst { spoken.first in it.start until it.end }
    if (piece < 0) return false
    if (screenReaders.accessibilityFocusedVirtualViewId == piece) {
      screenReaders.invalidateVirtualView(piece, AccessibilityEventCompat.CONTENT_CHANGE_TYPE_STATE_DESCRIPTION)
    } else {
      screenReaders.getAccessibilityNodeProvider(this)?.performAction(piece, AccessibilityNodeInfoCompat.ACTION_ACCESSIBILITY_FOCUS, null)
    }
    return true
  }

  private fun scrollSmoothly(x: Int, y: Int) {
    // A scroll by hand that settles, or a turn: the reader is where it will rest.
    val shown = shown
    if (scrollMovesAnchor && shown != null && shown.text === text) anchor = characterInSight(shown, x, y)
    if (x == scrollX && y == scrollY) return settled()
    scroller.startScroll(scrollX, scrollY, x - scrollX, y - scrollY, PAGE_TURN_MILLISECONDS)
    postInvalidateOnAnimation()
  }

  override fun computeScroll() {
    if (!scroller.computeScrollOffset()) return
    scrollTo(scroller.currX, scroller.currY)
    if (scroller.isFinished) settled() else postInvalidateOnAnimation()
  }

  /** The page or scroll came to rest: after a scroll by hand, the reader is where it ended – unless a new text is being laid out. */
  private fun settled() {
    val shown = shown
    if (scrollMovesAnchor && shown != null && shown.text === text) anchor = characterInSight(shown)
    updatePieces()
    if (focusSpokenOnSettle) focusSpokenOnSettle = !focusSpoken()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> touching = true
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> touching = false
    }
    gestures.onTouchEvent(event)
    val shown = shown
    if (shown != null && (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) && !flung) {
      if (shown.format.continuous) settled() else scrollSmoothly((scrollX / shown.width.toFloat()).roundToInt() * shown.width, 0)
    }
    return true
  }

  /** A screen reader's scroll: a page forward or back, or a screen down or up. */
  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    val forward = when (action) {
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> true
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> false
      else -> return super.performAccessibilityAction(action, arguments)
    }
    return turn(forward)
  }

  override fun dispatchHoverEvent(event: MotionEvent) = screenReaders.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

  /** Each heading and verse in sight, cut to the columns it shows in, and where that is in the content. */
  private fun updatePieces() {
    val shown = shown
    pieces = if (shown == null || shown.text !== text) emptyList() else buildList {
      // Those in the lines of a place from firstLine to before endLine, on a page pageLeft from the content's left.
      val addAll = { place: Place, firstLine: Int, endLine: Int, pageLeft: Int ->
        val layout = place.layout
        val from = layout.getLineStart(firstLine)
        val to = layout.getLineEnd(endLine - 1)
        val left = pageLeft + place.left
        val origin = inset + place.top - layout.getLineTop(place.firstLine)
        var index = readables.firstEndingAfter(from)
        while (index < readables.size && readables[index].start < to) {
          val readable = readables[index++]
          val (start, end) = maxOf(readable.start, from) to minOf(readable.end, to)
          val bounds = Rect(
            left.toInt(), (origin + layout.getLineTop(layout.getLineForOffset(start))).toInt(),
            (left + place.width).toInt(), (origin + layout.getLineBottom(layout.getLineForOffset(maxOf(end - 1, start)))).toInt(),
          )
          add(Piece(readable, start, end, bounds))
        }
      }
      if (shown.format.continuous) {
        val top = (scrollY - inset).toInt()
        for (place in shown.placesBetween(top, top + height)) {
          val layout = place.layout
          val origin = place.top - layout.getLineTop(place.firstLine)
          val first = layout.getLineForVertical((top - origin).coerceAtLeast(0)).coerceIn(place.firstLine, place.endLine - 1)
          val last = layout.getLineForVertical(top + height - origin).coerceIn(place.firstLine, place.endLine - 1)
          addAll(place, first, last + 1, 0)
        }
      } else {
        val page = shown.pageAt(scrollX)
        for (place in shown.pages.getOrNull(page).orEmpty()) addAll(place, place.firstLine, place.endLine, shown.scrollXOf(page))
      }
    }
    screenReaders.invalidateRoot()
  }

  /** The headings and verses in sight, as JS may see them: where they stand and where they are, in dp, but not their text. */
  fun accessibilityElementsInSight(): List<Map<String, Any?>> {
    val density = resources.displayMetrics.density
    return pieces.map { piece ->
      val bounds = Rect(piece.bounds).apply { offset(-scrollX, -scrollY) }
      mapOf(
        "passage" to piece.readable.passage, "book" to piece.readable.book, "chapter" to piece.readable.chapter, "verse" to piece.readable.verse,
        "language" to piece.readable.language,
        "frame" to listOf(bounds.left, bounds.top, bounds.width(), bounds.height()).map { (it / density * 10).roundToInt() / 10.0 },
      )
    }
  }

  /** A section laid out at its column's [width]: all of it, or the first part, up to [end]. */
  private class LaidSection(val section: Section, val width: Int, val layout: StaticLayout, val end: Int)

  /** Places of the text, and the page and how far down the next section starts. */
  private class Placed(val places: List<Place>, val page: Int, val top: Int)

  /** A row of a section's cells: their lines, each from the first to before the second, and how tall its tallest is. */
  private class Row(val cells: List<Cell>, val lines: List<Pair<Int, Int>>, val height: Int) {
    val heading = cells.all { it.heading }
  }

  /**
   * A layout in sight: the text and format it was made for, each section's width, the sections laid
   * out – all of them or the first – the size of the view it was cut for, and where its lines show:
   * each section on pages of its own, flowing through the columns or in rows of cells side by side,
   * or in one endless scroll, each under the one before.
   */
  private inner class Shown(
    val text: Spanned,
    val format: TextFormat,
    val widths: List<Int>,
    val laid: List<LaidSection>,
    val complete: Boolean,
    val width: Int,
    val height: Int,
  ) {
    val gap = gap(format)

    /** Where the lines show, in the text's order. */
    val places: List<Place> = buildList {
      var (page, top) = 0 to 0
      for (section in laid) {
        val placed = if (section.section.cells.isEmpty()) flow(section, page, top) else grid(section, page, top)
        addAll(placed.places)
        page = placed.page
        top = placed.top
      }
    }

    /** The places on each page; in one endless scroll, all on one. */
    val pages: List<List<Place>> = if (format.continuous) listOf(places) else places.groupBy { it.page }.let { byPage ->
      List((places.maxOfOrNull { it.page } ?: -1) + 1) { byPage[it].orEmpty() }
    }

    val pageCount = pages.size

    /** The end of the text it shows. */
    val end = places.lastOrNull()?.let { it.layout.getLineEnd(it.endLine - 1) } ?: 0

    val maxScrollY = maxOf(((places.maxOfOrNull { it.top + it.height } ?: 0) + 2 * inset - height).toInt(), 0)

    /** A section that flows through the columns of pages from [first] on, cut wherever the next line would overflow one; or in one endless scroll, from [top] down, in one. */
    private fun flow(section: LaidSection, first: Int, top: Int): Placed {
      val layout = section.layout
      if (format.continuous) {
        val place = Place(layout, 0, layout.lineCount, 0, format.margin, top, section.width)
        return Placed(listOf(place), first, top + place.height)
      }
      val starts = columnStarts(layout, 0, layout.lineCount)
      val columns = format.columns
      val places = (0 until starts.size - 1).map { Place(layout, starts[it], starts[it + 1], first + it / columns, left(it % columns, columns, section.width), 0, section.width) }
      return Placed(places, first + (places.size + columns - 1) / columns, top)
    }

    /**
     * A section's cells in their rows, each row as tall as its tallest cell. On pages from [first] on,
     * a page holds the rows that fit, and a row of headings only with the row after it. A row that
     * doesn't fit on a page, or below the headings it follows, is cut between lines and runs on over
     * the pages after. In one endless scroll, the rows stand under each other from [start] down. Only
     * rows laid out to their end show.
     */
    private fun grid(section: LaidSection, first: Int, start: Int): Placed {
      val layout = section.layout
      val pageHeight = (height - 2 * inset).toInt()
      val cells = section.section.cells
      val columns = format.columnsOf(section.section)
      val rows = mutableListOf<Row>()
      var index = 0
      while (index < cells.size) {
        var rowEnd = index
        while (rowEnd < cells.size && cells[rowEnd].row == cells[index].row) rowEnd++
        val row = cells.subList(index, rowEnd)
        if (row.last().end > section.end) break
        index = rowEnd
        val lines = row.map { layout.getLineForOffset(it.start) to layout.getLineForOffset(maxOf(it.end - 1, it.start)) + 1 }
        rows += Row(row, lines, lines.maxOf { (firstLine, endLine) -> layout.getLineTop(endLine) - layout.getLineTop(firstLine) })
      }
      val places = mutableListOf<Place>()
      var page = first
      var top = if (format.continuous) start else 0
      // Whether the row before is of headings on this page, which this one goes on from.
      var underHeadings = false
      for ((at, row) in rows.withIndex()) {
        // Headings go on a page only with the row after them, as much of it as a page holds.
        val next = if (row.heading && at + 1 < rows.size) minOf(rows[at + 1].height, pageHeight) else 0
        if (!format.continuous && top > 0 && !underHeadings && top + row.height + next > pageHeight) {
          page++
          top = 0
        }
        underHeadings = row.heading
        if (format.continuous || top + row.height <= pageHeight) {
          for ((cell, cellLines) in row.cells.zip(row.lines)) places += Place(layout, cellLines.first, cellLines.second, page, left(cell.column, columns, section.width), top, section.width)
          top += row.height
          continue
        }
        // Cut between lines: on this page below what stands on it, then on pages of their own.
        var pages = 1
        for ((cell, cellLines) in row.cells.zip(row.lines)) {
          val starts = columnStarts(layout, cellLines.first, cellLines.second, pageHeight - top)
          for (piece in 0 until starts.size - 1) places += Place(layout, starts[piece], starts[piece + 1], page + piece, left(cell.column, columns, section.width), if (piece == 0) top else 0, section.width)
          pages = maxOf(pages, starts.size - 1)
        }
        // The next row starts on a page of its own.
        page += pages
        top = 0
        underHeadings = false
      }
      // In pages, the next section starts on a page of its own.
      return Placed(places, if (format.continuous || top == 0) page else page + 1, top)
    }

    /**
     * Where columns a page tall start – the first [first] tall – a layout's lines from [from] to before
     * [to] cut wherever the next would overflow one; and after the last, [to].
     */
    private fun columnStarts(layout: StaticLayout, from: Int, to: Int, first: Int = (height - 2 * inset).toInt()): MutableList<Int> {
      val columnHeight = (height - 2 * inset).toInt()
      val starts = mutableListOf(from)
      while (starts.last() < to) {
        val start = starts.last()
        val bottom = layout.getLineTop(start) + if (start == from) first else columnHeight
        var end = layout.getLineForVertical(bottom)
        if (layout.getLineBottom(end) <= bottom) end++
        starts += maxOf(end, start + 1).coerceAtMost(to)
      }
      return starts
    }

    /** How far from a page's left a column of [width] starts, of [columns]: columns from the right run to the left. */
    private fun left(column: Int, columns: Int, width: Int) = format.margin + (if (format.rightToLeft) columns - 1 - column else column) * (width + gap)

    /** The place that shows the character at [offset]: the last that starts at or before it. */
    fun placeOf(offset: Int): Place? {
      var (low, high) = 0 to places.size
      while (low < high) {
        val middle = (low + high) / 2
        if (places[middle].start <= offset) low = middle + 1 else high = middle
      }
      return places.getOrNull(low - 1)
    }

    /** How far below where the text starts the line of the character at [offset] shows: on its page, or in one endless scroll. */
    fun topOf(offset: Int): Int {
      val place = placeOf(offset) ?: return 0
      val layout = place.layout
      return place.top + layout.getLineTop(layout.getLineForOffset(offset)) - layout.getLineTop(place.firstLine)
    }

    /** The places of one endless scroll that show between [top] and [bottom], below where the text starts. */
    fun placesBetween(top: Int, bottom: Int) = places.filter { it.top < bottom && it.top + it.height > top }

    /** Page `page` starts this far to the right; right-to-left pages run to the left. */
    fun scrollXOf(page: Int) = (if (format.rightToLeft) -page else page) * width

    val scrollXRange = if (format.rightToLeft) scrollXOf(maxOf(pageCount - 1, 0))..0 else 0..scrollXOf(maxOf(pageCount - 1, 0))

    fun pageAt(scrollX: Int) = ((if (format.rightToLeft) -scrollX else scrollX) / width.toFloat()).roundToInt().coerceIn(0, maxOf(pageCount - 1, 0))

    fun pageOf(offset: Int) = placeOf(offset)?.page ?: 0
  }

  /**
   * A layout's lines, from [firstLine] to before [endLine], shown on [page], [left] from its left
   * and [top] below where its text starts – in one endless scroll, in the content – in a column [width] wide.
   */
  private class Place(val layout: StaticLayout, val firstLine: Int, val endLine: Int, val page: Int, val left: Float, val top: Int, val width: Int) {
    val start get() = layout.getLineStart(firstLine)
    val height get() = layout.getLineTop(endLine) - layout.getLineTop(firstLine)
  }

  /** A heading or verse in sight, cut to one column, and where it is in the content. */
  private class Piece(val readable: Readable, val start: Int, val end: Int, val bounds: Rect)

  private inner class ScreenReaders : ExploreByTouchHelper(this@PagedText) {
    override fun getVirtualViewAt(x: Float, y: Float): Int {
      val index = pieces.indexOfFirst { it.bounds.contains((x + scrollX).toInt(), (y + scrollY).toInt()) }
      return if (index >= 0) index else INVALID_ID
    }

    override fun getVisibleVirtualViews(ids: MutableList<Int>) {
      ids += pieces.indices
    }

    override fun onPopulateNodeForVirtualView(id: Int, node: AccessibilityNodeInfoCompat) {
      val piece = pieces.getOrNull(id)
      if (piece == null) {
        node.text = ""
        node.setBoundsInParent(Rect())
        return
      }
      // TalkBack reads a piece with the voice of its language.
      node.text = SpannableString(text.subSequence(piece.start, piece.end).toString()).apply {
        setSpan(LocaleSpan(Locale.forLanguageTag(piece.readable.language)), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      node.setBoundsInParent(piece.bounds)
      node.isHeading = piece.readable.verse == null
      spoken?.takeIf { it.first in piece.start until piece.end }?.let { node.stateDescription = text.subSequence(it.first, it.last + 1) }
      for ((action, label, _) in MOVES) node.addAction(AccessibilityActionCompat(action, label))
    }

    override fun onPerformActionForVirtualView(id: Int, action: Int, arguments: Bundle?): Boolean {
      val piece = pieces.getOrNull(id) ?: return false
      val step = MOVES.firstOrNull { it.first == action }?.third ?: return false
      onAccessibilityMove?.invoke(step, piece.readable)
      return true
    }

    override fun onPopulateNodeForHost(node: AccessibilityNodeInfoCompat) {
      node.isScrollable = true
      node.addAction(AccessibilityActionCompat.ACTION_SCROLL_FORWARD)
      node.addAction(AccessibilityActionCompat.ACTION_SCROLL_BACKWARD)
    }
  }

  private companion object {
    /** Characters laid out at once: enough for the first pages, even in four columns. */
    const val FIRST_PAGES_LENGTH = 8000
    const val PAGE_TURN_MILLISECONDS = 250

    /** The moves as accessibility actions, which TalkBack offers in its actions menu. */
    val MOVES = listOf(
      Triple(R.id.scriptura_next_word, "Next word", "word+1"),
      Triple(R.id.scriptura_previous_word, "Previous word", "word-1"),
      Triple(R.id.scriptura_next_verse, "Next verse", "verse+1"),
      Triple(R.id.scriptura_previous_verse, "Previous verse", "verse-1"),
    )
  }
}

private fun distance(x: Float, y: Float, left: Float, top: Float, right: Float, bottom: Float) =
  hypot(maxOf(left - x, 0f, x - right), maxOf(top - y, 0f, y - bottom))

/** The first readable that ends after [offset], in a list sorted by position. */
private fun List<Readable>.firstEndingAfter(offset: Int): Int {
  var (low, high) = 0 to size
  while (low < high) {
    val middle = (low + high) / 2
    if (this[middle].end <= offset) low = middle + 1 else high = middle
  }
  return low
}
