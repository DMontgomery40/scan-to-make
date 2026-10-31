import SwiftUI
import Sparkle
import ServiceManagement
import AgentKit
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
        ScanToMakeApp.main()
    }
}

struct ScanToMakeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = CompanionModel.shared
    @State private var isInserted = true
    var body: some Scene {
        MenuBarExtra(isInserted:$isInserted) {
            MenuBarPopover(model:model)
        } label: {
            Image(nsImage:.menuBarCube)
        }.menuBarExtraStyle(.window)
    }
}

/// The pairing code and nothing else (journey.md §3.4, mockup 09): no title, caption or status line.
/// Without a code it shows a spinner, or one plain sentence and Try again.
struct PairingView: View {
    @ObservedObject var model: CompanionModel
    let side: CGFloat
    @State private var presentationID = UUID()
    var body: some View {
        ZStack {
            if let qr = model.qr {
                Image(nsImage:qr).interpolation(.none).resizable().scaledToFit()
                    .accessibilityLabel("Pairing QR code")
            } else if let message = failureMessage {
                VStack(spacing:14) {
                    Text(message).font(.system(size:13)).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).fixedSize(horizontal:false,vertical:true)
                    Button("Try again") { Task { await model.preparePairing() } }.disabled(model.working)
                }
                .padding(.horizontal,12)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width:side,height:side)
        .environment(\.colorScheme,.light)
        .task { await model.presentPairing(presentationID) }
        .onDisappear { model.hidePairing(presentationID) }
    }
    private var failureMessage: String? {
        guard let failure = model.failure else { return nil }
        switch failure as? AgentError {
        case .approvalRequired?: return "Allow Scan to Make in System Settings → General → Login Items."
        case .companionUnavailable?: return "Scan to Make couldn’t start in the background."
        default: return "Scan to Make couldn’t make a code."
        }
    }
}

/// Mockup 09's QR-only window: 360 wide, white, the code at 292 pt. The title bar is transparent over the
/// white window, so the traffic lights are the only chrome; its 32 pt plus the top padding make the mockup's 49.
struct PairingWindowContent: View {
    @ObservedObject var model: CompanionModel
    var body: some View {
        PairingView(model:model,side:292)
            .padding(EdgeInsets(top:17,leading:34,bottom:51,trailing:34))
            .background(Color.white)
    }
}

/// The menu-bar popover: the same code on white, with mockup 08's footer reduced to Quit.
/// The app has no Dock icon or main menu, so this is the only ordinary way to quit it.
struct MenuBarPopover: View {
    @ObservedObject var model: CompanionModel
    var body: some View {
        VStack(spacing:0) {
            PairingView(model:model,side:292)
                .padding(40)
                .background(Color.white)
            Divider()
            HStack {
                Button { SettingsWindow.shared.show() } label: { Label("Settings…", systemImage:"gearshape") }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .keyboardShortcut(",")
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .keyboardShortcut("q")
            }
            .font(.system(size:12.5))
            .padding(EdgeInsets(top:11,leading:12,bottom:13,trailing:12))
        }
        .frame(width:372)
    }
}

