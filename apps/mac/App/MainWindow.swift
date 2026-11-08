import SwiftUI
import AppKit
import UniformTypeIdentifiers
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// The Counterpart window (PRD §7.2, screens/mac-main.jpg): a sidebar of projects by what they need, the
// project's model full height on the dark stage with glass over it, a toolbar of the Mac's own tools,
// and an inspector. Every word about a project comes from ObjectWords.

struct MainWindow: View {
    @ObservedObject var model: ObjectsModel
    @State private var inspector = true
    @State private var deleting: Project?
    @State private var stopping: Project?
    @State private var newProject: NewProjectDraft?
    @State private var printing: Project?
    @State private var editorError: String?
    /// "Opened in Blender", for a moment.
    @State private var editorNote: String?

    var body: some View {
        NavigationSplitView {
            Sidebar(model: model, deleting: $deleting, stopping: $stopping)
        } detail: {
            detail
                .toolbar { toolbar }
                .inspector(isPresented: Binding(get: { inspector && newProject == nil }, set: { inspector = $0 })) {
                    Group {
                        if let object = model.selected { InspectorView(object: object, model: model, print: { printing = model.objects.first { $0.id == object.id } }).id(object.id) }
                        else { Color.clear }
                    }
                    .inspectorColumnWidth(min: 280, ideal: 320)
                }
        }
        .frame(minWidth: 900, minHeight: 600)
        .tint(.filament)
        // Read the companion only while the window can be seen: hidden, minimized or covered, it stops.
        .onWindowVisibilityChange { visible in
            model.setVisible(visible)
            if !visible { ModelStage.releaseCachedModels() }
        }
        .onDisappear { model.setVisible(false); ModelStage.releaseCachedModels() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in model.wake() }
        .dropDestination(for: URL.self) { urls, _ in
            let usable = urls.filter { ObjectsModel.fileKind($0) != nil }
            guard !usable.isEmpty, newProject == nil else { return false }
            startNewProject(NewProjectDraft(files: usable))
            return true
        }
        .onChange(of: model.selection) { _, selection in if selection != nil { newProject = nil } }
        .onChange(of: newProject) { _, draft in model.composing = draft != nil }
        .onAppear {
            #if DEBUG
            if DesignFixtures.assets != nil, DesignFixtures.screen == "new" { startNewProject(NewProjectDraft()) }
            if DesignFixtures.assets != nil, DesignFixtures.screen == "print" {
                Task { try? await Task.sleep(for: .seconds(2)); printing = model.selected }
            }
            if let id = DesignFixtures.realProject {
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    model.selection = id
                    if DesignFixtures.realScreen == "print" { printing = model.selected }
                }
            }
            #endif
        }
        .sheet(item: $printing) { object in PrintSheet(opened: object, model: model) }
        .confirmationDialog(deleting.map { "Delete “\($0.words.title)”?" } ?? "Delete?",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible, presenting: deleting) { object in
            Button("Delete", role: .destructive) { Task { await model.delete(object.id) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its scan, photos and model are removed from this Mac. This can’t be undone.")
        }
        .modifier(StopPrintDialog(stopping: $stopping, model: model))
        .overlay(alignment: .top) {
            if let editorNote {
                Label(editorNote, systemImage: "checkmark.circle.fill").font(.callout.weight(.medium))
                    .padding(.horizontal, 14).padding(.vertical, 8).glassEffect(.regular, in: .capsule).padding(.top, 12)
                    .transition(.opacity)
            }
        }
        .alert("Couldn’t Open the Model", isPresented: Binding(get: { editorError != nil }, set: { if !$0 { editorError = nil } })) {
            Button("OK", role: .cancel) { editorError = nil }
        } message: { Text(editorError ?? "") }
        .focusedSceneValue(\.newProjectAction) { startNewProject(NewProjectDraft()) }
    }

    /// The detail becomes New Project; choosing a project in the sidebar (or Cancel) leaves it.
    private func startNewProject(_ draft: NewProjectDraft) {
        model.composing = true
        model.selection = nil
        newProject = draft
    }

    @ViewBuilder private var detail: some View {
        if let draft = newProject {
            NewProjectPane(model: model, draft: draft) {
                newProject = nil
                if model.selection == nil { model.selection = model.ordered.first?.id }
            }
            .id(draft.id)
        } else {
            projectDetail
        }
    }

    @ViewBuilder private var projectDetail: some View {
        switch model.availability {
        case .loading where model.objects.isEmpty:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle("Counterpart")
        case .notSetUp:
            QuietMessage(title: "Not Set Up Yet", text: "Counterpart needs Claude Code and your printer set up on this Mac first.")
                .navigationTitle("Counterpart")
        case .notRunning:
            QuietMessage(title: "Not Running", text: "Counterpart couldn’t start in the background.")
                .navigationTitle("Counterpart")
        default:
            if let object = model.selected {
                ProjectDetail(object: object, model: model, print: { printing = model.objects.first { $0.id == object.id } }).id(object.id)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(model.objects.isEmpty ? "Your next project starts here" : "Choose a project, or make something new").font(.largeTitle.bold())
                        StarterProjectsView { starter in try await model.addStarter(starter) }
                        Button("New Project", systemImage: "plus") { startNewProject(NewProjectDraft()) }.buttonStyle(.glassProminent)
                    }.padding(32).frame(maxWidth: 820)
                }.navigationTitle("Projects")
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        let model3D = model.selected?.modelURL
        ToolbarItemGroup {
            Button { open(.blender) } label: { Label("Open in Blender", systemImage: "cube") }
                .help("Open in Blender").disabled(model3D == nil)
            Menu {
                Button("Bambu Studio") { open(.bambu) }
                Button("OrcaSlicer") { open(.orca) }
                Divider()
                Button("Choose Another App…") { open(.other) }
            } label: { Label("Open in Slicer", systemImage: "slider.horizontal.3") }
                .help("Open in Slicer").disabled(model3D == nil)
            Button { showInFinder() } label: { Label("Show in Finder", systemImage: "folder") }
                .help("Show in Finder").disabled(model.selected == nil)
        }
        ToolbarSpacer(.fixed)
        ToolbarItem {
            Button { startNewProject(NewProjectDraft()) } label: { Label("New Project", systemImage: "plus") }.help("New Project")
        }
        ToolbarItem {
            Button { inspector.toggle() } label: { Label("Inspector", systemImage: "sidebar.trailing") }.help("Inspector")
        }
    }

    private func showInFinder() {
        guard let object = model.selected else { return }
        guard let target = object.modelURL ?? object.scanURL ?? object.folderURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    private func open(_ editor: ModelEditor) {
        guard let object = model.selected else { return }
        if editor == .blender {
            // Blender imports STL: a multi-colour design opens its merged mesh, and a
            // published 3MF (which has none) says so instead of sending Blender a 3MF.
            guard let source = object.blenderModelURL else {
                if object.modelURL != nil { editorError = "Blender can’t open this 3MF. Open it in a slicer instead, or use Show in Finder." }
                return
            }
            Task {
                switch await ModelEditor.openInBlender(source) {
                case .success(let note):
                    withAnimation { editorNote = note }
                    try? await Task.sleep(for: .seconds(2.5))
                    withAnimation { editorNote = nil }
                case .failure(let problem): editorError = problem.text
                }
            }
            return
        }
        guard let source = object.modelURL else { return }
        if let problem = ModelEditor.open(source, in: editor) { editorError = problem }
    }
}

// MARK: - The sidebar

private struct Sidebar: View {
    @ObservedObject var model: ObjectsModel
    @Binding var deleting: Project?
    @Binding var stopping: Project?
    @State private var shownPrinter: PrinterDestination?
    @State private var openedStarter: StarterProject?
    @State private var showArchived = false
    @State private var query = ""

    private func rows(_ objects: [Project]) -> some View {
        ForEach(objects) { object in
            ProjectRow(object: object, selected: model.selection == object.id).tag(object.id)
                .contextMenu {
                    if object.words.printRunning && model.capabilities?.printControl == true {
                        let capabilities = model.printer(for: object)?.capabilities
                        // One command at a time, as on the project page: a second would be dropped while the first runs.
                        Group {
                            // The project is shown first, so a refusal appears where the person is looking.
                            if object.print?.live?.state == "paused" {
                                if capabilities?.resume ?? true {
                                    Button("Resume Print") { model.selection = object.id; Task { await model.control(object.id, .resume) } }
                                }
                            } else if capabilities?.pause ?? true {
                                Button("Pause Print") { model.selection = object.id; Task { await model.control(object.id, .pause) } }
                            }
                            if capabilities?.cancel ?? true { Button("Stop Print…", role: .destructive) { model.selection = object.id; stopping = object } }
                        }
                        .disabled(model.working.contains(object.id))
                        Divider()
                    }
                    if model.capabilities?.projectSettings == true { ProjectStatusMenu(object: object, model: model) }
                    Button("Show in Finder") { if let folder = object.folderURL { NSWorkspace.shared.activateFileViewerSelecting([folder]) } }
                        .disabled(object.folderURL == nil)
                    Divider()
                    Button("Delete…", role: .destructive) { deleting = object }
                        .disabled(model.working.contains(object.id))
                }
        }
    }

    var body: some View {
        let search = model.groups(matching: query)
        List(selection: $model.selection) {
            // A search never hides projects silently: the sidebar says how many it leaves out, with the way back.
            if search.hidden > 0 {
                Section {
                    HStack(spacing: 6) {
                        Text(search.groups.isEmpty ? "No projects match “\(query)”"
                             : "\(model.objects.count - search.hidden) of \(model.objects.count) projects match “\(query)”")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Spacer(minLength: 4)
                        Button("Show All") { query = "" }.buttonStyle(.link).font(.caption)
                    }
                    .selectionDisabled()
                }
            }
            ForEach(search.groups, id: \.group) { entry in
                if entry.group == .archived {
                    // Search opens matching archived projects without changing their saved visibility.
                    Section(isExpanded: Binding(get: { showArchived || !query.isEmpty }, set: { showArchived = $0 })) { rows(entry.objects) } header: { Text(entry.group.title) }
                } else {
                    Section(entry.group.title) { rows(entry.objects) }
                }
            }
            if !search.starters.isEmpty {
                Section("Start with These") {
                    ForEach(search.starters) { starter in
                        Button { openedStarter = starter } label: { StarterRow(starter) }
                            .buttonStyle(.plain)
                            .selectionDisabled()
                            .help("Open \(starter.title)")
                            .accessibilityIdentifier("sidebar-starter-\(starter.id)")
                    }
                }
            }
            if let printers = model.printerCatalog?.destinations, !printers.isEmpty {
                Section {
                    ForEach(printers) { printer in
                        Button { shownPrinter = printer } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack { Text(model.sidebarPrinterStatus(printer)).fixedSize(horizontal: false, vertical: true); Spacer(); ReadyDot(state: printer.state) }
                                    if printer.state == "offline" || printer.capabilities?.update != nil {
                                        Label("Needs attention", systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
                                    }
                                }
                            } icon: { Image(systemName: printer.mcpName == "bambu-printer-mcp" ? "printer.fill" : "printer").foregroundStyle(.blue) }
                        }
                        .buttonStyle(.plain)
                        .selectionDisabled()
                        .help("Open \(printer.name)")
                    }
                } header: {
                    HStack {
                        Text("Printers")
                        if model.printerProblems > 0 {
                            Text("\(model.printerProblems)").foregroundStyle(.white).padding(.horizontal, 5).background(.red, in: .capsule)
                                .accessibilityLabel("\(model.printerProblems) \(model.printerProblems == 1 ? "needs" : "need") attention")
                        }
                    }
                }
            }
        }
        // In the sidebar, above the projects it filters; previously the field sat in the window toolbar,
        // outside the sidebar.
        .searchable(text: $query, placement: .sidebar, prompt: "Projects, printers, notes")
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 240, ideal: 260)
        .onDeleteCommand { deleting = model.selected }
        .safeAreaInset(edge: .bottom) { footer }
        .sheet(item: $openedStarter) { starter in StarterDetail(project: starter) { try await model.addStarter($0) } }
        .sheet(item: $shownPrinter) { printer in
            SidebarPrinter(opened: printer, model: model) { project in
                model.selection = project.id
                shownPrinter = nil
            }
        }
    }

    /// "David's iPhone connected · Claude": who is paired and what does the work (PRD §7.2). Connected only on
    /// evidence of a recent request; otherwise when it was last heard from.
    private var footer: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            HStack(spacing: 8) {
                let device = model.latestDevice
                let recent = device?.connectedNow(at: context.date) ?? false
                Circle().fill(recent ? Color.okGreen : Color.gray).frame(width: 7).accessibilityHidden(true)
                Group {
                    if let device {
                        if recent { Text("\(device.deviceName) connected") }
                        else if device.lastSeenAt == nil { Text("\(device.deviceName) · not seen yet") }
                        else { Text("\(device.deviceName) · seen \(Date(timeIntervalSince1970: (device.lastSeenAt ?? device.pairedAt) / 1000), format: .relative(presentation: .named))") }
                    } else {
                        Text(model.missingPhoneText)
                    }
                }
                .font(.caption).lineLimit(1)
                Spacer()
                if let ai = model.aiProvider { Text(ai).font(.caption).foregroundStyle(.secondary) }
            }
            .padding(10)
        }
    }
}

