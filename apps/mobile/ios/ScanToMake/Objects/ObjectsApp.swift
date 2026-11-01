import SwiftUI
import UIKit
import React

// The phone's app UI, in SwiftUI so it is the system's own iOS 27 design (Liquid Glass bars, toolbars,
// sheets, lists and buttons). Every network, photo, capture and 3D call goes through the native modules
// the React Native app already uses and tests (ObjectsBridge, NativeCaptureCoordinator, CompanionPairing),
// so pairing, pinning and uploads behave exactly as before. Pairing itself stays a React Native screen.

// MARK: - The native modules, called directly

@objc private protocol ObjectsBridgeCalls {
    @objc(callOptions:resolve:reject:) func call(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(sendCaptureOptions:resolve:reject:) func sendCapture(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(choosePhotosOptions:resolve:reject:) func choosePhotos(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(sendChosenOptions:resolve:reject:) func sendChosen(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(pickPhotosOptions:resolve:reject:) func pickPhotos(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(takePhotoOptions:resolve:reject:) func takePhoto(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(downloadOptions:resolve:reject:) func download(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(showModelOptions:resolve:reject:) func showModel(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
}
@objc private protocol CaptureCalls {
    @objc(status:reject:) func status(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(drafts:reject:) func drafts(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(start:resolve:reject:) func start(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
}
@objc private protocol PairingCalls {
    @objc(statusResolve:reject:) func status(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
    @objc(checkResolve:reject:) func check(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
}

/// A refusal in one sentence the screen can show as it is.
struct MacError: Error, Equatable {
    var code: String
    var message: String
    var needsPairing: Bool { ["pairing-required", "pairing-changed", "certificate-changed", "scope-denied", "pairing"].contains(code) }
    static let unreachable = MacError(code: "unreachable", message: "Your Mac isn't answering. Check it's on and awake, then try again.")
}

private func native(_ name: String) -> NSObject? { (NSClassFromString(name) as? NSObject.Type)?.init() }

@MainActor private func promise(_ body: (@escaping RCTPromiseResolveBlock, @escaping RCTPromiseRejectBlock) -> Void) async throws -> Any? {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any?, Error>) in
        var done = false
        body({ value in
            guard !done else { return }; done = true
            continuation.resume(returning: value)
        }, { code, message, _ in
            guard !done else { return }; done = true
            continuation.resume(throwing: MacError(code: code ?? "failed", message: message ?? "Something went wrong talking to your Mac. Try again."))
        })
    }
}

/// The Mac, through the paired, pinned connection the native modules keep.
@MainActor final class MacConnection {
    private let bridge = native("ObjectsBridge").map { unsafeBitCast($0, to: ObjectsBridgeCalls.self) }
    private let captureModule = native("NativeCaptureCoordinator").map { unsafeBitCast($0, to: CaptureCalls.self) }
    private let pairingModule = native("CompanionPairing").map { unsafeBitCast($0, to: PairingCalls.self) }

    private func require<T>(_ value: T?) throws -> T {
        guard let value else { throw MacError(code: "unavailable", message: "This needs the iPhone app.") }
        return value
    }

    private func request<T: Decodable>(_ method: String, _ path: String, _ json: [String: Any]? = nil, as type: T.Type) async throws -> T {
        let bridge = try require(bridge)
        var options: [String: Any] = ["method": method, "path": path]
        if let json { options["json"] = json }
        let reply = try await promise { bridge.call(options as NSDictionary, resolve: $0, reject: $1) } as? [String: Any]
        let status = reply?["status"] as? Int ?? 0
        let data = Data(((reply?["body"] as? String) ?? "").utf8)
        if (200..<300).contains(status) {
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw MacError(code: "invalid-response", message: "Your Mac sent something this app doesn't understand. Update both apps.") }
        }
        let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
        let message = error?["message"] as? String
        switch status {
        case 401, 403: throw MacError(code: "pairing", message: "Connect to your Mac again.")
        case 404 where path == "/v1/objects": throw MacError(code: "not-set-up", message: "Your Mac isn't ready to make things yet. Open Counterpart on your Mac.")
        case 404: throw MacError(code: "not-found", message: "This is no longer on your Mac.")
        case 409: throw MacError(code: "conflict", message: message ?? "Wait until the current step finishes.")
        default: throw MacError(code: "failed", message: "Something went wrong on your Mac. Try again.")
        }
    }
    private struct ObjectReply: Decodable { var object: StmObject }
    private struct ListReply: Decodable { var objects: [StmObject] }
    private struct Deleted: Decodable { var deleted: Bool }

    func list() async throws -> [StmObject] { try await request("GET", "/v1/objects", as: ListReply.self).objects }
    func get(_ id: String) async throws -> StmObject { try await request("GET", "/v1/objects/\(id)", as: ObjectReply.self).object }
    func create(_ instructions: String) async throws -> StmObject {
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await request("POST", "/v1/objects", text.isEmpty ? [:] : ["instructions": text], as: ObjectReply.self).object
    }
    func start(_ id: String) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/start", as: ObjectReply.self).object }
    func correct(_ id: String, _ note: String) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/corrections", ["note": note], as: ObjectReply.self).object }
    func closeup(_ id: String, bestGuess: Bool) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/closeup", ["bestGuess": bestGuess], as: ObjectReply.self).object }
    func print(_ id: String, checked: Bool) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/print", checked ? ["checked": true] : nil, as: ObjectReply.self).object }
    func plateClear(_ id: String) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/plate", ["clear": true], as: ObjectReply.self).object }
    func printCaliper() async throws -> StmObject { try await request("POST", "/v1/objects/caliper", as: ObjectReply.self).object }
    func delete(_ id: String) async throws { _ = try await request("DELETE", "/v1/objects/\(id)", as: Deleted.self) }

    /// Photos picked for a new object; they stay on this phone until sent.
    func choosePhotos(limit: Int) async throws -> [ChosenPhoto] {
        let bridge = try require(bridge)
        let chosen = try await promise { bridge.choosePhotos(["limit": limit] as NSDictionary, resolve: $0, reject: $1) } as? [[String: Any]] ?? []
        return chosen.compactMap { item in
            guard let id = item["id"] as? String, let uri = item["uri"] as? String, let url = URL(string: uri) else { return nil }
            return ChosenPhoto(id: id, url: url)
        }
    }
    func sendChosen(_ id: String, _ photos: [ChosenPhoto]) async throws {
        guard !photos.isEmpty else { return }
        let bridge = try require(bridge)
        _ = try await promise { bridge.sendChosen(["objectId": id, "ids": photos.map(\.id)] as NSDictionary, resolve: $0, reject: $1) }
    }
    /// Close-ups for an object that asked for them; sent as soon as they're picked or taken.
    func addCloseups(_ id: String, camera: Bool) async throws -> Int {
        let bridge = try require(bridge)
        let reply = try await promise {
            if camera { bridge.takePhoto(["objectId": id] as NSDictionary, resolve: $0, reject: $1) }
            else { bridge.pickPhotos(["objectId": id, "limit": 12] as NSDictionary, resolve: $0, reject: $1) }
        } as? [String: Any]
        return reply?["photosSent"] as? Int ?? 0
    }
    func download(_ object: StmObject, _ name: String) async throws -> URL? {
        let bridge = try require(bridge)
        let reply = try await promise {
            bridge.download(["objectId": object.id, "name": name, "version": object.updatedAtMs] as NSDictionary, resolve: $0, reject: $1)
        } as? [String: Any]
        return (reply?["uri"] as? String).flatMap(URL.init(string:))
    }
    func showModel(_ object: StmObject) async throws {
        let bridge = try require(bridge)
        _ = try await promise { bridge.showModel(["objectId": object.id, "version": object.updatedAtMs] as NSDictionary, resolve: $0, reject: $1) }
    }

    // LiDAR capture: the native Object Capture flow, with the object's id as its origin, so a finished
    // scan that wasn't sent is found again and sent.
    func canScan() async -> Bool {
        guard let captureModule else { return false }
        let status = (try? await promise { captureModule.status($0, reject: $1) }) as? [String: Any]
        return status?["supported"] as? Bool == true && status?["lidar"] as? Bool != false
    }
    func scan(_ id: String) async throws -> String? {
        let captureModule = try require(captureModule)
        let origin: [String: Any] = ["projectId": id, "revision": 0, "snapshot": "{}", "context": NSNull()]
        let draft = try await promise { captureModule.start(origin as NSDictionary, resolve: $0, reject: $1) } as? [String: Any]
        return draft?["status"] as? String == "ready" ? draft?["runID"] as? String : nil
    }
    func finishedScan(_ id: String) async -> String? {
        guard let captureModule else { return nil }
        let drafts = (try? await promise { captureModule.drafts($0, reject: $1) }) as? [[String: Any]] ?? []
        let draft = drafts.first { ($0["origin"] as? [String: Any])?["projectId"] as? String == id }
        return draft?["status"] as? String == "ready" ? draft?["runID"] as? String : nil
    }
    /// Sends the scan's model and up to 24 of its own photos (only what the Mac lacks), then starts.
    func sendScan(_ id: String, run: String) async throws -> StmObject {
        try await sendCapture(id, run: run)
        return try await start(id)
    }
    /// Sends the scan's model and photos without starting, so chosen photos can go with them.
    func sendCapture(_ id: String, run: String) async throws {
        let bridge = try require(bridge)
        _ = try await promise { bridge.sendCapture(["objectId": id, "runID": run, "maxPhotos": 24] as NSDictionary, resolve: $0, reject: $1) }
    }

    struct Pairing: Equatable { var paired: Bool; var address: String? }
    func pairing(check: Bool) async -> Pairing {
        guard let pairingModule else { return Pairing(paired: false, address: nil) }
        let reply = (try? await promise { check ? pairingModule.check($0, reject: $1) : pairingModule.status($0, reject: $1) }) as? [String: Any]
        let address = (reply?["baseUrl"] as? String).flatMap(URL.init(string:))?.host
        return Pairing(paired: reply?["state"] as? String == "paired", address: address)
    }
}

struct ChosenPhoto: Identifiable, Equatable { var id: String; var url: URL }

// MARK: - State

@MainActor @Observable final class ObjectsStore {
    let mac = MacConnection()
    var objects: [StmObject] = []
    var loaded = false
    var error: MacError?
    var connection: MacConnection.Pairing?
    var canScan = false
    var onPair: () -> Void = {}

    func load() async {
        do { objects = try await mac.list(); error = nil }
        catch let failure as MacError { error = failure }
        catch { self.error = .unreachable }
        loaded = true
    }
    func replace(_ object: StmObject) {
        if let index = objects.firstIndex(where: { $0.id == object.id }) { objects[index] = object } else { objects.insert(object, at: 0) }
    }
    func remove(_ id: String) { objects.removeAll { $0.id == id } }
    var anyBusy: Bool { objects.contains { ObjectWords($0).busy } }
    func refreshConnection(check: Bool = false) async { connection = await mac.pairing(check: check) }
}

private let cobalt = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
    ? UIColor(red: 0x7B / 255, green: 0x95 / 255, blue: 0xFF / 255, alpha: 1)
    : UIColor(red: 0x24 / 255, green: 0x48 / 255, blue: 0xD8 / 255, alpha: 1) })

private extension ObjectWords.Tone {
    var color: Color {
        switch self {
        case .pass: .green
        case .fail: .red
        case .accent: cobalt
        case .pending: .orange
        case .neutral: .secondary
        }
    }
}

// MARK: - Root: the list

struct ObjectsRootView: View {
    @State var store: ObjectsStore
    let pairingKey: Int
    @State private var path: [String] = []
    @State private var creating = false
    @State private var settings = false

    @State private var selected: String?
    @Environment(\.horizontalSizeClass) private var width

    @ToolbarContentBuilder private var listToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { settings = true } label: { Label("Settings", systemImage: "gearshape") }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { creating = true } label: { Label("New", systemImage: "plus") }
                .buttonStyle(.glassProminent)
        }
    }

    var body: some View {
        Group {
            if width == .regular {
                // iPad and an unfolded Duo: the list and the page side by side.
                NavigationSplitView {
                    ObjectsListView(store: store, startNew: { creating = true }, selection: $selected)
                        .navigationTitle("Counterpart")
                        .toolbar { listToolbar }
                } detail: {
                    if let selected {
                        NavigationStack { ObjectDetailView(store: store, id: selected, close: { self.selected = nil }) }
                            .id(selected)
                    } else {
                        ContentUnavailableView("Choose Something", systemImage: "cube",
                                               description: Text("Pick something from the list, or tap + to make something new."))
                    }
                }
            } else {
                NavigationStack(path: $path) {
                    ObjectsListView(store: store, startNew: { creating = true })
                        .navigationTitle("Counterpart")
                        .toolbar { listToolbar }
                        .navigationDestination(for: String.self) { id in
                            ObjectDetailView(store: store, id: id, close: { path.removeAll() })
                        }
                }
            }
        }
        .tint(cobalt)
        .sheet(isPresented: $creating) {
            NewObjectView(store: store) { object in
                creating = false
                store.replace(object)
                if width == .regular { selected = object.id } else { path = [object.id] }
            }
        }
        .sheet(isPresented: $settings) { SettingsView(store: store) }
        .task(id: pairingKey) {
            async let scan = store.mac.canScan()
            await store.refreshConnection()
            await store.load()
            store.canScan = await scan
        }
        // While something is touching up or printing, keep the list current (not while in the background).
        .task(id: store.anyBusy) {
            guard store.anyBusy else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if UIApplication.shared.applicationState != .background { await store.load() }
            }
        }
    }
}

struct ObjectsListView: View {
    @Bindable var store: ObjectsStore
    let startNew: () -> Void
    /// The selected object in the side-by-side layout (iPad, unfolded Duo); nil on iPhone.
    var selection: Binding<String?>? = nil
    @State private var deleting: StmObject?
    @State private var refusal: String?

    var body: some View {
        List(selection: selection) {
            Section {
                ConnectionRow(connection: store.connection, error: store.error) { store.onPair() }
                if let refusal {
                    Label(refusal, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                }
            }
            CaliperSetupCard(store: store)
            if store.objects.isEmpty, store.loaded, store.error == nil {
                Section {
                    ContentUnavailableView {
                        Label("Nothing yet", systemImage: "cube")
                    } description: {
                        Text("Describe something to make, or scan a real object to copy it.")
                    } actions: {
                        Button("Make Something", action: startNew).buttonStyle(.glassProminent)
                    }
                }
            } else if !store.objects.isEmpty {
                Section("Your Things") {
                    ForEach(store.objects) { object in
                        NavigationLink(value: object.id) { ObjectRow(store: store, object: object) }
                            .swipeActions {
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = object }
                            }
                            .contextMenu {
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = object }
                            }
                    }
                }
            }
        }
        .refreshable { await store.load() }
        .confirmationDialog("Delete this from your Mac?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { object in
            Button("Delete", role: .destructive) {
                Task {
                    do { try await store.mac.delete(object.id); store.remove(object.id); refusal = nil }
                    catch let failure as MacError {
                        if failure.needsPairing || failure.code == "unreachable" { store.error = failure } else { refusal = failure.message }
                    }
                }
            }
        } message: { _ in Text("Its model, photos and renders are removed from your Mac.") }
    }
}

/// The paired Mac and whether it answers: the first thing to check when something doesn't arrive.
struct ConnectionRow: View {
    let connection: MacConnection.Pairing?
    let error: MacError?
    let pair: () -> Void
    var body: some View {
        if let error, error.needsPairing || error.code == "unreachable" || error.code == "not-set-up" {
            VStack(alignment: .leading, spacing: 8) {
                Label(error.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                if error.needsPairing { Button("Connect to Your Mac", action: pair).buttonStyle(.glass) }
            }
        } else if connection?.paired == true {
            Label { Text("Connected to your Mac") + Text(connection?.address.map { "  \($0)" } ?? "").foregroundStyle(.secondary) }
                icon: { Image(systemName: "desktopcomputer").foregroundStyle(.green) }
        } else if connection != nil {
            HStack {
                Label("Not connected to a Mac", systemImage: "desktopcomputer.trianglebadge.exclamationmark").foregroundStyle(.orange)
                Spacer()
                Button("Connect", action: pair).buttonStyle(.glass)
            }
        } else {
            Label("Checking your Mac…", systemImage: "desktopcomputer").foregroundStyle(.secondary)
        }
    }
}

struct ObjectRow: View {
    let store: ObjectsStore
    let object: StmObject
    /// A selected sidebar row sits on the accent colour: its status turns white to stay readable.
    @Environment(\.backgroundProminence) private var prominence
    var body: some View {
        let words = ObjectWords(object)
        HStack(spacing: 14) {
            RenderImage(store: store, object: object, render: object.current?.renders.first)
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(words.title).font(.headline).lineLimit(2)
                HStack(spacing: 6) {
                    if words.busy { ProgressView().controlSize(.mini) }
                    Text(words.status.components(separatedBy: ". ").first ?? words.status)
                        .font(.subheadline)
                        .foregroundStyle(prominence == .increased ? Color.white.opacity(0.9) : words.tone.color)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// A render downloaded once per object version, on the build-plate colour while it loads.
struct RenderImage: View {
    let store: ObjectsStore
    let object: StmObject
    let render: String?
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            Color(white: 0.17)
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if render == nil { Image(systemName: "cube").font(.title2).foregroundStyle(.white.opacity(0.5)) }
        }
        .task(id: "\(object.id)#\(object.updatedAtMs)#\(render ?? "")") {
            guard let render, let name = render.split(separator: "/").last else { image = nil; return }
            if let url = try? await store.mac.download(object, "renders/\(name)"), let data = try? Data(contentsOf: url) { image = UIImage(data: data) }
        }
    }
}

// MARK: - New

struct NewObjectView: View {
    let store: ObjectsStore
    let started: (StmObject) -> Void
    @State private var instructions = ""
    @State private var photos: [ChosenPhoto] = []
    @State private var working: String?
    @State private var problem: String?
    @State private var askedForDescription = false
    @State private var created: StmObject?
    @State private var photosSent = false
    @FocusState private var describing: Bool
    @Environment(\.dismiss) private var dismiss
    private var described: Bool { !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("A clip that holds a 6 mm cable to the edge of my desk", text: $instructions, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($describing)
                } header: {
                    Text("Describe It")
                } footer: {
                    Text(askedForDescription && !described
                         ? "Describe what you want made first. Photos only show what it goes with."
                         : "What it is, what it fits or attaches to, and any sizes. Product names, model numbers and links all help.")
                        .foregroundStyle(askedForDescription && !described ? .red : .secondary)
                }
                Section {
                    if !photos.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(photos) { photo in
                                    ChosenThumbnail(photo: photo) { photos.removeAll { $0.id == photo.id } }
                                }
                            }
                            .padding(.vertical, 6)
                        }
                    }
                    Button { Task { await addPhotos() } } label: {
                        Label(photos.isEmpty ? "Add Photos" : "Add More Photos", systemImage: "photo.badge.plus")
                    }
                    .disabled(working != nil || photos.count >= 12)
                } header: {
                    Text("Photos")
                } footer: {
                    Text("Optional. Show the thing it goes with, from a couple of angles.")
                }
                if !store.canScan {
                    Section { } footer: { Text("Scanning needs an iPhone or iPad with LiDAR.") }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Make Something")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            // The actions stay in view above the form, and above the keyboard while typing.
            .safeAreaBar(edge: .bottom) {
                VStack(spacing: 10) {
                    Button { Task { await make() } } label: {
                        Label(working == "make" ? "Sending to Your Mac…" : "Make It", systemImage: "wand.and.sparkles")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.extraLarge)
                    .disabled(working != nil)
                    .accessibilityLabel(working == "make" ? "Sending to your Mac" : "Make It")
                    if store.canScan && !describing {
                        Button { Task { await scan() } } label: {
                            Label(working == "scan" ? "Sending to Your Mac…" : "Scan It Instead", systemImage: "viewfinder")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.glass)
                        .controlSize(.extraLarge)
                        .disabled(working != nil)
                        .accessibilityLabel(working == "scan" ? "Sending to your Mac" : "Scan It Instead")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working != nil) }
                if describing {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { describing = false } }
                }
            }
            .interactiveDismissDisabled(working != nil)
        }
        .tint(cobalt)
        .onAppear { describing = true }
    }

    private func run(_ kind: String, _ body: () async throws -> Void) async {
        guard working == nil else { return }
        working = kind; problem = nil
        defer { working = nil }
        do { try await body() }
        catch let failure as MacError {
            if failure.code == "cancelled" { return }
            if failure.needsPairing { dismiss(); store.onPair(); return }
            problem = failure.message
        } catch { problem = MacError.unreachable.message }
    }
    private func addPhotos() async {
        describing = false
        await run("photos") { photos += try await store.mac.choosePhotos(limit: max(1, 12 - photos.count)) }
    }
    /// The object this form made, kept so a retry finishes it instead of making another.
    private func object() async throws -> StmObject {
        if let created { return created }
        let object = try await store.mac.create(instructions)
        created = object
        return object
    }
    /// Sends the chosen photos once; they leave this phone's cache when the Mac has them.
    private func sendPhotos(_ id: String) async throws {
        guard !photosSent else { return }
        try await store.mac.sendChosen(id, photos)
        photosSent = true
    }
    private func make() async {
        guard described else { askedForDescription = true; describing = true; return }
        describing = false
        await run("make") {
            let object = try await object()
            try await sendPhotos(object.id)
            started(try await store.mac.start(object.id))
        }
    }
    private func scan() async {
        await run("scan") {
            let object = try await object()
            guard let run = try await store.mac.scan(object.id) else { started(object); return }
            try await store.mac.sendCapture(object.id, run: run)
            try await sendPhotos(object.id)
            started(try await store.mac.start(object.id))
        }
    }
}

struct ChosenThumbnail: View {
    let photo: ChosenPhoto
    let remove: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = UIImage(contentsOfFile: photo.url.path) { Image(uiImage: image).resizable().scaledToFill() }
                else { Color.secondary.opacity(0.2) }
            }
            .frame(width: 84, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            Button(role: .destructive, action: remove) {
                Image(systemName: "xmark").font(.caption.weight(.bold)).padding(6)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Remove this photo")
            .offset(x: 6, y: -6)
        }
    }
}

// MARK: - The object page

struct ObjectDetailView: View {
    let store: ObjectsStore
    let id: String
    let close: () -> Void
    @State private var note = ""
    @State private var working = false
    @State private var problem: String?
    /// The last refresh failed; cleared as soon as one succeeds (separate from an action's refusal).
    @State private var fetchProblem: String?
    @State private var resumed = false
    @State private var confirmDelete = false
    @State private var plateImage: UIImage?
    @FocusState private var writing: Bool
    private var object: StmObject? { store.objects.first { $0.id == id } }

    var body: some View {
        Group {
            if let object { page(object) } else { ProgressView() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) {
            await reload()
            // A scan that finished on this phone but never reached the Mac (the app closed) goes now.
            guard !resumed, let object, object.state == .new, object.scan == nil else { return }
            resumed = true
            if let run = await store.mac.finishedScan(object.id) { act { try await store.mac.sendScan(object.id, run: run) } }
        }
        .task(id: object.map { ObjectWords($0).busy } ?? false) {
            guard let object, ObjectWords(object).busy else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if UIApplication.shared.applicationState != .background { await reload() }
            }
        }
    }

    private func reload() async {
        do { store.replace(try await store.mac.get(id)); fetchProblem = nil }
        catch let failure as MacError { fetchProblem = failure.message }
        catch { fetchProblem = MacError.unreachable.message }
    }

    private func act(_ body: @escaping () async throws -> StmObject?) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do { if let next = try await body() { store.replace(next) } else { await reload() } }
            catch let failure as MacError {
                if failure.code == "cancelled" { return }
                if failure.needsPairing { store.onPair(); return }
                problem = failure.message
            } catch { problem = MacError.unreachable.message }
        }
    }

