import SwiftUI
import CounterpartKit

/// The pictures at the top of a project's page (PRD §5.4 Pictures): every entry of the project's `ProjectGallery`, one
/// at a time, on the dark stage. A row of labels under the stage moves between them: none for one entry, a few labels
/// for the common two or three, a scrolling row for a designer's dozen plates. The labels sit below the stage, never
/// over it, so a drag always turns the model (HIG, Page controls: a scrolling row for an arbitrary number of pages;
/// Segmented controls: short noun labels, no introductory text).
struct ProjectGalleryView: View {
    let store: ProjectsStore
    let project: Project
    let words: ProjectWords
    let height: CGFloat
    let modelURL: URL?
    /// The part's AR file once the AR chip has prepared it (the page's Share offers it too).
    @Binding var arURL: URL?
    /// The scan while it is still only on this phone (before the Mac has it).
    let localScan: URL?
    var working = false
    /// "See it together": asks the Mac where the scanned object sits in a part made before passes said.
    var locate: (() -> Void)? = nil
    @State private var selected: String?
    /// Entries whose model is here but can't be drawn (review F7 on #525): their picture stays, and the line says so.
    @State private var undrawable: Set<String> = []
    /// Entries whose stage picture didn't come either: then the stage's own line says both and its Try Again tries both.
    @State private var pictureFailed: Set<String> = []
    @Environment(\.scenePhase) private var scenePhase
    @State private var measured: [String: [Double]] = [:]
    @State private var showingPhotos = false
    /// The part's AR file is being written (`ARModel.usdz`), or couldn't be.
    @State private var arPreparing = false
    @State private var arFailed = false
    @State private var arTask: Task<Void, Never>?

    private var gallery: ProjectGallery { ProjectGallery(project: project, scanOnThisDevice: localScan != nil) }
    private var entry: ProjectGallery.Entry? {
        let entries = gallery.entries
        return entries.first { $0.id == selected } ?? entries.first
    }

    var body: some View {
        VStack(spacing: 10) {
            stage
                .frame(height: height)
                .clipped()
                .overlay(alignment: .bottom) { controls }
            if let entry { unavailable(entry) }
            if gallery.entries.count > 1 { labels }
        }
        .onChange(of: "\(modelURL?.path ?? "")#\(project.spoolColour ?? "")") { cancelAR(); arFailed = false }
        .onChange(of: scenePhase) { _, phase in if phase != .active { cancelAR() } }
        .onChange(of: selected) { cancelAR(); arFailed = false }
        .onDisappear { cancelAR() }
        .task(id: "\(project.id)#\(project.scan ?? "")#\(Int64(project.mediaVersion))#\(String(describing: project.scanFiles))#\(scenePhase)") {
            // The store fetches them, so leaving the page never stops a download (Nov 10). Coming back to the page or to
            // the app starts again one that failed meanwhile (a suspended app's transfer drops).
            guard scenePhase == .active else { return }
            if case .file(let path) = scanModel { store.models.want(project, path) }
            if gallery.entries.contains(where: { $0.kind == .together }), case .file(let path) = togetherModel { store.models.want(project, path) }
        }
    }

    // MARK: The models the stage draws

    private var limit: Double { Double(CompanionClient.scanLimit) }
    /// What you scanned: the scan model the Mac offers that this phone takes (the phone's own beside a Mac rebuild).
    private var scanModel: Project.ScanModel { project.scanModel(limit: limit) }
    /// Together: the scan whose frame the seats are in.
    private var togetherModel: Project.ScanModel { project.scanModel(together: true, limit: limit) }
    /// The scan to draw: the Mac's once it is here; this phone's own (before the Mac has one, or while it comes).
    private var scanURL: URL? {
        if case .file(let path) = scanModel, let file = store.models.file(project, path) { return file }
        return localScan
    }
    private var togetherScanURL: URL? {
        if case .file(let path) = togetherModel { return store.models.file(project, path) }
        return nil
    }

