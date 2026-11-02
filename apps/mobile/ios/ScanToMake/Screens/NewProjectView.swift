import SwiftUI
import CounterpartKit

/// New (PRD §5.2, screens/phone-new.jpg): say what you need, show it five ways, and send. The text is kept
/// whatever you do; a scan returns here attached; Send creates the project at once and the files follow
/// while the project shows Sending.
///
/// Guards: every action runs through `run`, single flight (`working`), released when it settles. A capture
/// finished for this draft is never reopened or replaced; its files are sent from the project page if a
/// send is cut short.
struct NewObjectView: View {
    let store: ProjectsStore
    var job: NewProjectJob? = nil
    /// The project was created: the sheet closes and its page opens.
    let started: (Project) -> Void
    @AppStorage("CounterpartNewDraft") private var instructions = ""
    /// The draft project this sheet made, kept so closing New and coming back finishes the same one.
    @AppStorage("CounterpartNewDraftId") private var draftId = ""
    @State private var photos: [ChosenPhoto] = []
    @State private var working: String?
    @State private var problem: String?
    @State private var askedForDescription = false
    @State private var created: Project?
    @State private var attached: Attached?
    @FocusState private var describing: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// A scan finished for this draft, kept on this phone until Send.
    enum Attached: Equatable { case walkAround, inHand }

    private var described: Bool { !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// The Mac's own rule for starting, in its words: photos show what something looks like, so without a
    /// scan the description says what to make. A scan always goes with its own photos.
    private var missing: String? {
        described || attached != nil ? nil : "Describe what to make, or add a scan."
    }
    private var canSend: Bool { missing == nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What do you need?").font(.headline)
                        TextField(job == .copy ? "Copy this. Close up the bottom." : "A hook for my stroller handle…", text: $instructions, axis: .vertical)
                            .lineLimit(3...6)
                            .focused($describing)
                            .padding(14)
                            .glassEffect(.regular, in: .rect(cornerRadius: 20))
                            .accessibilityIdentifier("describe")
                        Text(askedForDescription ? missing ?? Self.hint : Self.hint)
                            .font(.footnote).foregroundStyle(askedForDescription && !canSend ? .red : .secondary)
                    }

                    Text("Show it").font(.headline)
                    RigTile(enabled: store.canScan && working == nil, scan: { Task { await scan(handheld: false) } },
                            printRig: { openURL(CounterpartIdentifiers.scanRig) })
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        SourceTile(symbol: "cube.transparent", title: "Scan it", detail: store.canScan ? "Walk around it. LiDAR measures it." : "Needs an iPhone or iPad with LiDAR.",
                                   tint: .filament, enabled: store.canScan && working == nil) { Task { await scan(handheld: false) } }
                            .accessibilityIdentifier("scan-object")
                        SourceTile(symbol: "hand.raised.fingers.spread", title: "Scan in hand",
                                   detail: HandheldCapture.isAvailable ? "Hold it up and turn it." : "Needs an iPhone or iPad with LiDAR.",
                                   tint: .blue, enabled: HandheldCapture.isAvailable && working == nil) { Task { await scan(handheld: true) } }
                            .accessibilityIdentifier("capture-photos")
                        SourceTile(symbol: "camera", title: "Take photos", detail: photos.count < Self.photoLimit ? "A few angles is plenty." : "24 photos is the most.", tint: .purple,
                                   enabled: working == nil && !photosLocked && photos.count < Self.photoLimit) { Task { await addPhotos(camera: true) } }
                        SourceTile(symbol: "photo.on.rectangle.angled", title: "From Photos", detail: photos.count < Self.photoLimit ? "Pick what you have." : "24 photos is the most.", tint: .green,
                                   enabled: working == nil && !photosLocked && photos.count < Self.photoLimit) { Task { await addPhotos(camera: false) } }
                    }