/// One sidebar row: the real render, the title and the status line in the state's colour.
struct ProjectRow: View {
    let object: Project
    /// Inside the selected row's accent highlight a state colour would vanish, so the line goes secondary there.
    var selected = false
    var body: some View {
        let words = object.words
        HStack(spacing: 10) {
            ProjectThumbnail(object: object).frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(words.title).font(.body.weight(.medium)).lineLimit(1)
                Text(words.status).font(.caption).lineLimit(1)
                    .foregroundStyle(selected ? AnyShapeStyle(.secondary) : AnyShapeStyle(words.done ? Color.okGreen : words.stage.tint))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(words.stage.label)
    }
}

/// The first render, else the first photo, else a quiet symbol on the stage colour. Never a fake picture.
struct ProjectThumbnail: View {
    let object: Project
    var body: some View {
        ZStack {
            Color.stageBottom
            if let url = object.renderURLs.first ?? object.photoURLs.first ?? object.captureURLs.first {
                FillImage(url: url, version: object.updatedAtMs)
            } else if object.words.busy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "cube").font(.system(size: 15, weight: .light)).foregroundStyle(.white.opacity(0.4))
            }
        }
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Opening the model in another app

enum ModelEditor {
    case bambu, orca, blender, other

    struct Problem: Error { let text: String }
    static let blenderId = "org.blenderfoundation.blender"