    /// The still for an entry (`StagePicture`, the stage's one still picture): its Mac picture until its model is drawn,
    /// and if it can't be; that one is coming; or that none can be had.
    private func still(_ entry: ProjectGallery.Entry) -> StagePicture {
        let problem = modelProblem(entry)
        // The model can't be had either: the stage's one line says both; its Try Again also retries the model when that can help.
        // When the Mac couldn't draw a picture at all, that is what the line says beside the model's reason (review S4).
        let still = project.still(for: entry)
        let neverDrawn = still == .notAvailable
        let missing: (line: String, retry: (() -> Void)?)? = problem.map { problem in
            let retry: (() -> Void)? = problem.reason.retryable ? problem.path.map { path in { store.models.retry(project, path) } } : nil
            return (problem.reason.line(entry.kind, pictureToo: true, neverDrawn: neverDrawn), retry)
        }
        return StagePicture(project: project, still: still, label: entry.label,
                            unavailableLine: entry.kind == .plate ? "No picture of this plate came with the file." : "Your Mac couldn’t draw a picture of this.",
                            modelMissing: missing,
                            failedChanged: { failed in if failed { pictureFailed.insert(entry.id) } else { pictureFailed.remove(entry.id) } },
                            controlsInset: Self.controlsHeight)
    }

    /// Why an entry's 3D model isn't drawn, from how its fetch actually ended (board X100: a refused part was called "too
    /// detailed", a scan's words for a size it never had): its line, the file to try again, and whether trying can help.
    private struct ModelProblem { var reason: ModelUnavailable; var path: String? }
    private func modelProblem(_ entry: ProjectGallery.Entry) -> ModelProblem? {
        let (path, model): (String?, Project.ScanModel?) = switch entry.drawing {
        case .model(let drawn) where drawn == "model.stl": ("model.stl", nil)
        case .model: (nil, scanURL == nil ? scanModel : nil)
        // Together needs both: the scan, and the part (review S4: with the scan here and the part missing it said nothing).
        case .assembly: togetherScanURL == nil ? (nil, togetherModel) : (modelURL == nil ? "model.stl" : nil, nil)
        case .picture: (nil, nil)
        }
        let fetch: ModelFiles.Fetch? = if let path { modelURL == nil ? store.models.fetch(project, path) : nil }
            else if case .file(let file)? = model { store.models.fetch(project, file) }
            else if case .tooLarge? = model { .tooLarge } else { nil }
        let retryPath: String? = path ?? { if case .file(let file)? = model { return file }; return nil }()
        switch fetch {
        case .failed?: return ModelProblem(reason: store.reachable == false ? .notAnswering : .didntCome, path: retryPath)
        case .refused?: return ModelProblem(reason: .refused, path: retryPath)
        case .tooLarge?: return ModelProblem(reason: .tooLarge, path: nil)
        default: return undrawable.contains(entry.id) ? ModelProblem(reason: .undrawable, path: nil) : nil
        }
    }

    /// One plain line under the stage when an entry's model can't be had: its picture stays above it. A picture's own
    /// state is the stage's (`StagePicture`), never a second line here.
    @ViewBuilder private func unavailable(_ entry: ProjectGallery.Entry) -> some View {
        // The picture failed too: the stage already says both in one line, with one Try Again for both.
        if let problem = modelProblem(entry), !pictureFailed.contains(entry.id), project.still(for: entry) != .notAvailable {
            if problem.reason.retryable {
                HStack(spacing: 8) {
                    Text(problem.reason.line(entry.kind)).font(.footnote).foregroundStyle(.secondary)
                    if let path = problem.path {
                        Button("Try Again") { store.models.retry(project, path) }.font(.footnote.weight(.semibold))
                            .accessibilityIdentifier("gallery-model-retry")
                    }
                }
                .padding(.horizontal, 16)
                .accessibilityElement(children: .contain).accessibilityIdentifier("gallery-model-unavailable")
            } else {
                Text(problem.reason.line(entry.kind)).font(.footnote).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(.horizontal, 16).accessibilityIdentifier("gallery-model-unavailable")
            }
        }
    }

    // MARK: Stage

