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

/// One of a project's images on a card or in a list, downloaded once per project version and decoded at the size shown.
/// A project's stage never uses it: `StagePicture` is the stage's one still picture.
struct ProjectImage: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let path: String?
    var maxPixelSize = 600
    var contentMode: ContentMode = .fill
    var placeholderSymbol = "cube"
    @Environment(\.scenePhase) private var scenePhase
    @State private var image: UIImage?
    @State private var shownKey: String?
    @State private var failed = false

    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }

    var body: some View {
        ZStack {
            StageBackground()
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if path == nil || failed {
                Image(systemName: placeholderSymbol).font(.title2).foregroundStyle(.white.opacity(0.35))
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
            guard let decoded = await ImageMemory.load(app, project, path, maxPixelSize: maxPixelSize) else { if !Task.isCancelled { failed = true }; return }
            guard !Task.isCancelled else { return }
            ImageMemory.shared.store(decoded, key)
            image = decoded; shownKey = key
        }
        .accessibilityHidden(true)
    }
}

extension ImageMemory {
    /// Downloads one of the project's pictures and decodes it at `maxPixelSize`. Nil when it can't be had.
    static func load(_ app: AppModel, _ project: Project, _ path: String, maxPixelSize size: Int) async -> UIImage? {
        guard let url = try? await app.projects.mac.download(project, path) else { return nil }
        // A few at a time: a grid of scan frames decoding two dozen HEICs at once got nothing back (Nov 10).
        var decoded: UIImage?
        for _ in 0..<2 where decoded == nil && !Task.isCancelled {
            // CounterpartKit's lane: three at a time, and a cell that scrolled away leaves the queue (review F4).
            decoded = await DecodeLane.shared.run { ImageMemory.thumbnail(at: url, maxPixelSize: size) } ?? nil
        }
        return decoded
    }
}

