import SwiftUI
import ImageIO
import CounterpartKit

/// Decoded thumbnails, kept for the session so scrolling never decodes twice.
@MainActor final class ImageMemory {
    static let shared = ImageMemory()
    private let cache = NSCache<NSString, UIImage>()
    func image(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, _ key: String) { cache.setObject(image, forKey: key as NSString) }

    /// Decode only the pixels a view can show, without expanding a full capture first.
    nonisolated static func thumbnail(at url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    nonisolated static func thumbnail(data: Data, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

extension Project {
    /// The picture that stands for a project: the real thing you showed Counterpart, so a project is
    /// recognisable the same way on every card. A model render is the fallback when there is no real
    /// photo or scan frame (a described or published project); the model itself is on its page.
    var thumbnailPath: String? {
        if let photo = photos.first { return "photos/\(photo)" }
        if let frame = capture?.first { return "capture/\(frame)" }
        if let render = current?.renders.first, let name = render.split(separator: "/").last { return "renders/\(name)" }
        return nil
    }
}

/// One of a project's images, downloaded once per project version and decoded at the size shown.
struct ProjectImage: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let path: String?
    var maxPixelSize = 600
    var contentMode: ContentMode = .fill
    var placeholderSymbol = "cube"
    @State private var image: UIImage?

    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }

    var body: some View {
        ZStack {
            StageBackground()
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if path == nil {
                Image(systemName: placeholderSymbol).font(.title2).foregroundStyle(.white.opacity(0.35))
            }
        }
        .clipped()
        .task(id: key) {
            if let cached = ImageMemory.shared.image(key) { image = cached; return }
            image = nil
            guard let path, let url = try? await app.projects.mac.download(project, path) else { return }
            let size = maxPixelSize
            let decoded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: size) }.value
            guard !Task.isCancelled, let decoded else { return }
            ImageMemory.shared.store(decoded, key)
            image = decoded
        }
        .accessibilityHidden(true)
    }
}

/// The printer camera as a refreshing photo (PRD §5.7, §8.6): a new still every `every` seconds while
/// shown, with when it was taken. Not video, and never called video.
@MainActor @Observable final class CameraFeed {
    var image: UIImage?
    var capturedAt: Date?
    var problem: String?
    var unsupported = false

    func run(_ client: CompanionClient, project: String? = nil, printer: String? = nil, every seconds: Double, maxPixelSize: Int = 1200) async {
        guard project != nil || printer != nil else { return }
        var previous: CompanionClient.CameraFrame?
        let fullScreen = seconds < 10
        var snapshots = false
        unsupported = false
        func display(_ frame: CompanionClient.CameraFrame) async {
            let size = fullScreen ? maxPixelSize : 300
            let decoded = await Task.detached { ImageMemory.thumbnail(data: frame.jpeg, maxPixelSize: size) }.value
            guard !Task.isCancelled else { return }
            if let decoded { image = decoded; capturedAt = frame.capturedAt ?? Date() }
            problem = nil
        }
        while !Task.isCancelled {
            do {
                if snapshots {
                    let frame = project != nil ? try await client.camera(project: project!, fullScreen: fullScreen, previous: previous)
                        : try await client.camera(printer: printer!, fullScreen: fullScreen, previous: previous)
                    if previous == nil || frame.etag == nil || frame.etag != previous?.etag { await display(frame) }
                    previous = frame; problem = nil
                } else {
                    let frames = project != nil ? client.cameraFrames(project: project!, fullScreen: fullScreen)
                        : client.cameraFrames(printer: printer!, fullScreen: fullScreen)
                    for try await frame in frames { await display(frame) }
                }
            } catch let error as CompanionError {
                guard !Task.isCancelled else { return }
                if error.isUnsupported, !snapshots { snapshots = true; continue }
                if error.isUnsupported || error.code == "no-camera" || error.needsPairing {
                    unsupported = error.isUnsupported || error.code == "no-camera"; problem = error.message; return
                }
                problem = error.message
            } catch { return }
            try? await Task.sleep(for: .seconds(fullScreen && previous?.streaming == true ? 2 : seconds))
        }
    }
}

