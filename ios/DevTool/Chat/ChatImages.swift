import DevToolKit
import SwiftUI
import UIKit

/// One image a tool result carried (`chat.image`, §8.9).
struct ChatImageRef: Hashable, Identifiable {
    let itemId: String
    let index: Int
    /// How many images the tool item has.
    let count: Int

    var id: String { "\(itemId)#\(index)" }
}

/// What a tool row needs to show its images: fetch one at a given longest
/// side in pixels, and open one full screen. Nil while the chat is read-only
/// or the desktop doesn't list `chat.image`.
struct ChatImageActions {
    var load: @MainActor (ChatImageRef, Int) async throws -> UIImage
    var open: @MainActor (ChatImageRef) -> Void
}

/// A tool row's images: a strip of thumbnails, or just how many there are when
/// they can't be fetched.
struct ToolImages: View {
    let itemId: String
    let count: Int
    let actions: ChatImageActions?

    var body: some View {
        if let actions {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(0..<count, id: \.self) { index in
                        let ref = ChatImageRef(itemId: itemId, index: index, count: count)
                        Button { actions.open(ref) } label: {
                            ChatImageThumbnail(ref: ref, load: actions.load)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(count == 1 ? "Image" : "Image \(index + 1) of \(count)")
                        .accessibilityHint("Opens it full screen")
                    }
                }
            }
            .scrollClipDisabled()
        } else {
            Label(count == 1 ? "1 image" : "\(count) images", systemImage: "photo")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
        }
    }
}

struct ChatImageThumbnail: View {
    let ref: ChatImageRef
    let load: @MainActor (ChatImageRef, Int) async throws -> UIImage
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false

    private static let size = CGSize(width: 132, height: 88)

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                Image(systemName: "photo.badge.exclamationmark")
                    .foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(.quaternary, lineWidth: 0.5)
        }
        .contentShape(Rectangle())
        .task(id: ref) {
            guard image == nil else { return }
            failed = false
            // Enough pixels for the fill crop of a wide screenshot.
            let side = Int((Self.size.width * 1.6 * displayScale).rounded())
            do {
                image = try await load(ref, side)
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

/// Full-screen viewer for a tool row's images: swipe between them, pinch or
/// double-tap to zoom, share the one on screen.
struct ChatImageViewer: View {
    let start: ChatImageRef
    let load: @MainActor (ChatImageRef, Int) async throws -> UIImage
    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var loaded: [Int: UIImage] = [:]

    init(start: ChatImageRef, load: @escaping @MainActor (ChatImageRef, Int) async throws -> UIImage) {
        self.start = start
        self.load = load
        _index = State(initialValue: start.index)
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(0..<start.count, id: \.self) { i in
                    ChatImagePage(ref: ChatImageRef(itemId: start.itemId, index: i, count: start.count), load: load) { image in
                        loaded[i] = image
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: start.count > 1 ? .always : .never))
            .background(.black)
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle(start.count > 1 ? "\(index + 1) of \(start.count)" : "Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if let image = loaded[index] {
                    ToolbarItem(placement: .topBarLeading) {
                        let shown = Image(uiImage: image)
                        ShareLink(item: shown, preview: SharePreview("Image", image: shown))
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct ChatImagePage: View {
    let ref: ChatImageRef
    let load: @MainActor (ChatImageRef, Int) async throws -> UIImage
    let onLoad: (UIImage) -> Void
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let image {
                    ZoomableImage(image: image)
                } else if let error {
                    ContentUnavailableView {
                        Label("Couldn't load the image", systemImage: "photo.badge.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { attempt += 1 }
                            .buttonStyle(.bordered)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task(id: attempt) {
                guard image == nil else { return }
                error = nil
                // The screen's longest side in pixels, so zooming in still has detail to show.
                let points = max(geometry.size.width, geometry.size.height)
                let side = min(ChatImageParams.maxSide, max(ChatImageParams.minSide, Int((points * displayScale * 1.5).rounded())))
                do {
                    let loaded = try await load(ref, side)
                    image = loaded
                    onLoad(loaded)
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription }
                }
            }
        }
    }
}

/// A UIScrollView, for the pinch and double-tap zoom SwiftUI lacks on iOS 17.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> ZoomingScrollView { ZoomingScrollView(image: image) }

    func updateUIView(_ view: ZoomingScrollView, context: Context) { view.show(image) }
}

private final class ZoomingScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()

    init(image: UIImage) {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 6
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        imageView.contentMode = .scaleAspectFit
        imageView.image = image
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = "Image"
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ image: UIImage) {
        guard imageView.image !== image else { return }
        imageView.image = image
        setZoomScale(1, animated: false)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // At 1× the image fills the page (aspect fit); zooming scales from there.
        if zoomScale == 1 {
            imageView.frame = bounds
            contentSize = bounds.size
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        if zoomScale > 1 {
            setZoomScale(1, animated: true)
            return
        }
        let point = gesture.location(in: imageView)
        let size = CGSize(width: bounds.width / 3, height: bounds.height / 3)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}