    @ViewBuilder private var stage: some View {
        if let entry {
            switch entry.drawing {
            case .model(let path):
                ModelStage(url: path == "model.stl" ? modelURL : scanURL, tint: tint(entry.colour),
                           lightStage: StageContrast.lightStage(for: entry.colour), measured: { drawn(entry, $0) },
                           placeholder: AnyView(still(entry)), undrawable: { undrawable.insert(entry.id) },
                           drawn: { undrawable.remove(entry.id) })
                    .id(entry.id)
            case .assembly(_, _, let seats):
                // Both models or neither: a part with no scan at its seats would not be Together.
                ModelStage(url: togetherScanURL == nil ? nil : modelURL, tint: tint(entry.colour), lightStage: StageContrast.lightStage(for: entry.colour),
                           object: togetherScanURL, seats: seats.map(\.matrix), measured: { drawn(entry, $0) }, placeholder: AnyView(still(entry)), undrawable: { undrawable.insert(entry.id) },
                           drawn: { undrawable.remove(entry.id) })
                    .id(entry.id)
            case .picture:
                still(entry)
            }
        } else if let photo = project.photoPicture {
            // Photos sent, no scan model or result yet: the subject the Mac cut out, as the project's card shows it.
            StagePicture(project: project, still: .picture(photo), label: "Your photo")
        } else {
            // Nothing to show yet: coming while the Mac works, else said plainly.
            StagePicture(project: project, still: words.busy ? .waiting : .notAvailable, label: project.title ?? "Your project",
                         unavailableLine: "Nothing to show yet.")
        }
    }

    /// The model drew (`ModelStage` measured it): its size for the chip, and any earlier "couldn't be shown" line goes
    /// (review S5 on #539). ModelStage measures before it draws its poster, so a poster that then fails still says so.
    private func drawn(_ entry: ProjectGallery.Entry, _ size: [Double]) {
        measured[entry.id] = size
        undrawable.remove(entry.id)
    }

    private func tint(_ colour: ProjectGallery.Colour) -> UIColor? {
        guard case .spool(let hex) = colour, let value = Int(hex.dropFirst().prefix(6), radix: 16) else { return nil }
        return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }

    // MARK: Controls on the stage: AR, the scan's photos, Together, and the size of what is shown

    /// What the row of controls takes at the stage's bottom: its padding and one glass button or chip. The stage's words lay
    /// out above it (`StagePicture.controlsInset`).
    static let controlsHeight: CGFloat = 14 + 44

