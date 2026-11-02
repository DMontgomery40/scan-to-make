import Foundation
import Combine
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

/// What the objects window needs from the companion: local-control's `objects.*` methods.
protocol ObjectsCompanion: Sendable {
    func printers() async throws -> PrinterCatalog
    func filaments(_ id: String) async throws -> [PrinterFilament]
    func print(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> Project
    func passActivity(_ id: String, index: Int) async throws -> [Project.Activity]
    func selectPrinter(_ id: String, destinationId: String) async throws -> Project
    func objects() async throws -> [Project]
    func correct(_ id: String, note: String) async throws -> Project
    func correct(_ id: String, note: String, photoNames: [String]) async throws -> Project
    func correct(_ id: String, note: String, photos: [String], photoNames: [String]) async throws -> Project
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> Project
    func print(_ id: String, checked: Bool) async throws -> Project
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> Project
    func start(_ id: String) async throws -> Project
    func delete(_ id: String) async throws
    /// What the companion can do (capability flags) and the phones paired with it, for the footer and gating.
    func status() async throws -> ControlStatus
    func devices() async throws -> [ControlDevice]
    /// The AI that does the work ("Claude Code"), nil when none is chosen or it can't be read.
    func aiProvider() async -> String?
    func create(instructions: String?, kind: String?) async throws -> Project
    func addFile(_ id: String, kind: String, path: String) async throws -> Project
    func addPhotoFile(_ id: String, path: String, forMessage: Bool) async throws -> String
    func correct(_ id: String, note: String, photos: [String]) async throws -> Project
    func print(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate
    func control(_ id: String, _ action: PrintControl) async throws -> Project
    /// PRD §8.11: the objects with what a published model adds (credit, files, the Ask's type).
    func objectsWithExtras() async throws -> (projects: [Project], extras: [String: PublishedExtras])
    func answerAsk(_ id: String, askId: String, choices: [String]) async throws -> Project
    func createPublished(url: String, instructions: String?) async throws -> Project
    /// Project Settings (PRD §5.4): `status` or `archived`.
    func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project
}

extension ObjectsCompanion {
    func correct(_ id: String, note: String, photos: [String], photoNames: [String]) async throws -> Project { try await correct(id, note: note, photos: photos) }
    func correct(_ id: String, note: String, photoNames: [String]) async throws -> Project { try await correct(id, note: note) }
    func filaments(_ id: String) async throws -> [PrinterFilament] { throw ControlClientError.unavailable }
    func print(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> Project { throw ControlClientError.unavailable }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> Project { throw ControlClientError.unavailable }
    func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] { throw ControlClientError.unavailable }
    func printers() async throws -> PrinterCatalog { throw ControlClientError.unavailable }
    func selectPrinter(_ id: String, destinationId: String) async throws -> Project { throw ControlClientError.unavailable }
    func status() async throws -> ControlStatus { throw ControlClientError.unavailable }
    func devices() async throws -> [ControlDevice] { throw ControlClientError.unavailable }
    func aiProvider() async -> String? { nil }
    func create(instructions: String?, kind: String?) async throws -> Project { throw ControlClientError.unavailable }
    func addFile(_ id: String, kind: String, path: String) async throws -> Project { throw ControlClientError.unavailable }
    func addPhotoFile(_ id: String, path: String, forMessage: Bool) async throws -> String { throw ControlClientError.unavailable }
    func correct(_ id: String, note: String, photos: [String]) async throws -> Project {
        guard photos.isEmpty else { throw ControlClientError.unavailable }
        return try await correct(id, note: note)
    }
    func print(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project { throw ControlClientError.unavailable }
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        throw ControlClientError.unavailable
    }
    func control(_ id: String, _ action: PrintControl) async throws -> Project { throw ControlClientError.unavailable }
    func objectsWithExtras() async throws -> (projects: [Project], extras: [String: PublishedExtras]) { (try await objects(), [:]) }
    func answerAsk(_ id: String, askId: String, choices: [String]) async throws -> Project { throw ControlClientError.unavailable }
    func createPublished(url: String, instructions: String?) async throws -> Project { throw ControlClientError.unavailable }
    func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project { throw ControlClientError.unavailable }
}

/// The control socket. A fresh client per call, so a missing socket fails that call, not the model.
struct SocketObjects: ObjectsCompanion {
    let path: String
    func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] { try await ControlClient(socketPath:path).passActivity(id, index:index) }
    func printers() async throws -> PrinterCatalog { try await ControlClient(socketPath:path).printers() }
    func filaments(_ id: String) async throws -> [PrinterFilament] { try await ControlClient(socketPath:path, timeout:30).filaments(id) }
    func print(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> Project { try await ControlClient(socketPath:path, timeout:30).printObject(id, checked:checked, filament:filament) }
    func selectPrinter(_ id: String, destinationId: String) async throws -> Project { try await ControlClient(socketPath:path).selectPrinter(id, destinationId:destinationId) }
    func objects() async throws -> [Project] { try await ControlClient(socketPath:path).objects() }
    func objectsWithExtras() async throws -> (projects: [Project], extras: [String: PublishedExtras]) {
        try await ControlClient(socketPath:path).objectsAndExtras()
    }
    func answerAsk(_ id: String, askId: String, choices: [String]) async throws -> Project {
        try await ControlClient(socketPath:path).answerAsk(id, askId:askId, choices:choices)
    }
    func createPublished(url: String, instructions: String?) async throws -> Project {
        try await ControlClient(socketPath:path).createPublished(url:url, instructions:instructions)
    }
    func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project {
        try await ControlClient(socketPath:path).setProjectSettings(id, patch)
    }
    func correct(_ id: String, note: String, photos: [String], photoNames: [String]) async throws -> Project {
        try await ControlClient(socketPath: path, timeout: 30).correctObject(id, note: note, photos: photos, photoNames: photoNames)
    }
    func correct(_ id: String, note: String, photoNames: [String]) async throws -> Project {
        try await ControlClient(socketPath: path, timeout: 30).correctObject(id, note: note, photoNames: photoNames)
    }
    func correct(_ id: String, note: String) async throws -> Project { try await ControlClient(socketPath:path, timeout:30).correctObject(id, note:note) }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> Project { try await ControlClient(socketPath:path).answerCloseup(id, bestGuess:bestGuess) }
    func print(_ id: String, checked: Bool) async throws -> Project { try await ControlClient(socketPath:path).printObject(id, checked:checked) }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> Project {
        try await ControlClient(socketPath:path).answerPrintConfirmation(id, confirmationId:confirmationId, answer:answer)
    }
    func start(_ id: String) async throws -> Project { try await ControlClient(socketPath:path).startObject(id) }
    func delete(_ id: String) async throws { try await ControlClient(socketPath:path).deleteObject(id) }
    func status() async throws -> ControlStatus { try await ControlClient(socketPath:path).status() }
    func devices() async throws -> [ControlDevice] { try await ControlClient(socketPath:path).devices() }
    func aiProvider() async -> String? {
        guard let snapshot = try? await ControlClient(socketPath:path).modelAccess(), snapshot.choice != .none else { return nil }
        return snapshot.choice.providerName
    }
    func create(instructions: String?, kind: String?) async throws -> Project {
        try await ControlClient(socketPath:path).createObject(instructions:instructions, kind:kind)
    }
    func addPhotoFile(_ id: String, path file: String, forMessage: Bool) async throws -> String {
        try await ControlClient(socketPath: path, timeout: 30).addPhotoFile(id, path: file, forMessage: forMessage)
    }
    func addFile(_ id: String, kind: String, path file: String) async throws -> Project {
        try await ControlClient(socketPath:path, timeout:30).addFile(id, kind:kind, path:file)
    }
    func correct(_ id: String, note: String, photos: [String]) async throws -> Project {
        try await ControlClient(socketPath:path, timeout:30).correctObject(id, note:note, photos:photos)
    }
    func print(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project {
        try await ControlClient(socketPath:path, timeout:30).printObject(id, checked:checked, settings:settings)
    }
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        try await ControlClient(socketPath:path, timeout:ControlClient.timeout(for:"objects.estimate")).estimate(id, destinationId:destinationId, quality:quality, strength:strength)
    }
    func control(_ id: String, _ action: PrintControl) async throws -> Project {
        try await ControlClient(socketPath:path, timeout:ControlClient.timeout(for:action.method)).controlPrint(id, action)
    }
}

/// The objects window's list and the object it shows (spec §5.1, §5.6). It reads the list only while the
/// window is on screen: every 3 s while something is busy, and every 15 s otherwise so a new scan from
/// the phone still shows up. Opening or focusing the window reads it at once.
@MainActor final class ObjectsModel: ObservableObject {
    enum Availability: Equatable {
        case loading, ready
        /// The companion refused the list: objects aren't set up on this Mac (or it predates them).
        case notSetUp
        /// The companion hasn't answered for a while.
        case notRunning
    }
    /// One sentence about an action that didn't go through, shown on that object's page.
    struct Problem: Equatable { let id: String, text: String }

    static let busyDelay: Double = 3, idleDelay: Double = 15

    @Published private(set) var objects: [Project] = []
    @Published private(set) var printerCatalog: PrinterCatalog?
    /// What this Mac's companion can do; nil until it answers. Features it lacks show why instead of failing.
    @Published private(set) var capabilities: ControlStatus.Capabilities?
    @Published private(set) var devices: [ControlDevice] = []
    /// PRD §8.11, by project id: the designer's credit, the files, and the Ask's type.
    @Published private(set) var extras: [String: PublishedExtras] = [:]
    @Published private(set) var aiProvider: String?
    @Published private(set) var availability = Availability.loading
    @Published var selection: String?
    @Published private(set) var working: Set<String> = []
    @Published private(set) var problem: Problem?
    @Published private(set) var corrections: CorrectionQueue {
        didSet { defaults.set(corrections.saved, forKey: "CounterpartQueuedNotes") }
    }
    private let defaults: UserDefaults
    private var correcting: Set<String> = []
    private let companion: any ObjectsCompanion
    private var loop: Task<Void, Never>?
    private var failures = 0
    /// Reads are numbered as they start; a reply older than one already applied is dropped, so a slow read can never
    /// put back a state the project has left (a "Ready to print" shown through a whole pass).
    private var readsStarted = 0
    private var readApplied = 0
    private var extrasReadAt: Date?
    private var loadedOnce = false
    /// New Project is open in the window: nothing is selected on purpose.
    var composing = false
    /// How often the footer's phone and AI, and the capability flags, are read again.
    static let extrasDelay: Double = 30

    init(companion: any ObjectsCompanion, defaults: UserDefaults = .standard) {
        self.companion = companion; self.defaults = defaults
        self.corrections = CorrectionQueue(saved: defaults.dictionary(forKey: "CounterpartQueuedNotes"))
    }

    var selected: Project? { objects.first { $0.id == selection } }

    /// The sidebar (PRD §7.2): Now, Needs you, Ready, Printed, each newest first. Empty groups are left out.
    var groups: [(group: ProjectGroup, objects: [Project])] {
        // An archived project leaves its group for Archived, whatever its status (which Unarchive restores).
        let words = Dictionary(uniqueKeysWithValues:objects.map { ($0.id, extras[$0.id]?.archived == true ? .archived : $0.words.group) })
        return ProjectGroup.allCases.compactMap { group in
            let members = objects.filter { words[$0.id] == group }
            return members.isEmpty ? nil : (group, members)
        }
    }
    /// In sidebar order.
    var ordered: [Project] { groups.flatMap(\.objects) }

    /// The phone people know, for the footer: the most recently seen paired device, one row per name.
    /// The phone heard from most recently; a pairing from before stable identity is never the one shown.
    var latestDevice: ControlDevice? { devices.filter { $0.legacy != true }.max { $0.seenAt < $1.seenAt } }
    var isPolling: Bool { loop != nil }

    func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] {
        try await companion.passActivity(id, index:index)
    }

    func filaments(_ id: String) async throws -> [PrinterFilament] { try await companion.filaments(id) }

    @discardableResult func print(_ id: String, checked: Bool, filament: PrinterFilament) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        problem = nil
        do {
            let updated = try await companion.print(id, checked:checked, filament:filament)
            applyReply(updated)
            wake()
            return true
        } catch {
            await refresh()
            problem = Problem(id:id, text:Self.sentence(for:error))
            return false
        }
    }

