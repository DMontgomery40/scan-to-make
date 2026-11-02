import SwiftUI
import CounterpartKit

/// The app's long-lived state: the pairing, the companion client, and where to go next. One per process.
@MainActor @Observable final class AppModel {
    let pairing: PairingClient
    let companion: CompanionClient
    let nearby: NearbyPairing
    let projects: ProjectsStore

    /// Nil until the stored pairing has been read once.
    private(set) var status: PairingStatus?
    /// The stored pairing couldn't be read (the phone is locked, or the item is damaged).
    private(set) var statusUnreadable = false
    /// Bumped when the pairing changes, so the screens read the Mac again.
    private(set) var pairingKey = 0
    /// Find your Mac, on top of the app (connecting a different Mac, or a pairing link that arrived).
    var showPairing = false
    /// Keeps the first-run pairing screen up until its Connected step is done, though a pairing now exists.
    var holdPairingScreen = false
    /// A `scantomake://pair` link waiting for the pairing screen.
    var pendingLink: String?
    /// A screen to open (from a notification or a link), consumed by the root view.
    var route: AppRoute?
    /// Debug builds: which project section a screenshot opens on.
    var debugSection: String?
    /// DEBUG: the printer whose page `-CounterpartScreen printer` opens.
    var debugPrinter: String?
    /// DEBUG: `-CounterpartScreen welcome` or `notify` shows that first-run step.
    var debugFirstRun: String?
    /// DEBUG: the Settings page `-CounterpartScreen notifications` or `about` opens.
    var debugSettings: String?
    private var lastLink: (url: String, at: Date)?
    private var observer: NSObjectProtocol?

    init(store: SecureStore = KeychainStore()) {
        var store = store
        var transport: HTTPTransport = PinnedTransport()
        #if DEBUG
        if let folder = Fixtures.folder { store = Fixtures.store(); transport = FixtureTransport(folder: folder) }
        #endif
        let pairingStore = PairingStore(store: store)
        pairing = PairingClient(store: pairingStore, transport: transport)
        companion = CompanionClient(pairing: pairing, transport: transport, deviceName: pairing.store.userAssignedName())
        nearby = NearbyPairing(client: pairing, transport: transport)
        projects = ProjectsStore(mac: MacConnection(client: companion), pairing: pairing)
        observer = NotificationCenter.default.addObserver(forName: PairingStore.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.readStatus()
                self?.pairingKey += 1
            }
        }
        readStatus()
        projects.onPair = { [weak self] in self?.showPairing = true }
        #if DEBUG
        debugRoute()
        #endif
    }

    /// No usable pairing: Find your Mac is the first screen.
    var needsMac: Bool { status.map { $0.state != .paired } ?? false }

    func readStatus() {
        do { status = try pairing.store.status(); statusUnreadable = false }
        catch { statusUnreadable = true; status = status ?? .disconnected }
    }

    /// Keeps the credential alive when the app opens and each time it comes back. Quiet unless the Mac
    /// refuses it, which shows the pairing screen.
    func keepFresh() async {
        readStatus()
        if await PairingFreshness.keep(pairing) == .pairAgain {
            readStatus()
            pairingKey += 1
        }
    }

    /// After pairing finishes on the pairing screen.
    func paired() {
        readStatus()
        showPairing = false
        pairingKey += 1
    }

    // MARK: Links and routes

    /// A link that opened the app. A cold start can deliver the same pairing link twice within moments.
    func open(_ url: URL) {
        guard let route = AppRoute(url: url) else { return }
        if case .pair(let link) = route {
            let now = Date()
            if let last = lastLink, last.url == link, now.timeIntervalSince(last.at) < 2 { return }
            lastLink = (link, now)
            pendingLink = link
            if !needsMac { showPairing = true }
            return
        }
        self.route = route
    }

    /// The one entry point for notification routing (a later milestone's notification delegate calls it).
    func open(notification userInfo: [AnyHashable: Any], action: String?) {
        if let route = AppRoute(notification: userInfo, action: action) { self.route = route }
    }

    #if DEBUG
    /// `-CounterpartScreen <name>` opens one screen directly, as the mockup app's `-screen` does.
    private func debugRoute() {
        guard let screen = UserDefaults.standard.string(forKey: "CounterpartScreen") else { return }
        let ids = Fixtures.ids
        switch screen {
        case "ready": route = .project(ids.mic)
        case "printed": route = .project(ids.first)
        case "preparing": Fixtures.preparing = true
        case "inputs": route = .project(ids.mic); debugSection = "inputs"
        case "working": route = .project(ids.potato)
        case "ask": route = .project(ids.plush)
        case "failed": route = .project(ids.failed); debugSection = "activity"
        case "failed-print": Fixtures.failure = "print"; route = .project(ids.mic)
        case "failed-change": Fixtures.failure = "change"; route = .project(ids.mic)
        case "printing": route = .printing(ids.clip)
        // The one-colour sheet: v1 prints one filament (PRD §5.5); "print" shows the same until parts arrive (M3b).
        case "print", "print-one": route = .print(ids.mic)
        case "print-noams": Fixtures.printer = "mcp-garage"; route = .print(ids.mic)
        case "print-loaded": Fixtures.printer = "mcp-ender"; route = .print(ids.mic)
        case "confirm": Fixtures.confirmation = "supported"; route = .project(ids.mic)
        case "confirm-mac": Fixtures.confirmation = "unsupported"; route = .project(ids.mic)
        case "confirm-mac-answers": Fixtures.confirmation = "unsupported"; Fixtures.macAnswers = true; route = .project(ids.mic)
        case "confirm-generic": Fixtures.confirmation = "generic"; route = .project(ids.mic)
        case "welcome", "notify": debugFirstRun = screen
        case "settings", "notifications", "about": debugSettings = screen
        case "new": route = .newProject
        case "printers": route = .printers
        case "printer": debugPrinter = "current"; route = .printers
        case "printer-update": debugPrinter = "mcp-ender"; route = .printers
        default: break
        }
    }
    #endif
}
