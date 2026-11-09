import SwiftUI
import CounterpartKit

/// The app once a Mac is paired: Home and a project on iPhone (and Duo folded); a sidebar and the project
/// side by side on iPad and Duo unfolded (PRD §6). New, Print and search have keyboard shortcuts.
struct ProjectsRoot: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var store: ProjectsStore
    let pairingKey: Int
    @Environment(\.horizontalSizeClass) private var width
    @State private var path: [String] = []
    @State private var detailPath: [String] = []
    @State private var selected: String?
    @State private var newSheet: NewSheetRequest?
    @State private var printing: IdentifiedProject?
    @State private var showSettings = false
    @State private var showPrinters = false

    var body: some View {
        Group {
            if width == .regular { split } else { stack }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $newSheet) { request in
            NewObjectView(store: store, job: request.job) { project in
                newSheet = nil
                open(project.id)
            }
            .presentationDetents([.large])
        }
        .sheet(item: $printing) { item in PrintSheet(store: store, projectId: item.id) }
        .sheet(isPresented: $showSettings) { SettingsView(store: store) }
        .sheet(isPresented: $showPrinters) { NavigationStack { PrintersView(store: store) } }
        .task(id: pairingKey) {
            store.reset()
            HandheldCapture.previewIfAsked()
            store.canScan = await store.mac.canScan()
            #if DEBUG
            // The screenshot comparisons show a LiDAR iPhone, as the mockups do; the Simulator has no LiDAR.
            if Fixtures.folder != nil { store.canScan = true }
            #endif
            await store.loadPrinters()
            await store.loadCapabilities()
        }
        .task(id: "\(pairingKey)#\(scenePhase)") {
            guard scenePhase == .active else { return }
            // Events received while suspended are intentionally skipped; refresh once when returning.
            await store.load()
            await store.follow()
        }
        #if DEBUG
        .task { if app.debugSettings != nil { showSettings = true } }
        #endif
        .onChange(of: app.route, initial: true) { _, route in
            guard let route else { return }
            app.route = nil
            switch route {
            case .project(let id), .camera(let id): open(id)
            case .printing(let id): open(id); if width == .regular { detailPath = [Page.printing(id)] } else { path.append(Page.printing(id)) }
            case .print(let id): open(id); printing = IdentifiedProject(id: id)
            case .newProject: newSheet = NewSheetRequest(job: nil)
            case .printers: showPrinters = true
            case .home, .pair: path.removeAll(); selected = nil
            }
        }
    }

    /// Opens a project. On iPad the detail's pushed pages belong to the previous project, so they go too:
    /// otherwise a starter added from the sidebar landed on the old project's Printing screen.
    private func open(_ id: String) {
        if width == .regular { selected = id; detailPath = [] } else { path = [id] }
    }

    private var stack: some View {
        NavigationStack(path: $path) {
            HomeView(store: store, path: $path, newProject: { newSheet = NewSheetRequest(job: $0) },
                     openPrinters: { showPrinters = true }, openSettings: { showSettings = true })
                .navigationDestination(for: String.self) { id in page(id) { path.removeAll() } }
        }
    }

    private var split: some View {
        NavigationSplitView {
            SidebarList(store: store, selection: Binding(get: { selected }, set: { selected = $0; detailPath = [] }), newProject: { newSheet = NewSheetRequest(job: nil) },
                        addStarter: addStarter, openPrinters: { showPrinters = true }, openSettings: { showSettings = true })
        } detail: {
            if let selected {
                NavigationStack(path: $detailPath) {
                    projectPage(selected) { self.selected = nil }
                        .navigationDestination(for: String.self) { id in page(id) { detailPath.removeAll() } }
                }
                .id(selected)
            } else {
                // Nothing selected: the starters and the two jobs, as iPhone Home has them, whether or not
                // projects exist (PRD §5.11, §6.1). This is what the iPad shows when the app opens.
                StartPane(hasProjects: !store.projects.isEmpty, newProject: { newSheet = NewSheetRequest(job: $0) }, addStarter: addStarter)
            }
        }
    }

    /// A starter becomes a project on the Mac, which then opens (PRD §5.11).
    private func addStarter(_ starter: StarterProject) async throws {
        let ticket = store.startRequest()
        let project = try await store.mac.client.addStarter(starter)
        store.replace(project, ticket: ticket)
        open(project.id)
    }

    private func projectPage(_ id: String, close: @escaping () -> Void) -> some View {
        ProjectView(store: store, id: id, close: close, openPrint: { printing = IdentifiedProject(id: $0) },
                    openPrinting: { id in if width == .regular { detailPath.append(Page.printing(id)) } else { path.append(Page.printing(id)) } })
    }

    /// A pushed page: a project, or a print's Printing screen.
    @ViewBuilder private func page(_ value: String, close: @escaping () -> Void) -> some View {
        if let id = Page.printingId(value) { PrintingView(store: store, id: id) } else { projectPage(value, close: close) }
    }
}

/// Navigation values are strings: a project id, or `printing:<id>` for its Printing screen.
enum Page {
    static func printing(_ id: String) -> String { "printing:" + id }
    static func printingId(_ value: String) -> String? { value.hasPrefix("printing:") ? String(value.dropFirst("printing:".count)) : nil }
}

struct NewSheetRequest: Identifiable { let id = UUID(); let job: NewProjectJob? }
struct IdentifiedProject: Identifiable { let id: String }

