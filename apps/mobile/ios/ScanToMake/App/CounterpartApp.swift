import SwiftUI
import UserNotifications
import CounterpartKit

/// Counterpart for iPhone and iPad: a SwiftUI app, no other runtime (PRD §3).
@main
struct CounterpartApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(.filament)
                .onOpenURL { app.open($0) }
                .task { await app.keepFresh() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await app.keepFresh() } }
                }
        }
    }
}

/// Which first-run step shows (PRD §5.10). A paired phone always shows Home, whatever else is undecided:
/// Welcome is only for an unpaired first launch, and the notifications question only comes straight after
/// pairing on this phone. Nothing here waits on the system, so no state can leave the window empty.
enum FirstRunStep: Equatable {
    case loading, welcome, pair, notify, home

    static func step(statusKnown: Bool, paired: Bool, holdPairing: Bool, welcomed: Bool, justPaired: Bool,
                     notificationsUndecided: Bool?, askedNotifications: Bool) -> FirstRunStep {
        guard statusKnown else { return .loading }
        if !paired { return welcomed ? .pair : .welcome }
        // The pairing screen holds its success state for a moment after pairing.
        if holdPairing { return .pair }
        if justPaired && !askedNotifications && notificationsUndecided == true { return .notify }
        return .home
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @AppStorage(FirstRun.welcomedKey) private var welcomed = false
    @AppStorage(FirstRun.notificationsAskedKey) private var askedNotifications = false
    /// Nil until the system says whether it has asked before.
    @State private var notificationsUndecided: Bool?
    /// A Mac was paired during this run: the moment to ask about notifications.
    @State private var justPaired = false
    /// DEBUG: `-CounterpartScreen welcome` shows Welcome over a paired canned Mac.
    @State private var debugWelcome = false

    private var step: FirstRunStep {
        FirstRunStep.step(statusKnown: app.status != nil, paired: !app.needsMac, holdPairing: app.holdPairingScreen, welcomed: welcomed,
                          justPaired: justPaired, notificationsUndecided: notificationsUndecided, askedNotifications: askedNotifications)
    }

    var body: some View {
        @Bindable var app = app
        Group {
            if debugWelcome {
                WelcomeView { debugWelcome = false }
            } else {
                switch step {
                case .loading: Color(uiColor: .systemBackground).ignoresSafeArea()
                case .welcome: WelcomeView { withAnimation { welcomed = true } }
                case .pair: FindYourMacView(mode: .firstRun)
                case .notify: NotifyPermissionView { withAnimation { askedNotifications = true } }
                case .home: ProjectsRoot(store: app.projects, pairingKey: app.pairingKey)
                }
            }
        }
        .fullScreenCover(isPresented: $app.showPairing) {
            FindYourMacView(mode: .replace)
                .environment(app)
                .tint(.filament)
        }
        .onChange(of: app.needsMac) { wasUnpaired, unpaired in if wasUnpaired && !unpaired { justPaired = true } }
        .task { notificationsUndecided = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined }
        #if DEBUG
        .onChange(of: app.debugFirstRun, initial: true) { _, step in
            switch step {
            case "welcome": debugWelcome = true
            case "notify": justPaired = true; notificationsUndecided = true; askedNotifications = false
            default: break
            }
        }
        #endif
    }
}
