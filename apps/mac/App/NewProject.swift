import SwiftUI
import AppKit
import UniformTypeIdentifiers
import LinkPresentation
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

struct NewProjectDraft: Identifiable, Equatable {
    let id = UUID()
    var files: [URL] = []
    /// A project whose scan the new one is made from (design §3.3).
    var seed: Project? = nil
}

/// New Project on the Mac (PRD §7.2): the detail becomes the drop target. Drop photos, an STL, 3MF or USDZ, or
/// just say what you need. It shows on the phone too, because the phone reads the same projects.
struct NewProjectPane: View {
    @ObservedObject var model: ObjectsModel
    let close: () -> Void
    @State private var request = ""
    @State private var files: [URL]
    @State private var kind = "fit"
    @State private var targeted = false
    @State private var starting = false
    @State private var problem: String?
    /// The kept scan this project is made from: the page's, or one chosen under "Use a scan you already have".
    @State private var seed: Project?
    /// Asked first for a kept scan: nothing is chosen for the person.
    @State private var scanUse: String?

    init(model: ObjectsModel, draft: NewProjectDraft, close: @escaping () -> Void) {
        self.model = model
        self.close = close
        _seed = State(initialValue: draft.seed)
        _files = State(initialValue: draft.files)
        _kind = State(initialValue: draft.files.contains { ObjectsModel.fileKind($0) == "scan" } ? "copy" : "fit")
    }

    private var available: Bool { model.capabilities?.objectsCreate == true }
    private var empty: Bool { request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty }
    /// PRD §8.11: a model page's link in the request. The project prints what the designer published.
    private var link: URL? { ModelLink.find(in: request) }

