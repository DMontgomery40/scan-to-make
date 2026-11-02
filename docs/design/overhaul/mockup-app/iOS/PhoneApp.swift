import SwiftUI

/// Launch with `-screen <name>` to open one mockup state.
@main
struct CounterpartMockApp: App {
    var body: some Scene {
        WindowGroup {
            Router(screen: UserDefaults.standard.string(forKey: "screen") ?? "home")
                .tint(.filament)
                .preferredColorScheme(UserDefaults.standard.string(forKey: "light") == "1" ? .light : .dark)
        }
    }
}

struct Router: View {
    let screen: String
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        switch screen {
        case "new": HomeView(showNew: true)
        case "working": NavigationStack { ProjectView(project: Mock.projects[1]) }
        case "ask": NavigationStack { ProjectView(project: Mock.projects[3]) }
        case "ready": NavigationStack { ProjectView(project: Mock.projects[0]) }
        case "inputs": NavigationStack { ProjectView(project: Mock.projects[0], section: .inputs) }
        case "print": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PrintSheet() }
        case "plate": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PlateCheckSheet() }
        case "printing": NavigationStack { PrintingView(project: Mock.projects[2]) }
        case "lock": LockScreenMock()
        case "hand": InHandCaptureMock()
        case "rig": RigCaptureMock()
        case "printers": NavigationStack { PrintersView() }
        case "split": SplitHome()
        // First run and pairing (§5.10)
        case "welcome": WelcomeView()
        case "pair": FindMacView()
        case "notify": NotifyPermissionView()
        // Home empty, project failed (§5.1, §5.4)
        case "empty": HomeView(empty: true)
        case "failed": NavigationStack { ProjectView(project: Mock.failedProject, section: .activity) }
        // Settings and About (§5.9)
        case "settings": Color.black.ignoresSafeArea().sheet(isPresented: .constant(true)) { PhoneSettingsView() }
        case "notifications": NavigationStack { NotificationSettingsView() }
        case "about": NavigationStack { AboutView() }
        // Print sheet variants and the MCP's confirmation (§5.5)
        case "print-one": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PrintSheet(variant: .oneColor) }
        case "print-noams": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PrintSheet(variant: .noAMS) }
        case "print-loaded": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PrintSheet(variant: .whatsLoaded) }
        case "confirm": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { PrintConfirmSheet() }
        case "confirm-mac": NavigationStack { ProjectView(project: Mock.projects[0]) }.sheet(isPresented: .constant(true)) { AnswerOnMacSheet() }
        // Printer detail (§5.8, §8.2)
        case "printer": NavigationStack { PrinterDetailView(printer: Mock.printers[0]) }
        case "printer-update": NavigationStack { PrinterDetailView(printer: Mock.enderOnline) }
        // System surfaces (§9.1, §9.4, §9.5): approximations
        case "notifs": NotificationStackMock()
        case "widgets": WidgetsHomeMock()
        case "widgets-lock": WidgetsLockMock()
        case "island": DynamicIslandMock()
        default:
            if hSize == .regular { SplitHome() } else { HomeView() }
        }
    }
}