extension NSImage {
    /// Mockup 08's `logo-mono` cube (24-unit viewBox), drawn as a template so the menu bar tints it.
    static let menuBarCube: NSImage = {
        let image = NSImage(size:NSSize(width:18,height:18), flipped:true) { _ in
            let scale: CGFloat = 18.0 / 24.0
            func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x:x * scale, y:y * scale) }
            let path = NSBezierPath()
            path.move(to:point(12,3)); path.line(to:point(20,7.6)); path.line(to:point(20,16.4))
            path.line(to:point(12,21)); path.line(to:point(4,16.4)); path.line(to:point(4,7.6)); path.close()
            path.move(to:point(4,7.6)); path.line(to:point(12,12.2)); path.line(to:point(20,7.6))
            path.move(to:point(12,12.2)); path.line(to:point(12,21))
            path.lineWidth = 1.7 * scale
            path.lineJoinStyle = .round
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Scan to Make"
        return image
    }()
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var phoneWatch: Task<Void, Never>?
    private var showingSetup = false
    private lazy var setupModel = ModelAccessModel(installation:Installation(bundle:.main))
    private let updates = Updates()
    func applicationDidFinishLaunching(_ notification: Notification) {
        if Installation(bundle:.main).variant.isEmpty && SMAppService.mainApp.status == .notRegistered {
            try? SMAppService.mainApp.register()
        }
        let event = NSAppleEventManager.shared().currentAppleEvent
        let loginLaunch = event?.eventID == kAEOpenApplication
            && event?.paramDescriptor(forKeyword:keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        if !loginLaunch { showPairing() }
    }
    func windowWillClose(_ notification: Notification) {
        phoneWatch?.cancel()
        showingSetup = false
        window?.contentView = nil
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPairing(); return true
    }
    /// Mockup 09: once a phone connects, the QR window becomes the setup questions (first run only).
    private func watchForPhone() {
        phoneWatch?.cancel()
        let socket = ModelAccessModel.socketPath(for:Installation(bundle:.main))
        phoneWatch = Task { [weak self] in
            var baseline: Int?
            while !Task.isCancelled {
                if let count = try? await ControlClient(socketPath:socket).status().pairedDeviceCount {
                    // A new phone, or a phone paired before setup was finished.
                    let unfinished = !UserDefaults.standard.bool(forKey:"setupFinished")
                    if let baseline, count > baseline { self?.phoneConnected(); return }
                    if baseline == nil, count > 0, unfinished { self?.phoneConnected(); return }
                    baseline = baseline ?? count
                }
                try? await Task.sleep(for:.seconds(2))
            }
        }
    }
    private func phoneConnected() {
        guard let window, window.isVisible else { return }
        guard !UserDefaults.standard.bool(forKey:"setupFinished") else { window.close(); return }
        showingSetup = true
        window.backgroundColor = .windowBackgroundColor
        window.appearance = nil
        window.contentView = NSHostingView(rootView:SetupView(model:setupModel) { [weak self] in
            UserDefaults.standard.set(true, forKey:"setupFinished")
            self?.window?.close()
        })
        // Mockup 09: setup is 720 × 520. Grow from the code's window around its centre; the hosting
        // view alone doesn't resize a window whose content was swapped after it was shown.
        var frame = window.frameRect(forContentRect:NSRect(x:0, y:0, width:720, height:520))
        frame.origin = NSPoint(x:window.frame.midX - frame.width / 2, y:window.frame.midY - frame.height / 2)
        window.setFrame(window.constrainFrameRect(frame, to:window.screen), display:true, animate:true)
    }
    private func showPairing() {
        // Reopening the app brings an open setup forward instead of replacing it with the code.
        if showingSetup, let window, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps:true)
            return
        }
        if window == nil {
            let window = NSWindow(contentRect:NSRect(x:0,y:0,width:360,height:360),
                                  styleMask:[.titled,.closable],backing:.buffered,defer:false)
            window.title = "Scan to Make" // Window menu and VoiceOver only; never drawn.
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.backgroundColor = .white
            window.appearance = NSAppearance(named:.aqua)
            window.isMovableByWindowBackground = true
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            self.window = window
        }
        window?.backgroundColor = .white
        window?.appearance = NSAppearance(named:.aqua)
        window?.setContentSize(NSSize(width:360, height:360)) // back from setup's 720 × 520
        window?.contentView = NSHostingView(rootView:PairingWindowContent(model:CompanionModel.shared))
        watchForPhone()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
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
            throw NSError(domain:"com.scantomake.mac.updates",code:1,userInfo:[NSLocalizedDescriptionKey:"Updates wait until the companion is stopped."])
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