// MARK: The question's picture

/// The picture under a question from the Mac (David, Nov 9, on his iPad: "the area it's highlighting is almost impossible to
/// see"): the card's width, the whole photo at its own aspect ratio, the rest dimmed and the asked-about part outlined.
/// Tapping it zooms it full screen (`navigationTransition(.zoom)`), where it pinches and double-taps to zoom.
struct AskPhoto: View {
    @Environment(AppModel.self) private var app
    let project: Project
    /// `asks/<id>.jpg`, or the project's own picture when the question came without one.
    let path: String?
    let region: Project.Region?
    let caption: String
    /// The tallest it gets, so the answers stay in view on an iPad; it keeps its aspect ratio, so it narrows instead.
    var maxHeight: CGFloat = 460
    @State private var image: UIImage?
    @State private var file: URL?
    @State private var full = false
    @Namespace private var zoom

    private var aspect: CGFloat { image.map { $0.size.width / max($0.size.height, 1) } ?? 4 / 3 }
    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#ask" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { full = true } label: {
                ZStack {
                    if let image { Image(uiImage: image).resizable() } else { StageBackground() }
                    AskRegionOverlay(region: image == nil ? nil : region)
                }
                .aspectRatio(aspect, contentMode: .fit)
                .clipShape(.rect(cornerRadius: 16))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote.weight(.semibold))
                        .frame(width: 34, height: 34).glassEffect(.regular.interactive(), in: .circle).padding(10)
                        .opacity(image == nil ? 0 : 1)
                }
                .matchedTransitionSource(id: "ask-photo", in: zoom)
                .frame(maxWidth: .infinity, maxHeight: maxHeight)
            }
            .buttonStyle(.plain)
            .disabled(file == nil)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(caption)
            .accessibilityHint("Opens the picture full screen")
            .accessibilityAddTraits(.isImage)
            .accessibilityIdentifier("ask-picture")
            Text(caption).font(.footnote).foregroundStyle(.secondary).accessibilityHidden(true)
        }
        .fullScreenCover(isPresented: $full) {
            if let file { AskPhotoFullScreen(file: file, region: region, caption: caption).navigationTransition(.zoom(sourceID: "ask-photo", in: zoom)) }
        }
        .task(id: key) {
            if let cached = ImageMemory.shared.image(key) { image = cached }
            guard let path, let url = try? await app.projects.mac.download(project, path) else { return }
            file = url
            guard image == nil else { return }
            // Sharp at the card's width on a 3x iPhone and a 2x iPad, never the camera's full size (PRD §9.6).
            let decoded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: 1600) }.value
            guard !Task.isCancelled, let decoded else { return }
            ImageMemory.shared.store(decoded, key)
            image = decoded
        }
    }
}

/// The question's picture full screen, its region marked into the pixels so it stays on the part at any zoom.
struct AskPhotoFullScreen: View {
    let file: URL
    let region: Project.Region?
    let caption: String
    @Environment(\.dismiss) private var dismiss
    @State private var marked: UIImage?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let marked { ZoomableImage(image: marked).ignoresSafeArea().accessibilityIdentifier("ask-picture-full") }
            else { ProgressView().tint(.white) }
        }
        .overlay(alignment: .topTrailing) {
            Button("Done", systemImage: "xmark") { dismiss() }
                .labelStyle(.iconOnly).font(.title3.weight(.semibold))
                .buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.large)
                .padding(16).accessibilityIdentifier("ask-picture-done")
        }
        .overlay(alignment: .bottom) {
            Text(caption).font(.footnote.weight(.medium)).foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassEffect(.regular, in: .capsule).padding(.bottom, 12)
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
        .task {
            let file = file, region = region
            marked = await Task.detached {
                guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 4096] as CFDictionary),
                      let marked = AskPicture.marked(image, region: region) else { return nil }
                return UIImage(cgImage: marked)
            }.value
        }
    }
}

