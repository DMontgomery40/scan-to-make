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

    init(client: CompanionClient) {
        self.client = client
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let changed = self.expensive != path.isExpensive || self.constrained != path.isConstrained
                self.expensive = path.isExpensive; self.constrained = path.isConstrained
                // Back on Wi-Fi: what waited for it comes now.
                if changed, let last = self.last { self.fill(last.projects, fromMac: last.fromMac) }
            }
        }
        monitor.start(queue: DispatchQueue(label: "counterpart.library.path"))
        refreshUsage()
    }

    /// Which Mac's library is in use, from a pairing that was read: another Mac's is cleared. Nothing else clears it here:
    /// a failed or locked read, or a Mac that wants pairing again, is not the person forgetting the Mac (board X96).
    func paired(_ status: PairingStatus?, fixture: Bool) {
        guard let status else { return }
        if status.state == .paired, let mac = fixture ? "fixture" : status.baseUrl { library.use(mac: mac) }
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
        guard library.isActive, !projects.isEmpty else { return }
        if fromMac { library.prune(keeping: Set(projects.map(\.id))) }
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
        queue = []
        library.clear()
        refreshUsage()
    }

    func refreshUsage() { usage = library.usage }
}
