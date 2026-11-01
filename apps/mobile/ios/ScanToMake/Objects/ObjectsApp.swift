import SwiftUI
import UIKit
import ImageIO
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
    @objc(sendHandheldOptions:resolve:reject:) func sendHandheld(_ o: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock)
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
        case 404 where path.hasSuffix("/filaments"): throw MacError(code: "not-set-up", message: "Update Counterpart on your Mac to choose a filament here.")
        case 404: throw MacError(code: "not-found", message: "This is no longer on your Mac.")
        case 409: throw MacError(code: "conflict", message: message ?? "Wait until the current step finishes.")
        default: throw MacError(code: "failed", message: "Something went wrong on your Mac. Try again.")
        }
    }
    private struct ObjectReply: Decodable { var object: StmObject }
    private struct ListReply: Decodable { var objects: [StmObject] }
    private struct Deleted: Decodable { var deleted: Bool }

    func printers() async throws -> PrinterCatalog { try await request("GET", "/v1/objects/printers", as: PrinterCatalog.self) }
    private struct FilamentsReply: Decodable { var filaments: [PrinterFilament] }
    func filaments(_ id: String) async throws -> [PrinterFilament] {
        try await request("GET", "/v1/objects/\(id)/filaments", as: FilamentsReply.self).filaments
    }
    private struct ActivityReply: Decodable { var activity: [StmObject.Activity] }
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] {
        try await request("GET", "/v1/objects/\(id)/passes/\(index)/activity", as: ActivityReply.self).activity
    }
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject {
        try await request("POST", "/v1/objects/\(id)/printer", ["destinationId": destinationId], as: ObjectReply.self).object
    }
    func list() async throws -> [StmObject] { try await request("GET", "/v1/objects", as: ListReply.self).objects }
    func get(_ id: String) async throws -> StmObject { try await request("GET", "/v1/objects/\(id)", as: ObjectReply.self).object }
    func create(_ instructions: String) async throws -> StmObject {
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await request("POST", "/v1/objects", text.isEmpty ? [:] : ["instructions": text], as: ObjectReply.self).object
    }
    func updateDraft(_ id: String, instructions: String) async throws -> StmObject {
        try await request("PATCH", "/v1/objects/\(id)", ["instructions": instructions], as: ObjectReply.self).object
    }
    func start(_ id: String, captureManifest: [String: Any]? = nil) async throws -> StmObject {
        try await request("POST", "/v1/objects/\(id)/start", captureManifest.map { ["captureManifest": $0] }, as: ObjectReply.self).object
    }
    func correct(_ id: String, _ note: String) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/corrections", ["note": note], as: ObjectReply.self).object }
    func closeup(_ id: String, bestGuess: Bool) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/closeup", ["bestGuess": bestGuess], as: ObjectReply.self).object }
    func print(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> StmObject {
        guard let choice = try JSONSerialization.jsonObject(with: JSONEncoder().encode(filament)) as? [String: Any] else {
            throw MacError(code: "invalid-request", message: "Couldn’t prepare this filament choice.")
        }
        return try await request("POST", "/v1/objects/\(id)/print", ["checked":checked, "filament":choice], as: ObjectReply.self).object
    }
    func plateClear(_ id: String) async throws -> StmObject { try await request("POST", "/v1/objects/\(id)/plate", ["clear": true], as: ObjectReply.self).object }
    func answerPrintConfirmation(_ id: String, response: PrintConfirmationResponse) async throws -> StmObject {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        return try await request("POST", "/v1/objects/\(id)/print-confirmation", json, as: ObjectReply.self).object
    }
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
            bridge.download(["objectId": object.id, "name": name, "version": object.mediaVersion] as NSDictionary, resolve: $0, reject: $1)
        } as? [String: Any]
        return (reply?["uri"] as? String).flatMap(URL.init(string:))
    }
    func showModel(_ object: StmObject) async throws {
        let bridge = try require(bridge)
        _ = try await promise { bridge.showModel(["objectId": object.id, "version": object.mediaVersion] as NSDictionary, resolve: $0, reject: $1) }
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

    /// A handheld scan's photos (HandheldCapture.swift); the Mac rebuilds the model, then touches it up.
    private struct HandheldManifest: Decodable {
        var version: Int
        var images: [String]
        var depthRequired: Bool
    }
    func sendHandheld(_ id: String) async throws -> StmObject {
        let bridge = try require(bridge)
        let reply = try await promise { bridge.sendHandheld(["objectId": id] as NSDictionary, resolve: $0, reject: $1) } as? [String: Any]
        guard let raw = reply?["captureManifest"] as? [String: Any],
              JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let manifest = try? JSONDecoder().decode(HandheldManifest.self, from: data),
              manifest.version == 1, (1...10000).contains(manifest.images.count),
              manifest.images == manifest.images.sorted(), Set(manifest.images).count == manifest.images.count,
              manifest.images.allSatisfy({ $0.range(of: "^[0-9]{4}\\.heic$", options: .regularExpression) != nil }) else {
            throw MacError(code: "invalid-response", message: "The capture upload didn't confirm all saved frames. Your capture is still saved on this phone.")
        }
        return try await start(id, captureManifest: raw)
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
        do {
            let latest = try await mac.list()
            guard !Task.isCancelled else { return }
            objects = latest; error = nil
        }
        catch let failure as MacError { if !Task.isCancelled { error = failure } }
        catch { if !Task.isCancelled { self.error = .unreachable } }
        guard !Task.isCancelled else { return }
        loaded = true
    }
    func replace(_ object: StmObject) {
        if let index = objects.firstIndex(where: { $0.id == object.id }) { objects[index] = object } else { objects.insert(object, at: 0) }
    }
    func remove(_ id: String) { objects.removeAll { $0.id == id } }
    var printerCatalog: PrinterCatalog?
    var printerProblem: String?
    private var printerRead = 0
    func resetPrinters() {
        printerRead += 1
        printerCatalog = nil
        printerProblem = nil
    }
    func loadPrinters() async {
        guard !Task.isCancelled else { return }
        resetPrinters()
        let read = printerRead
        do {
            let catalog = try await mac.printers()
            guard read == printerRead, !Task.isCancelled else { return }
            printerCatalog = catalog
        } catch {
            guard read == printerRead, !Task.isCancelled else { return }
            printerProblem = "Couldn't read the printers configured on your Mac."
        }
    }
    func printer(for object: StmObject) -> PrinterDestination? {
        guard let catalog = printerCatalog else { return nil }
        return catalog.destinations.first { $0.id == (object.printerDestinationId ?? catalog.defaultDestinationId) }
    }
    var anyBusy: Bool { objects.contains { ObjectWords($0).busy } }
    func refreshConnection(check: Bool = false) async { connection = await mac.pairing(check: check) }
}