    /// Open in Blender (PRD §9.6): never a new Blender per click, and at most one that Counterpart started.
    /// The Blender Counterpart started for editing, while it is open, imports from its inbox; otherwise one starts,
    /// watching the inbox, and later clicks reuse it. Any other Blender (the person's own, or the companion's touch-up
    /// Blender during a pass) is never sent anything: this one is then its own instance. The copy keeps the project's
    /// own file untouched.
    @MainActor static func openInBlender(_ source: URL) async -> Result<String, Problem> {
        let workspace = NSWorkspace.shared
        guard let application = workspace.urlForApplication(withBundleIdentifier: blenderId) else {
            return .failure(Problem(text: "Blender isn’t on this Mac. Install it, or choose a slicer."))
        }
        guard let copy = try? editorCopy(source) else { return .failure(Problem(text: "The model couldn’t be copied for Blender.")) }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: blenderId).filter { !$0.isTerminated }
        // No await from here until `launching` is set, so a second click can't start a second Blender.
        do {
            if let ours = ownBlender() {
                try BlenderBridge.drop(copy)
                ours.activate()
                return .success("Opened in Blender")
            }
            if launching {
                try BlenderBridge.drop(copy) // the Blender starting now imports it once it is up
                return .success("Opening in Blender…")
            }
            BlenderBridge.clear()
            try BlenderBridge.drop(copy)
        } catch {
            return .failure(Problem(text: "The model couldn’t be copied for Blender."))
        }
        launching = true
        defer { launching = false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = !running.isEmpty
        configuration.arguments = ["--python-expr", BlenderBridge.watcher, "--", BlenderBridge.inbox.path]
        do {
            started = try await workspace.openApplication(at: application, configuration: configuration)
            return .success("Opened in Blender")
        } catch {
            return .failure(Problem(text: "Blender didn’t open. Try again, or open the model from Show in Finder."))
        }
    }

