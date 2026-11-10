import SwiftUI
import ImageIO
import CounterpartKit

/// Decoded thumbnails, kept for the session so scrolling never decodes twice.
@MainActor final class ImageMemory {
    static let shared = ImageMemory()
    private let cache = NSCache<NSString, UIImage>()
    func image(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, _ key: String) { cache.setObject(image, forKey: key as NSString) }
    /// A picture of the project this phone has already decoded at any size the lists use (`ProjectImage`'s keys).
    func anySize(_ project: Project, _ path: String?) -> UIImage? {
        guard let path else { return nil }
        return [500, 300, 160, 600, 1200].lazy.compactMap { self.image("\(project.id)#\(Int64(project.mediaVersion))#\(path)#\($0)") }.first
    }

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
    /// The picture that stands for a project everywhere (Projects, sidebar, Home cards, Printers, the Live Activity):
    /// the object alone on the stage, the project page's first picture (CounterpartKit `picturePath`, PRD §5.1).
    /// Never a photo with its room in it (David, Nov 10). Nil shows the neutral placeholder.
    var thumbnailPath: String? { picturePath }
}

/// One of a project's images, downloaded once per project version and decoded at the size shown.
struct ProjectImage: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let path: String?
    var maxPixelSize = 600
    var contentMode: ContentMode = .fill
    var placeholderSymbol = "cube"
    /// On a project's stage, never a bare backdrop (review F4 on #525): while the picture loads, the project's list
    /// picture if this phone already has it, else a quiet progress mark; if it can't be had, `placeholderSymbol`. Says
    /// which in its accessibility value ("shown" only once a picture is decoded).
    var onStage = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var image: UIImage?
    @State private var shownKey: String?
    @State private var failed = false

    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }
    private var early: UIImage? { onStage && image == nil && !failed ? ImageMemory.shared.anySize(project, project.thumbnailPath) : nil }

    var body: some View {
        let content = ZStack {
            StageBackground()
            if let image = image ?? early {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if path == nil || failed {
                Image(systemName: placeholderSymbol).font(onStage ? .system(size: 44) : .title2).foregroundStyle(.white.opacity(0.35))
            } else if onStage {
                ProgressView().tint(.white.opacity(0.5))
            }
        }
        .clipped()
        // Coming back to the app tries a picture that failed again, as a reopened page does.
        .task(id: "\(key)#\(scenePhase)") {
            if let cached = ImageMemory.shared.image(key) { image = cached; shownKey = key; failed = false; return }
            if shownKey == key, image != nil { return }
            guard scenePhase == .active else { return }
            image = nil; failed = false
            guard let path else { return }
            guard let url = try? await app.projects.mac.download(project, path) else { if !Task.isCancelled { failed = true }; return }
            let size = maxPixelSize
            // A few at a time: a grid of scan frames decoding two dozen HEICs at once got nothing back (Nov 10).
            var decoded: UIImage?
            for _ in 0..<2 where decoded == nil && !Task.isCancelled {
                // CounterpartKit's lane: three at a time, and a cell that scrolled away leaves the queue (review F4).
                decoded = await DecodeLane.shared.run { ImageMemory.thumbnail(at: url, maxPixelSize: size) } ?? nil
            }
            guard !Task.isCancelled else { return }
            guard let decoded else { failed = true; return }
            ImageMemory.shared.store(decoded, key)
            image = decoded; shownKey = key
        }
        if onStage {
            content.accessibilityElement(children: .ignore)
                .accessibilityValue(image != nil ? "shown" : failed || path == nil ? "not available" : "loading")
        } else {
            content.accessibilityHidden(true)
        }
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
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// The tallest it gets, so the answers stay near it (a portrait photo on an iPhone, any photo on an iPad); it keeps its
    /// aspect ratio, so it narrows instead of cropping.
    private var maxHeight: CGFloat { sizeClass == .compact ? 380 : 460 }
    /// The picture, its file and whether it failed, for the current key (review F2, F3).
    @State private var load = PictureLoad<UIImage>()
    @State private var full = false
    @Namespace private var zoom

    private var image: UIImage? { load.key == key ? load.picture : ImageMemory.shared.image(key) }
    private var file: URL? { load.key == key ? load.file : nil }
    private var aspect: CGFloat { image.map { $0.size.width / max($0.size.height, 1) } ?? 4 / 3 }
    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#ask" }

    var body: some View {
        Group { if !(load.key == key && load.hidden) { figure } }
            .task(id: key) { await fetch(key) }
    }

    private var figure: some View {
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
    }

    /// A new key starts from its own cached picture or none; a failed download or decode hides the figure.
    private func fetch(_ key: String) async {
        load.start(key, cached: ImageMemory.shared.image(key))
        guard let path else { load.downloaded(nil, for: key); return }
        let url = try? await app.projects.mac.download(project, path)
        guard !Task.isCancelled else { return }
        load.downloaded(url, for: key)
        guard let url, load.picture == nil else { return }
        // Sharp at the card's width on a 3x iPhone and a 2x iPad, never the camera's full size (PRD §9.6).
        let decoded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: 1600) }.value
        guard !Task.isCancelled else { return }
        if let decoded { ImageMemory.shared.store(decoded, key) }
        load.decoded(decoded, for: key)
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
                guard let image = AskPicture.upright(file), let marked = AskPicture.marked(image, region: region) else { return nil }
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
        // A fixed page size: a sheet sized to its content measures the whole grid, which fetched every frame on the iPad.
        .sheet(isPresented: $open) { ScanGallery(project: project, scan: scan).presentationSizing(.page) }
    }
}

/// One frame in the full set: fetched once it is on screen, never because the grid built its cell ahead of time (on an
/// iPad the grid built nearly every cell, which fetched 123 of 130 frames).
private struct VisibleFrame: View {
    let project: Project
    let path: String
    @State private var seen = false
    var body: some View {
        Color.clear.aspectRatio(3 / 4, contentMode: .fit)
            .overlay { if seen { ProjectImage(project: project, path: path, maxPixelSize: 300) } else { StageBackground() } }
            .clipShape(.rect(cornerRadius: 6))
            .onScrollVisibilityChange(threshold: 0.05) { if $0 { seen = true } }
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
                            VisibleFrame(project: project, path: path)
                        }
                        .accessibilityLabel("Photo \(index + 1) of \(scan.count)")
                    }
                }
                .padding(.horizontal, 4)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("scan-gallery")
            .navigationTitle("Your scan")
            .navigationSubtitle(scan.words)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
