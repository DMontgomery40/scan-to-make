import SwiftUI
import CounterpartKit

/// The app once a Mac is paired: Home and a project on iPhone (and Duo folded); a sidebar and the project
/// side by side on iPad and Duo unfolded (PRD §6). New, Print and search have keyboard shortcuts.
struct ProjectsRoot: View {
    @Environment(AppModel.self) private var app
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
            await store.load()
            await store.loadPrinters()
            await store.loadCapabilities()
        }
        .task(id: pairingKey) { await store.follow() }
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

    private func open(_ id: String) {
        if width == .regular { selected = id } else { path = [id] }
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
                        openPrinters: { showPrinters = true }, openSettings: { showSettings = true })
        } detail: {
            if let selected {
                NavigationStack(path: $detailPath) {
                    projectPage(selected) { self.selected = nil }
                        .navigationDestination(for: String.self) { id in page(id) { detailPath.removeAll() } }
                }
                .id(selected)
            } else if store.loaded && store.projects.isEmpty {
                ScrollView { EmptyHome { newSheet = NewSheetRequest(job: $0) }.padding(24).frame(maxWidth: 640) }.background(Color.black)
            } else {
                ContentUnavailableView("Choose a project", systemImage: "cube", description: Text("Its model, what you sent and what your Mac did show here."))
                    .background(Color.black)
            }
        }
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

/// The iPad and Duo sidebar: Now, Needs you, Ready, Printed, and the rest (PRD §6, screens/ipad-split.jpg).
struct SidebarList: View {
    @Bindable var store: ProjectsStore
    @Binding var selection: String?
    let newProject: () -> Void
    let openPrinters: () -> Void
    let openSettings: () -> Void
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var showArchived = false

    private func matches(_ project: Project) -> Bool {
        query.isEmpty || ProjectWords.title(project).localizedCaseInsensitiveContains(query) || (project.instructions ?? "").localizedCaseInsensitiveContains(query)
    }

    /// The projects in these phases, in the order the phases are given (printing before working, as on Home).
    /// Archived projects are only in Archived.
    private func group(_ phases: [ProjectPhase]) -> [Project] {
        let rank = { (p: Project) in phases.firstIndex(of: store.words(p).phase) ?? phases.count }
        return store.projects.enumerated()
            .filter { !$0.element.isArchived && phases.contains(store.words($0.element).phase) }
            .filter { matches($0.element) }
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
    }
    private var archived: [Project] { store.projects.filter { $0.isArchived && matches($0) } }

    var body: some View {
        List(selection: $selection) {
            section("Now", group([.printing, .preparing, .working, .sending]))
            section("Needs you", group([.needsYou]))
            section("Ready", group([.ready]), highlight: true)
            section("Done", group([.confirmed]))
            section("Printed", group([.printed, .sent]))
            section("Other", group([.draft, .failed, .unknown]))
            if !archived.isEmpty {
                Section(isExpanded: $showArchived) {
                    ForEach(archived) { project in
                        SidebarRow(store: store, project: project)
                            .tag(project.id)
                            .listRowBackground(selection == project.id ? Color.filament.opacity(0.32) : nil)
                            .contextMenu {
                                Button("Unarchive", systemImage: "tray.and.arrow.up") {
                                    Task { if let next = try? await store.archive(project, false) { store.replace(next) } else { await store.reload(project.id) } }
                                }
                                DeleteProjectButton(store: store, project: project)
                            }
                    }
                } header: { Text("Archived · \(archived.count)") }
            }
        }
        .navigationTitle("Projects")
        .navigationSubtitle(store.reachable == false ? "\(store.macName ?? "Your Mac") isn't answering" : "\(store.macName ?? "Your Mac") connected")
        .searchable(text: $query, prompt: "Projects, printers, notes")
        .searchFocused($searching)
        .background { Button("Search") { searching = true }.keyboardShortcut("f", modifiers: .command).hidden() }
        .refreshable { await store.load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button(action: openPrinters) { Image(systemName: "printer.fill") }.accessibilityLabel("Printers") }
            ToolbarItem(placement: .topBarTrailing) { Button(action: openSettings) { Image(systemName: "person.crop.circle") }.accessibilityLabel("Settings") }
            ToolbarItem(placement: .bottomBar) {
                Button(action: newProject) { Label("New", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut("n", modifiers: .command)
            }
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
                Text(words.line).font(.caption).foregroundStyle(prominence == .increased ? .white.opacity(0.9) : words.phase.color).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