/// The iPad detail with no project selected: what to start with, never an empty "Choose a project".
struct StartPane: View {
    let hasProjects: Bool
    let newProject: (NewProjectJob?) -> Void
    let addStarter: (StarterProject) async throws -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text(hasProjects ? "Choose a project, or start something new" : "Your next project starts here")
                    .font(.largeTitle.bold())
                StarterProjectsView(start: addStarter)
                EmptyHome(start: newProject)
            }
            .padding(24).frame(maxWidth: 680, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color.black)
    }
}

/// The iPad and Duo sidebar: Now, Needs you, Ready, Printed, the rest, and the starters (PRD §6, screens/ipad-split.jpg).
struct SidebarList: View {
    @Bindable var store: ProjectsStore
    @Binding var selection: String?
    let newProject: () -> Void
    let addStarter: (StarterProject) async throws -> Void
    let openPrinters: () -> Void
    let openSettings: () -> Void
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var showArchived = false
    @State private var openedStarter: StarterProject?

    private func matches(_ project: Project) -> Bool {
        project.matchesSearch(query, additional: [store.printerName(project) ?? ""])
    }

    /// The projects in these phases, in the order the phases are given (printing before working, as on Home).
    /// Archived projects are only in Archived.
    private func group(_ phases: [ProjectPhase]) -> [Project] {
        // A scan still on this phone needs you (Send to your Mac or Scan again), so it's listed
        // near the top, not under Other where David couldn't find his unicorn (Nov 9).
        let phase = { (p: Project) in store.localScanWords(p) != nil ? ProjectPhase.needsYou : store.words(p).phase }
        let rank = { (p: Project) in phases.firstIndex(of: phase(p)) ?? phases.count }
        return store.projects.enumerated()
            .filter { !$0.element.isArchived && phases.contains(phase($0.element)) }
            .filter { matches($0.element) }
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
    }
    private var archived: [Project] { store.projects.filter { $0.isArchived && matches($0) } }

    var body: some View {
        VStack(spacing: 0) {
            ProjectSearchBar(query: $query, searching: $searching, matched: store.projects.filter { matches($0) }.count, total: store.projects.count)
        List(selection: $selection) {
            section("Now", group([.printing, .preparing, .working, .sending]))
            section("Needs you", group([.needsYou]))
            section("Ready", group([.ready]), highlight: true)
            section("Done", group([.confirmed]))
            section("Printed", group([.printed, .sent]))
            section("Other", group([.draft, .failed, .unknown]))
            if !archived.isEmpty {
                Section(isExpanded: Binding(get: { showArchived || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }, set: { showArchived = $0 })) {
                    ForEach(archived) { project in
                        SidebarRow(store: store, project: project)
                            .tag(project.id)
                            .listRowBackground(selection == project.id ? Color.filament.opacity(0.32) : nil)
                            .contextMenu {
                                Button("Unarchive", systemImage: "tray.and.arrow.up") {
                                    Task { let ticket = store.startRequest(); if let next = try? await store.archive(project, false) { store.replace(next, ticket: ticket) } else { await store.reload(project.id) } }
                                }
                                DeleteProjectButton(store: store, project: project)
                            }
                    }
                } header: { Text("Archived · \(archived.count)") }
            }
            // The starters stay one tap away while a project is open, as at the end of iPhone Home.
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Section("Start with these") {
                    ForEach(StarterProject.all) { starter in
                        Button { openedStarter = starter } label: { StarterRow(starter) }
                            .accessibilityIdentifier("sidebar-starter-\(starter.id)")
                    }
                }
            }
        }
            // New has its own bar under the list, as search has above it. As a bottom-bar toolbar item it was a
            // floating "+" over whichever row sat behind it (iPad build 202611052142, Nov 5).
            Button(action: newProject) {
                Label("New Project", systemImage: "plus").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent).controlSize(.large)
            .accessibilityIdentifier("new-project")
            .keyboardShortcut("n", modifiers: .command)
            .padding(.horizontal, 16).padding(.vertical, 10)
        }
        .sheet(item: $openedStarter) { starter in StarterDetail(project: starter, start: addStarter) }
        .navigationTitle("Projects")
        .navigationSubtitle(store.reachable == false ? "\(store.macName ?? "Your Mac") isn't answering" : store.reachable == true ? "\(store.macName ?? "Your Mac") connected" : store.macName ?? "Your Mac")

        .background { Button("Search") { searching = true }.keyboardShortcut("f", modifiers: .command).hidden() }
        .refreshable { await store.load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button(action: openPrinters) { Image(systemName: "printer.fill") }.accessibilityLabel("Printers") }
            ToolbarItem(placement: .topBarTrailing) { Button(action: openSettings) { Image(systemName: "person.crop.circle") }.accessibilityLabel("Settings") }
        }
    }

    @ViewBuilder private func section(_ title: String, _ projects: [Project], highlight: Bool = false) -> some View {
        if !projects.isEmpty {
            Section(title) {
                ForEach(projects) { project in
                    SidebarRow(store: store, project: project)
                        .tag(project.id)
                        .listRowBackground(selection == project.id ? Color.filament.opacity(0.32) : highlight ? Color.filament.opacity(0.12) : nil)
                        .contextMenu { DeleteProjectButton(store: store, project: project) }
                }
            }
        }
    }
}

struct SidebarRow: View {
    let store: ProjectsStore
    let project: Project
    @Environment(\.backgroundProminence) private var prominence
    var body: some View {
        let words = store.words(project)
        HStack(spacing: 12) {
            ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 160).frame(width: 44, height: 44).clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(words.title).font(.body.weight(.semibold)).lineLimit(1)
                // A scan still on this phone, as on Home's card.
                Text(store.localScanWords(project) ?? words.line).font(.caption).foregroundStyle(prominence == .increased ? .white.opacity(0.9) : words.phase.color).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
