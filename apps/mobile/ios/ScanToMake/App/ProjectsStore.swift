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
    /// Whether the Mac is answering: the one value Home, the sidebar and Settings all read (`MacLink`).
    var link = MacLink.checking
    /// The Mac answered the last request (nil until one has).
    var reachable: Bool? { link.reachable }

    /// The Mac replied, so nothing is wrong with the connection any more.
    private func answered() {
        link.answered()
        if let shown = error, shown.isUnreachable || shown.needsPairing { error = nil }
    }

    /// A request failed. A connection failure (the Mac didn't answer, or wants pairing again) is the whole app's
    /// problem and shows in the banner; any other refusal is that request's own and proves the Mac answered.
    func requestFailed(_ failure: CompanionError) {
        if failure.isUnreachable || failure.needsPairing { link.failed(failure); error = failure } else { answered() }
    }
    var canScan = false
    /// Scans stopped after keeping photos, by project: still on this phone, shown as "Scan stopped · 9 photos kept".
    var stoppedScans: [String: MacConnection.StoppedScan] = [:]
    /// Finished scans still only on this phone: their projects offer Send even though the Mac has no scan yet.
    var readyScans: Set<String> = []
    func refreshStoppedScans() { stoppedScans = mac.stoppedScans(); readyScans = mac.readyScanProjects() }
    /// "Scan stopped · 9 photos kept", while the project hasn't been sent.
    func stoppedScanWords(_ project: Project) -> String? {
        guard project.state == .new, let stopped = stoppedScans[project.id] else { return nil }
        return "Scan stopped · \(stopped.photos) photo\(stopped.photos == 1 ? "" : "s") kept"
    }
    /// A scan kept on this phone (stopped or finished but unsent), in the words its card and row show.
    func localScanWords(_ project: Project) -> String? {
        if let stopped = stoppedScanWords(project) { return stopped }
        guard project.state == .new, !project.hasScan, readyScans.contains(project.id) else { return nil }
        return "Scan saved · send to your Mac"
    }
    /// Projects this phone is still sending files to: they show "Sending to your Mac".
    var sending: Set<String> = [] { didSet { sendProgress = sendProgress.filter { sending.contains($0.key) } } }
    /// How much of a send has reached the Mac (0…1): a walk-around's every photo can take a while.
    var sendProgress: [String: Double] = [:]
    /// A project whose page should open Ask for changes with "After printing: " started: Needs Changes was
    /// pressed on its finished Printing screen. The page takes it once.
    var askAfterPrinting: String?
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
    var attemptedMcpMoves: [String: String] = [:]
    /// What each printer last reported loaded, from a print sheet (the Mac reports spools per project).
    var spools: [String: [PrinterFilament]] = [:]
    /// The Mac serves `/v1/events`; false after it answered "not supported".
    var events: Bool?
    var onPair: () -> Void = {}

    /// The 3D models project pages draw, fetched here rather than by the page (`ModelFiles`).
    let models: ModelFiles

    init(mac: MacConnection, pairing: PairingClient) {
        self.mac = mac; self.pairingClient = pairing
        models = ModelFiles { project, path in
            guard let file = try await mac.download(project, path) else { throw CompanionError(code: "download-failed", message: "That file couldn't be saved on this phone.") }
            return file
        }
        mac.onSendProgress = { [weak self] id, share in
            guard let self, self.sending.contains(id) else { return }
            self.sendProgress[id] = share
        }
    }

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    func words(_ project: Project) -> ProjectWords {
        ProjectWords(project, sending: sending.contains(project.id), localScan: readyScans.contains(project.id), printerName: printerName(project))
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

    /// "Mac mini connected · 2 printers ready"
    var homeSubtitle: String {
        let mac = macName ?? "Your Mac"
        let connection = reachable == false ? "\(mac) isn't answering" : reachable == true ? "\(mac) connected" : mac
        guard let catalog = catalog, !catalog.destinations.isEmpty else { return connection }
        // What the printers are doing: printing first ("Bambu Lab P1S printing"), then how many are ready.
        // Printing, not getting ready: a print the printer is still preparing isn't "printing" yet.
        let printing = catalog.destinations.filter { destination in
            destination.state == "printing" || (self.printing(on: destination.id).map { words($0).phase == .printing } ?? false)
        }
        if printing.count == 1 { return "\(connection) · \(printing[0].model ?? printing[0].name) printing" }
        if printing.count > 1 { return "\(connection) · \(printing.count) printers printing" }
        let count = catalog.destinations.count
        let ready = catalog.destinations.filter { $0.isReady == true }.count
        if ready == 0 { return "\(connection) · \(count) \(count == 1 ? "printer" : "printers")" }
        return "\(connection) · \(ready) \(ready == 1 ? "printer" : "printers") ready"
    }

    /// Said beside a starter's Add button before any tap, when the store already knows the Mac isn't answering (F6).
    var starterUnavailableMessage: String? {
        reachable == false ? "Your Mac isn't answering. Check it's on and awake, then try again." : nil
    }

    /// Printers that are offline or need an MCP update.
    var printerProblems: Int {
        catalog?.destinations.filter { $0.isOffline || $0.capabilities?.update != nil }.count ?? 0
    }

    var printersLabel: String {
        printerProblems == 0 ? "Printers" : "Printers, \(printerProblems) \(printerProblems == 1 ? "needs" : "need") attention"
    }

    var anyRunning: Bool { projects.contains { words($0).busy } || !sending.isEmpty }

    private var reads = ProjectReads()

    // MARK: Reading

    func load() async {
        let ticket = reads.start()
        do {
            let latest = try await mac.list()
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return }
            projects = reads.merge(latest, ticket: ticket, current: projects); error = nil; link.answered()
            refreshStoppedScans()
            for project in projects where corrections.pending(project.id) != nil { sendQueuedNote(project) }
        } catch let failure as CompanionError {
            guard !Task.isCancelled, reads.isCurrent(ticket), failure.code != "cancelled" else { return }
            // The list couldn't be read: the banner says why, whatever the reason.
            link.failed(failure); error = failure
        } catch { if !Task.isCancelled, reads.isCurrent(ticket) { requestFailed(.unreachable) } }
        guard !Task.isCancelled, reads.isCurrent(ticket) else { return }
        loaded = true
    }

    @discardableResult func reload(_ id: String) async -> CompanionError? {
        let ticket = reads.start()
        do {
            let latest = try await mac.get(id)
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return .cancelled }
            answered()
            if reads.accept(id, ticket: ticket) { show(latest) }
            return nil
        } catch {
            guard !Task.isCancelled, reads.isCurrent(ticket) else { return .cancelled }
            let failure = error as? CompanionError ?? .unreachable
            // Every failure says something about the link: the Mac didn't answer, wants pairing again, or answered
            // with a refusal (which ends a stale "isn't answering").
            if failure.code != "cancelled" { requestFailed(failure) }
            if failure.code == "not-found" {
                guard reads.accept(id, ticket: ticket) else { return .cancelled }
                answered()
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

    func queue(note: String, for id: String, messageId: String? = nil) {
        let photos = projects.first(where: { $0.id == id }).flatMap { corrections.availablePhotos($0) }
        corrections.add(note, for: id, photos: photos, messageId: messageId)
    }

    /// A change asked for during a pass goes in as soon as the Mac can take it.
    private func sendQueuedNote(_ project: Project) {
        guard let note = corrections.due(project), !correcting.contains(project.id), project.pendingFollowup == nil else { return }
        correcting.insert(project.id)
        Task {
            defer { correcting.remove(project.id) }
            do {
                let ticket = startRequest()
                let next = try await mac.correct(project.id, note, photoNames: corrections.messages[project.id]?.first?.photos, messageId: corrections.dueId(project.id))
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
        projects = []; loaded = false; error = nil; catalog = nil; printerProblem = nil; link = .checking; events = nil; spools = [:]; macCapabilities = []; mcpUpdates = [:]; attemptedMcpMoves = [:]; mcpCopies = nil; mcpCopiesProblem = nil
        stoppedScans = [:]; readyScans = []; sendFailures = [:]
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
                        answered()
                        await receive(event)
                    }
                }
            } catch let failure as CompanionError {
                if failure.isUnsupported { events = false }
                if failure.needsPairing { requestFailed(failure); return }
            } catch {}
        }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            if UIApplication.shared.applicationState != .background { await load() }
        }
    }

    // MARK: Sending

    /// A finished scan uploading while its use is still being chosen. It starts no pass.
    private var uploadTasks: [String: Task<Void, Never>] = [:]
    func beginUpload(_ id: String, _ body: @escaping @MainActor () async throws -> Void) {
        guard uploadTasks[id] == nil, !sending.contains(id) else { return }
        sending.insert(id)
        sendFailures[id] = nil
        uploadTasks[id] = Task { @MainActor in
            defer { sending.remove(id); uploadTasks[id] = nil }
            do { try await body(); await reload(id) }
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

    /// Send once an upload already under way settles; a cut-short upload is simply resumed by the send.
    func sendAfterUpload(_ id: String, _ body: @escaping @MainActor () async throws -> Void) async {
        if let task = uploadTasks[id] {
            Task { @MainActor in
                await task.value
                await sendInBackground(id, body)
            }
        } else {
            await sendInBackground(id, body)
        }
    }

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
        case "waiting": return "Updates as soon as Counterpart finishes its work on this printer"
        case "done": return "Updated" + (toVersion.map { " to \($0)" } ?? "")
        case "current": return "Already the latest version"
        case "unresolved": return "Counterpart couldn't tell how this is installed" + (found.map { " (found \($0))" } ?? "") + "."
        case "failed": return "The update didn't finish."
        default: return state
        }
    }
    var isRunning: Bool { state == "started" || state == "waiting" }
    /// Work under way now, shown with a spinner. Waiting for a print can take hours: that is the sentence alone (Nov 6).
    var isWorking: Bool { state == "started" }
}

