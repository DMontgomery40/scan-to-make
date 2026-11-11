import SwiftUI
import Sparkle
import ServiceManagement
import UniformTypeIdentifiers
import AgentKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

@main enum EntryPoint {
    static func main() {
        if CommandLine.arguments.dropFirst().first == "--model-worker" { launchModelWorker(Installation(bundle:.main)) }
        if CommandLine.arguments.contains("--companion-agent") { launchAgent(Installation(bundle:.main)) }
        if CommandLine.arguments.contains("--unregister-agent") {
            do { try Installation(bundle:.main).service.unregister(); exit(0) }
            catch { exit(1) }
        }
        if CommandLine.arguments.contains("--install-agent") {
            Task { @MainActor in
                do { try await CompanionModel.shared.installAutomatically(); exit(0) }
                catch { fputs("Companion installation failed: \(error.localizedDescription)\n",stderr); exit(1) }
            }
            RunLoop.main.run()
            return
        }
        #if DEBUG
        // Design QA only: the real app, on screen, with the mockup's projects read from a folder of assets.
        if let index = CommandLine.arguments.firstIndex(of:"--design-fixtures"), index + 1 < CommandLine.arguments.count {
            DesignFixtures.assets = URL(fileURLWithPath:CommandLine.arguments[index + 1], isDirectory:true)
            DesignFixtures.screen = CommandLine.arguments.firstIndex(of:"--design-screen").flatMap {
                $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? "main"
        }
        #endif
        CounterpartApp.main()
    }
}

/// Where the app's models come from: the companion's control socket, or (Debug design QA) fixtures.
@MainActor enum AppModels {
    static let objects: ObjectsModel = {
        #if DEBUG
        if let companion = DesignFixtures.companion() {
            let model = ObjectsModel(companion:companion)
            model.selection = DesignFixtures.selected
            return model
        }
        #endif
        return ObjectsModel(companion:SocketObjects(path:ModelAccessModel.socketPath(for:Installation(bundle:.main))))
    }()
    static let modelAccess = ModelAccessModel(installation:Installation(bundle:.main))
}

/// Asks for a window from places that can't reach SwiftUI's `openWindow` (the app delegate, Dock reopen).
/// The menu bar label, which always exists, carries the request out.
@MainActor final class AppRouter: ObservableObject {
    static let shared = AppRouter()
    enum Destination: Equatable { case main, pairing, settings, qaPopover }
    @Published private(set) var pending: Destination?
    func open(_ destination: Destination) { pending = destination }
    func handled() { pending = nil }
    /// First run shows the pairing code (then setup) until a phone is paired and set up; after that, the window.
    var home: Destination { UserDefaults.standard.bool(forKey:"setupFinished") ? .main : .pairing }
}

/// The app's Dock icon, from Settings → General. Set once at launch and when the setting changes, never per window.
enum DockIcon {
    static let key = "showInDock"
    static var shown: Bool { UserDefaults.standard.object(forKey:key) as? Bool ?? true }
    @MainActor static func apply() { NSApp.setActivationPolicy(shown ? .regular : .accessory) }
}

struct CounterpartApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var objects = AppModels.objects
    @StateObject private var nearby = NearbyModel.shared
    @StateObject private var pairing = PairingFlow.shared
    @State private var isInserted = true

