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
    /// The open project, the column a collapsed split shows and the one sheet that may be up: one value, whose
    /// transitions are unit-tested in CounterpartKit (`ProjectsNavigationTests`). Views say what happened.
    @State private var nav = ProjectsNavigation()
    /// The device has a hinge (iPhone Duo). Open, its inner display has a rail on the trailing edge where the system
    /// puts the detail column's toolbar buttons.
    @State private var hinged = false
    /// Duo open: Printers and Settings sit in that rail, as they do folded, and not in the sidebar's top bar where
    /// they crowded the title (David, Nov 10: "with the duo flipped open the settings and profile and print icons
    /// should go into the side edge"). An iPad has no hinge and no rail: they stay above its sidebar.
    private var railed: Bool { hinged && width == .regular }

    var body: some View {
        split
        .preferredColorScheme(.dark)
        // One sheet at a time. A route's sheet takes the place of Settings or Printers, never of New or Print
        // (`ProjectsNavigation.apply`).
        .sheet(item: Binding(get: { nav.presented }, set: { if $0 == nil { nav.dismissSheet() } })) { presented in
            switch presented.sheet {
            case .new(let job):
                NewObjectView(store: store, job: job.flatMap(NewProjectJob.init(rawValue:))) { project in
                    nav.dismissSheet()
                    nav.open(project.id)
                }
                .presentationDetents([.large])
                // The system's page size on the iPad (and the Mac): room for the question after a scan and its three
                // answers, not a small card over a dimmed Home (U5). The iPhone keeps its full-height sheet.
                .presentationSizing(.page)
            case .print(let id): PrintSheet(store: store, projectId: id)
            case .settings: SettingsView(store: store)
            case .printers: NavigationStack { PrintersView(store: store) }
            }
        }
        // A page under a sheet stays "appeared"; its notifications show while the sheet is up (F7).
        .onChange(of: nav.sheet != nil, initial: true) { _, up in app.sheetUp = up }
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
        .task { if app.debugSettings != nil { nav.present(.settings) } }
        #endif
        .onChange(of: app.route, initial: true) { _, route in
            guard let route else { return }
            app.route = nil
            nav.apply(route)
        }
        .modifier(HingeReader(hinged: $hinged))
        .onChange(of: nav.column) {
            // The system Back button in the collapsed split returns to Home. Do not resurrect that
            // project when the window expands again (Duo unfold or iPad multitasking).
            nav.columnChanged(compact: width == .compact)
        }
    }

    private func newProject(_ job: NewProjectJob?) { nav.present(.new(job: job?.rawValue)) }

    private var railButtons: some ToolbarContent {
        PrintersAndSettingsButtons(store: store, openPrinters: { nav.present(.printers) }, openSettings: { nav.present(.settings) })
    }

    /// One split and one detail stack survive every size-class change. Only the leading column's
    /// presentation changes: Home's cards in compact width, grouped rows at regular width.
    private var split: some View {
        NavigationSplitView(preferredCompactColumn: Binding(
            get: { nav.column == .detail ? NavigationSplitViewColumn.detail : .sidebar },
            set: { nav.show($0 == .detail ? .detail : .sidebar) })) {
            if width == .regular {
                // Only a row opens a project here. The list clears its selection to nil when the split collapses
                // (a fold, an iPad resize), and that must not close the project the detail shows; the project
                // page's own close button and Back in the collapsed split close it.
                SidebarList(store: store, selection: Binding(get: { nav.project }, set: { nav.select($0) }),
                            newProject: { newProject(nil) },
                            addStarter: addStarter, openPrinters: { nav.present(.printers) }, openSettings: { nav.present(.settings) },
                            showsToolbarButtons: !railed)
            } else {
                HomeView(store: store, openProject: { value in
                    if let id = Page.printingId(value) { nav.openPrinting(id) }
                    else { nav.open(value) }
                }, newProject: newProject,
                         openPrinters: { nav.present(.printers) }, openSettings: { nav.present(.settings) })
            }
        } detail: {
            // Invariant: the only value this stack ever pushes is `printing:<open project id>`. `nav.path` is derived
            // from `nav.detail`, and its setter ignores anything else.
            NavigationStack(path: $nav.path) {
                Group {
                    if let selected = nav.project { projectPage(selected, close: { nav.close() }) }
                    else {
                        StartPane(hasProjects: !store.projects.isEmpty, unavailableMessage: store.starterUnavailableMessage,
                                  newProject: newProject, addStarter: addStarter)
                    }
                }
                .toolbar { if railed { railButtons } }
                .navigationDestination(for: String.self) { id in page(id, close: { nav.close() }).toolbar { if railed { railButtons } } }
            }
            // A new project gets a new stack, built with the path set beside the selection (a Live Activity or print
            // notification opens Printing on top of its project). With only the root keyed, the iPad dropped that push.
            .id(nav.project)
        }
    }

    /// A starter becomes a project on the Mac, which then opens (PRD §5.11).
    private func addStarter(_ starter: StarterProject) async throws {
        let ticket = store.startRequest()
        let project = try await store.mac.client.addStarter(starter)
        store.replace(project, ticket: ticket)
        nav.open(project.id)
    }

    private func projectPage(_ id: String, close: @escaping () -> Void) -> some View {
        ProjectView(store: store, id: id, close: close, openPrint: { nav.present(.print($0)) },
                    openPrinting: { nav.openPrinting($0) })
    }

    /// A pushed page: a project, or a print's Printing screen.
    @ViewBuilder private func page(_ value: String, close: @escaping () -> Void) -> some View {
        if let id = Page.printingId(value) { PrintingView(store: store, id: id, openProject: { nav.open($0) }) } else { projectPage(value, close: close) }
    }
}