    @ViewBuilder private var controls: some View {
        if let entry {
            let light = StageContrast.lightStage(for: entry.colour)
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if let ar = arChip(entry) { arButton(ar, light: light) }
                    if entry.kind == .scan, !entry.photos.isEmpty {
                        Button { showingPhotos = true } label: { Label(entry.photos.count == 1 ? "1 photo" : "\(entry.photos.count) photos", systemImage: "photo.on.rectangle") }
                            .stageButton(light: light).accessibilityIdentifier("gallery-photos")
                    }
                    if entry.kind == .part, let locate, project.canLocate {
                        Button(action: locate) { Label("See it together", systemImage: "cube.transparent") }
                            .stageButton(light: light).disabled(working).accessibilityIdentifier("gallery-locate")
                            .accessibilityHint("Your Mac works out where the scanned object sits in this part, without changing it")
                    }
                    Spacer(minLength: 0)
                    if let size = entry.sizeText(measured[entry.id]) {
                        Text(size).font(.caption.monospacedDigit().weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            .padding(.horizontal, 12).padding(.vertical, 8).stageChip(light: light)
                            .accessibilityLabel("\(entry.measures) size \(size)").accessibilityIdentifier("gallery-size")
                    }
                }
                .labelStyle(.titleAndIcon).font(.caption.weight(.semibold))
            }
            .padding(14)
            .sheet(isPresented: $showingPhotos) { ScanPhotos(project: project, photos: entry.photos) }
        }
    }

    // MARK: AR: one control, for what the stage shows

    /// What the stage's AR chip can do for an entry (Nov 11: one AR control, not a chip and a second button). A part is
    /// prepared on tap; the scan is Object Capture's own USDZ. Together, a plate and a multi-colour 3MF's picture have no
    /// AR file the phone can make, so they offer none.
    enum ARChip: Equatable { case show(URL), prepare(URL), preparing, failed(URL), failedScan(URL), needsMac }

    private func arChip(_ entry: ProjectGallery.Entry) -> ARChip? {
        switch entry.kind {
        case .part:
            guard case .model(let path) = entry.drawing, path == "model.stl" else { return nil }
            if arPreparing { return .preparing }
            if let arURL { return .show(arURL) }
            if let modelURL { return arFailed ? .failed(modelURL) : .prepare(modelURL) }
            return store.away ? .needsMac : nil
        case .scan:
            if let scanURL, scanURL.pathExtension.lowercased() == "usdz" { return arFailed ? .failedScan(scanURL) : .show(scanURL) }
            if case .file = scanModel, store.away { return .needsMac }
            return nil
        case .together, .plate:
            return nil
        }
    }

    @ViewBuilder private func arButton(_ chip: ARChip, light: Bool) -> some View {
        switch chip {
        case .show(let url):
            Button {
                // A file that went away meanwhile (the cache was cleared) is made again rather than showing nothing.
                if !ARModel.show(url) {
                    arFailed = true
                    if let modelURL, url == arURL { arURL = nil; prepareAR(modelURL) }
                }
            } label: { Label("AR", systemImage: "arkit") }
                .stageButton(light: light).accessibilityValue("ready")
                .accessibilityHint("Places it at true size in your room").accessibilityIdentifier("gallery-ar")
        case .prepare(let stl):
            Button { prepareAR(stl) } label: { Label("AR", systemImage: "arkit") }
                .stageButton(light: light).accessibilityValue("ready")
                .accessibilityHint("Places it at true size in your room").accessibilityIdentifier("gallery-ar")
        case .preparing:
            Button {} label: { HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Preparing AR…") } }
                .stageButton(light: light).disabled(true).accessibilityValue("preparing").accessibilityIdentifier("gallery-ar")
        case .failed(let stl):
            Button { prepareAR(stl) } label: { Label("AR didn’t open. Try Again", systemImage: "arkit") }
                .stageButton(light: light).accessibilityValue("failed").accessibilityIdentifier("gallery-ar")
        case .failedScan(let url):
            Button { arFailed = !ARModel.show(url) } label: { Label("AR didn’t open. Try Again", systemImage: "arkit") }
                .stageButton(light: light).accessibilityValue("failed").accessibilityIdentifier("gallery-ar")
        case .needsMac:
            Button {} label: { Label("AR needs your Mac", systemImage: "arkit") }
                .stageButton(light: light).disabled(true).accessibilityValue("needs-mac")
                .accessibilityHint("Your Mac isn’t answering and the model isn’t on this iPhone yet").accessibilityIdentifier("gallery-ar")
        }
    }

    /// Writes the part's USDZ (seconds for a large part), then opens AR Quick Look on it.
    private func prepareAR(_ stl: URL) {
        arTask?.cancel()
        arPreparing = true; arFailed = false
        let tint = project.spoolColour, scene = String(describing: scenePhase)
        arTask = Task {
            let prepared = await MediaTrace.$context.withValue(MediaTrace.Context(file: stl, scene: scene)) {
                await ARModel.usdz(fromSTL: stl, tint: tint)
            }
            guard !Task.isCancelled else { return }
            arPreparing = false
            if let prepared, ARModel.show(prepared) { arURL = prepared } else { arFailed = true }
        }
    }

    private func cancelAR() { arTask?.cancel(); arTask = nil; arPreparing = false }

    // MARK: Labels

    private var labels: some View {
        ScrollViewReader { reader in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(gallery.entries) { item in
                        let chosen = item.id == entry?.id
                        Button { withAnimation(.snappy) { selected = item.id } } label: {
                            Text(item.label).font(.subheadline.weight(.semibold)).lineLimit(1)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .foregroundStyle(chosen ? Color.black : Color.primary)
                                .background(chosen ? Color.white : Color.white.opacity(0.10), in: .capsule)
                        }
                        .buttonStyle(.plain).id(item.id)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                        .accessibilityIdentifier("gallery-\(item.id)")
                    }
                }
                .padding(.horizontal, 20)
            }
            .scrollIndicators(.hidden)
            .onChange(of: selected) { _, id in withAnimation { reader.scrollTo(id, anchor: .center) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pictures")
    }
}

/// The scan's photos, one tap in from "What you scanned": where raw photos belong (David, Nov 10). The first one, large,
/// and how many there are; the whole set is under "What you sent".
private struct ScanPhotos: View {
    let project: Project
    let photos: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                ProjectImage(project: project, path: photos.first, maxPixelSize: 1600, contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 16))
                Text(photos.count == 1 ? "The photo your scan was made from." : "1 of the \(photos.count) photos your scan was made from. All of them are under What you sent.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .navigationTitle("What you scanned").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
