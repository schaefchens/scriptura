import UIKit

/// A note opened where it stands – a footnote's text, a cross reference's verses, later a lexicon
/// entry: a callout over the reader, below the place it opened at or above it where there is no
/// room below, its text scrolling if it is long, and its links followed. It knows nothing of what
/// the text is: the reader sets it, with its fonts and colors.
final class NoteView: UIView, UITextViewDelegate {
  /// A link in the text was tapped.
  var onLink: ((URL) -> Void)?
  /// VoiceOver's escape gesture: the note is to close.
  var onEscape: (() -> Void)?
  let textView = UITextView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 8
    layer.borderWidth = 1
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 8
    layer.shadowOffset = CGSize(width: 0, height: 4)
    textView.isEditable = false
    // Links are tapped only in a selectable text view.
    textView.isSelectable = true
    textView.isScrollEnabled = true
    textView.backgroundColor = .clear
    textView.textContainerInset = UIEdgeInsets(top: 10, left: 14, bottom: 10, right: 14)
    textView.textContainer.lineFragmentPadding = 0
    textView.layer.cornerRadius = 8
    textView.clipsToBounds = true
    textView.delegate = self
    textView.accessibilityTraits = .staticText
    addSubview(textView)
    isHidden = true
  }

  required init?(coder: NSCoder) {
    fatalError("not used from a storyboard")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
  }

  /// Shows `text` at `anchor`, within `area` – both in the superview's coordinates – at most
  /// `maxWidth` wide and `maxHeight` tall.
  func show(_ text: NSAttributedString, at anchor: CGRect, in area: CGRect, maxWidth: CGFloat, maxHeight: CGFloat,
            background: UIColor, border: UIColor, linkColor: UIColor) {
    textView.linkTextAttributes = [.foregroundColor: linkColor, .underlineStyle: NSUnderlineStyle.single.rawValue]
    textView.attributedText = text
    backgroundColor = background
    layer.borderColor = border.cgColor
    let width = max(min(maxWidth, area.width), 1)
    let fitting = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    let height = min(fitting.height.rounded(.up), maxHeight)
    // Below the place, if there is room for it there, else above.
    let below = anchor.maxY + 6 + height <= area.maxY
    let y = below ? anchor.maxY + 6 : max(anchor.minY - 6 - height, area.minY)
    let x = min(max(anchor.minX, area.minX), max(area.maxX - width, area.minX))
    frame = CGRect(x: x, y: y, width: width, height: height)
    textView.setContentOffset(.zero, animated: false)
    isHidden = false
  }

  func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    if interaction == .invokeDefaultAction {
      onLink?(URL)
    }
    return false
  }

  override func accessibilityPerformEscape() -> Bool {
    onEscape?()
    return true
  }
}
