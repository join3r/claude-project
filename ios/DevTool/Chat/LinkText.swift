import SwiftUI
import UIKit

/// Read-only text backed by a `UITextView`, so links behave like links:
/// tap opens, long-press shows the system link menu (Open, Copy Link, Share),
/// and the text can be partly selected. Bare URLs are detected too.
/// SwiftUI `Text` with `.textSelection(.enabled)` offers neither on iOS.
struct LinkText: UIViewRepresentable {
    let text: NSAttributedString
    /// Longest line width; set for content in a horizontal scroll view (table cells).
    var maxWidth: CGFloat = .infinity
    var linkColor: UIColor? = nil

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = .link
        view.adjustsFontForContentSizeCategory = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if !view.attributedText.isEqual(to: text) {
            view.attributedText = text
        }
        if let linkColor {
            view.linkTextAttributes = [
                .foregroundColor: linkColor,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ]
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let limit = min(proposal.width ?? maxWidth, maxWidth)
        let bound = limit.isFinite ? max(limit, 1) : CGFloat.greatestFiniteMagnitude
        let rect = text.boundingRect(
            with: CGSize(width: bound, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        // Fill an offered width; hug the text when none (or an unbounded one) is offered.
        let width = limit.isFinite && proposal.width != nil ? limit : ceil(rect.width)
        return CGSize(width: width, height: ceil(rect.height))
    }
}

extension LinkText {
    /// Inline Markdown (as parsed by `MarkdownText.inline`) in a Dynamic Type style.
    static func attributed(
        _ inline: AttributedString,
        style: UIFont.TextStyle,
        bold: Bool = false,
        color: UIColor = .label,
        alignment: NSTextAlignment = .natural
    ) -> NSAttributedString {
        let base = UIFont.preferredFont(forTextStyle: style)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        let out = NSMutableAttributedString()
        for run in inline.runs {
            let intent = run.inlinePresentationIntent ?? []
            var traits: UIFontDescriptor.SymbolicTraits = bold ? .traitBold : []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            var font = base
            if intent.contains(.code) {
                font = .monospacedSystemFont(ofSize: base.pointSize * 0.92, weight: traits.contains(.traitBold) ? .semibold : .regular)
            } else if !traits.isEmpty, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
                font = UIFont(descriptor: descriptor, size: 0)
            }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: color,
                .paragraphStyle: paragraph,
            ]
            if intent.contains(.code) { attributes[.backgroundColor] = UIColor.tertiarySystemFill }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: String(inline[run.range].characters), attributes: attributes))
        }
        return out
    }
}