    var body: some View {
        ZStack {
            StageBackground().ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let seed {
                        seeded(seed)
                    } else {
                        Picker("", selection: $kind) {
                            Text("Make something that fits").tag("fit")
                            Text("Copy something").tag("copy")
                        }
                        .pickerStyle(.segmented).labelsHidden().frame(width: 380)
                        dropZone
                        if files.isEmpty { existingScans }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What do you need?").font(.headline)
                        TextField(kind == "fit" ? "A hook for my stroller handle…" : "Copy this, and close up the bottom…", text: $request, axis: .vertical)
                            .textFieldStyle(.plain).lineLimit(3...5)
                            .padding(14).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                    }
                    if let link { LinkCard(url: link) }
                    if !available {
                        Label(ObjectsModel.createUnavailable, systemImage: "iphone").font(.callout).foregroundStyle(.secondary)
                    }
                    if let problem { Label(problem, systemImage: "exclamationmark.circle.fill").font(.callout).foregroundStyle(.red) }
                    HStack {
                        Label(model.latestDevice.map { "It shows up on \($0.deviceName) too." } ?? "It shows up on your iPhone too.", systemImage: "iphone")
                            .font(.callout).foregroundStyle(.secondary)
                        Spacer()
                        if starting { ProgressView().controlSize(.small) }
                        Button("Cancel", action: close).controlSize(.extraLarge).keyboardShortcut(.cancelAction)
                        Button { start() } label: { Text(sendLabel).padding(.horizontal, 6) }
                            .buttonStyle(.glassProminent).controlSize(.extraLarge).keyboardShortcut(.defaultAction)
                            .disabled(!available || starting || (seed == nil ? empty : scanUse == nil || (scanUse == "fit" && wordless)))
                    }
                    // Or start from a starter: New Project is where a Mac with projects goes to start something
                    // (PRD §5.11). Adding one opens it, which closes this pane.
                    Divider().padding(.vertical, 6)
                    StarterProjectsView { try await model.addStarter($0) }
                }
                .frame(maxWidth: 640)
                .padding(32)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center, for: .alignment)
        }
        .environment(\.colorScheme, .dark)
        .navigationTitle("New Project")
        .navigationSubtitle("Your Mac starts as soon as you create it")
    }

    private var wordless: Bool { request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var sendLabel: String {
        guard seed != nil else { return link == nil ? "Create Project" : "Get This Model" }
        switch scanUse {
        case nil: return "Choose What This Scan Becomes"
        case "fit": return wordless ? "Say What It Should Fit" : "Create Project"
        default: return ScanLineage.copyChoice
        }
    }

    /// New holding a scan this Mac already has (design §3.3): the question first, the scan named by its project.
    @ViewBuilder private func seeded(_ seed: Project) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                ProjectThumbnail(object: seed).frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 2) {
                    Text("What should this scan become?").font(.title2.bold())
                    Text("\(ProjectWords.title(seed)) · \(ScanLineage.scannedLine(seed))").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Remove") { self.seed = nil; scanUse = nil }.disabled(starting)
            }
            HStack(spacing: 10) {
                ForEach([("copy", ScanLineage.copyChoice, "doc.on.doc"), ("fit", ScanLineage.fitChoice, "ruler")], id: \.0) { value, title, symbol in
                    Button { scanUse = value } label: {
                        Label(title, systemImage: scanUse == value ? "checkmark.circle.fill" : symbol).frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.glass).controlSize(.large)
                    .overlay { if scanUse == value { RoundedRectangle(cornerRadius: 14).strokeBorder(Color.filament, lineWidth: 2) } }
                    .accessibilityAddTraits(scanUse == value ? .isSelected : [])
                }
            }
            Text("Your Mac copies this scan, its photos and its checked sizes into a new project. The project it came from stays as it is.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .padding(20).glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    /// "Use a scan you already have": the scans this Mac keeps on other projects, by picture and name.
    @ViewBuilder private var existingScans: some View {
        let scans = ScanLineage.scans(in: model.objects)
        if !scans.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(ScanLineage.useExisting).font(.headline)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(scans) { project in
                            Button { seed = project; scanUse = nil } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    ProjectThumbnail(object: project).frame(width: 140, height: 100).clipShape(.rect(cornerRadius: 14))
                                    Text(ProjectWords.title(project)).font(.callout.weight(.semibold)).lineLimit(2)
                                    Text(ScanLineage.scannedLine(project)).font(.caption).foregroundStyle(.secondary)
                                }
                                .frame(width: 140, alignment: .topLeading)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("existing-scan-\(project.id)")
                        }
                    }
                }
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 14) {
            HStack(spacing: 18) {
                Image(systemName: "photo.on.rectangle.angled"); Image(systemName: "cube"); Image(systemName: "rotate.3d")
            }
            .font(.system(size: 30, weight: .light)).foregroundStyle(Color.filament)
            Text("Drop photos, STL, 3MF or USDZ files").font(.title3.weight(.semibold))
            Text("or [choose them](counterpart-choose:), or just describe it below")
                .font(.callout).foregroundStyle(.secondary)
                .environment(\.openURL, OpenURLAction { _ in choose(); return .handled })
            if !files.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) { ForEach(files, id: \.self) { url in DroppedChip(url: url) { files.removeAll { $0 == url } } } }
                        .padding(.horizontal, 12)
                }
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity).frame(height: 300)
        .glassEffect(.regular.tint(Color.filament.opacity(targeted ? 0.22 : 0.10)), in: .rect(cornerRadius: 28))
        .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(Color.filament, style: .init(lineWidth: 2, dash: [8, 6])) }
        .dropDestination(for: URL.self) { urls, _ in add(urls) } isTargeted: { targeted = $0 }
    }

    @discardableResult private func add(_ urls: [URL]) -> Bool {
        let usable = urls.filter { ObjectsModel.fileKind($0) != nil && !files.contains($0) }
        files += usable
        if usable.contains(where: { ObjectsModel.fileKind($0) == "scan" }) { kind = "copy" }
        return !usable.isEmpty
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.jpeg, .heic, .png, .usdz] + ["stl", "3mf"].compactMap { UTType(filenameExtension: $0) }
        panel.prompt = "Add"
        if panel.runModal() == .OK { add(panel.urls) }
    }

    private func start() {
        starting = true
        problem = nil
        Task {
            if let seed, let scanUse {
                problem = await model.makeFromScan(seed.id, kind: scanUse, instructions: request)
            } else if let link {
                problem = await model.startProject(instructions: ModelLink.words(in: request, without: link), files: files, kind: "published",
                                                   url: link.absoluteString)
            } else {
                problem = await model.startProject(instructions: request, files: files, kind: kind)
            }
            starting = false
            if problem == nil { close() }
        }
    }
}

/// A dropped file, in a glass capsule, with its own remove button.
private struct DroppedChip: View {
    let url: URL
    let remove: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if ObjectsModel.fileKind(url) == "photos" { FillImage(url: url, version: 0) }
                else { ZStack { Color.stageBottom; Image(systemName: "cube").font(.caption).foregroundStyle(.white) } }
            }
            .frame(width: 30, height: 30).clipShape(.rect(cornerRadius: 6))
            Text(url.lastPathComponent).font(.callout).lineLimit(1)
            Button(action: remove) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .buttonStyle(.plain).accessibilityLabel("Remove \(url.lastPathComponent)")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
    }
}

/// The link as a card with the page's own title and picture, from Apple's LinkPresentation. Only the answer for the
/// link shown now fills it: an answer for an earlier link is dropped.
private struct LinkCard: NSViewRepresentable {
    let url: URL
    final class Coordinator { var requested: URL? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> LPLinkView {
        let view = LPLinkView(url: url)
        load(into: view, context.coordinator)
        return view
    }
    func updateNSView(_ view: LPLinkView, context: Context) {
        guard context.coordinator.requested != url else { return }
        view.metadata = LPLinkMetadata()
        load(into: view, context.coordinator)
    }
    private func load(into view: LPLinkView, _ coordinator: Coordinator) {
        let address = url
        coordinator.requested = address
        LPMetadataProvider().startFetchingMetadata(for: address) { metadata, _ in
            guard let metadata else { return }
            DispatchQueue.main.async { if coordinator.requested == address { view.metadata = metadata } }
        }
    }
}