    /// The Blender this Mac started, while it runs: its inbox heartbeat, or the launch itself until that begins.
    @MainActor private static func ownBlender() -> NSRunningApplication? {
        if let pid = BlenderBridge.listeningPid(), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
           app.bundleIdentifier == blenderId { return app }
        return started.flatMap { $0.isTerminated ? nil : $0 }
    }
    @MainActor private static var started: NSRunningApplication?
    /// A launch in flight.
    @MainActor private static var launching = false

    /// A copy of the model, so another app's edits never change the project.
    static func editorCopy(_ source: URL) throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Scan to Make/Editor Copies", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let copy = root.appendingPathComponent(source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: copy)
        return copy
    }

    /// Opens a copy of the STL in a slicer (Blender has `openInBlender`). Returns a sentence on failure.
    @MainActor static func open(_ source: URL, in editor: ModelEditor) -> String? {
        let workspace = NSWorkspace.shared
        let application: URL?
        switch editor {
        case .bambu: application = workspace.urlForApplication(withBundleIdentifier: "com.bambulab.bambu-studio")
        case .orca: application = workspace.urlForApplication(withBundleIdentifier: "com.orcaslicer.OrcaSlicer")
            ?? workspace.urlForApplication(withBundleIdentifier: "com.softfever3d.orca-slicer")
        case .blender: application = workspace.urlForApplication(withBundleIdentifier: blenderId)
        case .other:
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.applicationBundle]
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
            panel.prompt = "Choose App"
            panel.message = "Choose the slicer to open this model."
            application = panel.runModal() == .OK ? panel.url : nil
            if application == nil { return nil }
        }
        guard let application else { return "That app isn’t on this Mac. Install it or choose another one." }
        guard let copy = try? editorCopy(source) else { return "The model couldn’t be copied for the other app." }
        workspace.open([copy], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        return nil
    }
}

