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

/// First run (PRD §5.10): Welcome, then Find your Mac until a Mac is paired, then the notifications
/// question once, then the projects.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @AppStorage(FirstRun.welcomedKey) private var welcomed = false
    @AppStorage(FirstRun.notificationsAskedKey) private var askedNotifications = false
    /// Nil until the system says whether it has asked before.
    @State private var notificationsUndecided: Bool?
    /// DEBUG: `-CounterpartScreen welcome` shows Welcome over a paired canned Mac.
    @State private var debugWelcome = false

    var body: some View {
        @Bindable var app = app
        Group {
            if app.status == nil {
                Color(uiColor: .systemBackground).ignoresSafeArea()
            } else if debugWelcome {
                WelcomeView { debugWelcome = false }
            } else if app.needsMac || app.holdPairingScreen {
                if !welcomed && app.needsMac && !app.holdPairingScreen { WelcomeView { withAnimation { welcomed = true } } }
                else { FindYourMacView(mode: .firstRun) }
            } else if notificationsUndecided == nil {
                // Until the system says whether it asked before, nothing mounts that could take a pending route.
                Color(uiColor: .systemBackground).ignoresSafeArea()
            } else if notificationsUndecided == true && !askedNotifications {
                NotifyPermissionView { withAnimation { askedNotifications = true } }
            } else {
                ProjectsRoot(store: app.projects, pairingKey: app.pairingKey)
            }
        }
        .fullScreenCover(isPresented: $app.showPairing) {
            FindYourMacView(mode: .replace)
                .environment(app)
                .tint(.filament)
        }
        .task {
            // Someone upgrading with a Mac already paired has seen what Welcome says.
            if app.status?.state == .paired { welcomed = true }
            notificationsUndecided = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined
            #if DEBUG
            if app.debugFirstRun == nil, Fixtures.folder != nil { askedNotifications = true }
            #endif
        }
        #if DEBUG
        // The debug route can arrive after the first look at the notification settings.
        .onChange(of: app.debugFirstRun, initial: true) { _, step in
            switch step {
            case "welcome": debugWelcome = true
            case "notify": notificationsUndecided = true; askedNotifications = false
            default: break
            }
        }
        #endif
    }
}
