import SwiftUI
import Network
import CounterpartKit

/// Fills the phone's own library (`OnDeviceLibrary`, docs/design/overhaul/on-device-library.md) without being asked: when
/// the project list loads or changes, every project's picture comes in the background, a few at a time, on any link; the
/// models of opened and recent projects come on an unmetered link (and on a metered one only when known to be small); a
/// scan only when the person keeps everything. A page's own request still fetches anything it needs, on any link.
/// David, Nov 11: "Just keep the latest versions on the phone? ... Or ... just let them ... choose? Doesn't seem hard."
@MainActor @Observable final class LibraryFiller {
    private let client: CompanionClient
    var library: OnDeviceLibrary { client.library }
    /// What the person keeps (Settings → Keep on this iPhone). Changing it lets go of what is no longer kept at once.
    var keep: OnDeviceLibrary.Keep = OnDeviceLibrary.Keep.chosen {
        didSet {
            OnDeviceLibrary.Keep.chosen = keep
            library.evict(keep: keep, ceiling: Self.ceiling)
            refreshUsage()
            if let last { fill(last.projects, fromMac: last.fromMac) }
        }
    }
    /// The bytes the library holds, for Settings' line.
    private(set) var usage: Int64 = 0
    /// The link now: cellular or a personal hotspot (`isExpensive`), Low Data Mode (`isConstrained`). Apple's NWPath; a
    /// tunnel (David's WireGuard) reports the path under it as far as the system knows it.
    private(set) var expensive = false
    private(set) var constrained = false
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var pump: Task<Void, Never>?
    @ObservationIgnored private var queue: [LibraryPlan.Want] = []
    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private var last: (projects: [Project], fromMac: Bool)?
    @ObservationIgnored private var opened: Set<String> = []
    /// The ceiling: the choice's own, or (debug builds) `-CounterpartLibraryCeiling <bytes>` for the eviction UI test.
    nonisolated static var ceiling: Int64? {
        #if DEBUG
        let bytes = UserDefaults.standard.integer(forKey: "CounterpartLibraryCeiling")
        if bytes > 0 { return Int64(bytes) }
        #endif
        return nil
    }
    /// At most this many files at once, so a list of 40 projects never floods a slow link.
    static let width = 3

    /// `watchesLink` false (tests): the link is only what `linkChanged` says.
    init(client: CompanionClient, watchesLink: Bool = true) {
        self.client = client
        defer { refreshUsage() }
        guard watchesLink else { return }
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                self.linkChanged(expensive: path.isExpensive, constrained: path.isConstrained)
            }
        }
        monitor.start(queue: DispatchQueue(label: "counterpart.library.path"))
    }

    /// The link changed (NWPathMonitor; tests call it directly). Back on Wi-Fi, what waited for it comes now; on cellular
    /// or Low Data Mode, what is still queued is checked again before it starts (`drain`).
    func linkChanged(expensive: Bool, constrained: Bool) {
        let changed = self.expensive != expensive || self.constrained != constrained
        self.expensive = expensive; self.constrained = constrained
        if changed, let last { fill(last.projects, fromMac: last.fromMac) }
    }

    /// Files queued or in flight, by `project#name#version` (tests).
    var pending: Set<String> { inFlight }
    /// Whether a fill is fetching now (tests).
    var isFilling: Bool { pump != nil }

    /// Which Mac's library is in use, from a pairing that was read: another Mac's is cleared. Nothing else clears it here:
    /// a failed or locked read, or a Mac that wants pairing again, is not the person forgetting the Mac (board X96).
    /// The Mac is who it is by its pin (`KnownProjects.key`, the saved list's key too), not by an address, and an expired
    /// credential is still the same Mac: its library stays readable while it wants pairing again.
    func paired(_ status: PairingStatus?, fixture: Bool) {
        guard let status else { return }
        if let mac = fixture ? "fixture" : KnownProjects.key(for: status) { library.use(mac: mac) }
        refreshUsage()
    }

    /// Forget This Mac: everything kept goes.
    func forgot() {
        queue = []
        library.unpair(); opened = []; last = nil
        refreshUsage()
    }

    /// The person opened a project's page: it is the last to be evicted, and its plates, question photo and (when kept)
    /// scan join the fill.
    func opened(_ id: String) {
        library.opened(id)
        guard opened.insert(id).inserted, let last else { return }
        fill(last.projects, fromMac: last.fromMac)
    }

    /// The project list loaded or changed. `fromMac`: it came from the Mac now (not the copy saved on this phone), so a
    /// project missing from it is deleted and its files go.
    func fill(_ projects: [Project], fromMac: Bool) {
        last = (projects, fromMac)
        guard library.isActive else { return }
        // The Mac's whole list is the truth even when it is empty: every project was deleted, so every file goes (review
        // of #741, P1). A saved or partial list never prunes.
        if fromMac { library.prune(keeping: Set(projects.map(\.id))) }
        guard !projects.isEmpty else { return }
        let wants = LibraryPlan.wants(projects, opened: opened.union(projects.compactMap { library.lastOpened($0.id) != nil ? $0.id : nil }), keep: keep)
            .filter { LibraryPlan.fetches($0, keep: keep, expensive: expensive, constrained: constrained) }
            .filter { library.file(project: $0.project.id, name: $0.name, version: Int64($0.project.mediaVersion)) == nil }
            .filter { !library.isTooLarge(project: $0.project.id, name: $0.name, version: Int64($0.project.mediaVersion)) }
        // Added to what is being fetched, never cancelling a file in flight: on a slow link the event stream reloads the
        // list constantly, and cancelling would throw each transfer away.
        let fresh = wants.filter { inFlight.insert(Self.key($0)).inserted }
        guard !fresh.isEmpty else { return }
        MediaTrace.record("library.fill", ["files": String(fresh.count)])
        queue.append(contentsOf: fresh)
        if pump == nil { pump = Task { await drain() } }
    }

    nonisolated private static func key(_ want: LibraryPlan.Want) -> String { "\(want.project.id)#\(want.name)#\(Int64(want.project.mediaVersion))" }

    /// Fetches the queue three at a time until it is empty, then keeps the library under its ceiling.
    private func drain() async {
        let client = client
        await withTaskGroup(of: String.self) { group in
            var running = 0
            while true {
                while running < Self.width, !queue.isEmpty {
                    let want = queue.removeFirst(), key = Self.key(want)
                    // The link now, not when it was queued: a model queued on Wi-Fi waits once the phone is on cellular or
                    // Low Data Mode (review of #741, P2; David is often on 5G through his tunnel). Released, so the next
                    // fill on an unmetered link queues it again.
                    guard LibraryPlan.fetches(want, keep: keep, expensive: expensive, constrained: constrained) else {
                        inFlight.remove(key)
                        MediaTrace.record("library.deferred", ["kind": want.kind.rawValue])
                        continue
                    }
                    group.addTask { _ = try? await client.download(want.project, want.name); return key }
                    running += 1
                }
                guard running > 0, let done = await group.next() else { break }
                running -= 1
                inFlight.remove(done)
            }
        }
        library.evict(keep: keep, ceiling: Self.ceiling)
        refreshUsage()
        pump = nil
    }

    /// Settings → Clear: this Mac's files go; the next list fills it again.
    func clear() {
        // What was queued is released too, so the next list queues those files again (review of #741, P2); a transfer
        // in flight releases its own key when it ends.
        inFlight.subtract(queue.map(Self.key))
        queue = []
        library.clear()
        refreshUsage()
    }

    func refreshUsage() { usage = library.usage }
}