                    if attached != nil || !photos.isEmpty {
                        Text("Added").font(.headline)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                if let attached {
                                    AttachmentChip(image: nil, symbol: attached == .walkAround ? "cube.transparent" : "hand.raised.fingers.spread",
                                                   label: attached == .walkAround ? "Scan" : "Scan in hand", remove: nil)
                                }
                                ForEach(photos) { photo in
                                    AttachmentChip(url: photo.url, label: "Photo", remove: photosLocked ? nil : { photos.removeAll { $0.id == photo.id } })
                                }
                            }
                        }
                    }
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red)
                    }
                }
                .padding(20)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.disabled(working == "make") }
                if describing { ToolbarItem(placement: .confirmationAction) { Button("Done") { describing = false } } }
            }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await make() } } label: {
                    Label(working == "make" ? "Sending…" : "Send to \(store.macName ?? "your Mac")", systemImage: "arrow.up")
                        .fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40)
                }
                .buttonStyle(.glassProminent).controlSize(.large).padding(.horizontal, 20)
                .disabled(working != nil)
                .accessibilityIdentifier("send")
                .frame(maxWidth: 640)
            }
            .interactiveDismissDisabled(working != nil)
            .dropDestination(for: Data.self) { items, _ in
                Task { await addDropped(items) }
                return !items.isEmpty
            }
        }
        .task {
            // A draft from an earlier sheet keeps its project and its finished scan.
            _ = try? await savedDraft()
            if let created, attached == nil { attached = await savedCapture(created.id) }
        }
    }

    /// The Mac takes up to 24 photos with a project.
    static let photoLimit = 24

    static let hint = "Describe it, scan it, or both. Your Mac can look up published sizes, like a phone or a mic."

    /// Chosen photos stay put while something is running.
    private var photosLocked: Bool { working != nil }

    private func run(_ kind: String, _ body: () async throws -> Void) async {
        guard working == nil else { return }
        working = kind; problem = nil
        defer { working = nil }
        do { try await body() }
        catch let failure as CompanionError {
            if failure.code == "cancelled" { return }
            if failure.needsPairing { dismiss(); store.onPair(); return }
            problem = failure.message
        } catch { problem = CompanionError.unreachable.message }
    }

    private func addPhotos(camera: Bool) async {
        describing = false
        await run("photos") {
            if camera {
                guard photos.count < Self.photoLimit else { return }
                if let photo = try await PhotoSources.takePhoto(), let chosen = MacConnection.keep(photo) { photos.append(chosen) }
            } else {
                guard photos.count < Self.photoLimit else { return }
                photos += try await store.mac.choosePhotos(limit: Self.photoLimit - photos.count)
            }
        }
    }

    private func addDropped(_ items: [Data]) async {
        for data in items.prefix(max(0, Self.photoLimit - photos.count)) {
            let ext = data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? "png" : "jpg"
            if let image = UIImage(data: data), let chosen = MacConnection.keep(PickedPhoto(data: ext == "png" ? data : (image.jpegData(compressionQuality: 0.9) ?? data), ext: ext)) {
                photos.append(chosen)
            }
        }
    }

    /// The draft this sheet made, kept so a retry finishes it instead of making another.
    /// The draft an earlier New sheet made, resolved before anything could make a second one. Nil when
    /// there's none or the Mac no longer has it; any other failure throws, so Send never duplicates it.
    private func savedDraft() async throws -> Project? {
        guard created == nil, !draftId.isEmpty else { return nil }
        do {
            let saved = try await store.mac.get(draftId)
            if saved.state == .new { created = saved } else { draftId = "" }
            return saved
        } catch let failure as CompanionError where failure.code == "not-found" { draftId = ""; return nil }
    }

    private func object() async throws -> Project {
        // A sent draft (started elsewhere) opens as it is.
        if let saved = try await savedDraft(), saved.state != .new { return saved }
        if let created {
            let latest = try await store.mac.get(created.id)
            // Start may have succeeded even when its reply was lost; never PATCH a started request.
            guard latest.state == .new else { return latest }
            do { return try await store.mac.updateDraft(created.id, instructions: instructions) }
            catch {
                if let current = try? await store.mac.get(created.id), current.state != .new { return current }
                throw error
            }
        }
        let object = try await store.mac.create(instructions)
        created = object
        draftId = object.id
        return object
    }

    /// Send: the project is made at once and its page opens; its files follow while it shows Sending.
    /// Everything the send needs is captured now: this sheet is gone by the time the files go.
    private func make() async {
        guard canSend else { askedForDescription = true; describing = true; return }
        describing = false
        await run("make") {
            let object = try await object()
            guard object.state == .new else { started(object); return }
            let chosen = photos, mac = store.mac
            store.replace(object)
            instructions = ""
            draftId = ""
            started(object)
            await store.sendInBackground(object.id) { [store] in
                store.replace(try await mac.sendProject(object.id, photos: chosen))
            }
        }
    }

    private func savedCapture(_ id: String) async -> Attached? {
        if HandheldCapture.finished(id) { return .inHand }
        if await store.mac.finishedScan(id) != nil { return .walkAround }
        return nil
    }

    /// Scans for this draft and comes back here with the scan attached; Send sends it with the rest.
    private func scan(handheld: Bool) async {
        describing = false
        await run("scan") {
            let object = try await object()
            guard object.state == .new else { started(object); return }
            if let saved = await savedCapture(object.id) { attached = saved; return }
            guard object.scan == nil, (object.capture ?? []).isEmpty else {
                throw CompanionError(code: "missing-capture", message: "This project's saved scan is no longer on this phone. Start a new project to scan it again.")
            }
            if handheld {
                if await HandheldCapture.run(objectId: object.id) { attached = .inHand }
            } else if try await store.mac.scan(object.id) != nil {
                attached = .walkAround
            }
        }
    }
}