/// The one view that puts a still picture on a project's stage (review B1/S2 on #539; docs/operations.md "Waiting,
/// failed and empty are screens too"). Every still goes through it: an entry before its model is drawn, a 3MF's or a
/// plate's picture, the photo's subject, and a page with nothing yet. It is never a bare backdrop, for as long as the page
/// is open, with or without a model:
/// - **shown**: this picture.
/// - **waiting**: an earlier copy of this same picture (another size) if this phone has one, else a progress mark and one
///   line saying what is coming. Never a picture of something else.
/// - **not available**: a symbol and one line saying so, with Try Again where trying again can help (a fetch that failed).
/// VoiceOver and UI tests read one element, `gallery-stage-picture`, whose value is "shown", "loading" or "not available".
struct StagePicture: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let project: Project
    let still: Project.Still
    /// What it is a picture of: the entry's label ("Model", "Plate 3", "What you scanned").
    let label: String
    /// The not-available line when the Mac has none: a plate's file came without it, or the Mac couldn't draw it.
    var unavailableLine = "Your Mac couldn’t draw a picture of this."
    /// The not-available symbol: a neutral one, never the project's phase (a "Ready" seal beside "couldn't" reads as done).
    var symbol = "cube.transparent"
    var maxPixelSize = 1200
    /// The 3D model under this stage that couldn't be had either (`ProjectGalleryView`): when this picture fails too, the
    /// stage's one line says both and its one Try Again tries both (board X100: never two Try Again buttons).
    var modelMissing: (line: String, retry: () -> Void)? = nil
    /// Whether this picture's fetch failed, for the gallery's line under the stage.
    var failedChanged: (Bool) -> Void = { _ in }
    /// The height the stage's own controls take at its bottom (AR, the size chip). The waiting and not-available words lay
    /// out above it, never under a chip: a "Did it fit?" card leaves the stage as short as 160 points (lead, Nov 10, X80).
    var controlsInset: CGFloat = 0
    @State private var load = PictureLoad<UIImage>()
    @State private var attempt = 0

    private var path: String? { if case .picture(let path) = still { path } else { nil } }
    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }

    fileprivate enum Shows { case shown(UIImage), loading(UIImage?), waiting, notAvailable(String, retry: Bool) }
    private var shows: Shows {
        switch still {
        case .waiting: return .waiting
        case .notAvailable: return .notAvailable(unavailableLine, retry: false)
        case .picture(let path):
            if load.key == key, let image = load.picture { return .shown(image) }
            if let image = ImageMemory.shared.image(key) { return .shown(image) }
            if load.key == key, load.failed { return .notAvailable(modelMissing?.line ?? "The picture didn’t come from your Mac.", retry: true) }
            return .loading(ImageMemory.shared.anySize(project, path))
        }
    }
    private var coming: String { "\(label): coming from your Mac" }

    var body: some View {
        let shows = shows
        let label: String = switch shows {
        case .shown, .loading(_?): "\(label), as your Mac drew it"
        case .loading(nil), .waiting: coming
        case .notAvailable(let line, _): "\(label). \(line)"
        }
        ZStack {
            StageBackground()
            // The stage's one accessibility element, the whole stage in every state; what is drawn on it is hidden from
            // VoiceOver (the label says it), except Try Again.
            Color.clear.allowsHitTesting(false)
                .accessibilityElement().accessibilityLabel(label).accessibilityValue(shows.value)
                .accessibilityAddTraits(.isImage).accessibilityIdentifier("gallery-stage-picture")
            switch shows {
            case .shown(let image), .loading(let image?):
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                    .overlay(alignment: .topTrailing) {
                        if case .loading = shows { ProgressView().tint(.white.opacity(0.6)).padding(14) }
                    }
                    .accessibilityHidden(true).allowsHitTesting(false)
            case .loading(nil), .waiting:
                // Above the chips; side by side when the stage is too short to stack them.
                ViewThatFits(in: .vertical) {
                    VStack(spacing: 12) { ProgressView().tint(.white.opacity(0.6)); comingText }
                    HStack(spacing: 10) { ProgressView().tint(.white.opacity(0.6)); comingText }
                }
                .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, controlsInset + 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .multilineTextAlignment(.center).accessibilityHidden(true).allowsHitTesting(false)
            case .notAvailable(let line, let retry):
                // Above the chips: the symbol shrinks, then goes, before anything would touch them; the line stays whole.
                ViewThatFits(in: .vertical) {
                    unavailable(line, retry: retry, symbolSize: 40)
                    unavailable(line, retry: retry, symbolSize: 24)
                    unavailable(line, retry: retry, symbolSize: nil)
                }
                .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, controlsInset + 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .multilineTextAlignment(.center)
            }
        }
        .clipped()
        .onChange(of: load.key == key && load.failed, initial: true) { _, failed in failedChanged(failed) }
        // Coming back to the app, or Try Again, fetches a picture that failed again.
        .task(id: "\(key)#\(attempt)#\(scenePhase)") {
            guard let path else { return }
            let key = key
            if let cached = ImageMemory.shared.image(key) { load.start(key, cached: cached); return }
            if load.key == key, load.picture != nil { return }
            guard scenePhase == .active else { return }
            load.start(key, cached: nil)
            let decoded = await ImageMemory.load(app, project, path, maxPixelSize: maxPixelSize)
            guard !Task.isCancelled else { return }
            if let decoded { ImageMemory.shared.store(decoded, key) }
            load.decoded(decoded, for: key)
        }
    }
}

private extension StagePicture {
    var comingText: some View {
        Text(coming).font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.7)).fixedSize(horizontal: false, vertical: true)
    }

    func unavailable(_ line: String, retry: Bool, symbolSize: CGFloat?) -> some View {
        VStack(spacing: symbolSize == nil ? 8 : 10) {
            VStack(spacing: 8) {
                if let symbolSize { Image(systemName: symbol).font(.system(size: symbolSize)).foregroundStyle(.white.opacity(0.4)) }
                Text(line).font(.footnote).foregroundStyle(.white.opacity(0.7)).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityHidden(true)
            if retry {
                Button("Try Again") { attempt += 1; modelMissing?.retry() }.font(.footnote.weight(.semibold)).buttonStyle(.glass)
                    .accessibilityIdentifier("gallery-stage-retry")
            }
        }
    }
}

private extension StagePicture.Shows {
    var value: String {
        switch self {
        case .shown: "shown"
        case .loading, .waiting: "loading"
        case .notAvailable: "not available"
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
