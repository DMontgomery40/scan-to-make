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
    /// How a fit's size is settled goes as fields. A Mac that doesn't take them would design without them, so it
    /// is asked to update instead.
    private func requireFitFields(_ fit: ProjectFit?) async throws {
        guard fit != nil else { return }
        guard try await client.capabilities().contains("fitFields") else {
            throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac so it knows how this part's size is settled.")
        }
    }

    func create(_ instructions: String, kind: String? = nil, fit: ProjectFit? = nil) async throws -> StmObject {
        try await requireFitFields(fit)
        let link = PublishedModelLink.find(in: instructions)
        if link != nil {
            let capabilities = try await client.capabilities()
            guard capabilities.contains("publishedModels") else {
                throw CompanionError(code: "published-models-unavailable", message: "Update Counterpart on your Mac to get the designer’s model file.")
            }
        }
        return try await client.create(instructions, kind: link == nil ? kind : "published", url: link, fit: link == nil ? fit : nil)
    }
    func updateDraft(_ id: String, instructions: String, kind: String? = nil, fit: ProjectFit? = nil) async throws -> StmObject {
        try await requireFitFields(fit)
        return try await client.updateDraft(id, instructions: instructions, kind: kind, fit: fit)
    }
    func start(_ id: String, captureManifest: [String: Any]? = nil) async throws -> StmObject { try await client.start(id, captureManifest: captureManifest) }
    func correct(_ id: String, _ note: String, photoNames: [String]? = nil, messageId: String? = nil) async throws -> StmObject { try await client.correct(id, note, photoNames: photoNames, messageId: messageId) }
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
        } else if let kept = keptScan(id) {
            // A stopped scan goes like a finished one, as its photos (#791): Send never leaves it on the phone.
            let manifest: [String: Any]?
            switch kept {
            case .finished(let run): manifest = try await sendCapture(id, run: run)
            case .stopped(let run, _): manifest = try await sendStoppedCapture(id, run: run)
            }
            try await sendChosen(id, chosen)
            sent = try await start(id, captureManifest: manifest)
        } else {
            try await sendChosen(id, chosen)
            sent = try await start(id)
        }
        Self.clearPending(id)
        Self.setPendingDeclare(project: id, run: nil)   // the send declared it itself
        return sent
    }

    /// Sends a finished scan's own files without starting the project, so choosing Copy or Fit doesn't
    /// wait for the largest transfer. Chosen photos stay for Send, so their thumbnails stay put here.
    func uploadProject(_ id: String) async throws {
        if HandheldCapture.finished(id) { _ = try await uploadHandheld(id); return }
        switch keptScan(id) {
        case .finished(let run): _ = try await sendCapture(id, run: run)
        case .stopped(let run, _): _ = try await sendStoppedCapture(id, run: run)
        case nil: break
        }
    }

    /// A stopped scan's photos alone, declared before any is sent: only a Mac that rebuilds from photos takes them.
    private func sendStoppedCapture(_ id: String, run: String) async throws -> [String: Any] {
        guard let manifest = try await sendCapture(id, run: run, modelRequired: false) else {
            throw MacError(code: "needs-update", message: "Update Counterpart on your Mac to rebuild a scan from its photos.")
        }
        return manifest
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

    /// Projects with a finished scan still only on this phone: they must offer Send even though the Mac's
    /// copy of the project has no scan yet.
    func readyScanProjects() -> Set<String> {
        #if DEBUG
        // UI tests: "<project id>".
        if Fixtures.folder != nil, let id = ProcessInfo.processInfo.environment["COUNTERPART_READY_SCAN"], !id.isEmpty { return [id] }
        #endif
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        return Set(drafts.compactMap { draft in
            guard draft["status"] as? String == "ready" else { return nil }
            return (draft["origin"] as? [String: Any])?["projectId"] as? String
        })
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

    /// A picture of a finished scan still on this phone, for New's question about it: one of the capture's own frames,
    /// a third of the way round. Nil when the run kept none.
    func scanPicture(_ id: String) -> URL? {
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        guard let run = drafts.first(where: {
            $0["status"] as? String == "ready" && ($0["origin"] as? [String: Any])?["projectId"] as? String == id
        })?["runID"] as? String,
              UUID(uuidString: run) != nil, run == run.lowercased() else { return nil }
        let images = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)/Images", directoryHint: .isDirectory)
        let names = Self.imageNames(in: images)
        return names.isEmpty ? nil : images.appending(path: names[names.count / 3])
    }

    /// The walk-around scan's model while it's still on this phone: the project page shows it until the Mac
    /// has a result of its own. The Mac doesn't serve the scan back.
    func localScan(_ id: String) -> URL? {
        #if DEBUG
        // The made-up sets' phone holds a scan (scanB.usdz). Not the photo-only set, whose phone sent photos and
        // nothing else, nor the real projects, whose files are the Mac's.
        if let folder = Fixtures.folder, !["photo-only", "real"].contains(Fixtures.set) { return folder.appending(path: "scanB.usdz") }
        #endif
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        guard let run = drafts.first(where: {
            $0["status"] as? String == "ready" && ($0["origin"] as? [String: Any])?["projectId"] as? String == id
        })?["runID"] as? String,
              UUID(uuidString: run) != nil, run == run.lowercased() else { return nil }
        let model = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)/Models/model-mobile.usdz")
        return (try? model.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true ? model : nil
    }

    /// A scan that was stopped (or failed, or cut off) after it kept photos: it stays on this phone until it is sent or
    /// scanned again, and its project says so. Only the newest run of each project counts: a finished one after it
    /// wins. Runs that kept no photos are not listed; nothing here deletes a capture.
    struct StoppedScan: Equatable { let run: String; let photos: Int }

    func stoppedScans() -> [String: StoppedScan] {
        #if DEBUG
        // UI tests: "<project id>:<photos>".
        if Fixtures.folder != nil {
            guard let value = ProcessInfo.processInfo.environment["COUNTERPART_STOPPED_SCAN"],
                  let colon = value.lastIndex(of: ":"), let photos = Int(value[value.index(after: colon)...]) else { return [:] }
            return [String(value[..<colon]): StoppedScan(run: "fixture", photos: photos)]
        }
        #endif
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        let active = NativeCaptureCoordinator.status()["activeRunID"] as? String
        let removed = Self.removedStoppedScans, declared = Self.declaredRuns()
        // Each project's kept scan by the same rule Send uses (keptScan): the newest run decides.
        var projects: [String] = []
        for draft in drafts {
            if let project = (draft["origin"] as? [String: Any])?["projectId"] as? String, !projects.contains(project) { projects.append(project) }
        }
        var stopped: [String: StoppedScan] = [:]
        for project in projects {
            if case .stopped(let run, let photos)? = Self.keptScan(for: project, drafts: drafts, active: active, removed: removed,
                                                                 declared: declared[project], photos: Self.photoCount) {
                stopped[project] = StoppedScan(run: run, photos: photos)
            }
        }
        return stopped
    }

    static func photoCount(_ run: String) -> Int {
        imageNames(in: URL.documentsDirectory.appending(path: "NativeCaptures/\(run)/Images", directoryHint: .isDirectory)).count
    }

    /// The scan on this phone that a project sends: its newest run that kept something, a finished one or one stopped
    /// after it kept photos (#791: David stopped a 68-photo scan whose Done never enabled, and Send went without it).
    enum KeptScan: Equatable { case finished(run: String), stopped(run: String, photos: Int) }

    /// `drafts` newest first, as the capture store lists them; `photos` counts a run's kept images.
    /// `removed`: stopped runs taken off their project with Remove; they stay on the phone and are never sent.
    /// The newest run decides (review of #801). If it is a stopped run that was removed or kept no photos, the project
    /// falls back first to the run the Mac was told about (`declared`), while it still has its photos: the Mac waits for
    /// exactly that scan, so the phone must keep offering it. Then to an older finished scan. Never to an older stopped
    /// run that was never declared.
    static func keptScan(for project: String, drafts: [[String: Any]], active: String?, removed: Set<String> = [],
                         declared: String? = nil, photos: (String) -> Int) -> KeptScan? {
        var newestStoppedSeen = false
        var declaredFallback: KeptScan?, finishedFallback: KeptScan?
        for draft in drafts {
            guard let run = draft["runID"] as? String, UUID(uuidString: run) != nil, run == run.lowercased(), run != active,
                  (draft["origin"] as? [String: Any])?["projectId"] as? String == project,
                  let status = draft["status"] as? String else { continue }
            if status == "ready" {
                if !newestStoppedSeen { return .finished(run: run) }
                finishedFallback = finishedFallback ?? .finished(run: run)
                continue
            }
            guard ["stopped", "failed", "interrupted"].contains(status) else { continue }
            if !newestStoppedSeen {
                newestStoppedSeen = true
                if !removed.contains(run) {
                    let kept = photos(run)
                    if kept > 0 { return .stopped(run: run, photos: kept) }
                }
                continue
            }
            if run == declared && declaredFallback == nil {
                let kept = photos(run)
                if kept > 0 { declaredFallback = .stopped(run: run, photos: kept) }
            }
        }
        return declaredFallback ?? finishedFallback
    }

    /// The run each project's photo list was last declared to the Mac for (or is about to be: recorded with the pending
    /// declare). A newer declared run replaces it. Kept so the phone and the Mac agree on the scan a draft waits for.
    static func declaredRuns(_ defaults: UserDefaults = .standard) -> [String: String] {
        (defaults.dictionary(forKey: declaredRunsKey) as? [String: String]) ?? [:]
    }
    static func setDeclaredRun(project: String, run: String?, _ defaults: UserDefaults = .standard) {
        var runs = declaredRuns(defaults)
        runs[project] = run
        defaults.set(runs, forKey: declaredRunsKey)
    }
    private static let declaredRunsKey = "CounterpartDeclaredScanRuns"

    func keptScan(_ id: String) -> KeptScan? {
        let drafts = (try? NativeCaptureCoordinator.shared.drafts()) ?? []
        let active = NativeCaptureCoordinator.status()["activeRunID"] as? String
        return Self.keptScan(for: id, drafts: drafts, active: active, removed: Self.removedStoppedScans,
                             declared: Self.declaredRuns()[id], photos: Self.photoCount)
    }

    /// Stopped runs taken off their project on New with Remove (review of #795; every stopped scan since David, Nov 15):
    /// they never lock a draft or go with its Send. Kept on the phone; nothing deletes a capture.
    static var removedStoppedScans: Set<String> { removedStoppedScans(.standard) }
    static func removedStoppedScans(_ defaults: UserDefaults) -> Set<String> { Set(defaults.stringArray(forKey: removedStoppedKey) ?? []) }
    static func removeStoppedScan(run: String, _ defaults: UserDefaults = .standard) {
        defaults.set((removedStoppedScans(defaults).union([run])).sorted(), forKey: removedStoppedKey)
    }
    private static let removedStoppedKey = "CounterpartRemovedStoppedScans"

    /// Whether a kept scan is named to the Mac as soon as it's attached: a stopped one with enough photos. One with
    /// fewer waits for Send (review of #795). Either can be taken off with Remove, which tells the Mac to forget it.
    static func declaresAtOnce(_ kept: KeptScan?) -> Bool {
        if case .stopped(_, let photos)? = kept { return isEnough(stoppedPhotos: photos) }
        return false
    }

    /// The photos of the run a capture just stopped, comparing the project's kept scan before and after it: nil when
    /// that run kept none, so an older stopped run is never sent again in its place (review of #795).
    static func justStopped(before: KeptScan?, after: KeptScan?) -> Int? {
        guard case .stopped(let run, let photos)? = after else { return nil }
        if case .stopped(let earlier, _)? = before, earlier == run { return nil }
        return photos
    }

    /// Whether a send cut short (Send was pressed, `sendRequested`) has a scan on this phone to finish with: an in-hand
    /// capture, or a kept walk-around scan, finished or stopped after it kept photos (#791, review of #795).
    static func resumesSend(handheldFinished: Bool, kept: KeptScan?) -> Bool { handheldFinished || kept != nil }

    /// A stopped scan with this many photos is sent as it is, like a finished one; fewer are still offered, with a
    /// warning, and the Mac says plainly if it can't build from them.
    static func isEnough(stoppedPhotos photos: Int) -> Bool { photos >= 20 }

    /// The line under a stopped scan's question on New (#795). Too few sits beside Remove, so it names it.
    static func stoppedScanWords(photos: Int) -> String {
        let kept = "Stopped at \(photos) photo\(photos == 1 ? "" : "s")"
        return isEnough(stoppedPhotos: photos) ? "\(kept). Your Mac builds the model from them."
            : "\(kept), which may be too few. Remove it, or your Mac will try."
    }

    private static func imageNames(in images: URL) -> [String] {
        let pattern = /[A-Za-z0-9][A-Za-z0-9._ -]{0,122}\.(HEIC|heic|JPG|jpg|JPEG|jpeg|PNG|png)/
        return ((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? [])
            .filter { $0.wholeMatch(of: pattern) != nil && !$0.contains("..") }.sorted()
    }

    /// Names a kept scan's photos to the Mac without sending any (#791), the same list `sendCapture` declares, so the
    /// Mac starts the project only with them. Nothing on a Mac that can't rebuild from photos.
    func declareKeptScan(_ id: String, run: String) async throws {
        guard UUID(uuidString: run) != nil, run == run.lowercased() else { return }
        let images = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)/Images", directoryHint: .isDirectory)
        let frames = try ProjectUploader.captureFrames((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? [])
        guard !frames.isEmpty, try await client.capabilities().contains("objectCaptureImages") else { return }
        try await declare(id, run: run, manifest: Self.captureManifest(frames.map(\.name)))
    }

    /// Names a run's photos to the Mac. A different run the Mac acknowledged before is forgotten first, with any of its
    /// photos that came: every run names its photos alike (0001.heic…) and a send skips names the Mac already has, so
    /// an older run's photos would otherwise be rebuilt as the newer scan.
    /// A Mac older than `captureForget` (Mac beta 6) can't forget: the newer run is declared as before.
    private func declare(_ id: String, run: String, manifest: [String: Any]) async throws {
        let forgets = try await client.capabilities().contains("captureForget")
        try await Self.declare(project: id, run: run, forget: { [client] in
            if forgets { _ = try await client.forgetCapture($0) }
        }, declare: { [client] in _ = try await client.declareCapture($0, manifest: manifest) })
    }

    static func declare(project: String, run: String, _ defaults: UserDefaults = .standard,
                        forget: (String) async throws -> Void, declare: (String) async throws -> Void) async throws {
        if let earlier = macRun(project, defaults), earlier != run {
            try await forget(project)
            setAcknowledgedRun(project: project, run: nil, defaults)
            if declaredRuns(defaults)[project] == earlier { setDeclaredRun(project: project, run: nil, defaults) }
        }
        try await declare(project)
        setAcknowledgedRun(project: project, run: run, defaults)
    }

    /// The run whose photo list the Mac has, as far as this phone knows: the one it acknowledged, or, from a build before
    /// `acknowledgedRuns` (202611142311), the declared run once no declare of it is pending (only an answered declare,
    /// in `retryDeclares` or `sendCapture`, recorded it then).
    static func macRun(_ project: String, _ defaults: UserDefaults = .standard) -> String? {
        if let run = acknowledgedRuns(defaults)[project] { return run }
        guard let run = declaredRuns(defaults)[project], pendingDeclares(defaults)[project] != run else { return nil }
        return run
    }

    /// The run whose photo list the Mac last acknowledged, by project; nil once it was forgotten.
    static func acknowledgedRuns(_ defaults: UserDefaults = .standard) -> [String: String] {
        (defaults.dictionary(forKey: acknowledgedRunsKey) as? [String: String]) ?? [:]
    }
    static func setAcknowledgedRun(project: String, run: String?, _ defaults: UserDefaults = .standard) {
        var runs = acknowledgedRuns(defaults)
        runs[project] = run
        defaults.set(runs, forKey: acknowledgedRunsKey)
    }
    private static let acknowledgedRunsKey = "CounterpartAcknowledgedScanRuns"

    /// Remove on a stopped scan (David, Nov 15: a 20-photo-or-more stop could never be taken off): the Mac forgets it if
    /// it was told, and this phone stops offering it. Kept on the phone; nothing deletes a capture. A declare that never
    /// reached the Mac (still pending, and the Mac doesn't answer) needs no forgetting.
    func removeStoppedScan(_ id: String, run: String) async throws {
        try await Self.removeStoppedScan(project: id, run: run, forget: { [client] in
            guard try await client.capabilities().contains("captureForget") else {
                throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac to remove a scan it already knows about.")
            }
            _ = try await client.forgetCapture($0)
        })
    }

    static func removeStoppedScan(project: String, run: String, _ defaults: UserDefaults = .standard,
                                  forget: (String) async throws -> Void) async throws {
        let told = macRun(project, defaults) == run, pending = pendingDeclares(defaults)[project] == run
        if told || pending {
            do { try await forget(project) }
            catch let failure as CompanionError where !told && failure.isUnreachable {}
        }
        setPendingDeclare(project: project, run: nil, defaults)
        if told { setAcknowledgedRun(project: project, run: nil, defaults) }
        if declaredRuns(defaults)[project] == run { setDeclaredRun(project: project, run: nil, defaults) }
        removeStoppedScan(run: run, defaults)
    }

    static func captureManifest(_ images: [String]) -> [String: Any] {
        ["version": 1, "images": images, "depthRequired": false, "source": "object-capture"]
    }

    // MARK: Declaring a stopped scan until the Mac has it (review of #801, F1)

    /// Stopped scans of 20 photos or more whose photo list the Mac hasn't acknowledged yet, by project. Declaring is what
    /// stops any client (the Mac, Android, Linux) starting the project from its words alone, so it must not be lost when
    /// the Mac is asleep or the app is suspended at Stop: it's kept here and tried again whenever the Mac answers.
    static func pendingDeclares(_ defaults: UserDefaults = .standard) -> [String: String] {
        (defaults.dictionary(forKey: pendingDeclaresKey) as? [String: String]) ?? [:]
    }
    static func setPendingDeclare(project: String, run: String?, _ defaults: UserDefaults = .standard) {
        var pending = pendingDeclares(defaults)
        pending[project] = run
        defaults.set(pending, forKey: pendingDeclaresKey)
    }
    private static let pendingDeclaresKey = "CounterpartPendingScanDeclares"

    /// Tries every pending declare once. One is done when the Mac acknowledges it, when the Mac refuses it (the project
    /// has moved on), or when the project's kept scan is no longer that run with enough photos (sent, superseded,
    /// removed); one the Mac didn't answer stays for the next try.
    static func retryDeclares(_ defaults: UserDefaults = .standard, kept: (String) -> KeptScan?,
                              declare: (String, String) async throws -> Void) async {
        for (project, run) in pendingDeclares(defaults).sorted(by: { $0.key < $1.key }) {
            guard case .stopped(run, let photos)? = kept(project), isEnough(stoppedPhotos: photos) else {
                setPendingDeclare(project: project, run: nil, defaults); continue
            }
            do {
                try await declare(project, run)
                setDeclaredRun(project: project, run: run, defaults)
                setPendingDeclare(project: project, run: nil, defaults)
            } catch let failure as CompanionError where !failure.isUnreachable && !failure.needsPairing {
                setPendingDeclare(project: project, run: nil, defaults)
            } catch {
                // The Mac didn't answer: kept for the next time it does.
            }
        }
    }

    /// A stopped scan with enough photos was attached to this project: record it at once (it survives the app being
    /// suspended), then `retryPendingDeclares` tells the Mac. Whether there was one to record.
    @discardableResult func recordStoppedDeclare(_ id: String) -> Bool {
        let kept = keptScan(id)
        guard Self.declaresAtOnce(kept), case .stopped(let run, _)? = kept else { return false }
        Self.setPendingDeclare(project: id, run: run)
        Self.setDeclaredRun(project: id, run: run)
        return true
    }

    func retryPendingDeclares() async {
        guard !Self.pendingDeclares().isEmpty else { return }
        await Self.retryDeclares(kept: { [self] in keptScan($0) }, declare: { [self] in try await declareKeptScan($0, run: $1) })
    }

    /// Sends a stopped scan's photos as they are; the Mac rebuilds from what's there and says plainly if it's too few.
    func sendStoppedScan(_ id: String, run: String) async throws -> StmObject {
        try await start(id, captureManifest: try await sendStoppedCapture(id, run: run))
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
    /// A stopped scan (`modelRequired: false`) has photos and no phone model: it sends the photos alone, and only to a
    /// Mac that rebuilds from them.
    func sendCapture(_ id: String, run: String, modelRequired: Bool = true) async throws -> [String: Any]? {
        guard UUID(uuidString: run) != nil, run == run.lowercased() else { throw MacError(code: "invalid-request", message: "That request isn't allowed.") }
        let folder = URL.documentsDirectory.appending(path: "NativeCaptures/\(run)", directoryHint: .isDirectory)
        let model = folder.appending(path: "Models/model-mobile.usdz")
        let hasModel = (try? model.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        guard hasModel || !modelRequired else {
            throw MacError(code: "no-model", message: "The scan didn't finish making a model. Scan it again.")
        }
        let images = folder.appending(path: "Images", directoryHint: .isDirectory)
        let names = Self.imageNames(in: images)
        guard hasModel || !names.isEmpty else { throw MacError(code: "no-photos", message: "The scan has no photos. Scan it again.") }
        // Marked as the phone's preview on every path, so a Mac never mistakes it for a full scan.
        let preview = UploadFile(kind: .scan, name: "scan.usdz", source: .file(model), type: "model/vnd.usdz+zip", preview: true)
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
            guard hasModel else { return nil }
            let files = [preview] + ProjectUploader.spread(names, count: 24).map { UploadFile.image(images.appending(path: $0), name: $0) }
            try await uploader.send(files, to: id, progress: progress)
            return nil
        }
        let frames = try ProjectUploader.captureFrames(((try? FileManager.default.contentsOfDirectory(atPath: images.path)) ?? []))
        let manifest = Self.captureManifest(frames.map(\.name))
        // Every image is named before any is sent: no client can start the Mac on part of them.
        try await declare(id, run: run, manifest: manifest)
        Self.setDeclaredRun(project: id, run: run)
        // Then the images: the Mac takes capture frames only until a scan is there.
        let files = frames.map { UploadFile.image(images.appending(path: $0.file), name: $0.name, kind: .capture) } + (hasModel ? [preview] : [])
        try await uploader.send(files, to: id, progress: progress)
        return manifest
    }


    /// An in-hand scan's photos and depth (HandheldCapture.swift): the Mac rebuilds the model, then touches it up.
    func sendHandheld(_ id: String) async throws -> StmObject {
        try await start(id, captureManifest: try await uploadHandheld(id))
    }

    func uploadHandheld(_ id: String) async throws -> [String: Any] {
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
        return ["version": 1, "images": names, "depthRequired": depthRequired]
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
