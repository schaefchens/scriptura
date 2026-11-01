package de.schaefchens.scriptura

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.text.style.LineHeightSpan
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

/** Space below a paragraph, like iOS's paragraphSpacing: [spacing] pixels added to its last line, which the marks' fills leave out. */
class ParagraphSpacingSpan(val spacing: Int) : LineHeightSpan {
  override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
    if (end == (text as Spanned).getSpanEnd(this)) {
      fm.descent += spacing
      fm.bottom += spacing
    }
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
 * line's baseline – or, in a font of initials, the letter itself fills the two lines. The letter with
 * its marks – an Arabic letter's vowel above it, a tail below – stays within the two lines: taller,
 * it is set smaller, and where it still reaches out, moved in.
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
    val two = second < layout.lineCount && layout.getLineStart(second) < paragraphEnd
    val at = if (two) layout.getLineBaseline(second).toFloat() else baseline + (layout.getLineBottom(line) - layout.getLineTop(line)).toFloat()
    val large = Paint(paint).apply {
      isAntiAlias = true
      textSize = size
      this@DropCapSpan.typeface?.let { typeface = it }
    }
    // The room above the baseline, up to the first line's top, and below it, down to the second's descent.
    val above = at - layout.getLineTop(line)
    val below = if (two) layout.getLineDescent(second).toFloat() else paint.descent()
    val glyphs = Rect()
    large.getTextBounds(letter, 0, letter.length, glyphs)
    val tall = (glyphs.bottom - glyphs.top).toFloat()
    if (tall > above + below) {
      large.textSize = size * (above + below) / tall
      large.getTextBounds(letter, 0, letter.length, glyphs)
    }
    val shift = when {
      glyphs.bottom > below -> below - glyphs.bottom
      -glyphs.top > above -> -glyphs.top - above
      else -> 0f
    }
    canvas.drawText(letter, if (dir >= 0) x.toFloat() else x - large.measureText(letter), at + shift, large)
  }

  companion object {
    const val LINES = 2
  }
}
