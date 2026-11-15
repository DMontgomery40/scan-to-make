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
        // #775 review screenshots: Settings → Printer software drawn off screen from a fixture, then exit.
        if let index = CommandLine.arguments.firstIndex(of:"--render-printer-software"), index + 2 < CommandLine.arguments.count {
            MainActor.assumeIsolated { PrinterSoftwareSnapshot.render(Array(CommandLine.arguments[(index + 1)...])) }
        }
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
        CommandGroup(after:.appInfo) { CheckForUpdatesButton(updates:Updates.shared) }
        CommandGroup(replacing:.newItem) {
            Button("New Project…") { newProject?() }
                .keyboardShortcut("n")
                .disabled(newProject == nil)
            // H2 (Nov 11): the system file chooser for the files New Project takes. Not tied to the window's focus, as
            // New Project… is; with no window open, whether the menu has it is unchecked (review of #582, finding 4).
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
    private let updates = Updates.shared
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
        // #829: a translocated copy can't register the companion or the login item, and can't update; it only says to move it.
        if Translocation.isTranslocated(Bundle.main.bundleURL) {
            TranslocationNotice.show()
            return
        }
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
        updates.resumeAgentAfterUpdate()
        updates.checkCompanionBuild()
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
        // Open (review of #582, finding 5): a file opened on a Mac not yet set up goes to New Project, not pairing.
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
    /// all land here. The window comes forward and takes the files into New Project as a drop on it does, naming any
    /// it can't use.
    func application(_ application: NSApplication, open urls: [URL]) {
        if OpenedFiles.shared.receive(urls.filter(\.isFileURL)) { AppRouter.shared.open(.main) }
    }

    /// #828: with a downloaded update waiting to install on quit, stop the companion agent first (`UpdateQuit`).
    /// Review F1: Sparkle 2.9.3 has no way to put off an install-on-quit for one quit, so a quit while the companion is
    /// working is refused with the waiting sentence, and the app quits by itself once the work is done (the update
    /// installs then). Logging out, restarting or shutting down is never held up: those end the agent too, and launchd
    /// starts it from the new app at the next login.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard updates.staged, !Self.sessionEnding else { return .terminateNow }
        Task { @MainActor in sender.reply(toApplicationShouldTerminate:await updates.quit.shouldTerminate()) }
        return .terminateLater
    }

    /// The quit comes from logging out, restarting or shutting down (the quit event's reason).
    private static var sessionEnding: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEQuitApplication,
              let reason = event.attributeDescriptor(forKeyword:kAEQuitReason)?.enumCodeValue else { return false }
        let ending: Set<OSType> = [OSType(kAELogOut), OSType(kAEReallyLogOut), OSType(kAEShowRestartDialog),
                                   OSType(kAEShowShutdownDialog), OSType(kAERestart), OSType(kAEShutDown)]
        return ending.contains(reason)
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

