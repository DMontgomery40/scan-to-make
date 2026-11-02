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
    func correct(_ id: String, note: String, photos: [String]) async throws -> Project
    func print(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate
    func control(_ id: String, _ action: PrintControl) async throws -> Project
}

extension ObjectsCompanion {
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
    func correct(_ id: String, note: String, photos: [String]) async throws -> Project {
        guard photos.isEmpty else { throw ControlClientError.unavailable }
        return try await correct(id, note: note)
    }
    func print(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project { throw ControlClientError.unavailable }
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        throw ControlClientError.unavailable
    }
    func control(_ id: String, _ action: PrintControl) async throws -> Project { throw ControlClientError.unavailable }
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
    func correct(_ id: String, note: String) async throws -> Project { try await ControlClient(socketPath:path).correctObject(id, note:note) }
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
    @Published private(set) var aiProvider: String?
    @Published private(set) var availability = Availability.loading
    @Published var selection: String?
    @Published private(set) var working: Set<String> = []
    @Published private(set) var problem: Problem?
    private let companion: any ObjectsCompanion
    private var loop: Task<Void, Never>?
    private var failures = 0
    private var extrasReadAt: Date?
    private var loadedOnce = false
    /// New Project is open in the window: nothing is selected on purpose.
    var composing = false
    /// How often the footer's phone and AI, and the capability flags, are read again.
    static let extrasDelay: Double = 30

    init(companion: any ObjectsCompanion) { self.companion = companion }

    var selected: Project? { objects.first { $0.id == selection } }

    /// The sidebar (PRD §7.2): Now, Needs you, Ready, Printed, each newest first. Empty groups are left out.
    var groups: [(group: ProjectGroup, objects: [Project])] {
        let words = Dictionary(uniqueKeysWithValues:objects.map { ($0.id, $0.words.group) })
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
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
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
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
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
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
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
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
            problem = nil
        } catch { problem = Problem(id:id, text:Self.sentence(for:error)) }
    }

    /// Reads the list once and returns the seconds until the next read.
    @discardableResult func refresh() async -> Double {
        do {
            let list = try await companion.objects()
            failures = 0
            objects = list
            printerCatalog = try? await companion.printers()
            availability = .ready
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
        if let status = try? await companion.status() { capabilities = status.capabilities }
        if let devices = try? await companion.devices() { self.devices = devices }
        aiProvider = await companion.aiProvider()
    }

    /// Starts a project on this Mac (PRD §7.2): the request, then each dropped file, then the pass. Photos
    /// (JPEG, HEIC, PNG) go in as photos; STL, 3MF and USDZ as the thing to copy. Returns one sentence when it
    /// didn't go through; the project is selected when it did.
    func startProject(instructions: String, files: [URL], kind: String = "fit") async -> String? {
        guard capabilities?.objectsCreate == true else { return Self.createUnavailable }
        let text = String(instructions.trimmingCharacters(in:.whitespacesAndNewlines).prefix(4000))
        guard !text.isEmpty || !files.isEmpty else { return "Say what you need, or drop a photo or a model." }
        do {
            var object = try await companion.create(instructions:text.isEmpty ? nil : text,
                                                    kind:capabilities?.structuredPasses == true ? kind : nil)
            for file in files {
                guard let kind = Self.fileKind(file) else { continue }
                object = try await companion.addFile(object.id, kind:kind, path:file.path)
            }
            object = try await companion.start(object.id)
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
                let text = String(note.trimmingCharacters(in:.whitespacesAndNewlines).prefix(4000))
                updated = photos.isEmpty ? try await companion.correct(id, note:text)
                    : try await companion.correct(id, note:text.isEmpty ? "See the photos I added." : text, photos:photos.map(\.path))
            case .bestGuess: updated = try await companion.answerCloseup(id, bestGuess:true)
            case .retry: updated = try await companion.start(id)
            }
            if let index = objects.firstIndex(where: { $0.id == id }) { objects[index] = updated }
            wake()
            return true
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
            if let index = objects.firstIndex(where:{ $0.id == id }) { objects[index] = updated }
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