    var body: some Scene {
        Window("Counterpart", id:"main") {
            MainWindow(model:objects)
        }
        .defaultLaunchBehavior(.suppressed)
        // The app decides when its window opens (never at a login launch), so the system doesn't restore it.
        .restorationBehavior(.disabled)
        .defaultSize(width:1320, height:820)
        .windowToolbarStyle(.unified)
        .commands { CounterpartCommands() }

        Window("Add a Phone", id:"pairing") {
            PairingWindow(flow:pairing)
        }
        .defaultLaunchBehavior(.suppressed)
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        .restorationBehavior(.disabled)

        Settings {
            SettingsView(mac:MacStatusModel.shared, cleanup:AppModels.modelAccess, objects:objects)
        }

        MenuBarExtra(isInserted:$isInserted) {
            MenuBarPopover(nearby:nearby, mac:MacStatusModel.shared, objects:objects)
        } label: {
            MenuBarLabel(nearby:nearby, router:AppRouter.shared)
        }
        .menuBarExtraStyle(.window)

        #if DEBUG
        // Design QA only: screenshots can't open a menu bar extra, so its content can open as a window.
        Window("Popover (QA)", id:"qa-popover") {
            MenuBarPopover(nearby:nearby, mac:MacStatusModel.shared, objects:objects)
        }
        .defaultLaunchBehavior(.suppressed)
        .windowResizability(.contentSize)
        #endif
    }
}

/// The menu bar's cube (with a dot while a phone waits for Allow). It is always on screen, so it also opens
/// the windows the app delegate asks for.
private struct MenuBarLabel: View {
    @ObservedObject var nearby: NearbyModel
    @ObservedObject var router: AppRouter
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Image(nsImage:nearby.requests.isEmpty ? .menuBarCube : .menuBarCubeWaiting)
            .onAppear { route(router.pending) }
            .onChange(of:router.pending) { _, destination in route(destination) }
    }

    private func route(_ destination: AppRouter.Destination?) {
        guard let destination else { return }
        router.handled()
        NSApp.activate()
        switch destination {
        case .main: openWindow(id:"main")
        case .pairing: openWindow(id:"pairing")
        case .settings: openSettings()
        case .qaPopover: openWindow(id:"qa-popover")
        }
    }
}