/// Sparkle (#828). Release builds start it only with an HTTPS feed and a valid Ed25519 public key, and never from a
/// translocated copy (Sparkle refuses to update one). Checks, scheduled and Check for Updates…, are always allowed.
///
/// Installing replaces Counterpart.app, which the companion agent runs from, so the agent is stopped first and started
/// again after (62dccb41 refused every check while the agent was enabled, "until MAC-4 exposes busy/idle state", so no
/// working install could update). Install and Relaunch waits, with a plain sentence, until no pass is running and no
/// print is being sent (`UpdateGate`); Sparkle then quits the app, `UpdateQuit` stops the agent, Sparkle replaces
/// the app and relaunches it, and the relaunched app registers the agent again (`resumeAgentAfterUpdate`).
/// A downloaded update the person dismissed still installs when the app quits; the same quit path stops the agent, and
/// refuses a quit while the companion is working (then quits by itself once it is done).
@MainActor final class Updates: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = Updates()
    /// What the next launch does about the agent: `stopped` (unregistered for an update: register it again) or
    /// `outdated` (launchd refused to stop it for the update: restart it once idle, review R1).
    static let agentKey = "agentAfterUpdate"
    private var controller: SPUStandardUpdaterController?
    private var observation: NSKeyValueObservation?
    /// Sparkle runs in this build (the menu shows Check for Updates…).
    @Published private(set) var available = false
    @Published private(set) var canCheck = false
    /// A downloaded update waits for Counterpart to quit: Install and Relaunch, or a dismissed Ready to Install.
    private var staging = UpdateGate.Staging()
    var staged: Bool { staging.staged }
    private var waitingAlert: NSAlert?

    override init() {
        super.init()
        let key = Bundle.main.object(forInfoDictionaryKey:"SUPublicEDKey") as? String ?? ""
        let feed = Bundle.main.object(forInfoDictionaryKey:"SUFeedURL") as? String ?? ""
        guard Data(base64Encoded:key)?.count == 32, URL(string:feed)?.scheme == "https",
              !Translocation.isTranslocated(Bundle.main.bundleURL) else { return }
        let controller = SPUStandardUpdaterController(startingUpdater:true,updaterDelegate:self,userDriverDelegate:nil)
        controller.updater.automaticallyChecksForUpdates = true
        controller.updater.automaticallyDownloadsUpdates = false
        self.controller = controller
        available = true
        observation = controller.updater.observe(\.canCheckForUpdates, options:[.initial, .new]) { [weak self] updater, _ in
            let value = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheck = value }
        }
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }

    // No `updater(_:mayPerform:)`: every check is allowed. No `feedURLStringForUpdater(_:)` either, so a `SUFeedURL`
    // user default still points a test install at a test appcast (README, "Updates and distribution").

    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) { staging.apply(.extracted) }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { staging.apply(.installing) }
    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem, state: SPUUserUpdateState) {
        // Skip cancels an update that began installing. Any other answer once Sparkle's installer has started leaves it
        // to install on quit; a downloaded update whose installer hasn't started doesn't install on quit.
        staging.apply(.choice(skip:choice == .skip, installerStarted:state.stage == .installing))
    }

    /// Review F6: an aborted update installs nothing on quit, so the next quit leaves the agent alone. "No update found"
    /// says nothing about one already waiting to install.
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        staging.apply(.aborted(noUpdateFound:(error as NSError).code == Int(SUError.noUpdateError.rawValue)))
    }

    /// Install and Relaunch: wait until no work would be cut short, then let Sparkle quit and replace the app.
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        staging.apply(.installing)
        Task { @MainActor in
            await waitUntilIdle(announce:true)
            installHandler()
        }
        return true
    }

    /// The companion's projects, from its control socket.
    nonisolated static func projects(timeout: TimeInterval = 10) async -> Result<[Project], Error> {
        do {
            let path = ModelAccessModel.socketPath(for:Installation(bundle:.main))
            return .success(try await ControlClient(socketPath:path, timeout:timeout).objects())
        } catch { return .failure(error) }
    }

    private func waitUntilIdle(announce: Bool) async {
        var told = false
        var waiter = UpdateGate.Waiter()
        while !Task.isCancelled, waiter.next(await Self.projects()) == .wait {
            if announce && !told { told = true; showWaiting() }
            try? await Task.sleep(for:.seconds(15))
        }
        if announce { closeWaiting() }
    }

    /// The sentence in its own small window, not a modal alert: the wait goes on behind it and closes it when done.
    /// With `dontQuit`, a refused quit's window: OK leaves the quit pending, Don't Quit calls it off (review R2).
    private func showWaiting(dontQuit: (() -> Void)? = nil) {
        closeWaiting() // review R1: never stacked
        let alert = NSAlert()
        alert.messageText = UpdateGate.waitingSentence
        alert.addButton(withTitle:"OK")
        alert.buttons.first?.target = self
        alert.buttons.first?.action = #selector(closeWaiting)
        if let dontQuit {
            alert.addButton(withTitle:"Don’t Quit")
            alert.buttons.last?.target = self
            alert.buttons.last?.action = #selector(callOffQuit)
            self.dontQuit = dontQuit
        }
        alert.layout()
        waitingAlert = alert
        NSApp.activate()
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
    }
    /// A plain sentence in its own small window (#850: the companion didn't come back).
    private func showNotice(_ text: String) {
        closeWaiting()
        let alert = NSAlert()
        alert.messageText = text
        alert.addButton(withTitle:"OK")
        alert.buttons.first?.target = self
        alert.buttons.first?.action = #selector(closeWaiting)
        alert.layout()
        waitingAlert = alert
        NSApp.activate()
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
    }
    @objc private func closeWaiting() {
        waitingAlert?.window.orderOut(nil)
        waitingAlert = nil
    }
    private var dontQuit: (() -> Void)?
    @objc private func callOffQuit() { let callOff = dontQuit; dontQuit = nil; callOff?() }

    /// The quit path with its real effects (`UpdateQuit`).
    private(set) lazy var quit = UpdateQuit(effects:.init(
        ask: { await Self.askOnce() },
        unregister: { await Self.unregisterAgent() },
        waitForJobGone: { await Self.waitForJobGone() },
        record: { UserDefaults.standard.set($0, forKey:Self.agentKey) },
        waitUntilIdle: { [weak self] in await self?.waitUntilIdle(announce:false) },
        showWaiting: { [weak self] callOff in self?.showWaiting(dontQuit:callOff) },
        closeWaiting: { [weak self] in self?.closeWaiting() },
        terminate: { NSApp.terminate(nil) }))

    /// One ask, answered within 4 s or taken as working (review F1).
    private static func askOnce() async -> UpdateGate.Decision {
        await withTaskGroup(of:UpdateGate.Decision.self) { group in
            group.addTask { UpdateGate.decide(await Self.projects(timeout:3)) }
            group.addTask { try? await Task.sleep(for:.seconds(4)); return .wait }
            let first = await group.next() ?? .wait
            group.cancelAll()
            return first
        }
    }

    /// Unregistering stops the agent; bounded at 10 s (review F5), past which the request stands.
    private static func unregisterAgent() async -> UpdateQuit.Unregister {
        let installation = Installation(bundle:.main)
        guard installation.service.status == .enabled else { return .done }
        let plist = installation.label + ".plist"
        return await withTaskGroup(of:UpdateQuit.Unregister.self) { group in
            group.addTask {
                do { try await SMAppService.agent(plistName:plist).unregister(); return .done } catch { return .refused }
            }
            group.addTask { try? await Task.sleep(for:.seconds(10)); return .timedOut }
            let first = await group.next() ?? .timedOut
            group.cancelAll()
            return first
        }
    }

    /// Unregistering boots the job out; wait (briefly) until launchd no longer has it, so Node has exited.
    private static func waitForJobGone() async {
        let target = "gui/\(getuid())/\(Installation(bundle:.main).label)"
        for _ in 0..<20 {
            let present = await Task.detached {
                (try? command(URL(fileURLWithPath:"/bin/launchctl"), ["print", target])) != nil
            }.value
            if !present { break }
            try? await Task.sleep(for:.milliseconds(500))
        }
    }

    /// At launch, after an update: register the agent stopped for it, or restart one an update replaced while it worked.
    func resumeAgentAfterUpdate() {
        let installation = Installation(bundle:.main)
        switch UserDefaults.standard.string(forKey:Self.agentKey) {
        case "stopped"?:
            // A failure (approval needed) leaves the key, so the next launch tries again; pairing says what to allow.
            guard (try? RegisteredAgent(service:installation.service).register()) != nil else { return }
            UserDefaults.standard.removeObject(forKey:Self.agentKey)
        case "outdated"?:
            // Review R1: launchd refused to stop it for the update, so it may still run the old app's code; the build
            // check (#850) restarts it once idle.
            UserDefaults.standard.removeObject(forKey:Self.agentKey)
        default: return
        }
    }

    /// #850, at every launch: a companion launched by another build (an app replaced by hand, or one before #850, which
    /// doesn't say) is restarted to run this app's payload, once idle. Only for the installed app with its agent enabled:
    /// a development build elsewhere never restarts the installed app's companion.
    func checkCompanionBuild() {
        let installation = Installation(bundle:.main)
        let path = installation.bundle.bundleURL.resolvingSymlinksInPath().path
        let userApps = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/"
        guard path.hasPrefix("/Applications/") || path.hasPrefix(userApps), installation.service.status == .enabled,
              let build = installation.bundle.object(forInfoDictionaryKey:"CFBundleVersion") as? String, !build.isEmpty else { return }
        let socket = ModelAccessModel.socketPath(for:installation), target = "gui/\(getuid())/\(installation.label)"
        let check = CompanionBuildCheck(appBuild:build, appPayload:installation.resources.appendingPathComponent("Payload").path, effects:.init(
            status: {
                do {
                    let status = try await ControlClient(socketPath:socket, timeout:5).status()
                    return .success(.init(build:status.appBuild, payload:status.appPayload))
                } catch { return .failure(error) }
            },
            ask: { await Self.askOnce() },
            waitUntilIdle: { [weak self] in await self?.waitUntilIdle(announce:true) },
            restart: { _ = try? await Task.detached { try command(URL(fileURLWithPath:"/bin/launchctl"), ["kickstart", "-k", target]) }.value },
            pause: { try? await Task.sleep(for:.seconds(CompanionBuildCheck.pauseSeconds)) },
            say: { [weak self] in self?.showNotice($0) }))
        Task { @MainActor in _ = await check.run() }
    }
}

/// The app menu's Check for Updates…, Sparkle's standard item; absent from builds without Sparkle (development).
private struct CheckForUpdatesButton: View {
    @ObservedObject var updates: Updates
    var body: some View {
        if updates.available {
            Button("Check for Updates…") { updates.checkForUpdates() }
                .disabled(!updates.canCheck)
        }
    }
}

/// #829: opened straight from Downloads, macOS runs a read-only copy that can't start the companion. Say so, once,
/// instead of the pairing window's "couldn't make a code"; the button shows the person's copy in Finder.
enum TranslocationNotice {
    @MainActor static func show() {
        let alert = NSAlert()
        alert.messageText = Translocation.sentence
        alert.addButton(withTitle:"Show in Finder")
        alert.addButton(withTitle:"Quit")
        NSApp.activate()
        if alert.runModal() == .alertFirstButtonReturn {
            if let original = Translocation.originalURL(of:Bundle.main.bundleURL) {
                NSWorkspace.shared.activateFileViewerSelecting([original])
            } else {
                NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads"))
            }
        }
        NSApp.terminate(nil)
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