let cobalt = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
    ? UIColor(red: 0x3A / 255, green: 0x63 / 255, blue: 0xF2 / 255, alpha: 1)
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
        ToolbarItem(placement: .bottomBar) {
            Button { creating = true } label: {
                Label("New Project", systemImage: "plus")
                    .font(.headline)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 6)
            }
                .buttonStyle(.glassProminent)
                .labelStyle(.titleAndIcon)
                .accessibilityIdentifier("new-project")
        }
    }

    var body: some View {
        Group {
            if width == .regular {
                // iPad and an unfolded Duo: the list and the page side by side.
                NavigationSplitView {
                    ObjectsListView(store: store, startNew: { creating = true }, selection: $selected)
                        .navigationTitle("Projects")
                        .toolbar { listToolbar }
                } detail: {
                    if let selected {
                        NavigationStack { ObjectDetailView(store: store, id: selected, close: { self.selected = nil }) }
                            .id(selected)
                    } else {
                        ContentUnavailableView("Your Project Workspace", systemImage: "cube",
                                               description: Text("Choose a project to see its model, reference images and activity, or start a new one."))
                    }
                }
            } else {
                NavigationStack(path: $path) {
                    ObjectsListView(store: store, startNew: { creating = true })
                        .navigationTitle("Projects")
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
            store.resetPrinters()
            store.objects = []; store.loaded = false; store.error = nil
            HandheldCapture.previewIfAsked()
            async let scan = store.mac.canScan()
            await store.refreshConnection()
            await store.load()
            await store.loadPrinters()
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
    @State private var search = ""

    var body: some View {
        List(selection: selection) {
            Section {
                ConnectionRow(connection: store.connection, error: store.error) { store.onPair() }
                if let refusal {
                    Label(refusal, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                }
            }
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
                Section("Your Projects") {
                    ForEach(store.objects.filter { search.isEmpty || ($0.instructions ?? ObjectWords.title($0)).localizedCaseInsensitiveContains(search) }) { object in
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
        .searchable(text: $search, prompt: "Find a project")
        .refreshable { await store.load(); await store.loadPrinters() }
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
            ProjectThumbnail(store: store, object: object)
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
                Text(Date(timeIntervalSince1970: object.createdAtMs / 1000), format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Decode only the pixels a thumbnail can display, without first expanding a full capture.
enum ProjectImageLoader {
    static func thumbnail(at url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL,
            [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct ProjectThumbnail: View {
    let store: ObjectsStore
    let object: StmObject
    @State private var photo: UIImage?
    var body: some View {
        Group {
            if let photo { Image(uiImage: photo).resizable().scaledToFill() }
            else { RenderImage(store: store, object: object, render: object.current?.renders.first) }
        }
        .task(id: "\(object.id)#\(object.current == nil)") {
            guard object.current == nil,
                  let path = object.photos.first.map({ "photos/\($0)" }) ?? object.capture?.first.map({ "capture/\($0)" }),
                  let url = try? await store.mac.download(object, path) else { photo = nil; return }
            photo = ProjectImageLoader.thumbnail(at: url, maxPixelSize: 180)
        }
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
        .task(id: "\(object.id)#\(object.mediaVersion)#\(render ?? "")") {
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
    @State private var photosLocked = false
    @State private var photoPreviews: [String: UIImage] = [:]
    @FocusState private var describing: Bool
    @Environment(\.dismiss) private var dismiss
    private var described: Bool { !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section("Start With What You Have") {
                    if store.canScan {
                        Button { Task { await scan(handheld: false) } } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Scan with LiDAR").font(.headline)
                                    Text("Walk around the object to capture its shape and size").font(.subheadline).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: "viewfinder").font(.title2) }
                            .padding(.vertical, 6)
                        }
                        .disabled(working != nil)
                        .accessibilityIdentifier("scan-object")
                    }
                    if HandheldCapture.isAvailable {
                        Button { Task { await scan(handheld: true) } } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Capture in Hand").font(.headline)
                                    Text("Record the object with the rear camera and LiDAR while you turn it in your hand.")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: "hand.raised").font(.title2) }
                            .padding(.vertical, 6)
                        }
                        .disabled(working != nil)
                        .accessibilityIdentifier("capture-photos")
                    }
                    Button { Task { await addPhotos() } } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Add Reference Photos").font(.headline)
                                Text("Show what your part needs to fit").font(.subheadline).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "photo.on.rectangle.angled").font(.title2) }
                        .padding(.vertical, 6)
                    }
                    .disabled(working != nil || photosLocked || photos.count >= 12)
                }
                Section {
                    TextField("A clip that holds a 6 mm cable to the edge of my desk", text: $instructions, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($describing)
                } header: {
                    Text("What Would You Like to Make?")
                } footer: {
                    Text(askedForDescription && !described
                         ? "Describe what you want made first. Photos only show what it goes with."
                         : "What it is, what it fits or attaches to, and any sizes. Product names, model numbers and links all help.")
                        .foregroundStyle(askedForDescription && !described ? .red : .secondary)
                }
                if !photos.isEmpty { Section {
                    if !photos.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(photos) { photo in
                                    if photosLocked {
                                        Group {
                                            if let image = photoPreviews[photo.id] {
                                                Image(uiImage: image).resizable().scaledToFill()
                                            } else { Color.secondary.opacity(0.2) }
                                        }
                                        .frame(width: 84, height: 84)
                                        .clipShape(RoundedRectangle(cornerRadius: 14))
                                        .accessibilityLabel("Selected reference photo")
                                    } else {
                                        ChosenThumbnail(photo: photo) { photos.removeAll { $0.id == photo.id } }
                                            .disabled(working != nil)
                                    }
                                }
                            }
                            .padding(.vertical, 6)
                        }
                    }
                    Button { Task { await addPhotos() } } label: {
                        Label(photos.isEmpty ? "Add Photos" : "Add More Photos", systemImage: "photo.badge.plus")
                    }
                    .disabled(working != nil || photosLocked || photos.count >= 12)
                } header: {
                    Text("Photos")
                } footer: {
                    Text(photosLocked
                         ? (photos.isEmpty ? "This submission has no photos. Finish creating the project before starting another with different inputs."
                            : photosSent ? "These photos are saved on your Mac. Finish creating the project to see them in Inputs."
                            : "The photo selection is fixed for this submission. Retry sends these same photos.")
                         : "Optional. Show the thing it goes with, from a couple of angles.")
                } }
                if !store.canScan {
                    Section { } footer: { Text("Scanning needs an iPhone or iPad with LiDAR.") }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
            }
            .navigationTitle("New Project")
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
        if let created {
            let latest = try await store.mac.get(created.id)
            // Start may have succeeded even when its reply was lost. The saved
            // project is the result; never PATCH its now-immutable description.
            guard latest.state == .new else { return latest }
            do { return try await store.mac.updateDraft(created.id, instructions: instructions) }
            catch {
                // Another screen can start it between the GET and PATCH.
                if let current = try? await store.mac.get(created.id), current.state != .new { return current }
                throw error
            }
        }
        let object = try await store.mac.create(instructions)
        created = object
        return object
    }
    /// Sends the chosen photos once; they leave this phone's cache when the Mac has them.
    private func sendPhotos(_ id: String) async throws {
        guard !photosSent else { return }
        if !photosLocked {
            // sendChosen removes the original cache files only after every
            // upload succeeds. Keep small previews for a later start retry.
            for photo in photos {
                photoPreviews[photo.id] = ProjectImageLoader.thumbnail(at: photo.url, maxPixelSize: 252)
            }
            photosLocked = true
        }
        try await store.mac.sendChosen(id, photos)
        photosSent = true
    }
    private func make() async {
        guard described else { askedForDescription = true; describing = true; return }
        describing = false
        await run("make") {
            let object = try await object()
            guard object.state == .new else { started(object); return }
            if let sent = try await sendSavedCapture(object.id) { started(sent); return }
            try await sendPhotos(object.id)
            started(try await store.mac.start(object.id))
        }
    }
    /// A retry keeps the original capture, even if a different scan mode was chosen. Reopening
    /// capture would reuse filenames the Mac already has and combine two different photo sets.
    private func sendSavedCapture(_ id: String) async throws -> StmObject? {
        if HandheldCapture.finished(id) {
            try await sendPhotos(id)
            return try await store.mac.sendHandheld(id)
        }
        if let run = await store.mac.finishedScan(id) {
            try await store.mac.sendCapture(id, run: run)
            try await sendPhotos(id)
            return try await store.mac.start(id)
        }
        return nil
    }
    private func scan(handheld: Bool) async {
        await run("scan") {
            let object = try await object()
            guard object.state == .new else { started(object); return }
            if let sent = try await sendSavedCapture(object.id) { started(sent); return }
            guard object.scan == nil, (object.capture ?? []).isEmpty else {
                throw MacError(code: "missing-capture", message: "This project's saved scan is no longer on this phone. Start a new project to scan it again.")
            }
            if handheld {
                guard await HandheldCapture.run(objectId: object.id) else { started(object); return }
                try await sendPhotos(object.id)
                started(try await store.mac.sendHandheld(object.id))
                return
            }
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
    @State private var image: UIImage?
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFill() }
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
        .task(id: photo.url) { image = ProjectImageLoader.thumbnail(at: photo.url, maxPixelSize: 252) }
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
    @State private var section = ProjectSection.model
    @State private var preparingPrint = false
    @FocusState private var writing: Bool
    private var object: StmObject? { store.objects.first { $0.id == id } }

    var body: some View {
        Group {
            if let object { page(object) } else { ProgressView() }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: id) {
            await reload()
            if let object, object.current == nil {
                section = object.state == .touchingUp ? .activity : .inputs
            }
            await resumeSavedCapture()
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

    /// Resume after relaunch even when the model or some photos already reached the Mac.
    private func resumeSavedCapture() async {
        guard !resumed, let object, object.state == .new else { return }
        resumed = true
        if HandheldCapture.finished(object.id) {
            act { try await store.mac.sendHandheld(object.id) }
        } else if let run = await store.mac.finishedScan(object.id) {
            act { try await store.mac.sendScan(object.id, run: run) }
        }
    }

    private func sendSavedCapture(_ id: String) async throws -> StmObject? {
        if HandheldCapture.finished(id) { return try await store.mac.sendHandheld(id) }
        if let run = await store.mac.finishedScan(id) { return try await store.mac.sendScan(id, run: run) }
        return nil
    }

    private func finishSending(_ object: StmObject) async throws -> StmObject {
        if let sent = try await sendSavedCapture(object.id) { return sent }
        return try await store.mac.start(object.id)
    }

    private func scan(_ object: StmObject, handheld: Bool) async throws -> StmObject? {
        if let sent = try await sendSavedCapture(object.id) { return sent }
        guard object.scan == nil, (object.capture ?? []).isEmpty else {
            throw MacError(code: "missing-capture", message: "This project's saved scan is no longer on this phone. Start a new project to scan it again.")
        }
        if handheld { return await HandheldCapture.run(objectId: object.id) ? try await store.mac.sendHandheld(object.id) : nil }
        guard let run = try await store.mac.scan(object.id) else { return nil }
        return try await store.mac.sendScan(object.id, run: run)
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

    private func answerPrintConfirmation(_ questionId: String, action: PrintConfirmationResponse.Action, content: [String: Bool]) {
        act {
            guard let object = self.object, object.state == .printing,
                  let response = object.printConfirmation?.response(confirmationId: questionId, action: action, content: content,
                                                                      atMs: Date().timeIntervalSince1970 * 1000) else {
                await reload()
                throw MacError(code: "stale-confirmation", message: "This printer question has changed or expired. Review the current question before continuing.")
            }
            return try await store.mac.answerPrintConfirmation(id, response: response)
        }
    }

    @ViewBuilder private func page(_ object: StmObject) -> some View {
        let words = ObjectWords(object)
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(object.instructions?.isEmpty == false ? object.instructions! : words.title)
                        .font(.title2.bold()).lineLimit(3).textSelection(.enabled)
                    HStack(alignment: .top, spacing: 8) {
                        if words.busy { ProgressView().padding(.top, 3) }
                        if object.print?.uncertain == true {
                            Label("Check the previous print before trying again", systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline).foregroundStyle(.orange)
                        } else {
                            Text(words.status).font(.subheadline).foregroundStyle(words.tone.color)
                        }
                    }
                    Text(Date(timeIntervalSince1970: object.createdAtMs / 1000), format: .dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let problem = problem ?? fetchProblem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline).foregroundStyle(.red)
                }
                if object.state == .printing, let confirmation = object.printConfirmation {
                    PrinterConfirmationView(question: confirmation, working: working) { action, content in
                        answerPrintConfirmation(confirmation.id, action: action, content: content)
                    }
                    .id(confirmation.id)
                    if let item = object.plate?.item, !item.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Label("The camera check saw \(item) on the plate. Check and clear it before confirming.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if object.plate?.photo == true, let plateImage {
                    Image(uiImage: plateImage).resizable().scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .accessibilityLabel("The printer camera's view of the plate")
                    if object.printConfirmation != nil {
                        Text("The camera image is a reference. Check the printer yourself before confirming.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !words.actions.contains(.print) && !words.actions.contains(.printChecked) {
                    actions(object, words)
                }
                printerSelection(object)
                Picker("Project section", selection: $section) {
                    ForEach(ProjectSection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                switch section {
                case .model:
                    if object.current != nil {
                        VStack(alignment: .leading, spacing: 14) {
                            Renders(store: store, object: object).clipShape(RoundedRectangle(cornerRadius: 20))
                            HStack {
                                Button { act { try await store.mac.showModel(object); return nil } } label: {
                                    Label("Explore in 3D", systemImage: "rotate.3d")
                                }.buttonStyle(.glass)
                                Spacer()
                                if let size = words.size {
                                    Label(size, systemImage: "ruler").font(.caption).monospacedDigit()
                                        .foregroundStyle(.secondary).textSelection(.enabled)
                                }
                            }
                            if let summary = object.current?.summary, !summary.isEmpty {
                                DisclosureGroup("Model details") {
                                    Text((try? AttributedString(markdown: summary)) ?? AttributedString(summary))
                                        .font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.top, 8)
                                }
                            }
                        }
                    } else {
                        ContentUnavailableView {
                            Label(words.busy ? "Your Mac Is Working" : "No Model Yet", systemImage: words.busy ? "sparkles" : "cube")
                        } description: {
                            Text(words.busy ? "Follow Activity to see the work as it happens. Your request and photos are saved in Inputs." : "Your request and source images stay with this project. You can return to them at any time.")
                        } actions: {
                            Button("View \(words.busy ? "Activity" : "Inputs")") { section = words.busy ? .activity : .inputs }
                        }
                    }
                case .inputs:
                    ProjectInputs(store: store, object: object)
                case .activity:
                    ProjectActivity(store: store, object: object)
                }
                if words.actions.contains(.correct) {
                    Divider()
                    VStack(alignment: .leading, spacing: 10) {
                        Text(object.current == nil ? "Revise Your Request" : "Refine This Version").font(.headline)
                        Text(object.current == nil ? "Explain what you want made from these photos, or clarify what went wrong. Your existing photos stay with the project." : "Describe the change you need. Your request and the next pass will stay in Activity.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        HStack(alignment: .bottom, spacing: 10) {
                            TextField("What would you like to change?", text: $note, axis: .vertical)
                                .lineLimit(2...6).focused($writing)
                                .padding(12).background(.background, in: RoundedRectangle(cornerRadius: 14))
                            Button {
                                let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
                                writing = false
                                act {
                                    let next = try await store.mac.correct(object.id, text)
                                    note = ""; section = .activity
                                    return next
                                }
                            } label: { Image(systemName: "arrow.up").font(.body.weight(.semibold)) }
                            .buttonStyle(.glassProminent).buttonBorderShape(.circle)
                            .disabled(working || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Send Changes")
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Project")
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if words.actions.contains(.print) || words.actions.contains(.printChecked) {
                actions(object, words).padding(.horizontal, 20).padding(.vertical, 10)
                    .background(Color(uiColor: .systemBackground))
            }
        }
        .sheet(isPresented: $preparingPrint) { PhonePrintPreparation(store: store, objectId: object.id) }
        .toolbar {
            if writing {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { writing = false } }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Delete Project", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Label("More", systemImage: "ellipsis") }
            }
        }
        .confirmationDialog("Delete this project from your Mac?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Project", role: .destructive) {
                Task {
                    do { try await store.mac.delete(object.id); store.remove(object.id); close() }
                    catch let failure as MacError { problem = failure.message }
                }
            }
        } message: { Text("Its model, photos and activity will be removed from your Mac.") }
        .task(id: "\(object.updatedAtMs)#\(object.plate?.photo == true)") {
            guard object.plate?.photo == true, let url = try? await store.mac.download(object, "plate.jpg"),
                  let data = try? Data(contentsOf: url) else { plateImage = nil; return }
            plateImage = UIImage(data: data)
        }
    }

    @ViewBuilder private func printerSelection(_ object: StmObject) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let catalog = store.printerCatalog, !catalog.destinations.isEmpty {
                Picker(selection: Binding(get: { object.printerDestinationId ?? catalog.defaultDestinationId }, set: { selected in
                    act { try await store.mac.selectPrinter(object.id, destinationId: selected) }
                })) {
                    ForEach(catalog.destinations) { destination in Text(destination.name).tag(destination.id) }
                } label: { Label("Printer", systemImage: "printer") }
                .disabled(working || object.state == .touchingUp || object.state == .printing)
            } else {
                Label(store.printerProblem ?? "Reading your Mac's printers…", systemImage: "printer")
                    .font(.subheadline).foregroundStyle(.secondary)
                if store.printerProblem != nil {
                    Button("Try Again") { Task { await store.loadPrinters() } }
                }
            }
            if let destination = object.print?.destination {
                Text(object.print?.uncertain == true ? "Last attempt: \(destination.name)" : "Last print: \(destination.name)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder private func actions(_ object: StmObject, _ words: ObjectWords) -> some View {
        VStack(spacing: 10) {
            ForEach(Array(words.actions.enumerated()), id: \.offset) { _, action in
                switch action {
                case .print:
                    prepareButton()
                case .printChecked:
                    prepareButton()
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
                    big("Finish Sending", "arrow.up.circle", prominent: false) { try await finishSending(object) }
                case .scan:
                    if store.canScan {
                        big("Scan with LiDAR", "viewfinder", prominent: true) { try await scan(object, handheld: false) }
                    }
                    if HandheldCapture.isAvailable {
                        big("Capture in Hand", "hand.raised", prominent: false) { try await scan(object, handheld: true) }
                    }
                case .makeIt:
                    big("Make It From the Description", "wand.and.sparkles", prominent: false) { try await finishSending(object) }
                case .correct:
                    EmptyView()
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func prepareButton() -> some View {
        Button { preparingPrint = true } label: {
            Label("Prepare to Print", systemImage: "printer.fill").frame(maxWidth: .infinity)
        }.buttonStyle(.glassProminent).controlSize(.large).disabled(working)
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

private struct PhonePrintPreparation: View {
    let store: ObjectsStore
    let objectId: String
    @Environment(\.dismiss) private var dismiss
    @State private var printerId = ""
    @State private var choices: [PrinterFilament] = []
    @State private var selected: Int?
    @State private var checked = false
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?

    private var object: StmObject? { store.objects.first { $0.id == objectId } }
    private var previousPrinter: String { object?.print?.destination?.name ?? "the printer" }
    private func displayName(_ filament: PrinterFilament) -> String {
        var name = filament.name.replacingOccurrences(of: #"\s*#[0-9a-fA-F]{6,8}\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = " " + filament.material
        if name.count > suffix.count, name.uppercased().hasSuffix(suffix.uppercased()) {
            name.removeLast(suffix.count)
        }
        return name.isEmpty ? filament.material : name
    }
    private func swatch(_ hex: String) -> Color {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255,
                     blue: Double(value & 255) / 255)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let object {
                        Text(object.instructions?.isEmpty == false ? object.instructions! : "Your model")
                            .font(.headline).lineLimit(3)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Printer").font(.headline)
                        if let catalog = store.printerCatalog, !catalog.destinations.isEmpty {
                            Picker("Printer", selection: Binding(get: { printerId }, set: { id in Task { await choosePrinter(id) } })) {
                                ForEach(catalog.destinations) { Text($0.name).tag($0.id) }
                            }
                            .pickerStyle(.menu).labelsHidden().disabled(loading || sending)
                        } else {
                            Text(store.printerProblem ?? "Reading your Mac’s printers…").foregroundStyle(.secondary)
                        }
                    }
                    if object?.print?.uncertain == true {
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Check the previous print", systemImage: "exclamationmark.triangle.fill")
                                .font(.headline).foregroundStyle(.orange)
                            Text("The last request may have reached \(previousPrinter). Check it before trying again.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Toggle("I checked; it isn’t printing this model.", isOn: $checked)
                        }
                        .padding(16).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text("Filament").font(.headline)
                            Spacer()
                            if !loading { Button("Refresh") { Task { await load() } }.disabled(sending) }
                        }
                        if loading {
                            ProgressView("Reading your printer’s filament…").frame(maxWidth: .infinity, alignment: .leading)
                        } else if choices.isEmpty, error == nil {
                            Text("No selectable filament was reported. Check the printer or open the model in your slicer.").foregroundStyle(.secondary)
                        } else {
                            ForEach(choices) { filament in
                                Button { selected = filament.slot } label: {
                                    HStack(spacing: 14) {
                                        Circle().fill(swatch(filament.colour)).frame(width: 38, height: 38)
                                            .overlay(Circle().strokeBorder(.secondary.opacity(0.4)))
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(displayName(filament)).font(.body.weight(.medium)).foregroundStyle(.primary)
                                            Text(filament.slot >= 254 ? "External spool" : "Slot \(filament.slot + 1)")
                                                .font(.subheadline).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: selected == filament.slot ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selected == filament.slot ? Color.accentColor : Color.secondary)
                                    }
                                    .padding(14).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                                }.buttonStyle(.plain).disabled(sending)
                                    .accessibilityLabel("\(displayName(filament)), \(filament.colour), slot \(filament.slot + 1)")
                                    .accessibilityAddTraits(selected == filament.slot ? .isSelected : [])
                            }
                        }
                    }
                    if let error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                    Text("Your printer may ask you to confirm its checks before printing.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Prepare to Print").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) } }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button { Task { await submit() } } label: {
                    HStack { if sending { ProgressView() }; Text("Print").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                .disabled(loading || sending || selected == nil || (object?.print?.uncertain == true && !checked))
                .padding(.horizontal, 20).padding(.vertical, 10).background(Color(uiColor: .systemBackground))
            }
            .task {
                if store.printerCatalog == nil { await store.loadPrinters() }
                printerId = object?.printerDestinationId ?? store.printerCatalog?.defaultDestinationId ?? ""
                await load()
            }
        }
    }

    private func choosePrinter(_ id: String) async {
        guard id != printerId, !loading, !sending else { return }
        loading = true; selected = nil; choices = []; error = nil
        do {
            let updated = try await store.mac.selectPrinter(objectId, destinationId: id)
            store.replace(updated); printerId = id
            await load()
        } catch let failure as MacError { error = failure.message; loading = false }
        catch { self.error = MacError.unreachable.message; loading = false }
    }

    private func load() async {
        loading = true; selected = nil; choices = []; error = nil
        if printerId.isEmpty {
            await store.loadPrinters()
            printerId = object?.printerDestinationId ?? store.printerCatalog?.defaultDestinationId ?? ""
        }
        guard !printerId.isEmpty else { loading = false; error = store.printerProblem ?? "No printer is available on your Mac."; return }
        do { choices = try await store.mac.filaments(objectId) }
        catch let failure as MacError { error = failure.message }
        catch { self.error = MacError.unreachable.message }
        loading = false
    }

    private func submit() async {
        guard let filament = choices.first(where: { $0.slot == selected }), !sending else { return }
        sending = true; error = nil
        defer { sending = false }
        do {
            let updated = try await store.mac.print(objectId, checked: object?.print?.uncertain == true && checked, filament: filament)
            store.replace(updated); dismiss()
        } catch let failure as MacError { error = failure.message }
        catch { self.error = MacError.unreachable.message }
    }
}

enum ProjectSection: String, CaseIterable { case model = "Model", inputs = "Inputs", activity = "Activity" }

private struct PrinterConfirmationView: View {
    let question: StmObject.PrintConfirmation
    let working: Bool
    let answer: (PrintConfirmationResponse.Action, [String: Bool]) -> Void
    @State private var checked: [String: Bool] = [:]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let now = timeline.date.timeIntervalSince1970 * 1000
            let expired = question.expiresAtMs <= now
            VStack(alignment: .leading, spacing: 16) {
                Text("Printer Confirmation").font(.headline)
                Text(verbatim: question.message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if question.supported {
                    ForEach(question.fields, id: \.name) { field in
                        Button { checked[field.name] = !(checked[field.name] ?? false) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: checked[field.name] == true ? "checkmark.square.fill" : "square")
                                    .font(.title2).foregroundStyle(.tint)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: field.title).font(.body.weight(.medium))
                                    if let description = field.description {
                                        Text(verbatim: description).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    if field.required { Text("Required").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(checked[field.name] == true ? "Checked" : "Unchecked")
                        .disabled(working || expired)
                    }
                    Button { answer(.accept, checked) } label: {
                        Label("Confirm and Continue", systemImage: "checkmark.circle").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .disabled(working || !question.canAccept(checked, atMs: now))
                } else {
                    Text("This printer question needs a form this app cannot display. Cancel this print to continue.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if expired {
                    Text("This confirmation has expired. Waiting for your Mac to update.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Button("Cancel Print", role: .destructive) { answer(.cancel, [:]) }
                    .buttonStyle(.glass).controlSize(.large).frame(maxWidth: .infinity)
                    .disabled(working || expired)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct ProjectInputs: View {
    let store: ObjectsStore
    let object: StmObject
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your Request").font(.headline)
                Text(object.instructions?.isEmpty == false ? object.instructions! : object.scan != nil || !(object.capture ?? []).isEmpty ? "A copy of the scanned object." : "No description was saved with this project.")
                    .textSelection(.enabled)
            }
            if !object.photos.isEmpty {
                Text("Reference Photos").font(.headline)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], spacing: 12) {
                    ForEach(Array(object.photos.enumerated()), id: \.element) { index, name in
                        ProjectPhoto(store: store, object: object, path: "photos/\(name)", label: "Reference photo \(index + 1)")
                    }
                }
            }
            if let capture = object.capture, !capture.isEmpty {
                DisclosureGroup("Scan Images (\(capture.count))") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 10) {
                        ForEach(Array(capture.enumerated()), id: \.element) { index, name in
                            ProjectPhoto(store: store, object: object, path: "capture/\(name)", label: "Scan image \(index + 1)")
                        }
                    }.padding(.top, 10)
                }
            }
            if object.scan != nil {
                Label("Original scan saved on your Mac", systemImage: "viewfinder").foregroundStyle(.secondary)
            }
            if object.photos.isEmpty && (object.capture ?? []).isEmpty {
                Label("No reference photos in this project", systemImage: "photo").foregroundStyle(.secondary)
            }
        }
    }
}

struct ProjectPhoto: View {
    let store: ObjectsStore
    let object: StmObject
    let path: String
    let label: String
    @State private var image: UIImage?
    @State private var imageURL: URL?
    @State private var failure: String?
    @State private var fullSize = false
    var body: some View {
        Button { if image != nil { fullSize = true } else { Task { await load() } } } label: {
            ZStack {
                Color(uiColor: .secondarySystemGroupedBackground)
                if let image { Image(uiImage: image).resizable().scaledToFill() }
                else if failure != nil { Image(systemName: "arrow.clockwise").foregroundStyle(.secondary) }
                else { ProgressView() }
            }
            .frame(height: 145).frame(maxWidth: .infinity)
            .clipped().clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain).accessibilityLabel(failure == nil ? label : "Retry loading \(label)")
        .task(id: "\(object.id)/\(path)") { await load() }
        .sheet(isPresented: $fullSize) {
            if let imageURL { ProjectPhotoViewer(url: imageURL, label: label) }
        }
    }
    private func load() async {
        failure = nil
        do {
            guard let url = try await store.mac.download(object, path),
                  let decoded = ProjectImageLoader.thumbnail(at: url, maxPixelSize: 600) else {
                failure = "Couldn't open this photo"; return
            }
            imageURL = url
            image = decoded
        } catch { failure = "Couldn't load this photo" }
    }
}

/// The original is owned only by the presented viewer, never by a gallery tile.
private struct ProjectPhotoViewer: View {
    let url: URL
    let label: String
    @State private var image: UIImage?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group { if let image { Image(uiImage: image).resizable().scaledToFit() } }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black).navigationTitle(label).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task(id: url) { image = UIImage(contentsOfFile: url.path) }
        .onDisappear { image = nil }
    }
}

struct ProjectActivity: View {
    let store: ObjectsStore
    let object: StmObject
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label("Project Created", systemImage: "plus.circle.fill").font(.headline)
            Text(Date(timeIntervalSince1970: object.createdAtMs / 1000), format: .dateTime.month().day().hour().minute())
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(object.passes.enumerated()), id: \.offset) { index, pass in
                VStack(alignment: .leading, spacing: 10) {
                    Divider()
                    HStack {
                        Label("Pass \(index + 1)", systemImage: pass.endedAtMs == nil ? "sparkles" : ["failed", "interrupted"].contains(pass.status ?? "") ? "exclamationmark.circle" : "checkmark.circle")
                            .font(.headline)
                        Spacer()
                        Text(pass.status?.replacingOccurrences(of: "_", with: " ").capitalized ?? "In progress")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text(Date(timeIntervalSince1970: pass.startedAtMs / 1000), format: .dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                    if let note = pass.note, !note.isEmpty {
                        Text("Your change").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(note).textSelection(.enabled)
                    }
                    if let summary = pass.summary, !summary.isEmpty { Text(summary).textSelection(.enabled) }
                    if (pass.activityCount ?? pass.activity?.count ?? 0) > 0 {
                        PassActivityView(store: store, object: object, index: index, count: pass.activityCount ?? pass.activity?.count ?? 0)
                    } else if pass.endedAtMs != nil {
                        Text("Detailed activity wasn't recorded for this earlier pass.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if object.passes.isEmpty {
                Text("Work will appear here after you send the project to your Mac.").foregroundStyle(.secondary)
            }
        }
    }
}

struct PassActivityView: View {
    let store: ObjectsStore
    let object: StmObject
    let index: Int
    let count: Int
    @State private var expanded = false
    @State private var entries: [StmObject.Activity] = []
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        DisclosureGroup("Model Activity (\(count))", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                if failed {
                    Button("Couldn't load this pass. Try again.") { Task { await load() } }
                } else if loading && entries.isEmpty { ProgressView() }
                ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: entry.kind == "tool" ? "wrench.and.screwdriver" : "text.bubble")
                            .foregroundStyle(.secondary).frame(width: 20)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.text).font(.subheadline).textSelection(.enabled)
                            Text(Date(timeIntervalSince1970: entry.atMs / 1000), format: .dateTime.hour().minute().second())
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }.padding(.top, 10)
        }
        .task(id: expanded ? object.updatedAtMs : -1) { if expanded { await load() } }
    }
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let activity = try await store.mac.passActivity(object.id, index: index)
            guard !Task.isCancelled else { return }
            entries = activity; failed = false
        } catch { if !Task.isCancelled { failed = true } }
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
        .aspectRatio(4 / 3, contentMode: .fit)
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