// MARK: - Menu commands

struct NewProjectActionKey: FocusedValueKey { typealias Value = () -> Void }
extension FocusedValues {
    var newProjectAction: (() -> Void)? {
        get { self[NewProjectActionKey.self] }
        set { self[NewProjectActionKey.self] = newValue }
    }
}

/// PRD §5.4: Status, set by hand (Done is `works`), and Archive, which hides a project and keeps its status. The
/// sidebar row's context menu, and the status capsule on the project page.
struct ProjectStatusMenu: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    var body: some View {
        Menu("Status") { ProjectStatusItems(object: object, model: model) }
            .disabled(model.working.contains(object.id))
    }
}

struct ProjectStatusItems: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    static let statuses: [(value: String, label: String)] = [("not-printed", "Not Printed"), ("printed", "Printed"), ("works", "Done"),
                                                              ("needs-changes", "Needs Changes")]
    var body: some View {
        let current = model.extras[object.id]?.status ?? (object.words.done ? "works" : nil)
        let archived = model.extras[object.id]?.archived == true
        ForEach(Self.statuses, id: \.value) { status in
            Button { Task { await model.setStatus(status.value, for: object.id) } } label: {
                if current == status.value { Label(status.label, systemImage: "checkmark") } else { Text(status.label) }
            }
        }
        Divider()
        if archived {
            Button("Unarchive") { Task { await model.setArchived(false, for: object.id) } }
        } else {
            Button("Archive (Hide from Sidebar)") { Task { await model.setArchived(true, for: object.id) } }
        }
    }
}

/// Stop… from the sidebar asks first, as the project page does.
private struct StopPrintDialog: ViewModifier {
    @Binding var stopping: Project?
    let model: ObjectsModel
    func body(content: Content) -> some View {
        content.confirmationDialog("Stop the print?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }),
                                   titleVisibility: .visible, presenting: stopping) { object in
            Button("Stop Printing", role: .destructive) { Task { await model.control(object.id, .cancel) } }
                .disabled(model.working.contains(object.id))
            Button("Keep Printing", role: .cancel) {}
        }
    }
}

/// The selected printer's status and projects, using only the companion's structured catalog.
private struct SidebarPrinter: View {
    @Environment(\.dismiss) private var dismiss
    let opened: PrinterDestination
    @ObservedObject var model: ObjectsModel
    let openProject: (Project) -> Void
    private var printer: PrinterDestination? { model.printerCatalog?.destination(for: opened.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label(printer?.name ?? opened.name, systemImage: "printer").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let printer {
                HStack { ReadyDot(state: printer.state); Text(PrintersSettings.readiness(printer.state)) }
                if let name = printer.model { LabeledContent("Model", value: name) }
                if let address = printer.address { LabeledContent("Address", value: address) }
                let projects = model.projects(forPrinter: printer.id)
                if projects.isEmpty {
                    Text("No projects have printed on this printer yet.").foregroundStyle(.secondary)
                } else {
                    Text("Projects").font(.headline)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(projects) { project in
                                Button { openProject(project) } label: {
                                    HStack {
                                        Text(project.words.title)
                                        Spacer()
                                        Text(project.words.status).foregroundStyle(.secondary)
                                        Image(systemName: "chevron.right")
                                    }
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                }
            } else {
                Text("This printer is no longer available.").foregroundStyle(.secondary)
            }
        }
        .padding(24).frame(width: 520, height: 420)
    }
}
