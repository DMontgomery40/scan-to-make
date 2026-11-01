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
        default:
            if hSize == .regular { SplitHome() } else { HomeView() }
        }
    }
}