/// The 3D models a project page draws (its result, its scan), fetched by the store rather than the page. Nov 10: every
/// "What you scanned" on David's phone was blank: the download belonged to the page, so leaving it cancelled a transfer
/// that buffered the whole file first, a failure was swallowed, and nothing tried again. Here a download outlives the
/// page that asked for it, runs once per file and project version (the files are cached per version, as before), starts
/// again by itself after a dropped link, and says how it ended, so the page keeps the Mac's picture and says why.
@MainActor @Observable final class ModelFiles {
    enum Fetch: Equatable { case loading, ready(URL), failed, tooLarge }
    private(set) var fetches: [String: Fetch] = [:]
    @ObservationIgnored private var running: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let download: (Project, String) async throws -> URL
    /// The waits before each new try after a dropped link or a timeout.
    @ObservationIgnored var pauses: [Duration] = [.seconds(2), .seconds(8)]

    init(download: @escaping (Project, String) async throws -> URL) { self.download = download }

    static func key(_ project: Project, _ path: String) -> String { "\(project.id)#\(Int64(project.mediaVersion))#\(path)" }
    func fetch(_ project: Project, _ path: String) -> Fetch? { fetches[Self.key(project, path)] }
    func file(_ project: Project, _ path: String) -> URL? {
        if case .ready(let url) = fetch(project, path) { return url }
        return nil
    }

