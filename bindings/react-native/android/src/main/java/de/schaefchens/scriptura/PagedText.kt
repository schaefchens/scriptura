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

/** Paragraphs of the text, from [start] to [end], that stand side by side with others: in a row, in a column of it. */
class Cell(val start: Int, val end: Int, val row: Int, val column: Int)

/**
 * How the text shows: its background, its columns and whether they and the pages run from the
 * right, the way it scrolls, its paint, line spacing and side margin – and the cells of books read
 * side by side, if any.
 */
class TextFormat(
  val background: Int,
  columns: Int,
  val rightToLeft: Boolean,
  val continuous: Boolean,
  val paint: TextPaint,
  val lineSpacing: Float,
  val margin: Float,
  val cells: List<Cell> = emptyList(),
) {
  // One endless scroll is one column, unless books stand side by side: a column each.
  val columns = when {
    cells.isNotEmpty() -> cells.maxOf { it.column } + 1
    continuous -> 1
    else -> maxOf(columns, 1)
  }
}

/**
 * The reader's text in pages turned one by one, each page in columns the text flows through, or in
 * one endless scroll. The text is laid out at a column's width and, in pages, cut into columns of
 * the view's height. The first pages come from laying out only the start of the text; the whole of
 * it is laid out on another thread, so a long book shows without a wait – and until then, what was
 * in sight stays as it was. Only what is in sight is drawn. A page follows the finger and settles;
 * the scroll flings. Screen readers get each heading and verse in sight, and turn the pages.
 *
 * Books read side by side come in cells instead, a column for each book: every cell is a place of
 * its own, level with the others in its row.
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

  /** The text as last given, which stays unchanged: the highlight is drawn instead. */
  var text: Spanned = SpannedString("")
    private set
  private var format = TextFormat(Color.WHITE, 1, false, false, TextPaint(), 1f, 0f)

  /**
   * The character the reader is at: a word it was brought to, or after a scroll, the first on the
   * page or of the line at the top. A new layout, after the device turned or the font grew, keeps
   * it in sight.
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

  /** The layout in sight, and the text, format and column width the whole text is being laid out for on another thread. */
  private var shown: Shown? = null
  private var underWay: Triple<Spanned, TextFormat, Int>? = null
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
      scrollMovesAnchor = true
      return true
    }

    override fun onScroll(start: MotionEvent?, event: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
      val shown = shown ?: return false
      parent?.requestDisallowInterceptTouchEvent(true)
      if (shown.format.continuous) {
        scrollTo(0, (scrollY + distanceY).roundToInt().coerceIn(0, shown.maxScrollY))
      } else {
        scrollTo((scrollX + distanceX).roundToInt().coerceIn(shown.scrollXRange), 0)
      }
      return true
    }

    override fun onFling(start: MotionEvent?, event: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
      val shown = shown ?: return false
      flung = true
      if (shown.format.continuous) {
        scroller.fling(0, scrollY, 0, -velocityY.toInt(), 0, 0, 0, shown.maxScrollY)
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
   * Lays the text out at a column's width – its start at once, the whole of it on another thread –
   * unless that is done or under way: a new height alone, as the view settles into its place, only
   * cuts the lines into columns anew.
   */
  private fun paginate() {
    val (text, format) = text to format
    val columnWidth = columnWidth(format, width)
    val shown = shown
    if (shown != null && shown.text === text && shown.format === format && shown.complete && shown.columnWidth == columnWidth) {
      use(Shown(text, format, shown.layout, true, width, height))
      onPaginated?.invoke(pageCount)
      return
    }
    val underWay = underWay
    if (underWay != null && underWay.first === text && underWay.second === format && underWay.third == columnWidth) return
    val run = ++generation
    // Enough text for the first pages, cut at a space. Its last line may break otherwise than in
    // the whole text, so it waits for the whole layout – and so does a reader who is further on.
    val start = text.indexOf(' ', FIRST_PAGES_LENGTH).takeIf { it > 0 } ?: text.length
    if (anchor < start) {
      val first = Shown(text, format, layoutOf(text, start, format, columnWidth), start == text.length, width, height)
      if (anchor < first.end || first.complete) {
        use(first)
        onFirstPages?.invoke()
      }
    }
    if (start == text.length) {
      onPaginated?.invoke(pageCount)
      return
    }
    this.underWay = Triple(text, format, columnWidth)
    // A copy of its own for the other thread, as this one reads the text meanwhile. Not a
    // SpannedString, which copies a span by comparing it with all the others, and looks spans up
    // by going through them all: with a verse per line, that took seconds.
    val copy = SpannableStringBuilder(text)
    thread {
      val layout = layoutOf(copy, copy.length, format, columnWidth)
      post {
        if (run != generation) return@post
        this.underWay = null
        if (this.shown?.text !== text) onFirstPages?.invoke()
        // Cut for the view as it is now: it may have changed in height meanwhile.
        use(Shown(text, format, layout, true, width, height))
        onPaginated?.invoke(pageCount)
      }
    }
  }

  private fun columnWidth(format: TextFormat, width: Int) =
    ((width - 2 * format.margin - (format.columns - 1) * gap(format)) / format.columns).toInt().coerceAtLeast(1)

  private fun gap(format: TextFormat) = maxOf(format.margin, 16 * resources.displayMetrics.density)

  // Each paragraph takes the direction of its first strong character, as in a TextView.
  private fun layoutOf(text: Spanned, end: Int, format: TextFormat, width: Int) =
    StaticLayout.Builder.obtain(text, 0, end, TextPaint(format.paint), width)
      .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_LTR)
      .setLineSpacing(0f, format.lineSpacing)
      .build()

  private fun use(shown: Shown) {
    this.shown = shown
    setBackgroundColor(shown.format.background)
    scroller.forceFinished(true)
    val line = shown.layout.getLineForOffset(minOf(anchor, shown.end))
    if (shown.format.continuous) scrollTo(0, shown.topOf(line).coerceIn(0, shown.maxScrollY)) else scrollTo(shown.scrollXOf(shown.pageOfLine(line)), 0)
    pendingSight?.let { index -> if (index < shown.end) show(characterAt = index) }
    updatePieces()
    invalidate()
  }

  /** Where the reader is: the first character on the page, or of the first whole line in sight. */
  private fun characterInSight(shown: Shown): Int {
    val layout = shown.layout
    if (!shown.format.continuous) return shown.pages.getOrNull(shown.pageAt(scrollX))?.firstOrNull()?.let { layout.getLineStart(it.firstLine) } ?: 0
    // The first line, in the text's order, that starts in sight.
    val top = (scrollY - inset).toInt()
    for (place in shown.placesBetween(top, top + height)) {
      val origin = place.top - layout.getLineTop(place.firstLine)
      var line = layout.getLineForVertical((top - origin).coerceAtLeast(0)).coerceIn(place.firstLine, place.endLine - 1)
      if (layout.getLineTop(line) + origin < top) line++
      if (line < place.endLine) return layout.getLineStart(line)
    }
    return anchor
  }

  override fun onDraw(canvas: Canvas) {
    val shown = shown ?: return
    val highlight = highlight?.takeIf { shown.text === text && it.last <= shown.end }?.let {
      shown.layout.getSelectionPath(it.first, it.last, highlightPath)
      highlightPath
    }
    if (shown.format.continuous) {
      val top = (scrollY - inset).toInt()
      canvas.save()
      canvas.clipRect(scrollX, scrollY, scrollX + width, scrollY + height)
      for (place in shown.placesBetween(top, top + height)) draw(canvas, shown, place, 0, highlight)
      canvas.restore()
      return
    }
    // The pages in sight: one, or two while turning.
    val position = scrollX / shown.width.toFloat()
    for (slot in floor(position).toInt()..ceil(position).toInt()) {
      val page = if (shown.format.rightToLeft) -slot else slot
      for (place in shown.pages.getOrNull(page).orEmpty()) draw(canvas, shown, place, shown.scrollXOf(page), highlight)
    }
  }

  /** Draws the lines of [place], and the highlight, on a page that starts [pageLeft] from the content's left. */
  private fun draw(canvas: Canvas, shown: Shown, place: Place, pageLeft: Int, highlight: Path?) {
    val layout = shown.layout
    val top = layout.getLineTop(place.firstLine)
    canvas.save()
    canvas.translate(pageLeft + place.left, inset + place.top - top)
    // Short of the next line's top: a layout draws the line that starts at the clip's bottom too,
    // and the marks above a line such as an Arabic one's would show here.
    canvas.clipRect(0, top, shown.columnWidth, layout.getLineTop(place.endLine) - 1)
    highlight?.let { canvas.drawPath(it, highlightPaint) }
    layout.draw(canvas)
    canvas.restore()
  }

  /** The offset of the character at a point in this view's pixels, if the text holds one there – or a little way around it, the nearest. */
  fun offsetAt(x: Float, y: Float): Int? {
    val shown = shown?.takeIf { it.text === text } ?: return null
    val layout = shown.layout
    val page = if (shown.format.continuous) 0 else shown.pageAt(scrollX)
    // From the page's left, and from where its text starts.
    val (pointX, pointY) = x + scrollX - shown.scrollXOf(page) to y + scrollY - inset
    val place = shown.pages.getOrNull(page).orEmpty()
      .filter { pointX >= it.left - shown.gap / 2 && pointX <= it.left + shown.columnWidth + shown.gap / 2 && pointY >= it.top - inset && pointY <= it.top + shown.heightOf(it) + inset }
      .minByOrNull { distance(pointX, pointY, it.left, it.top.toFloat(), it.left + shown.columnWidth, (it.top + shown.heightOf(it)).toFloat()) }
      ?: return null
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
    if (shown == null || characterAt >= shown.end) {
      pendingSight = characterAt
      return
    }
    pendingSight = null
    anchor = characterAt
    scrollMovesAnchor = false
    val line = shown.layout.getLineForOffset(characterAt)
    if (shown.format.continuous) {
      val top = (inset + shown.topOf(line)).toInt()
      val bottom = top + shown.layout.getLineBottom(line) - shown.layout.getLineTop(line)
      if (top < scrollY || bottom > scrollY + height) scrollSmoothly(0, (top - height / 3).coerceIn(0, shown.maxScrollY))
    } else {
      scrollSmoothly(shown.scrollXOf(shown.pageOfLine(line)), 0)
    }
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
    val shown = shown ?: return false
    scrollMovesAnchor = true
    if (shown.format.continuous) {
      val target = (scrollY + (if (forward) 1 else -1) * (height - 2 * inset).toInt()).coerceIn(0, shown.maxScrollY)
      if (target == scrollY) return false
      scrollSmoothly(0, target)
    } else {
      val page = shown.pageAt(scrollX) + if (forward) 1 else -1
      if (page !in 0 until shown.pageCount) return false
      scrollSmoothly(shown.scrollXOf(page), 0)
    }
    return true
  }

  override fun dispatchHoverEvent(event: MotionEvent) = screenReaders.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

  /** Each heading and verse in sight, cut to the columns it shows in, and where that is in the content. */
  private fun updatePieces() {
    val shown = shown
    pieces = if (shown == null || shown.text !== text) emptyList() else buildList {
      val layout = shown.layout
      // Those in the lines of a place from firstLine to before endLine, on a page pageLeft from the content's left.
      val addAll = { place: Place, firstLine: Int, endLine: Int, pageLeft: Int ->
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
            (left + shown.columnWidth).toInt(), (origin + layout.getLineBottom(layout.getLineForOffset(maxOf(end - 1, start)))).toInt(),
          )
          add(Piece(readable, start, end, bounds))
        }
      }
      if (shown.format.continuous) {
        val top = (scrollY - inset).toInt()
        for (place in shown.placesBetween(top, top + height)) {
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

  /**
   * A layout in sight: the text and format it was made for, whether it holds the whole text, the
   * size of the view it was cut for, and where its lines show – in the columns of pages or in one
   * endless scroll, or side by side, in cells.
   */
  private inner class Shown(val text: Spanned, val format: TextFormat, val layout: StaticLayout, val complete: Boolean, val width: Int, val height: Int) {
    val gap = gap(format)
    val columnWidth = columnWidth(format, width)

    /** Where the lines show, in the text's order. */
    val places: List<Place> = if (format.cells.isEmpty()) flow() else grid()

    /** The places on each page; in one endless scroll, all on one. */
    val pages: List<List<Place>> = if (format.continuous) listOf(places) else places.groupBy { it.page }.let { byPage ->
      List((places.maxOfOrNull { it.page } ?: -1) + 1) { byPage[it].orEmpty() }
    }

    val pageCount = pages.size

    /** The end of the text it shows. */
    val end = places.lastOrNull()?.let { if (it.endLine < layout.lineCount) layout.getLineStart(it.endLine) else layout.getLineEnd(layout.lineCount - 1) } ?: 0

    val maxScrollY = maxOf(((places.maxOfOrNull { it.top + heightOf(it) } ?: 0) + 2 * inset - height).toInt(), 0)

    /** The text flowing through the columns of pages, cut wherever the next line would overflow one; or in one endless scroll, in one. */
    private fun flow(): List<Place> {
      // Until the whole text is laid out, its last line may still break otherwise.
      if (format.continuous) return listOf(Place(0, if (complete) layout.lineCount else maxOf(layout.lineCount - 1, 1), 0, format.margin, 0))
      val starts = columnStarts(0, layout.lineCount)
      // Its last column waits for the whole layout.
      if (!complete && starts.size > 2) starts.removeAt(starts.lastIndex)
      return (0 until starts.size - 1).map { Place(starts[it], starts[it + 1], it / format.columns, left(it % format.columns), 0) }
    }

    /**
     * The cells in their rows, each row as tall as its tallest cell. On pages, a page holds the rows
     * that fit; a row taller than a page is cut between lines, over pages of its own.
     */
    private fun grid(): List<Place> {
      val pageHeight = (height - 2 * inset).toInt()
      // Until the whole text is laid out, its last line may still break otherwise: the rows shown end before it.
      val laidOut = if (complete) Int.MAX_VALUE else layout.getLineStart(maxOf(layout.lineCount - 1, 0))
      val cells = format.cells
      val places = mutableListOf<Place>()
      var (page, top, index) = Triple(0, 0, 0)
      while (index < cells.size) {
        var rowEnd = index
        while (rowEnd < cells.size && cells[rowEnd].row == cells[index].row) rowEnd++
        val row = cells.subList(index, rowEnd)
        if (row.last().end > laidOut) break
        index = rowEnd
        val lines = row.map { layout.getLineForOffset(it.start) to layout.getLineForOffset(maxOf(it.end - 1, it.start)) + 1 }
        val rowHeight = lines.maxOf { (first, end) -> layout.getLineTop(end) - layout.getLineTop(first) }
        if (!format.continuous && top > 0 && top + rowHeight > pageHeight) {
          page++
          top = 0
        }
        if (format.continuous || rowHeight <= pageHeight) {
          for ((cell, cellLines) in row.zip(lines)) places += Place(cellLines.first, cellLines.second, page, left(cell.column), top)
          top += rowHeight
          continue
        }
        var pages = 1
        for ((cell, cellLines) in row.zip(lines)) {
          val starts = columnStarts(cellLines.first, cellLines.second)
          for (piece in 0 until starts.size - 1) places += Place(starts[piece], starts[piece + 1], page + piece, left(cell.column), 0)
          pages = maxOf(pages, starts.size - 1)
        }
        // The next row starts on a page of its own.
        page += pages
        top = 0
      }
      return places
    }

    /** Where columns a page tall start, the lines from [from] to before [to] cut wherever the next would overflow one – and after the last, [to]. */
    private fun columnStarts(from: Int, to: Int): MutableList<Int> {
      val columnHeight = (height - 2 * inset).toInt()
      val starts = mutableListOf(from)
      while (starts.last() < to) {
        val start = starts.last()
        val bottom = layout.getLineTop(start) + columnHeight
        var end = layout.getLineForVertical(bottom)
        if (layout.getLineBottom(end) <= bottom) end++
        starts += maxOf(end, start + 1).coerceAtMost(to)
      }
      return starts
    }

    /** How far from a page's left a column starts: columns from the right run to the left. */
    private fun left(column: Int) = format.margin + (if (format.rightToLeft) format.columns - 1 - column else column) * (columnWidth + gap)

    fun heightOf(place: Place) = layout.getLineTop(place.endLine) - layout.getLineTop(place.firstLine)

    /** The place that shows a line: the last that starts at or before it. */
    private fun placeOf(line: Int): Place? {
      var (low, high) = 0 to places.size
      while (low < high) {
        val middle = (low + high) / 2
        if (places[middle].firstLine <= line) low = middle + 1 else high = middle
      }
      return places.getOrNull(low - 1)
    }

    /** How far below where the text starts a line shows: on its page, or in one endless scroll. */
    fun topOf(line: Int) = placeOf(line)?.let { it.top + layout.getLineTop(line) - layout.getLineTop(it.firstLine) } ?: layout.getLineTop(line)

    /** The places of one endless scroll that show between [top] and [bottom], below where the text starts. */
    fun placesBetween(top: Int, bottom: Int) = places.filter { it.top < bottom && it.top + heightOf(it) > top }

    /** Page `page` starts this far to the right; right-to-left pages run to the left. */
    fun scrollXOf(page: Int) = (if (format.rightToLeft) -page else page) * width

    val scrollXRange = if (format.rightToLeft) scrollXOf(maxOf(pageCount - 1, 0))..0 else 0..scrollXOf(maxOf(pageCount - 1, 0))

    fun pageAt(scrollX: Int) = ((if (format.rightToLeft) -scrollX else scrollX) / width.toFloat()).roundToInt().coerceIn(0, maxOf(pageCount - 1, 0))

    fun pageOfLine(line: Int) = placeOf(line)?.page ?: 0
  }

  /**
   * Lines of the text, from [firstLine] to before [endLine], shown on [page], [left] from its left
   * and [top] below where its text starts – in one endless scroll, in the content.
   */
  private class Place(val firstLine: Int, val endLine: Int, val page: Int, val left: Float, val top: Int)

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
