import SwiftUI
import UIKit
import SceneKit
import ModelIO
import SceneKit.ModelIO
import CounterpartKit
import GuidedObjectCapture

typealias StmObject = Project
typealias MacError = CompanionError

/// The paired Mac, through CounterpartKit's pinned client: projects, photos, scans and printing. The
/// method names are the ones the screens (and their retry tests) have always used.
@MainActor final class MacConnection {
    let client: CompanionClient
    let uploader: ProjectUploader

    init(client: CompanionClient) {
        self.client = client
        self.uploader = ProjectUploader(client: client)
    }

    // MARK: Projects

    func printers() async throws -> PrinterCatalog { try await client.printers() }
    func filaments(_ id: String) async throws -> [PrinterFilament] { try await client.filaments(id) }
    func colourMapping(_ id: String) async throws -> ColourMapping { try await client.colourMapping(id) }
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] { try await client.passActivity(id, index: index) }
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject { try await client.selectPrinter(id, destinationId: destinationId) }
    func list() async throws -> [StmObject] { try await client.list() }
    func get(_ id: String) async throws -> StmObject { try await client.get(id) }
    func create(_ instructions: String, kind: String? = nil) async throws -> StmObject {
        let link = PublishedModelLink.find(in: instructions)
        if link != nil {
            let capabilities = try await client.capabilities()
            guard capabilities.contains("publishedModels") else {
                throw CompanionError(code: "published-models-unavailable", message: "Update Counterpart on your Mac to get the designer’s model file.")
            }
        }
        return try await client.create(instructions, kind: link == nil ? kind : "published", url: link)
    }
    func updateDraft(_ id: String, instructions: String) async throws -> StmObject { try await client.updateDraft(id, instructions: instructions) }
    func start(_ id: String, captureManifest: [String: Any]? = nil) async throws -> StmObject { try await client.start(id, captureManifest: captureManifest) }
    func correct(_ id: String, _ note: String, photoNames: [String]? = nil) async throws -> StmObject { try await client.correct(id, note, photoNames: photoNames) }
    func closeup(_ id: String, bestGuess: Bool, photoNames: [String] = []) async throws -> StmObject { try await client.answerAsk(id, bestGuess: bestGuess, photoNames: photoNames) }
    func answerPrintConfirmation(_ id: String, response: PrintConfirmationResponse) async throws -> StmObject {
        try await client.answerPrintConfirmation(id, response: response)
    }
    func delete(_ id: String) async throws { try await client.delete(id) }
    func download(_ object: StmObject, _ name: String) async throws -> URL? { try await client.download(object, name) }

    // MARK: Photos

    /// Photos picked for a new project. They stay on this phone (Caches/ObjectsChosen) until sent.
    func choosePhotos(limit: Int) async throws -> [ChosenPhoto] {
        let picked = try await PhotoSources.pick(limit: limit)
        let root = Self.chosenRoot
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return picked.compactMap { photo in
            let id = "\(UUID().uuidString.lowercased()).\(photo.ext)"
            let url = root.appending(path: id)
            return (try? photo.data.write(to: url, options: .atomic)).map { ChosenPhoto(id: id, url: url) }
        }
    }
    static var chosenRoot: URL { URL.cachesDirectory.appending(path: "ObjectsChosen", directoryHint: .isDirectory) }

    /// Keeps one picked or taken photo in the cache until it's sent.
    static func keep(_ photo: PickedPhoto) -> ChosenPhoto? {
        try? FileManager.default.createDirectory(at: chosenRoot, withIntermediateDirectories: true)
        let id = "\(UUID().uuidString.lowercased()).\(photo.ext)"
        let url = chosenRoot.appending(path: id)
        return (try? photo.data.write(to: url, options: .atomic)).map { ChosenPhoto(id: id, url: url) }
    }

    // MARK: Sending a new project

    /// Sends a new project's files and starts it: a finished capture for it first (sent as it was, never
    /// recaptured), then the chosen photos, then start. Everything it needs is on disk, so a send cut short
    /// finishes from the project page or on the next launch, without the sheet that began it.
    func sendProject(_ id: String, photos: [ChosenPhoto]) async throws -> StmObject {
        Self.markSendRequested(id)
        if !photos.isEmpty { Self.savePending(id, photos) }
        let chosen = photos.isEmpty ? Self.pendingPhotos(id) : photos
        let sent: StmObject
        if HandheldCapture.finished(id) {
            try await sendChosen(id, chosen)
            sent = try await sendHandheld(id)
        } else if let run = await finishedScan(id) {
            let manifest = try await sendCapture(id, run: run)
            try await sendChosen(id, chosen)
            sent = try await start(id, captureManifest: manifest)
        } else {
            try await sendChosen(id, chosen)
            sent = try await start(id)
        }
        Self.clearPending(id)
        return sent
    }

    /// The photos chosen for a project still being sent, kept beside them in the cache.
    static func pendingPhotos(_ id: String) -> [ChosenPhoto] {
        guard let data = try? Data(contentsOf: pendingFile(id)), let ids = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return ids.filter { $0.wholeMatch(of: /[a-f0-9-]{36}\.(jpg|png|heic)/) != nil }
            .map { ChosenPhoto(id: $0, url: chosenRoot.appending(path: $0)) }
            .filter { FileManager.default.fileExists(atPath: $0.url.path) }
    }
    private static func pendingFile(_ id: String) -> URL { chosenRoot.appending(path: "pending-\(id).json") }
    private static func savePending(_ id: String, _ photos: [ChosenPhoto]) {
        try? FileManager.default.createDirectory(at: chosenRoot, withIntermediateDirectories: true)
        try? JSONEncoder().encode(photos.map(\.id)).write(to: pendingFile(id), options: .atomic)
    }
    private static func clearPending(_ id: String) {
        try? FileManager.default.removeItem(at: pendingFile(id))
        try? FileManager.default.removeItem(at: requestedFile(id))
    }

    /// Send was pressed for this project and hasn't finished: the project page may resume it. A draft whose
    /// scan is attached but never sent has no marker.
    static func sendRequested(_ id: String) -> Bool { FileManager.default.fileExists(atPath: requestedFile(id).path) }
    private static func requestedFile(_ id: String) -> URL { chosenRoot.appending(path: "sending-\(id)") }
    private static func markSendRequested(_ id: String) {
        try? FileManager.default.createDirectory(at: chosenRoot, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: requestedFile(id).path, contents: Data())
    }

    /// Sends chosen photos; they leave this phone's cache once the Mac has every one.
    func sendChosen(_ id: String, _ photos: [ChosenPhoto], forMessage: Bool = false) async throws {
        guard !photos.isEmpty else { return }
        let files = photos.map { UploadFile.image($0.url, name: "photo-\($0.id)") }
        try await uploader.send(files, to: id, forMessage: forMessage)
        for photo in photos { try? FileManager.default.removeItem(at: photo.url) }
    }

    /// Close-ups for a project that asked for them, sent as soon as they're taken or picked.
    func addCloseups(_ id: String, camera: Bool, forMessage: Bool = false) async throws -> [String] {
        let photos: [PickedPhoto]
        if camera { photos = try await PhotoSources.takePhoto().map { [$0] } ?? [] }
        else { photos = try await PhotoSources.pick(limit: 12) }
        guard !photos.isEmpty else { return [] }
        let files = photos.map { UploadFile(kind: .photo, name: PhotoSources.closeupName($0.ext), source: .bytes($0.data),
                                            type: $0.ext == "png" ? "image/png" : $0.ext == "heic" ? "image/heic" : "image/jpeg") }
        _ = try await uploader.send(files, to: id, forMessage: forMessage)
        return files.map(\.name)
    }

    // MARK: Scans

    /// LiDAR walk-around scanning: Object Capture with a LiDAR Scanner.
    func canScan() async -> Bool {
        let status = NativeCaptureCoordinator.status()
        return status["supported"] as? Bool == true && status["lidar"] as? Bool != false
    }

    /// Opens the walk-around scan. Returns a ready run only when Add to this project was chosen.
    func scan(_ id: String) async throws -> String? {
        // A new capture choice replaces an earlier failed Send. Keep for later must not inherit that
        // old automatic-resume request; the files remain available when Send is explicitly pressed.
        try? FileManager.default.removeItem(at: Self.requestedFile(id))
        do {
            let draft = try await NativeCaptureCoordinator.shared.start(NativeCaptureDestination(projectId: id, revision: 0, snapshot: "{}", context: nil))
            guard draft["addRequested"] as? Bool == true, draft["status"] as? String == "ready" else { return nil }
            return draft["runID"] as? String
        } catch {
            throw MacError(code: "capture-error", message: error.localizedDescription)
        }
    }

    /// A finished scan for this project still on the phone, so a send cut short can resume.
    func finishedScan(_ id: String) async -> String? {
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        let draft = drafts.first {
            $0["status"] as? String == "ready" && ($0["origin"] as? [String: Any])?["projectId"] as? String == id
        }
        return draft?["runID"] as? String
    }

    /// The saved reconstruction warning follows the same ready run chosen for Send.
    func localScanWarning(_ id: String) -> String? {
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        let draft = drafts.first {
            $0["status"] as? String == "ready" && ($0["origin"] as? [String: Any])?["projectId"] as? String == id
        }
        return draft?["stitchingIncomplete"] as? Bool == true ? NativeCaptureCoordinator.stitchingWarning : nil
    }

    /// The walk-around scan's model while it's still on this phone: the project page shows it until the Mac
    /// has a result of its own. The Mac doesn't serve the scan back.
    func localScan(_ id: String) -> URL? {
        #if DEBUG
        if let folder = Fixtures.folder { return folder.appending(path: "scanB.usdz") }
        #endif
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        guard let run = drafts.first(where: {
            $0["status"] as? String == "ready" && ($0["origin"] as? [String: Any])?["projectId"] as? String == id
        })?["runID"] as? String,
              UUID(uuidString: run) != nil, run == run.lowercased() else { return nil }
        let model = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)/Models/model-mobile.usdz")
        return (try? model.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true ? model : nil
    }

    func sendScan(_ id: String, run: String) async throws -> StmObject {
        let manifest = try await sendCapture(id, run: run)
        return try await start(id, captureManifest: manifest)
    }

    /// How much of each project's send has reached the Mac (0…1), for the Sending card.
    var onSendProgress: @MainActor @Sendable (String, Double) -> Void = { _, _ in }

    /// Sends a walk-around scan so the Mac can rebuild it (only what the Mac lacks; a send cut short resumes).
    ///
    /// Every image Object Capture took goes byte for byte as Apple wrote it: each HEIC carries its camera, LiDAR depth
    /// and gravity, which the Mac's PhotogrammetrySession reads itself. That is what `isOverCaptureEnabled` is for:
    /// "for use when the images are intended to be transferred to macOS for model reconstruction". The phone's own
    /// model goes last, as a preview the Mac replaces with its full-detail rebuild. Apple's checkpoint folder stays
    /// here: "For macOS reconstruction, the checkpointDirectory … starts from scratch, and does not resume from
    /// previous checkpoints" (PhotogrammetrySession.Configuration.checkpointDirectory).
    ///
    /// Returns the start manifest that names every image. A Mac that can't rebuild them (an older Counterpart, or a
    /// computer without Apple's reconstruction) gets the model and 24 of the photos, as before, and no manifest.
    func sendCapture(_ id: String, run: String) async throws -> [String: Any]? {
        guard UUID(uuidString: run) != nil, run == run.lowercased() else { throw MacError(code: "invalid-request", message: "That request isn't allowed.") }
        let folder = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)", directoryHint: .isDirectory)
        let model = folder.appending(path: "Models/model-mobile.usdz")
        guard (try? model.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            throw MacError(code: "no-model", message: "The scan didn't finish making a model. Scan it again.")
        }
        let images = folder.appending(path: "Images", directoryHint: .isDirectory)
        let pattern = /[A-Za-z0-9][A-Za-z0-9._ -]{0,122}\.(HEIC|heic|JPG|jpg|JPEG|jpeg|PNG|png)/
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? [])
            .filter { $0.wholeMatch(of: pattern) != nil && !$0.contains("..") }.sorted()
        let preview = UploadFile(kind: .scan, name: "scan.usdz", source: .file(model), type: "model/vnd.usdz+zip")
        let report = onSendProgress
        let progress: @Sendable (Double) -> Void = { share in Task { @MainActor in report(id, share) } }
        // A send cut short keeps the way it started: frames already there mean every image, a model alone the older
        // send. A fresh one asks the Mac; if that question fails, the send fails and resumes, it never guesses.
        let held = try await client.get(id)
        let rebuilds: Bool
        if !(held.capture ?? []).isEmpty { rebuilds = true }
        else if held.scan != nil || names.isEmpty { rebuilds = false }
        else { rebuilds = try await client.capabilities().contains("objectCaptureImages") }
        guard rebuilds else {
            let files = [preview] + ProjectUploader.spread(names, count: 24).map { UploadFile.image(images.appending(path: $0), name: $0) }
            try await uploader.send(files, to: id, progress: progress)
            return nil
        }
        let frames = try ProjectUploader.captureFrames(((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? []))
        // The images first: the Mac takes capture frames only until a scan is there.
        let files = frames.map { UploadFile.image(images.appending(path: $0.file), name: $0.name, kind: .capture) } + [preview]
        try await uploader.send(files, to: id, progress: progress)
        return ["version": 1, "images": frames.map(\.name), "depthRequired": false, "source": "object-capture"]
    }


    /// An in-hand scan's photos and depth (HandheldCapture.swift): the Mac rebuilds the model, then touches it up.
    func sendHandheld(_ id: String) async throws -> StmObject {
        let folder = HandheldCapture.folder(id)
        guard FileManager.default.fileExists(atPath: folder.appending(path: "finished").path) else {
            throw MacError(code: "unfinished-capture", message: "This capture hasn't finished saving. Your capture is still saved on this phone.")
        }
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        let names = contents.filter { $0.wholeMatch(of: /[0-9]{4}\.heic/) != nil }.sorted()
        guard !names.isEmpty else { throw MacError(code: "no-photos", message: "The scan has no photos. Scan it again.") }
        // A damaged streaming capture must not silently become a photo-only upload.
        let depthRequired = contents.contains("capture-frames.jsonl") || contents.contains { $0.hasSuffix(".depth.plist") }
        var files: [UploadFile] = []
        for name in names {
            let depthName = name.replacingOccurrences(of: ".heic", with: ".depth.plist")
            let depth = folder.appending(path: depthName)
            let hasDepth = FileManager.default.fileExists(atPath: depth.path)
            if depthRequired && !hasDepth {
                throw MacError(code: "incomplete-depth", message: "A recorded frame is missing its depth file. Your capture is still saved on this phone.")
            }
            // Original depth goes first: the Mac refuses to rebuild from an incomplete set.
            if hasDepth { files.append(UploadFile(kind: .depth, name: depthName, source: .file(depth), type: "application/octet-stream")) }
            files.append(UploadFile(kind: .capture, name: name, source: .file(folder.appending(path: name)), type: "image/heic"))
        }
        try await uploader.send(files, to: id)
        return try await start(id, captureManifest: ["version": 1, "images": names, "depthRequired": depthRequired])
    }

    // MARK: 3D

    /// Opens the model full screen to turn around.
    func showModel(_ object: StmObject) async throws {
        guard let url = try await download(object, "model.stl") else { return }
        let asset = MDLAsset(url: url)
        let scene = SCNScene(mdlAsset: asset)
        scene.rootNode.enumerateChildNodes { node, _ in
            guard let geometry = node.geometry else { return }
            let material = SCNMaterial()
            material.diffuse.contents = UIColor(red: 1.0, green: 0.45, blue: 0.18, alpha: 1)
            material.roughness.contents = 0.6
            material.lightingModel = .physicallyBased
            geometry.materials = [material]
        }
        guard let presenter = PhotoSources.topViewController() else { throw MacError(code: "busy", message: "Close the current sheet first.") }
        let viewer = UIHostingController(rootView: ModelViewerSheet(scene: scene))
        viewer.modalPresentationStyle = .fullScreen
        presenter.present(viewer, animated: true)
    }

    // MARK: Pairing

    struct Pairing: Equatable { var paired: Bool; var address: String? }
}

struct ChosenPhoto: Identifiable, Equatable { var id: String; var url: URL }

private struct ModelViewerSheet: View {
    let scene: SCNScene
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            SceneView(scene: scene, options: [.allowsCameraControl, .autoenablesDefaultLighting])
                .background(Color.black)
                .ignoresSafeArea()
                .navigationTitle("Turn it around")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
