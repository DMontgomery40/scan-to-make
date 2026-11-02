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
    var queuedNotes: [String: String] = (UserDefaults.standard.dictionary(forKey: "CounterpartQueuedNotes") as? [String: String]) ?? [:] {
        didSet { UserDefaults.standard.set(queuedNotes, forKey: "CounterpartQueuedNotes") }
    }
    /// The companion's capability flags (`genericConfirmations` means the Mac can answer any printer question).
    var macCapabilities: Set<String> = []
    /// Bumped by `settings.changed`: Settings reads again.
    var settingsChanges = 0
    /// What each printer MCP's update is doing, from `mcp.update.*` events and the Update reply.
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

    // MARK: Reading

    func load() async {
        do {
            let latest = try await mac.list()
            guard !Task.isCancelled else { return }
            // Only what changed is published: an unchanged poll redraws nothing.
            if projects != latest { projects = latest }
            if error != nil { error = nil }
            if reachable != true { reachable = true }
            for project in latest where queuedNotes[project.id] != nil { sendQueuedNote(project) }
        } catch let failure as CompanionError {
            guard !Task.isCancelled, failure.code != "cancelled" else { return }
            error = failure
            if failure.isUnreachable { reachable = false }
        } catch { if !Task.isCancelled { self.error = .unreachable; reachable = false } }
        guard !Task.isCancelled else { return }
        loaded = true
    }

    func reload(_ id: String) async {
        if let latest = try? await mac.get(id) { replace(latest) }
    }

    func loadCapabilities() async {
        if let names = try? await mac.client.capabilities() { macCapabilities = names }
    }

    func loadPrinters() async {
        do {
            let latest = try await mac.printers()
            guard !Task.isCancelled else { return }
            if catalog != latest { catalog = latest }
            if printerProblem != nil { printerProblem = nil }
        } catch {
            guard !Task.isCancelled else { return }
            if catalog == nil { printerProblem = "Couldn't read the printers configured on your Mac." }
        }
    }

    func replace(_ project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) { if projects[index] != project { projects[index] = project } }
        else { projects.insert(project, at: 0) }
        sendQueuedNote(project)
    }

    func queue(note: String, for id: String) { queuedNotes[id] = [queuedNotes[id], note].compactMap { $0 }.joined(separator: "\n") }

    /// A change asked for during a pass goes in as soon as the Mac can take it.
    private func sendQueuedNote(_ project: Project) {
        guard let note = queuedNotes[project.id], words(project).actions.contains(.correct), !correcting.contains(project.id) else { return }
        correcting.insert(project.id)
        Task {
            defer { correcting.remove(project.id) }
            if let next = try? await mac.correct(project.id, note) {
                // Only what was sent leaves the queue; a change added meanwhile waits for this pass to end.
                let now = queuedNotes[project.id]
                queuedNotes[project.id] = now == note ? nil : now.map { $0.hasPrefix(note + "\n") ? String($0.dropFirst(note.count + 1)) : $0 }
                replace(next)
            }
        }
    }
    private var correcting: Set<String> = []
    func remove(_ id: String) { projects.removeAll { $0.id == id } }

    /// Clears everything read from the previous Mac.
    func reset() {
        projects = []; loaded = false; error = nil; catalog = nil; printerProblem = nil; reachable = nil; events = nil; spools = [:]; macCapabilities = []; mcpUpdates = [:]
        sendFailures = [:]
    }

    /// Follows the Mac while the app is on screen: events when served, else a refresh every 3 s while
    /// something runs (and every 30 s otherwise, so a phone left open still sees new projects).
    func follow() async {
        if events != false {
            do {
                for try await update in EventStream(feed: LongPollEventFeed(client: mac.client)).updates {
                    events = true
                    switch update {
                    case .resync: await load(); await loadPrinters()
                    case .event(let event):
                        if let project = event.projectId { await reload(project) }
                        // Events about the Mac, not a project: a printer MCP updating, or a setting changed elsewhere.
                        else if event.type.hasPrefix("mcp.update.") {
                            if let id = event.data?.mcpId { mcpUpdates[id] = MCPUpdateProgress(event) }
                            await loadPrinters()
                        } else if event.type == "settings.changed" { settingsChanges += 1 }
                    }
                }
            } catch let failure as CompanionError {
                if failure.isUnsupported { events = false }
                if failure.needsPairing { error = failure; return }
            } catch {}
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(anyRunning ? 3 : 30))
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
    var macName: String? { UserDefaults.standard.string(forKey: Self.macNameKey).flatMap { $0.isEmpty ? nil : $0 } }
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

