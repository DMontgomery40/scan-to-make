import SwiftUI
import CounterpartKit

/// The projects and printers the paired Mac has, kept current while they're on screen: the event long poll
/// when the Mac serves it (PRD §8.7), and a refresh every few seconds while anything runs otherwise.
@MainActor @Observable final class ProjectsStore {
    let mac: MacConnection
    let pairingClient: PairingClient
    var projects: [Project] = []
    var loaded = false
    var error: CompanionError?
    var catalog: PrinterCatalog?
    var printerProblem: String?
    /// The Mac answered the last request (nil until one has).
    var reachable: Bool?
    var canScan = false
    /// Projects this phone is still sending files to: they show "Sending to your Mac".
    var sending: Set<String> = []
    /// Why a send stopped, until it's tried again.
    var sendFailures: [String: String] = [:]
    /// Changes asked for while the Mac was working, sent when its pass ends (kept across launches).
    var corrections = CorrectionQueue(saved: UserDefaults.standard.dictionary(forKey: "CounterpartQueuedNotes")) {
        didSet { UserDefaults.standard.set(corrections.saved, forKey: "CounterpartQueuedNotes") }
    }
    /// The companion's capability flags (`genericConfirmations` means the Mac can answer any printer question).
    var macCapabilities: Set<String> = []
    /// Bumped by `settings.changed`: Settings reads again.
    var settingsChanges = 0
    /// What each printer MCP's update is doing, from `mcp.update.*` events and the Update reply.
    var mcpCopies: [MCPPackageCopies]?
    var mcpCopiesProblem: String?
    var mcpUpdates: [String: MCPUpdateProgress] = [:]
    /// What each printer last reported loaded, from a print sheet (the Mac reports spools per project).
    var spools: [String: [PrinterFilament]] = [:]
    /// The Mac serves `/v1/events`; false after it answered "not supported".
    var events: Bool?
    var onPair: () -> Void = {}

    init(mac: MacConnection, pairing: PairingClient) { self.mac = mac; self.pairingClient = pairing }

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    func words(_ project: Project) -> ProjectWords {
        ProjectWords(project, sending: sending.contains(project.id), printerName: printerName(project))
    }

    /// Spools for the printers, read fresh each time (spools get swapped): the Mac reports them for a project's
    /// printer, so ask through a project that uses each one. A printer no project uses yet shows its spools
    /// after its first print sheet.
    func loadSpools() async {
        for destination in catalog?.destinations ?? [] where destination.capabilities?.filaments != "none" {
            guard let project = projects.first(where: { ($0.printerDestinationId ?? catalog?.defaultDestinationId) == destination.id }) else { continue }
            if let reported = try? await mac.filaments(project.id), !reported.isEmpty { spools[destination.id] = reported }
        }
    }

    /// The project printing (or getting ready) on this printer, if any.
    func printing(on destinationId: String) -> Project? {
        projects.first { ($0.print?.destinationId ?? $0.print?.destination?.id ?? $0.printerDestinationId) == destinationId
            && [.printing, .preparing].contains(words($0).phase) }
    }

    func printerName(_ project: Project) -> String? {
        project.print?.destination?.name ?? catalog?.destination(project.printerDestinationId)?.name
    }

    var anyRunning: Bool { projects.contains { words($0).busy } || !sending.isEmpty }

    private var reads = ProjectReads()

    // MARK: Reading