    /// Starts the file's download unless it is running, done or refused as too large, and returns at once: the page
    /// reads `fetch`. Nothing the page does cancels it.
    func want(_ project: Project, _ path: String) {
        let key = Self.key(project, path)
        guard running[key] == nil else { return }
        switch fetches[key] {
        case .ready(let url) where FileManager.default.fileExists(atPath: url.path): return
        case .tooLarge: return
        default: break
        }
        fetches[key] = .loading
        let download = download, pauses = pauses
        running[key] = Task {
            var outcome = Fetch.failed
            for attempt in 0...pauses.count {
                if attempt > 0 { try? await Task.sleep(for: pauses[attempt - 1]) }
                do { outcome = .ready(try await download(project, path)); break }
                catch let error as CompanionError where Self.final.contains(error.code) {
                    outcome = error.code == "file-too-large" ? .tooLarge : .failed
                    break
                } catch { outcome = .failed }
            }
            self.fetches[key] = outcome
            self.running[key] = nil
        }
    }

    /// Try Again: a download that failed starts over.
    func retry(_ project: Project, _ path: String) {
        let key = Self.key(project, path)
        guard running[key] == nil, fetches[key] == .failed else { return }
        fetches[key] = nil
        want(project, path)
    }

    /// Answers that another try won't change: the Mac refused the file, or this phone may not ask for it.
    private static let final: Set<String> = ["file-too-large", "not-found", "invalid-request", "scope-denied", "pairing-required", "pairing-changed"]
}

