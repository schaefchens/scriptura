package de.schaefchens.scriptura

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.text.style.ReplacementSpan
import kotlin.math.roundToInt

/**
 * A note's mark: its text small and raised, in its own color, taking only its own width – the
 * line keeps the height its text gives it.
 */
class MarkSpan(private val color: Int?) : ReplacementSpan() {
  private fun small(paint: Paint) = Paint(paint).apply {
    textSize = paint.textSize * SCALE
    this@MarkSpan.color?.let { color = it }
  }

  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?) =
    small(paint).measureText(text, start, end).roundToInt()

  override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    canvas.drawText(text, start, end, x, y - paint.textSize * RAISE, small(paint))
  }

  companion object {
    const val SCALE = 0.6f
    const val RAISE = 0.33f
  }
}

/** Characters kept in the text, with their offsets, but not shown: the letter a drop cap sets large instead. */
class HiddenSpan : ReplacementSpan() {
  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?) = 0

  override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {}
}

/**
 * A drop cap: the first letter of a chapter's text, set large in the margin the paragraph's first
 * two lines leave at their start, its baseline on the second line's. The [size] is the one the
 * reader worked out, so a capital stands from the first line's digit height down to the second
 * line's baseline – or, in a font of initials, the letter itself fills the two lines.
 */
class DropCapSpan(
  private val letter: String,
  private val typeface: Typeface?,
  private val size: Float,
  private val margin: Int,
) : LeadingMarginSpan.LeadingMarginSpan2 {
  override fun getLeadingMarginLineCount() = LINES

  override fun getLeadingMargin(first: Boolean) = if (first) margin else 0

  override fun drawLeadingMargin(
    canvas: Canvas, paint: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout,
  ) {
    // Drawn with the first line, which is in sight whenever the drop cap should be: on the second
    // line's baseline – or, for a paragraph of one line, where it would be.
    if (!first) return
    val line = layout.getLineForOffset(start)
    val paragraphEnd = (text as? Spanned)?.getSpanEnd(this) ?: text.length
    val second = line + 1
    val at = if (second < layout.lineCount && layout.getLineStart(second) < paragraphEnd) layout.getLineBaseline(second).toFloat()
    else baseline + (layout.getLineBottom(line) - layout.getLineTop(line)).toFloat()
    val large = Paint(paint).apply {
      isAntiAlias = true
      textSize = size
      this@DropCapSpan.typeface?.let { typeface = it }
    }
    canvas.drawText(letter, if (dir >= 0) x.toFloat() else x - large.measureText(letter), at, large)
  }

  companion object {
    const val LINES = 2
  }
}