/// Navigation values are strings: a project id, or `printing:<id>` for its Printing screen (`ProjectsNavigation`).
enum Page {
    static func printing(_ id: String) -> String { ProjectsNavigation.printingValue(id) }
    static func printingId(_ value: String) -> String? { ProjectsNavigation.printingProject(value) }
}

struct IdentifiedProject: Identifiable { let id: String }

/// Printers (with how many need attention) and Settings: above the sidebar, or in the open Duo's trailing rail.
struct PrintersAndSettingsButtons: ToolbarContent {
    let store: ProjectsStore
    let openPrinters: () -> Void
    let openSettings: () -> Void
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) { Button(action: openPrinters) { Image(systemName: "printer.fill") }.badge(store.printerProblems).accessibilityLabel(store.printersLabel) }
        ToolbarItem(placement: .topBarTrailing) { Button(action: openSettings) { Image(systemName: "person.crop.circle") }.accessibilityLabel("Settings") }
    }
}

/// Whether this device has a hinge (`DeviceHinge`, iOS 27.1). Before 27.1 nothing is known and nothing changes.
private struct HingeReader: ViewModifier {
    @Binding var hinged: Bool
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, context in hinged = context.hinge != nil }
        } else {
            content
        }
    }
}

/// The iPad detail with no project selected: what to start with, never an empty "Choose a project".
struct StartPane: View {
    let hasProjects: Bool
    var unavailableMessage: String? = nil
    let newProject: (NewProjectJob?) -> Void
    let addStarter: (StarterProject) async throws -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text(hasProjects ? "Choose a project, or start something new" : "Your next project starts here")
                    .font(.largeTitle.bold())
                StarterProjectsView(unavailableMessage: unavailableMessage, start: addStarter)
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
    /// False on an open Duo, where the same two buttons are in the trailing rail.
    var showsToolbarButtons = true
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var showArchived = false
    @State private var openedStarter: StarterProject?