/// Pinch and double-tap zoom: UIKit's own `UIScrollView` zooming, which SwiftUI has no equivalent of.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> ZoomView { ZoomView(image: image) }
    func updateUIView(_ view: ZoomView, context: Context) {}

    final class ZoomView: UIScrollView, UIScrollViewDelegate {
        private let imageView: UIImageView
        private var fitted = CGSize.zero

        init(image: UIImage) {
            imageView = UIImageView(image: image)
            super.init(frame: .zero)
            delegate = self
            addSubview(imageView)
            showsVerticalScrollIndicator = false; showsHorizontalScrollIndicator = false
            decelerationRate = .fast; contentInsetAdjustmentBehavior = .never
            let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
            doubleTap.numberOfTapsRequired = 2
            addGestureRecognizer(doubleTap)
            isAccessibilityElement = true
            accessibilityTraits = [.image]
            accessibilityLabel = "Picture"
        }
        required init?(coder: NSCoder) { fatalError() }

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.size != .zero, let size = imageView.image?.size, size.width > 0, size.height > 0 else { return }
            let fit = min(bounds.width / size.width, bounds.height / size.height)
            let target = CGSize(width: size.width * fit, height: size.height * fit)
            if target != fitted {
                fitted = target
                zoomScale = 1
                imageView.frame = CGRect(origin: .zero, size: target)
                contentSize = target
                minimumZoomScale = 1
                maximumZoomScale = max(4, 1 / fit)
            }
            centre()
            accessibilityValue = "Zoom \(Int((zoomScale * 100).rounded())) percent"
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { centre(); accessibilityValue = "Zoom \(Int((zoomScale * 100).rounded())) percent" }

        private func centre() {
            let x = max(0, (bounds.width - imageView.frame.width) / 2), y = max(0, (bounds.height - imageView.frame.height) / 2)
            contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
        }

        @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
            if zoomScale > 1.01 { setZoomScale(1, animated: true); return }
            let point = tap.location(in: imageView), scale = min(maximumZoomScale, 3)
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

// MARK: A scan, as one thing

/// A scan's frames as one thing (David, Nov 9: "highly unnecessary to show every single one of these (and thus load every
/// single one of these) images"): five round the orbit and the count. Only these five are fetched until it's opened.
struct ScanStrip: View {
    let project: Project
    let scan: ScanPhotos
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(scan.preview, id: \.self) { path in
                        ProjectImage(project: project, path: path, maxPixelSize: 300)
                            .aspectRatio(3 / 4, contentMode: .fit)
                            .clipShape(.rect(cornerRadius: 8))
                    }
                }
                HStack(spacing: 6) {
                    Image(systemName: "cube.transparent")
                    Text("Your scan · \(scan.words)").fontWeight(.semibold)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your scan, \(scan.words)")
        .accessibilityHint("Shows every photo")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("scan-strip")
        .sheet(isPresented: $open) { ScanGallery(project: project, scan: scan) }
    }
}

/// Every frame of a scan, fetched only as each one scrolls into view.
struct ScanGallery: View {
    let project: Project
    let scan: ScanPhotos
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 4)], spacing: 4) {
                    ForEach(Array(scan.frames.enumerated()), id: \.element) { index, path in
                        NavigationLink {
                            ProjectImage(project: project, path: path, maxPixelSize: 2400, contentMode: .fit)
                                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.black)
                                .navigationTitle("Photo \(index + 1) of \(scan.count)").navigationBarTitleDisplayMode(.inline)
                        } label: {
                            Color.clear.aspectRatio(3 / 4, contentMode: .fit)
                                .overlay { ProjectImage(project: project, path: path, maxPixelSize: 300) }
                                .clipShape(.rect(cornerRadius: 6))
                        }
                        .accessibilityLabel("Photo \(index + 1) of \(scan.count)")
                    }
                }
                .padding(.horizontal, 4)
            }
            .accessibilityIdentifier("scan-gallery")
            .navigationTitle("Your scan")
            .navigationSubtitle(scan.words)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
