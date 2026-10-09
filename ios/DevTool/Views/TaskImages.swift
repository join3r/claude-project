import DevToolKit
import PhotosUI
import SwiftUI
import UIKit

/// A picture picked for a new task: kept scaled down to what could be sent,
/// encoded only when the task starts, once the share of each is known.
struct PickedImage: Identifiable {
    let id = UUID()
    let image: UIImage

    /// The longest side, in pixels, a picture is kept and sent at.
    static let maxSide: CGFloat = 2048

    /// From the photo library; nil when it can't be read as an image.
    static func load(_ item: PhotosPickerItem) async -> PickedImage? {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data)
        else { return nil }
        return PickedImage(image: scaled(image, maxSide: maxSide))
    }

    /// From the camera.
    init(captured image: UIImage) {
        self.image = Self.scaled(image, maxSide: Self.maxSide)
    }

    private init(image: UIImage) {
        self.image = image
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

/// The New task sheet's pictures: thumbnails with a remove button each, and
/// Add from the photo library or the camera while there is room.
struct TaskImagesSection: View {
    @Binding var images: [PickedImage]
    let disabled: Bool
    /// Why pictures can't go to the picked desktop, if they can't.
    let unsupported: String?

    @State private var libraryItems: [PhotosPickerItem] = []
    @State private var showLibrary = false
    @State private var showCamera = false
    @State private var loading = false

    private var room: Int { TaskNewImage.maxCount - images.count }

    var body: some View {
        Section {
            if !images.isEmpty {
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
            if room > 0 && unsupported == nil {
                Menu {
                    Button("Photo Library", systemImage: "photo.on.rectangle") { showLibrary = true }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Take Photo", systemImage: "camera") { showCamera = true }
                    }
                } label: {
                    HStack {
                        Label(images.isEmpty ? "Add pictures" : "Add more", systemImage: "photo.badge.plus")
                        if loading {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(disabled || loading)
            }
        } footer: {
            if let unsupported {
                Text(unsupported)
            } else if !images.isEmpty {
                Text("Up to \(TaskNewImage.maxCount). They go with the prompt, scaled down to fit.")
            }
        }
        .photosPicker(isPresented: $showLibrary, selection: $libraryItems, maxSelectionCount: max(room, 1),
                      selectionBehavior: .ordered, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: libraryItems) {
            let items = libraryItems
            guard !items.isEmpty else { return }
            libraryItems = []
            loading = true
            Task {
                for item in items {
                    guard images.count < TaskNewImage.maxCount else { break }
                    if let picked = await PickedImage.load(item) { images.append(picked) }
                }
                loading = false
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if images.count < TaskNewImage.maxCount { images.append(PickedImage(captured: image)) }
            }
            .ignoresSafeArea()
        }
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

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onCapture(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