/// On a scan rig (PRD §5.2, §11.1): the best-quality way, with Kass 3D's rig credited and linked.
struct RigTile: View {
    let enabled: Bool
    let scan: () -> Void
    let printRig: () -> Void
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "rotate.3d.fill").font(.title2.weight(.semibold)).foregroundStyle(Color.okGreen)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.tint(Color.okGreen.opacity(0.25)), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) { Text("On a scan rig").font(.headline); Text("BEST QUALITY").font(.caption2.weight(.bold)).foregroundStyle(Color.okGreen) }
                Text(enabled ? "Clamp your phone to the 360° rig and swing it around." : "Needs an iPhone or iPad with LiDAR.")
                    .font(.caption).foregroundStyle(.secondary)
                Button(action: printRig) { Text("Don't have one? Print the rig by Kass 3D →").font(.caption.weight(.semibold)).foregroundStyle(Color.filament) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the rig's page on MakerWorld")
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .contentShape(.rect)
        .onTapGesture { if enabled { scan() } }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
        .opacity(enabled ? 1 : 0.55)
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Scan on a rig") { if enabled { scan() } }
    }
}

/// One way to show it.
struct SourceTile: View {
    let symbol: String, title: String, detail: String, tint: Color
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol).font(.title2.weight(.semibold)).foregroundStyle(tint)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.tint(tint.opacity(0.25)), in: .circle)
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
            .padding(14)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
    }
}

/// Something attached to the new project, with a remove button.
struct AttachmentChip: View {
    var url: URL? = nil
    var image: UIImage? = nil
    var symbol: String = "photo"
    let label: String
    var remove: (() -> Void)?
    @State private var loaded: UIImage?

    init(url: URL, label: String, remove: (() -> Void)?) { self.url = url; self.label = label; self.remove = remove }
    init(image: UIImage?, symbol: String, label: String, remove: (() -> Void)?) { self.image = image; self.symbol = symbol; self.label = label; self.remove = remove }

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                StageBackground()
                if let shown = loaded ?? image { Image(uiImage: shown).resizable().scaledToFill() }
                else { Image(systemName: symbol).font(.title2).foregroundStyle(Color.filament) }
            }
            .frame(width: 76, height: 76).clipShape(.rect(cornerRadius: 16))
            .overlay(alignment: .topTrailing) {
                if let remove {
                    Button(action: remove) {
                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                    }
                    .padding(4)
                    .accessibilityLabel("Remove this \(label.lowercased())")
                }
            }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .task(id: url) {
            guard let url else { return }
            loaded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: 228) }.value
        }
    }
}
