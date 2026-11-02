import SwiftUI
import CounterpartKit

/// The app's long-lived state: the pairing, the companion client, and where to go next. One per process.
@MainActor @Observable final class AppModel {
    let pairing: PairingClient
    let companion: CompanionClient
    let nearby: NearbyPairing
    let objects: ObjectsStore

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
    private var lastLink: (url: String, at: Date)?
    private var observer: NSObjectProtocol?

    init(store: SecureStore = KeychainStore()) {
        let pairingStore = PairingStore(store: store)
        pairing = PairingClient(store: pairingStore)
        companion = CompanionClient(pairing: pairing)
        nearby = NearbyPairing(client: pairing)
        objects = ObjectsStore(mac: MacConnection(client: companion), pairing: pairing)
        observer = NotificationCenter.default.addObserver(forName: PairingStore.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.readStatus()
                self?.pairingKey += 1
            }
        }
        readStatus()
        objects.onPair = { [weak self] in self?.showPairing = true }
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
}
