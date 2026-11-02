import SwiftUI
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

/// Find your Mac until a Mac is paired; the projects after that.
struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        Group {
            if app.status == nil {
                Color(uiColor: .systemBackground).ignoresSafeArea()
            } else if app.needsMac || app.holdPairingScreen {
                FindYourMacView(mode: .firstRun)
            } else {
                ObjectsRootView(store: app.objects, pairingKey: app.pairingKey)
            }
        }
        .fullScreenCover(isPresented: $app.showPairing) {
            FindYourMacView(mode: .replace)
                .environment(app)
                .tint(.filament)
        }
    }
}

extension Color {
    /// Counterpart's accent, "filament orange" (PRD §10): the primary action, selection and Ready only.
    static let filament = Color(red: 1.0, green: 0.45, blue: 0.18)
    static let okGreen = Color(red: 0.25, green: 0.84, blue: 0.47)
}