    @ViewBuilder private func page(_ object: StmObject) -> some View {
        let words = ObjectWords(object)
        List {
            if object.current != nil || words.busy {
                Section {
                    Renders(store: store, object: object)
                        .listRowInsets(EdgeInsets())
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    if let size = words.size {
                        Text(size).font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                    }
                    HStack(spacing: 8) {
                        if words.busy { ProgressView() }
                        Text(words.status).font(.body.weight(.semibold)).foregroundStyle(words.tone.color)
                    }
                    if let summary = object.current?.summary, !words.busy {
                        Text(summary).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                if object.plate?.photo == true, let plateImage {
                    Image(uiImage: plateImage).resizable().scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("The printer camera's view of the plate")
                }
                if let problem = problem ?? fetchProblem { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            }
            MeasurementsSection(object: object)
            if !words.actions.filter({ $0 != .correct }).isEmpty {
                Section { actions(object, words) }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if words.actions.contains(.correct) {
                Section {
                    // Like Messages: the send button sits beside the text, so it stays above the keyboard.
                    HStack(alignment: .bottom, spacing: 10) {
                        TextField("Say what's wrong, like a size or a missing part", text: $note, axis: .vertical)
                            .lineLimit(1...6)
                            .focused($writing)
                        Button {
                            let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            writing = false
                            act { let next = try await store.mac.correct(object.id, text); note = ""; return next }
                        } label: {
                            Image(systemName: "arrow.up").font(.body.weight(.semibold))
                        }
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .disabled(working || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Send Changes")
                    }
                    .id("fix")
                } header: { Text("Anything to Fix?") } footer: { Text("It goes back to your Mac for another touch-up.") }
            }
            Section("What You Asked For") {
                Text((object.instructions ?? "").isEmpty ? "A copy of what you scanned." : object.instructions!)
                LabeledContent("Sent", value: ObjectWords.sent(object))
            }
        }
        .navigationTitle(words.title)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            if writing {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { writing = false } }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if object.current != nil {
                        Button("Turn It Around", systemImage: "rotate.3d") { act { try await store.mac.showModel(object); return nil } }
                    }
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Label("More", systemImage: "ellipsis") }
            }
        }
        .confirmationDialog("Delete this from your Mac?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    do { try await store.mac.delete(object.id); store.remove(object.id); close() }
                    catch let failure as MacError { problem = failure.message }
                }
            }
        } message: { Text("Its model, photos and renders are removed from your Mac.") }
        .task(id: "\(object.updatedAtMs)#\(object.plate?.photo == true)") {
            guard object.plate?.photo == true, let url = try? await store.mac.download(object, "plate.jpg"),
                  let data = try? Data(contentsOf: url) else { plateImage = nil; return }
            plateImage = UIImage(data: data)
        }
    }