    private func matches(_ project: Project) -> Bool {
        project.matchesSearch(query, additional: [store.printerName(project) ?? ""])
    }
    /// Why a search found this project, when its title doesn't say (U10): under the row, lined up with its title.
    private func reason(_ project: Project) -> SearchSnippet? {
        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : project.searchSnippet(query, additional: [store.printerName(project) ?? ""])
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
            section("Needs you", group([.needsYou, .failed]))
            section("Ready", group([.ready]))
            section("Done", group([.confirmed]))
            section("Printed", group([.printed, .sent]))
            section("Other", group([.draft, .unknown]))
            if !archived.isEmpty {
                Section(isExpanded: Binding(get: { showArchived || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }, set: { showArchived = $0 })) {
                    ForEach(archived) { project in
                        SidebarRow(store: store, project: project)
                            .accessibilityIdentifier("sidebar-project-\(project.id)")
                            .searchReason(reason(project), indent: 56)
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
        // New sits in a bottom bar the list scrolls under (first look U11): with the list cut flat at the button, "Done"
        // hid below it with nothing to say more was there. The hard edge keeps rows from showing through the button
        // (iPad build 202611052142, Nov 5: a floating "+" over a row), the indicators flash so the scroll is evident,
        // and the last row still ends above New.
        .scrollEdgeEffectStyle(.hard, for: .bottom)
        .scrollIndicatorsFlash(onAppear: true)
        .safeAreaBar(edge: .bottom) {
            // While a search is typed, New steps aside: riding above the keyboard it covered the only results' lines on an
            // iPad Air in landscape (train gate, Nov 10: the match's reason sat under it). ⌘N still works (below).
            if !searching {
                Button(action: newProject) {
                    Label("New Project", systemImage: "plus").fontWeight(.semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                .accessibilityIdentifier("new-project")
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
        .background { Button("New Project", action: newProject).keyboardShortcut("n", modifiers: .command).hidden() }
        }
        .sheet(item: $openedStarter) { starter in StarterDetail(project: starter, unavailableMessage: store.starterUnavailableMessage, start: addStarter) }
        .navigationTitle("Projects")
        // A sidebar toolbar subtitle is a single truncated line. Keep the shared summary in the
        // sidebar itself so both the connection and the printer status can wrap.
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                // The same banner as iPhone Home, with Try Again and the way to another Mac (F6): at regular width
                // Home's cards aren't shown, so without it the iPad said only "isn't answering" in the line below.
                if let error = store.error ?? (store.away ? CompanionError.unreachable : nil) {
                    ConnectionBanner(error: error, line: store.away && !error.needsPairing ? store.awayLine() : nil, pair: store.onPair) {
                        Task { await store.load(); await store.loadPrinters() }
                    }
                }
                // Readable at arm's length (first look U11): the system's secondary label colour, not a hierarchical
                // .secondary that went dark grey over the sidebar's glass, at footnote size.
                Text(store.homeSubtitle).font(.footnote).foregroundStyle(Color(uiColor: .secondaryLabel))
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("projects-status")
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }

        .background { Button("Search") { searching = true }.keyboardShortcut("f", modifiers: .command).hidden() }
        .refreshable { await store.load() }
        .toolbar { if showsToolbarButtons { PrintersAndSettingsButtons(store: store, openPrinters: openPrinters, openSettings: openSettings) } }
    }

    @ViewBuilder private func section(_ title: String, _ projects: [Project]) -> some View {
        if !projects.isEmpty {
            Section(title) {
                ForEach(projects) { project in
                    SidebarRow(store: store, project: project)
                        // The row's identifier first: on the whole cell it would replace the reason's own.
                        .accessibilityIdentifier("sidebar-project-\(project.id)")
                        .searchReason(reason(project), indent: 56)
                        .tag(project.id)
                        .listRowBackground(selection == project.id ? Color.filament.opacity(0.32) : nil)
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
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let words = store.words(project)
        // At the accessibility text sizes two lines hold a word or two (seen at the largest: "First plate fr…",
        // "Wall holder…"): the name and its line take as many lines as they need, and the picture goes above them
        // so they get the row's whole width.
        let large = typeSize.isAccessibilitySize
        let layout = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 160).frame(width: 44, height: 44).clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                // A project's name is how a person finds it: it wraps before it is ever cut (David's iPad, Nov 10:
                // "Scan from Nov 9, 12:24…" and "…12:15…", cut exactly where they differ). Rows may grow taller.
                Text(words.title).font(.body.weight(.semibold)).lineLimit(large ? nil : 2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sidebar-title-\(project.id)")
                // A scan still on this phone, as on Home's card.
                // Under its section's heading the row shows only what differs, on two lines so it isn't cut off
                // where the meaning is (David's iPad, Nov 10).
                Text(store.localScanWords(project) ?? ProjectWords.row(project, line: words.line)).font(.caption)
                    .foregroundStyle(prominence == .increased ? .white.opacity(0.9) : words.phase.color).lineLimit(large ? nil : 2)
                    .accessibilityIdentifier("sidebar-line-\(project.id)")
            }
        }
        .accessibilityElement(children: .combine)
    }
}
