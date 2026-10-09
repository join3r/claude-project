import DevToolKit
import SwiftUI
import UIKit

/// A picture pasted into a new task's prompt: kept scaled down to what could
/// be sent, encoded only when the task starts, once the share of each is known.
struct PickedImage: Identifiable {
    let id = UUID()
    let image: UIImage

    /// The longest side, in pixels, a picture is kept and sent at.
    static let maxSide: CGFloat = 2048

    init(pasted image: UIImage) {
        self.image = Self.scaled(image, maxSide: Self.maxSide)
    }

    /// Drawn upright at no more than `maxSide` pixels on its longest side.
    nonisolated static func scaled(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let ratio = min(1, maxSide / max(pixels.width, pixels.height, 1))
        let size = CGSize(width: (pixels.width * ratio).rounded(), height: (pixels.height * ratio).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// `task.new`'s `images` (§8.4): JPEGs, each within its share of the
    /// message, scaled down further and compressed harder until it fits.
    nonisolated static func encode(_ images: [UIImage]) -> [TaskNewImage] {
        guard !images.isEmpty else { return [] }
        let budget = TaskNewImage.maxData / images.count
        return images.compactMap { image in
            for side in [maxSide, 1600, 1280, 1024, 768, 512] {
                let sized = scaled(image, maxSide: side)
                for quality in [0.8, 0.6] as [CGFloat] {
                    guard let data = sized.jpegData(compressionQuality: quality) else { return nil }
                    let base64 = data.base64EncodedString()
                    if base64.utf8.count <= budget { return TaskNewImage(mediaType: "image/jpeg", data: base64) }
                }
            }
            return nil
        }
    }
}

/// The pictures pasted into the prompt, each with a remove button.
struct TaskImagesStrip: View {
    @Binding var images: [PickedImage]
    let disabled: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(images) { picked in
                    thumbnail(picked)
                }
            }
            .padding(.vertical, 4)
        }
        .scrollClipDisabled()
    }

    private func thumbnail(_ picked: PickedImage) -> some View {
        Image(uiImage: picked.image)
            .resizable()
            .scaledToFill()
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(.quaternary, lineWidth: 0.5)
            }
            .overlay(alignment: .topTrailing) {
                Button {
                    images.removeAll { $0.id == picked.id }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.6))
                        .font(.title3)
                        .padding(4)
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityLabel("Remove picture")
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Picture")
    }
}

/// The New task prompt: a growing text field whose Paste also takes
/// pictures (`onPasteImages`; nil pastes text only, as a plain field does).
/// SwiftUI's TextField offers no Paste for an image on the pasteboard.
struct PromptTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let disabled: Bool
    var minLines = 5
    var maxLines = 12
    let onPasteImages: (([UIImage]) -> Void)?

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.placeholder.text = placeholder
        view.accessibilityLabel = placeholder
        return view
    }

    func updateUIView(_ view: PastingTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.updatePlaceholder()
        view.isEditable = !disabled
        view.onPasteImages = disabled ? nil : onPasteImages
        if focused, !view.isFirstResponder {
            DispatchQueue.main.async { if view.window != nil { view.becomeFirstResponder() } }
        } else if !focused, view.isFirstResponder {
            DispatchQueue.main.async { view.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PastingTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let line = view.font?.lineHeight ?? 22
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let height = min(max(fitted, line * CGFloat(minLines)), line * CGFloat(maxLines))
        view.isScrollEnabled = fitted > height
        return CGSize(width: width, height: height.rounded(.up))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PromptTextView

        init(_ parent: PromptTextView) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            parent.text = view.text
            (view as? PastingTextView)?.updatePlaceholder()
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            if !parent.focused { parent.focused = true }
        }

        func textViewDidEndEditing(_ view: UITextView) {
            if parent.focused { parent.focused = false }
        }
    }
}

final class PastingTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?
    let placeholder = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.adjustsFontForContentSizeCategory = true
        placeholder.textColor = .placeholderText
        placeholder.numberOfLines = 0
        placeholder.isAccessibilityElement = false
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.topAnchor.constraint(equalTo: topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholder.widthAnchor.constraint(equalTo: widthAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func updatePlaceholder() { placeholder.isHidden = !text.isEmpty }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteImages != nil, UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    /// Pictures on the pasteboard become the task's pictures; anything else
    /// pastes as text.
    override func paste(_ sender: Any?) {
        if let onPasteImages, UIPasteboard.general.hasImages, let images = UIPasteboard.general.images, !images.isEmpty {
            onPasteImages(images)
            return
        }
        super.paste(sender)
    }
}
