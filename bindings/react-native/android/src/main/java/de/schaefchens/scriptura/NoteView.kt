package de.schaefchens.scriptura

import android.content.Context
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.method.LinkMovementMethod
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import kotlin.math.roundToInt

/**
 * A note opened where it stands: a card below the line its mark is on – or above it, where there
 * is no room below – with text that scrolls if it is long. It shows any text with its spans: a
 * footnote, a cross reference whose verses are links, a lexicon entry. The reader lays it out at
 * its [frame] whenever it lays itself out, and taps on it are its own.
 */
class NoteView(context: Context) : FrameLayout(context) {
  private val scroll = ScrollView(context)
  private val label = TextView(context)
  private val density = resources.displayMetrics.density
  private var anchor = Rect()
  private var margin = 0

  /** Where it stands in its parent, once shown. */
  var frame = Rect()
    private set

  init {
    visibility = GONE
    isClickable = true
    isFocusable = true
    elevation = 6 * density
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    scroll.setPadding(dp(14), dp(10), dp(14), dp(10))
    scroll.addView(label, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    label.movementMethod = LinkMovementMethod.getInstance()
    label.setLineSpacing(0f, 1.15f)
    label.textAlignment = TEXT_ALIGNMENT_VIEW_START
    // Each paragraph runs in the direction of its first letter: the verses a note refers to may be
    // in another script than the note.
    label.textDirection = View.TEXT_DIRECTION_FIRST_STRONG
  }


  private fun dp(value: Int) = (value * density).roundToInt()

  /**
   * Shows [text] at [anchor] – the mark's rectangle in the parent's pixels – within [bounds], the
   * parent's area, [margin] from its sides: in [typeface] at [textSize] pixels, [color] on
   * [background], right-to-left if the text's paragraph is.
   */
  fun show(text: CharSequence, typeface: Typeface?, textSize: Float, color: Int, background: Int, anchor: Rect, bounds: Rect, margin: Int, rightToLeft: Boolean) {
    label.text = text
    label.typeface = typeface
    label.setTextSize(TypedValue.COMPLEX_UNIT_PX, textSize)
    label.setTextColor(color)
    label.layoutDirection = if (rightToLeft) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
    this.background = GradientDrawable().apply {
      cornerRadius = 8 * density
      setColor(background)
      setStroke(dp(1).coerceAtLeast(1), ColorUtils.setAlphaComponent(color, 64))
    }
    this.anchor = Rect(anchor)
    this.margin = margin
    scroll.scrollTo(0, 0)
    visibility = VISIBLE
    place(bounds)
    // A screen reader reads the note as it opens.
    label.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)
  }

  /** Measures and lays itself out in [bounds]: at most 360 dp wide and 45 % of the bounds tall. */
  fun place(bounds: Rect) {
    val width = minOf(dp(360), bounds.width() - 2 * margin).coerceAtLeast(1)
    val maxHeight = (bounds.height() * 0.45f).toInt().coerceAtLeast(1)
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST))
    val height = measuredHeight
    val gap = dp(6)
    val below = anchor.bottom + gap + height <= bounds.bottom - dp(12)
    val top = if (below) anchor.bottom + gap else maxOf(anchor.top - gap - height, bounds.top)
    val rightmost = maxOf(bounds.right - margin - width, bounds.left + margin)
    val left = anchor.left.coerceIn(bounds.left + margin, rightmost).coerceAtLeast(bounds.left)
    frame = Rect(left, top, left + width, top + height)
    layout(frame.left, frame.top, frame.right, frame.bottom)
  }

  fun hide() {
    visibility = GONE
    label.text = ""
  }
}