struct CounterpartCommands: Commands {
    @FocusedValue(\.newProjectAction) private var newProject
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing:.newItem) {
            Button("New Project…") { newProject?() }
                .keyboardShortcut("n")
                .disabled(newProject == nil)
            // H2 (Nov 11): the system file chooser for the files New Project takes. Always on, even with no window open.
            Button("Open…") { OpenedFiles.choose() }
                .keyboardShortcut("o")
            Button("Add a Phone…") { NSApp.activate(); openWindow(id:"pairing") }
        }
        CommandGroup(replacing: .help) {
            Link("Counterpart Help", destination: CounterpartIdentifiers.helpPage)
            Link("Print the scan rig by Kass 3D", destination: CounterpartIdentifiers.scanRig)
        }
        CommandGroup(replacing:.appTermination) {
            // Delivery to the phone runs in this app (PRD §8.8), so quitting says what stops.
            Button("Quit Counterpart (your phone stops getting updates)") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private let updates = Updates()
    private let localNetwork = LocalNetworkAccess()

    func applicationWillFinishLaunching(_ notification: Notification) {
        DockIcon.apply()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if DesignFixtures.assets != nil {
            NSApp.appearance = NSAppearance(named:.darkAqua) // the mockups are rendered in dark mode
            AppRouter.shared.open(DesignFixtures.screen == "popover" ? .qaPopover : DesignFixtures.screen.hasPrefix("settings") ? .settings : .main)
            DesignFixtures.seedUpdate()
            DesignSnapshot.scheduleIfAsked()
            return
        }
        #endif
        localNetwork.observeNetwork { [weak self] in self?.permissionProbeForeground() ?? false }
        NotificationCenter.default.addObserver(self, selector:#selector(windowBecameKey(_:)), name:NSWindow.didBecomeKeyNotification, object:nil)
        #if DEBUG
        // Design QA on a real project (`--design-project`) only looks: the installed app keeps the event cursor, the
        // phone relay, nearby pairing and the login item. A second relay would move the shared cursor past events.
        if DesignFixtures.realProject != nil {
            AppRouter.shared.open(.main)
            DesignSnapshot.scheduleIfAsked()
            return
        }
        #endif
        if Installation(bundle:.main).variant.isEmpty && SMAppService.mainApp.status == .notRegistered
            && !UserDefaults.standard.bool(forKey:"openAtLoginOff") {
            try? SMAppService.mainApp.register()
        }
        let event = NSAppleEventManager.shared().currentAppleEvent
        let loginLaunch = event?.eventID == kAEOpenApplication
            && event?.paramDescriptor(forKeyword:keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        NearbyModel.shared.start()
        EventRelay.shared.start()
        // At login the app stays in the menu bar; opened by hand, it shows its window (or the pairing code first).
        if !loginLaunch { AppRouter.shared.open(OpenedFiles.shared.waiting.isEmpty ? AppRouter.shared.home : .main) }
        #if DEBUG
        DesignSnapshot.scheduleIfAsked() // design QA of a Debug build against the real companion
        #endif
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { AppRouter.shared.open(AppRouter.shared.home) }
        return true
    }

    /// H1 (Nov 11): Finder's Open With, a double-click with Counterpart chosen, a drop on the Dock icon and `open -a`
    /// all land here. The window takes the files into New Project as a drop on it does; anything else is ignored.
    func application(_ application: NSApplication, open urls: [URL]) {
        if OpenedFiles.shared.receive(urls.filter(\.isFileURL)) { AppRouter.shared.open(.main) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// CloudKit's content-available push for a new command from the phone (PRD §9.3).
    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        EventRelay.shared.cloud.fetchCommands()
    }

    /// The first Local Network request needs the app in front; a menu bar window can be key without that.
    private func permissionProbeForeground() -> Bool {
        if !localNetwork.hasAttempted, !NSApp.isActive, NSApp.keyWindow?.isVisible == true,
           !NetworkAddresses.current().lan.isEmpty { NSApp.activate() }
        return NSApp.isActive
    }
    @objc private func windowBecameKey(_ notification: Notification) {
        localNetwork.requestIfNeeded(isForeground:permissionProbeForeground(), hasLAN:!NetworkAddresses.current().lan.isEmpty)
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        localNetwork.requestIfNeeded(isForeground:NSApp.isActive, hasLAN:!NetworkAddresses.current().lan.isEmpty)
    }
}

/// Release builds enable Sparkle only with an HTTPS feed and a valid Ed25519
/// public key. Until MAC-4 exposes busy/idle state, require the service to be stopped.
@MainActor final class Updates: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController?
    private var installTimer: Timer?
    override init() {
        super.init()
        let key = Bundle.main.object(forInfoDictionaryKey:"SUPublicEDKey") as? String ?? ""
        let feed = Bundle.main.object(forInfoDictionaryKey:"SUFeedURL") as? String ?? ""
        guard Data(base64Encoded:key)?.count == 32, URL(string:feed)?.scheme == "https" else { return }
        controller = SPUStandardUpdaterController(startingUpdater:true,updaterDelegate:self,userDriverDelegate:nil)
        controller?.updater.automaticallyChecksForUpdates = true
        controller?.updater.automaticallyDownloadsUpdates = false
    }
    private var safeToReplaceApp: Bool {
        let installation = Installation(bundle:.main)
        return installation.service.status != .enabled && !FileManager.default.fileExists(atPath:installation.legacy.path)
    }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard safeToReplaceApp else {
            throw NSError(domain:"com.scantomake.mac.updates",code:1,userInfo:[NSLocalizedDescriptionKey:"Updates wait until Counterpart is stopped in the background."])
        }
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        guard !safeToReplaceApp else { return false }
        installTimer?.invalidate()
        installTimer = Timer.scheduledTimer(withTimeInterval:5,repeats:true) { [weak self] timer in
            Task { @MainActor in
                guard self?.safeToReplaceApp == true else { return }
                timer.invalidate()
                self?.installTimer = nil
                installHandler()
            }
        }
        return true
    }
}

extension OpenedFiles {
    /// File ▸ Open…: the system file chooser for the files New Project takes.
    static func choose() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = ObjectsModel.acceptedContentTypes
        panel.prompt = "Open"
        NSApp.activate()
        if panel.runModal() == .OK, shared.receive(panel.urls) { AppRouter.shared.open(.main) }
    }
}