    func load() async {
        let ticket = reads.start()
        do {
            let latest = try await mac.list()
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return }
            projects = reads.merge(latest, ticket: ticket, current: projects); error = nil; reachable = true
            for project in projects where corrections.pending(project.id) != nil { sendQueuedNote(project) }
        } catch let failure as CompanionError {
            guard !Task.isCancelled, reads.isCurrent(ticket), failure.code != "cancelled" else { return }
            error = failure
            if failure.isUnreachable { reachable = false }
        } catch { if !Task.isCancelled, reads.isCurrent(ticket) { self.error = .unreachable; reachable = false } }
        guard !Task.isCancelled, reads.isCurrent(ticket) else { return }
        loaded = true
    }

    @discardableResult func reload(_ id: String) async -> CompanionError? {
        let ticket = reads.start()
        do {
            let latest = try await mac.get(id)
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return .cancelled }
            reachable = true
            if error?.isUnreachable == true { error = nil }
            if reads.accept(id, ticket: ticket) { show(latest) }
            return nil
        } catch {
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return .cancelled }
            let failure = error as? CompanionError ?? .unreachable
            if failure.isUnreachable { reachable = false; self.error = failure }
            if failure.code == "not-found" {
                guard reads.accept(id, ticket: ticket) else { return .cancelled }
                reachable = true
                if self.error?.isUnreachable == true { self.error = nil }
                remove(id)
            }
            return failure
        }
    }

    /// A deletion has no project left to fetch. Tombstone it so an older reply cannot restore it.
    func receive(_ event: CounterpartEvent) async {
        if let project = event.projectId {
            if event.type == "project.deleted" { remove(project) }
            else { await reload(project) }
        } else if event.type.hasPrefix("mcp.update.") {
            if let id = event.data?.mcpId { mcpUpdates[id] = MCPUpdateProgress(event) }
            await loadPrinters()
            await loadMCPCopies()
        } else if event.type == "settings.changed" { settingsChanges += 1 }
    }

    /// The Mac keeps Project Settings (PRD §5.4): status, Did it fit?, Done.
    var projectSettings: Bool { macCapabilities.contains("projectSettings") }
    var projectRename: Bool { macCapabilities.contains("projectRename") }

    /// Hide from Home, or show again. A Mac whose settings carry `archived` keeps the status exactly; an older one
    /// gets back the status that was under it.
    func archive(_ project: Project, _ archived: Bool) async throws -> Project? {
        if project.settings?.archived != nil { return try await mac.client.setArchived(project.id, archived) }
        return try await mac.client.setStatus(project.id, archived ? .archived : project.statusUnderneath)
    }

    func loadCapabilities() async {
        guard let health = try? await mac.client.health() else { return }
        macCapabilities = health.capabilities
        // The Mac's real name ("Mac mini"), when it says so: a pairing link doesn't always carry it.
        if let name = health.name, name != macName { UserDefaults.standard.set(name, forKey: Self.macNameKey); macNameChanges += 1 }
    }
    /// Bumped when the Mac's name is learned, so views reading `macName` refresh.
    var macNameChanges = 0

    func loadPrinters() async {
        do {
            let latest = try await mac.printers()
            guard !Task.isCancelled else { return }
            catalog = latest; printerProblem = nil
            // Choosing another MCP can change the canonical printer ID used by copy rows.
            await loadMCPCopies()
        } catch {
            guard !Task.isCancelled else { return }
            if catalog == nil { printerProblem = "Couldn't read the printers configured on your Mac." }
        }
    }

    func loadMCPCopies() async {
        guard macCapabilities.contains("mcpCopies") else { mcpCopies = nil; return }
        let ticket = startRequest()
        do {
            let copies = try await mac.client.mcpCopies()
            guard requestIsCurrent(ticket) else { return }
            mcpCopies = copies; mcpCopiesProblem = nil
        } catch {
            guard requestIsCurrent(ticket) else { return }
            mcpCopiesProblem = "Couldn’t refresh the printer software copies."
        }
    }

    func startRequest() -> Int { reads.start() }

    /// Resetting the connection invalidates commands; accepting a newer display snapshot does not.
    func requestIsCurrent(_ ticket: Int) -> Bool { !Task.isCancelled && reads.isCurrent(ticket) }

    /// A refresh can overtake draft creation. Keep its newer state without dropping the requested Send.
    func prepareDraftSend(_ returned: Project, ticket: Int) -> Project? {
        guard requestIsCurrent(ticket) else { return nil }
        replace(returned, ticket: ticket)
        // Either reply can establish that Start already succeeded; never upload that draft again.
        if returned.state != .new { return returned }
        return project(returned.id) ?? returned
    }

    @discardableResult func replace(_ project: Project, ticket: Int) -> Bool {
        guard reads.accept(project.id, ticket: ticket) else { return false }
        show(project)
        return true
    }

    private func show(_ project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project } else { projects.insert(project, at: 0) }
        sendQueuedNote(project)
    }

    func queue(note: String, for id: String) {
        let photos = projects.first(where: { $0.id == id }).flatMap { corrections.availablePhotos($0) }
        corrections.add(note, for: id, photos: photos)
    }

    /// A change asked for during a pass goes in as soon as the Mac can take it.
    private func sendQueuedNote(_ project: Project) {
        guard let note = corrections.due(project), !correcting.contains(project.id), project.pendingFollowup == nil else { return }
        correcting.insert(project.id)
        Task {
            defer { correcting.remove(project.id) }
            do {
                let ticket = startRequest()
                let next = try await mac.correct(project.id, note, photoNames: corrections.messages[project.id]?.first?.photos)
                corrections.sent(note, for: project.id)
                sendFailures[project.id] = nil
                guard replace(next, ticket: ticket) else { return }
                correcting.remove(project.id)
                sendQueuedNote(next)
            } catch let failure as CompanionError where CorrectionQueue.waits(failure) {
                // Another device started a step; keep the saved note until that step ends.
            } catch let failure as CompanionError {
                corrections.fail(project.id, message: failure.message)
                sendFailures[project.id] = failure.message
            } catch {
                corrections.fail(project.id, message: CompanionError.unreachable.message)
                sendFailures[project.id] = CompanionError.unreachable.message
            }
        }
    }
    func retryQueuedChange(_ project: Project) {
        corrections.retry(project.id); sendFailures[project.id] = nil
        sendQueuedNote(project)
    }
    func discardQueuedChange(_ project: Project) {
        if let note = corrections.entries[project.id]?.first { corrections.sent(note, for: project.id) }
        sendFailures[project.id] = nil
        sendQueuedNote(project)
    }
    private var correcting: Set<String> = []
    func remove(_ id: String) { reads.remove(id); corrections.remove(id); projects.removeAll { $0.id == id } }

    /// Clears everything read from the previous Mac.
    func reset() {
        reads.reset()
        projects = []; loaded = false; error = nil; catalog = nil; printerProblem = nil; reachable = nil; events = nil; spools = [:]; macCapabilities = []; mcpUpdates = [:]; mcpCopies = nil; mcpCopiesProblem = nil
        sendFailures = [:]
    }

    /// One consumer for the visible app: events when served, otherwise a refresh every 30 s.
    /// Detail screens read this store rather than starting their own polling loops.
    func follow() async {
        if events != false {
            do {
                let client = mac.client
                for try await update in EventStream(feed: LongPollEventFeed(client: client), healthy: { await client.answers() }).updates {
                    events = true
                    switch update {
                    case .resync: await load(); await loadPrinters()
                    case .event(let event):
                        reachable = true
                        if error?.isUnreachable == true { error = nil }
                        await receive(event)
                    }
                }
            } catch let failure as CompanionError {
                if failure.isUnsupported { events = false }
                if failure.needsPairing { error = failure; return }
            } catch {}
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            if UIApplication.shared.applicationState != .background { await load() }
        }
    }

    // MARK: Sending

    /// Sends a new project's files after its sheet has closed. The project shows Sending until they land,
    /// then the Mac starts. A send cut short is finished from the project page, or when it's next opened.
    func sendInBackground(_ id: String, _ body: @escaping @MainActor () async throws -> Void) async {
        guard !sending.contains(id) else { return }
        sending.insert(id)
        sendFailures[id] = nil
        Task { @MainActor in
            defer { sending.remove(id) }
            do { try await body() }
            catch let failure as CompanionError {
                if failure.code != "cancelled" { sendFailures[id] = failure.message }
                if failure.needsPairing { onPair() }
                await reload(id)
            } catch {
                sendFailures[id] = CompanionError.unreachable.message
                await reload(id)
            }
        }
    }

    // MARK: Connection

    var connection: PairingStatus? { try? pairingClient.store.status() }

    /// "Mac mini", from the pairing (the Mac's name, saved when it paired), else "your Mac".
    var macName: String? { _ = macNameChanges; return UserDefaults.standard.string(forKey: Self.macNameKey).flatMap { $0.isEmpty ? nil : $0 } }
    nonisolated static let macNameKey = "CounterpartMacName"
}

/// A printer MCP's update, in words (PRD §8.10).
struct MCPUpdateProgress: Equatable {
    /// started, waiting, done, failed, current, unresolved
    var state: String
    var fromVersion: String?
    var toVersion: String?
    var found: String?
    var log: String?

    init(_ event: CounterpartEvent) {
        state = String(event.type.dropFirst("mcp.update.".count))
        fromVersion = event.data?.fromVersion; toVersion = event.data?.toVersion; log = event.data?.log
    }
    init(_ update: MCPUpdate) { state = update.state; fromVersion = update.fromVersion; toVersion = update.toVersion; found = update.found }

    var words: String {
        let versions = [fromVersion, toVersion].compactMap { $0 }.joined(separator: " → ")
        switch state {
        case "started": return "Updating" + (versions.isEmpty ? "…" : " \(versions)…")
        case "waiting": return "Updates after the current print"
        case "done": return "Updated" + (toVersion.map { " to \($0)" } ?? "")
        case "current": return "Already the latest version"
        case "unresolved": return "Counterpart couldn't tell how this is installed" + (found.map { " (found \($0))" } ?? "") + "."
        case "failed": return "The update didn't finish."
        default: return state
        }
    }
    var isRunning: Bool { state == "started" || state == "waiting" }
}

