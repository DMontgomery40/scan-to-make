import SwiftUI
import Sparkle
import ServiceManagement

@main enum EntryPoint {
    static func main() {
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
        MenuBarExtra("Scan to Make", systemImage:"qrcode", isInserted:$isInserted) {
            PairingView(model:model)
        }.menuBarExtraStyle(.window)
    }
}

struct PairingView: View {
    @ObservedObject var model: CompanionModel
    @State private var presentationID = UUID()
    var body: some View {
        VStack {
            if let qr = model.qr {
                Image(nsImage:qr).interpolation(.none).resizable().scaledToFit()
                    .frame(width:320,height:320).padding(20).background(.white)
                    .accessibilityLabel("Pairing QR code")
                Text("Scan with Scan to Make on your iPhone")
            } else if let error = model.error {
                Text(error)
                Button("Retry") { Task { await model.preparePairing() } }.disabled(model.working)
            } else {
                ProgressView("Getting your code ready…")
            }
        }
        .padding()
        .task { await model.presentPairing(presentationID) }
        .onDisappear { model.hidePairing(presentationID) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
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
        window?.contentView = nil
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPairing(); return true
    }
    private func showPairing() {
        if window == nil {
            let window = NSWindow(contentRect:NSRect(x:0,y:0,width:400,height:410),styleMask:[.titled,.closable],backing:.buffered,defer:false)
            window.title = "Scan to Make"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            self.window = window
        }
        window?.contentView = NSHostingView(rootView:PairingView(model:CompanionModel.shared))
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