    @ViewBuilder private func actions(_ object: StmObject, _ words: ObjectWords) -> some View {
        VStack(spacing: 10) {
            ForEach(Array(words.actions.enumerated()), id: \.offset) { _, action in
                switch action {
                case .print:
                    big("Print", "printer.fill", prominent: true) { try await store.mac.print(object.id, checked: false) }
                case .printChecked:
                    big("It Isn't Printing, Print Again", "printer.fill", prominent: true) { try await store.mac.print(object.id, checked: true) }
                case .plateClear:
                    big("It's Actually Clear", "checkmark.circle", prominent: true) { try await store.mac.plateClear(object.id) }
                case .openCamera:
                    big("Open Camera", "camera", prominent: true) {
                        let sent = try await store.mac.addCloseups(object.id, camera: true)
                        guard sent > 0 else { return nil }
                        return try await store.mac.closeup(object.id, bestGuess: false)
                    }
                case .attachPhotos:
                    big(object.state == .needsCloseup ? "Attach Photos" : "Add Photos", "photo.on.rectangle", prominent: false) {
                        let sent = try await store.mac.addCloseups(object.id, camera: false)
                        guard sent > 0 else { return nil }
                        if object.state == .needsCloseup { return try await store.mac.closeup(object.id, bestGuess: false) }
                        return try await store.mac.start(object.id)
                    }
                case .bestGuess:
                    big("Make Your Best Guess", "sparkles", prominent: false) { try await store.mac.closeup(object.id, bestGuess: true) }
                case .retry:
                    big("Try Again", "arrow.clockwise", prominent: true) { try await store.mac.start(object.id) }
                case .finishSending:
                    big("Finish Sending", "arrow.up.circle", prominent: false) {
                        if let run = await store.mac.finishedScan(object.id) { return try await store.mac.sendScan(object.id, run: run) }
                        return try await store.mac.start(object.id)
                    }
                case .scan:
                    if store.canScan {
                        big("Scan It", "viewfinder", prominent: true) {
                            guard let run = try await store.mac.scan(object.id) else { return nil }
                            return try await store.mac.sendScan(object.id, run: run)
                        }
                    }
                case .makeIt:
                    big("Make It From the Description", "wand.and.sparkles", prominent: false) { try await store.mac.start(object.id) }
                case .correct:
                    EmptyView()
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func big(_ title: String, _ symbol: String, prominent: Bool, _ body: @escaping () async throws -> StmObject?) -> some View {
        Group {
            if prominent {
                Button { act(body) } label: { Label(title, systemImage: symbol).frame(maxWidth: .infinity) }.buttonStyle(.glassProminent)
            } else {
                Button { act(body) } label: { Label(title, systemImage: symbol).frame(maxWidth: .infinity) }.buttonStyle(.glass)
            }
        }
        .controlSize(.large)
        .disabled(working)
        .accessibilityLabel(title)
    }
}

/// The renders, swipeable, on the dark build plate; the clearest one first (the Mac names them so).
struct Renders: View {
    let store: ObjectsStore
    let object: StmObject
    var body: some View {
        let renders = object.current?.renders ?? []
        ZStack {
            Color(white: 0.17)
            if renders.isEmpty {
                VStack(spacing: 10) {
                    ProgressView().tint(.white)
                    Text("The model shows here when it's ready.").font(.subheadline).foregroundStyle(.white.opacity(0.8))
                }
            } else {
                TabView {
                    ForEach(renders, id: \.self) { render in
                        RenderImage(store: store, object: object, render: render)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: renders.count > 1 ? .always : .never))
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

// MARK: - Settings

struct SettingsView: View {
    let store: ObjectsStore
    @State private var checking = false
    @Environment(\.dismiss) private var dismiss
    private var version: String {
        let info = Bundle.main.infoDictionary
        return "Version \(info?["CFBundleShortVersionString"] as? String ?? "–") (\(info?["CFBundleVersion"] as? String ?? "–"))"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Image("Logo").resizable().frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Counterpart").font(.title3.bold())
                            Text("Scan it or describe it. Your Mac makes it. Your printer prints it.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    LabeledContent("Status") {
                        if checking { ProgressView() }
                        else if store.connection?.paired == true {
                            Label(store.error == nil ? "Connected" : "Can't reach it", systemImage: "circle.fill")
                                .labelStyle(.titleAndIcon).foregroundStyle(store.error == nil ? .green : .orange)
                        } else { Text("Not connected").foregroundStyle(.orange) }
                    }
                    if let address = store.connection?.address { LabeledContent("Address", value: address) }
                    Button("Check Connection") {
                        Task { checking = true; await store.refreshConnection(check: true); await store.load(); checking = false }
                    }
                    Button("Connect to a Different Mac") { dismiss(); store.onPair() }
                } header: { Text("Your Mac") } footer: {
                    Text("Your Mac does the touch-ups and talks to your printer. Keep Counterpart running on it.")
                }
                Section("How It Works") {
                    Label("Describe what you want, add a photo or two, or scan a real object.", systemImage: "text.viewfinder")
                    Label("Your Mac makes the model with your own Claude and Blender, then shows it here.", systemImage: "desktopcomputer")
                    Label("Check the size and pictures, fix anything, then tap Print.", systemImage: "printer")
                }
                Section("Help") {
                    CaliperPrintButton(store: store)
                    Link(destination: URL(string: "https://counterpart.dtmont.com/")!) {
                        Label("Counterpart Website", systemImage: "safari")
                    }
                    Link(destination: URL(string: "https://counterpart.dtmont.com/#help")!) {
                        Label("Get Help", systemImage: "questionmark.circle")
                    }
                }
                Section("About") {
                    LabeledContent("Counterpart", value: version)
                    LabeledContent("Made With", value: "Open source")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(cobalt)
    }
}

// MARK: - Hosting inside the React Native shell

/// The React Native view that shows the SwiftUI app. `pairingKey` changes after pairing, so the app reloads;
/// `onPair` asks the shell to show its pairing screen.
@objc(STMObjectsAppView)
public final class STMObjectsAppView: UIView {
    @objc public var pairingKey: NSNumber = 0 { didSet { render() } }
    @objc public var onPair: RCTDirectEventBlock? { didSet { store.onPair = { [weak self] in self?.onPair?([:]) } } }
    private let store = ObjectsStore()
    private var host: UIHostingController<ObjectsRootView>?

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, host == nil else { return }
        let host = UIHostingController(rootView: ObjectsRootView(store: store, pairingKey: pairingKey.intValue))
        // A child of the nearest view controller, so navigation bars, sheets and dialogs work.
        var responder: UIResponder? = self
        while let next = responder?.next, !(next is UIViewController) { responder = next }
        (responder?.next as? UIViewController)?.addChild(host)
        host.view.frame = bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.backgroundColor = .clear
        addSubview(host.view)
        host.didMove(toParent: host.parent)
        self.host = host
    }
    private func render() { host?.rootView = ObjectsRootView(store: store, pairingKey: pairingKey.intValue) }
    public override func layoutSubviews() { super.layoutSubviews(); host?.view.frame = bounds }
}