    /// The project's chosen printer; the default one when it chose none or its choice is no longer configured.
    /// Prints with the sheet's settings when the companion takes them, else with the chosen filament as before.
    @discardableResult func print(_ id: String, checked: Bool, settings: PrintSettings, filament: PrinterFilament?) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        problem = nil
        do {
            let updated: Project
            if capabilities?.printSettings == true { updated = try await companion.print(id, checked:checked, settings:settings) }
            else if let filament { updated = try await companion.print(id, checked:checked, filament:filament) }
            else { updated = try await companion.print(id, checked:checked) }
            applyReply(updated)
            wake()
            return true
        } catch {
            await refresh()
            problem = Problem(id:id, text:Self.sentence(for:error))
            return false
        }
    }

    /// The slice estimate for the sheet; nil when the companion can't give one (the sheet says so).
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        try await companion.estimate(id, destinationId:destinationId, quality:quality, strength:strength)
    }

    /// Pause, resume or stop a print (`capabilities.printControl`). The printer MCP may ask its own confirmation first.
    @discardableResult func control(_ id: String, _ action: PrintControl) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated = try await companion.control(id, action)
            applyReply(updated)
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            await refresh()
            return false
        }
    }

    func printer(for object: Project) -> PrinterDestination? {
        guard let catalog = printerCatalog else { return nil }
        return catalog.destinations.first { $0.id == object.printerDestinationId }
            ?? catalog.destinations.first { $0.id == catalog.defaultDestinationId }
            ?? catalog.destinations.first
    }
    func selectPrinter(_ id: String, destinationId: String) async {
        guard !working.contains(id) else { return }
        working.insert(id)
        defer { working.remove(id) }
        do {
            let updated = try await companion.selectPrinter(id, destinationId:destinationId)
            applyReply(updated)
            problem = nil
        } catch { problem = Problem(id:id, text:Self.sentence(for:error)) }
    }

    /// Reads the list once and returns the seconds until the next read.
    /// An action's reply is the newest word on its project: a read that started before it is dropped.
    private func applyReply(_ updated: Project) {
        readApplied = startRead()
        if let index = objects.firstIndex(where: { $0.id == updated.id }) { objects[index] = updated }
    }

    /// The number of a read about to start: `apply(read:…)` takes its reply.
    func startRead() -> Int { readsStarted += 1; return readsStarted }

    /// One read's projects, unless a newer read (or an action's reply) was applied first. Returns whether it was.
    @discardableResult func apply(read: Int, _ list: [Project], _ extras: [String: PublishedExtras]) -> Bool {
        guard read > readApplied else { return false }
        readApplied = read
        // Published only when something changed: an unchanged read redraws nothing (PRD §9.6).
        if objects != list { objects = list }
        if self.extras != extras { self.extras = extras }
        return true
    }

    @discardableResult func refresh() async -> Double {
        do {
            let read = startRead()
            let (fetched, extras) = try await companion.objectsWithExtras()
            failures = 0
            // A newer read may already be shown (the event relay's): this one's list is dropped, the rest still runs.
            if apply(read: read, fetched, extras) {
                DownloadsWatcher.shared.follow(extras, titles: Dictionary(uniqueKeysWithValues: fetched.map { ($0.id, $0.words.title) }))
            }
            for project in objects { sendQueuedNote(project) }
            let list = objects
            let catalog = try? await companion.printers()
            if printerCatalog != catalog { printerCatalog = catalog }
            if availability != .ready { availability = .ready }
            // The first read shows the top project; later, only a project that went away moves the selection.
            // Nothing selected on purpose (New Project is open) stays that way.
            if let current = selection, !list.contains(where: { $0.id == current }) { selection = ordered.first?.id }
            else if selection == nil && !loadedOnce && !composing { selection = ordered.first?.id }
            loadedOnce = true
            await readExtrasIfDue()
            if let problem, !list.contains(where: { $0.id == problem.id }) { self.problem = nil }
            return list.contains { $0.words.busy } ? Self.busyDelay : Self.idleDelay
        } catch is ControlRemoteError {
            // The companion answered and refused: `unavailable` when objects aren't set up here, or
            // `invalid-request` from a companion that predates objects. Either way it is running.
            failures = 0
            objects = []
            availability = .notSetUp
            return Self.idleDelay
        } catch {
            // The companion may be starting or restarting: keep what's shown for a few tries.
            failures += 1
            if failures >= 3 { availability = .notRunning }
            return Self.busyDelay
        }
    }

    private func readExtrasIfDue() async {
        if let extrasReadAt, Date().timeIntervalSince(extrasReadAt) < Self.extrasDelay { return }
        extrasReadAt = Date()
        if let status = try? await companion.status(), capabilities != status.capabilities { capabilities = status.capabilities }
        if let devices = try? await companion.devices(), devices.map(\.id) != self.devices.map(\.id) || devices.map(\.seenAt) != self.devices.map(\.seenAt) { self.devices = devices }
        aiProvider = await companion.aiProvider()
    }

    /// Starts a project on this Mac (PRD §7.2): the request, then each dropped file, then the pass. Photos
    /// (JPEG, HEIC, PNG) go in as photos; STL, 3MF and USDZ as the thing to copy. Returns one sentence when it
    /// didn't go through; the project is selected when it did.
    func startProject(instructions: String, files: [URL], kind: String = "fit", url: String? = nil) async -> String? {
        guard capabilities?.objectsCreate == true else { return Self.createUnavailable }
        let text = String(instructions.trimmingCharacters(in:.whitespacesAndNewlines).prefix(4000))
        guard !text.isEmpty || !files.isEmpty || url != nil else { return "Say what you need, or drop a photo or a model." }
        do {
            // A model page's link (PRD §8.11): the companion reads the page and gets the designer's own file.
            var object = try await (url != nil && capabilities?.publishedModels == true
                ? companion.createPublished(url:url!, instructions:text.isEmpty ? nil : text)
                : companion.create(instructions:[url, text.isEmpty ? nil : text].compactMap { $0 }.joined(separator:" ").nilIfEmpty,
                                   kind:capabilities?.structuredPasses == true ? kind : nil))
            let published = url != nil && capabilities?.publishedModels == true
            for file in files {
                guard var kind = Self.fileKind(file) else { continue }
                // A published model's own file is the designer's model, never a scan to touch up (PRD §8.11).
                if published && ["stl", "3mf"].contains(file.pathExtension.lowercased()) { kind = "model" }
                object = try await companion.addFile(object.id, kind:kind, path:file.path)
            }
            object = try await companion.start(object.id)
            readApplied = startRead()
            if let index = objects.firstIndex(where:{ $0.id == object.id }) { objects[index] = object } else { objects.insert(object, at:0) }
            selection = object.id
            wake()
            return nil
        } catch {
            await refresh()
            return Self.sentence(for:error)
        }
    }

    static let createUnavailable = "Start new projects on your iPhone for now. This Mac can start them after Counterpart's next update."

    /// `photos` or `scan`, from the file's type; nil for anything Counterpart can't use.
    nonisolated static func fileKind(_ url: URL) -> String? {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg", "heic", "heif", "png": return "photos"
        case "stl", "3mf", "usdz": return "scan"
        default: return nil
        }
    }

    /// The window is on screen (true) or closed, hidden or covered (false).
    func setVisible(_ visible: Bool) { setWatching(visible, by:"window") }

    private var watchers: Set<String> = []
    /// Reads keep going while anything shows the projects: the window, or the menu bar popover.
    func setWatching(_ watching: Bool, by watcher: String) {
        if watching { watchers.insert(watcher) } else { watchers.remove(watcher) }
        if watchers.isEmpty { loop?.cancel(); loop = nil; return }
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.refresh() else { return }
                try? await Task.sleep(for:.seconds(delay))
            }
        }
    }

    /// Read now and restart the cadence, e.g. when the window becomes key or after an action.
    func wake() {
        guard loop != nil else { return }
        loop?.cancel(); loop = nil
        let watching = watchers
        watchers = []
        for watcher in watching { setWatching(true, by:watcher) }
    }

    /// Runs one action on one object. Returns whether it went through.
    /// Answers a published model's `file` Ask with the designer's file (PRD §8.11): the companion copies it and resumes.
    @discardableResult func useModelFile(_ file: URL, for id: String) async -> Bool {
        await change(id) { try await self.companion.addFile(id, kind:"model", path:file.path) }
    }

    /// Project Settings' Status (PRD §5.4): `not-printed`, `printed`, `works` (Done), `needs-changes`.
    @discardableResult func setStatus(_ status: String, for id: String) async -> Bool {
        guard capabilities?.projectSettings == true else { return false }
        let pending = objects.first(where: { $0.id == id })?.pendingFollowup
        let done = await change(id) { try await self.companion.setProjectSettings(id, ["status": .string(status)]) }
        if done, status == "works", let pending { corrections.sent(pending, for: id) }
        if done { await refresh() } // the settings the sidebar and "Did it fit?" read
        return done
    }
    @discardableResult func rename(_ id: String, title: String) async -> Bool {
        guard capabilities?.projectRename == true else { return false }
        return await change(id) { try await self.companion.setProjectSettings(id, ["title": .string(title)]) }
    }
    /// Archive hides a project from the sidebar's groups and keeps everything; Unarchive brings its status back.
    @discardableResult func setArchived(_ archived: Bool, for id: String) async -> Bool {
        guard capabilities?.projectSettings == true else { return false }
        let done = await change(id) { try await self.companion.setProjectSettings(id, ["archived": .bool(archived)]) }
        if done { await refresh() }
        return done
    }

    /// Answers a `choice` Ask (plates, objects, colours) with the options picked.
    @discardableResult func answerAsk(_ id: String, askId: String, choices: [String]) async -> Bool {
        guard !choices.isEmpty else { return false }
        return await change(id) { try await self.companion.answerAsk(id, askId:askId, choices:choices) }
    }

    /// One change to one project, shown as working while it runs; a refusal reads the project again.
    private func change(_ id: String, _ body: @escaping () async throws -> Project) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated = try await body()
            applyReply(updated)
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            await refresh()
            return false
        }
    }

    /// Copy evidence to the companion now, so a queued correction survives closing either app.
    @discardableResult func requestChanges(_ id: String, note: String, photos: [URL] = []) async -> Bool {
        guard let project = objects.first(where: { $0.id == id }), project.canAskForChanges, !working.contains(id) else { return false }
        if !project.changesWait { return await perform(.correct, on: id, note: note, photos: photos) }
        working.insert(id)
        defer {
            working.remove(id)
            if let current = objects.first(where: { $0.id == id }) { sendQueuedNote(current) }
        }
        return await queueChanges(id, note: note, photos: photos)
    }

    private func queueChanges(_ id: String, note: String, photos: [URL]) async -> Bool {
        do {
            var uploaded: [String] = []
            for photo in photos { uploaded.append(try await companion.addPhotoFile(id, path: photo.path, forMessage: true)) }
            let available = photos.isEmpty ? objects.first(where: { $0.id == id }).flatMap { corrections.availablePhotos($0) } : uploaded
            corrections.add(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "See the photos I added." : note, for: id, photos: available)
            if let project = objects.first(where: { $0.id == id }) { sendQueuedNote(project) }
            return true
        } catch { problem = Problem(id: id, text: Self.sentence(for: error)); return false }
    }

    private func sendQueuedNote(_ project: Project) {
        guard let note = corrections.due(project), !correcting.contains(project.id), !working.contains(project.id), project.pendingFollowup == nil else { return }
        correcting.insert(project.id)
        Task {
            defer { correcting.remove(project.id) }
            do {
                let updated: Project
                if capabilities?.messagePhotos == true, let photos = corrections.messages[project.id]?.first?.photos {
                    updated = try await companion.correct(project.id, note: note, photoNames: photos)
                } else { updated = try await companion.correct(project.id, note: note) }
                corrections.sent(note, for: project.id)
                applyReply(updated)
                correcting.remove(project.id)
                sendQueuedNote(updated)
                wake()
            } catch let failure as ControlRemoteError where failure.code == "conflict" && failure.message == "Wait until the current step finishes." {
                // Another device got there first. Keep the note for the next end of step.
            } catch {
                let message = Self.sentence(for: error)
                corrections.fail(project.id, message: message)
                problem = Problem(id: project.id, text: message)
            }
        }
    }

    func retryQueuedChange(_ project: Project) {
        corrections.retry(project.id)
        if problem?.id == project.id { problem = nil }
        sendQueuedNote(project)
    }
    func discardQueuedChange(_ project: Project) {
        if let note = corrections.entries[project.id]?.first { corrections.sent(note, for: project.id) }
        if problem?.id == project.id { problem = nil }
        sendQueuedNote(project)
    }

    @discardableResult func perform(_ action: ObjectAction, on id: String, note: String = "", photos: [URL] = []) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated: Project
            switch action {
            case .print: updated = try await companion.print(id, checked:false)
            case .printChecked: updated = try await companion.print(id, checked:true)
            case .correct:
                let text = note.trimmingCharacters(in:.whitespacesAndNewlines)
                // A held-message retry lets the companion retain its recorded evidence. Pending photos may belong to a later message.
                if capabilities?.messagePhotos == true, let project = objects.first(where: { $0.id == id }), project.pendingFollowup != text {
                    updated = try await companion.correct(id, note: text.isEmpty ? "See the photos I added." : text,
                        photos: photos.map(\.path), photoNames: corrections.availablePhotos(project) ?? [])
                } else {
                    updated = photos.isEmpty ? try await companion.correct(id, note:text)
                        : try await companion.correct(id, note:text.isEmpty ? "See the photos I added." : text, photos:photos.map(\.path))
                }
            case .bestGuess: updated = try await companion.answerCloseup(id, bestGuess:true)
            case .retry: updated = try await companion.start(id)
            }
            if action == .correct { corrections.sent(note.trimmingCharacters(in: .whitespacesAndNewlines), for: id) }
            applyReply(updated)
            wake()
            return true
        } catch let failure as ControlRemoteError where action == .correct && failure.code == "conflict" && failure.message == "Wait until the current step finishes." {
            return await queueChanges(id, note: note, photos: photos)
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            // A refusal usually means the object moved on (another device, or a finished step): show where it is now.
            await refresh()
            return false
        }
    }

    @discardableResult func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async -> Bool {
        guard !working.contains(id) else { return false }
        guard let question = objects.first(where:{ $0.id == id })?.printConfirmation, question.id == confirmationId else {
            problem = Problem(id:id, text:"That print confirmation has changed. Review the current request.")
            return false
        }
        // The shared checks, last before sending: never an accept that skips a required field, answers an expired
        // question, or one this Mac can't show.
        if answer.action == .accept, !question.canAccept(answer.content ?? [:], atMs: Date().timeIntervalSince1970 * 1000) {
            problem = Problem(id:id, text:"Complete the required checks before confirming this print. The request may have expired.")
            return false
        }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            let updated = try await companion.answerPrintConfirmation(id, confirmationId:confirmationId, answer:answer)
            applyReply(updated)
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            await refresh()
            return false
        }
    }

    /// Deletes one object from this Mac. The page moves to the next object (or the one before the last).
    /// Returns whether it went through; if not, the object stays and its page says why.
    @discardableResult func delete(_ id: String) async -> Bool {
        guard !working.contains(id) else { return false }
        working.insert(id)
        defer { working.remove(id) }
        if problem?.id == id { problem = nil }
        do {
            try await companion.delete(id)
            corrections.remove(id)
            if let index = objects.firstIndex(where: { $0.id == id }) {
                objects.remove(at:index)
                if selection == id { selection = objects.isEmpty ? nil : objects[min(index, objects.count - 1)].id }
            }
            wake()
            return true
        } catch {
            problem = Problem(id:id, text:Self.sentence(for:error))
            return false
        }
    }

    /// One plain sentence for an action that didn't go through.
    nonisolated static func sentence(for error: Error) -> String {
        switch (error as? ControlRemoteError)?.code {
        case "conflict"?:
            // A current Mac sends its own plain sentence ("There is no model to print yet.").
            let message = (error as? ControlRemoteError)?.message ?? ""
            return message.isEmpty || message.hasPrefix("The requested operation") ? "That can't be done right now." : message
        case "not-found"?: return "This one is no longer on your Mac."
        case .some: return "Something went wrong on your Mac."
        case nil: break
        }
        switch error as? ControlClientError {
        case .timedOut?: return "That's taking longer than usual. This page will update when it's done."
        case .unavailable?: return "Counterpart couldn’t start in the background."
        default: return "Something went wrong on your Mac."
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// PRD §5.4: after printing, "Did it fit?" It works marks the project Done (`status: works`); Needs changes starts Ask
/// for changes with "After printing: " and keeps the print history. Asked once per print: an answer, or Not Now, ends
/// it until the next print finishes.
enum DidItFit {
    /// This project's last print.
    static func key(_ object: Project) -> String { "fit.dismissed.\(object.id).\(object.print?.printId ?? object.print?.bundleId ?? "")" }
    /// Whether to ask: not once it's answered (Needs changes is the answer the companion keeps) or set aside.
    static func asks(_ object: Project, _ extras: PublishedExtras?, defaults: UserDefaults = .standard) -> Bool {
        extras?.status != "needs-changes" && !defaults.bool(forKey: key(object))
    }
    static func dismiss(_ object: Project, defaults: UserDefaults = .standard) { defaults.set(true, forKey: key(object)) }
}
