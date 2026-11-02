import SwiftUI
import AppKit
import UniformTypeIdentifiers
#if canImport(ControlKit)
import ControlKit
#endif

// The Counterpart window (PRD §7.2, screens/mac-main.jpg): a sidebar of projects by what they need, the
// project's model full height on the dark stage with glass over it, a toolbar of the Mac's own tools,
// and an inspector. Every word about a project comes from ObjectWords.

struct MainWindow: View {
    @ObservedObject var model: ObjectsModel
    @State private var inspector = true
    @State private var deleting: StmObject?
    @State private var newProject: NewProjectDraft?
    @State private var printing: StmObject?
    @State private var editorError: String?

    var body: some View {
        NavigationSplitView {
            Sidebar(model: model, deleting: $deleting)
        } detail: {
            detail
                .toolbar { toolbar }
                .inspector(isPresented: Binding(get: { inspector && newProject == nil }, set: { inspector = $0 })) {
                    Group {
                        if let object = model.selected { InspectorView(object: object, model: model, print: { printing = object }).id(object.id) }
                        else { Color.clear }
                    }
                    .inspectorColumnWidth(min: 280, ideal: 320)
                }
        }
        .frame(minWidth: 900, minHeight: 600)
        .tint(.filament)
        // Read the companion only while the window can be seen: hidden, minimized or covered, it stops.
        .onWindowVisibilityChange { model.setVisible($0) }
        .onDisappear { model.setVisible(false) }
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
                ProjectDetail(object: object, model: model, print: { printing = object }).id(object.id)
            } else {
                QuietMessage(title: model.objects.isEmpty ? "Nothing Here Yet" : nil,
                             text: model.objects.isEmpty ? "Scan something with your iPhone, or drop photos or a model here to start." : "Choose a project on the left.")
                    .navigationTitle("Counterpart")
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
        let target = object.modelURL ?? object.scanURL ?? URL(fileURLWithPath: object.directory, isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    private func open(_ editor: ModelEditor) {
        guard let source = model.selected?.modelURL else { return }
        if let problem = ModelEditor.open(source, in: editor) { editorError = problem }
    }
}

// MARK: - The sidebar

private struct Sidebar: View {
    @ObservedObject var model: ObjectsModel
    @Binding var deleting: StmObject?

    var body: some View {
        List(selection: $model.selection) {
            ForEach(model.groups, id: \.group) { entry in
                Section(entry.group.title) {
                    ForEach(entry.objects) { object in
                        ProjectRow(object: object, selected: model.selection == object.id).tag(object.id)
                            .contextMenu {
                                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: object.directory, isDirectory: true)]) }
                                Divider()
                                Button("Delete…", role: .destructive) { deleting = object }
                                    .disabled(model.working.contains(object.id))
                            }
                    }
                }
            }
            if let printers = model.printerCatalog?.destinations, !printers.isEmpty {
                Section("Printers") {
                    ForEach(printers) { printer in
                        Label {
                            HStack { Text(printer.name); Spacer(); ReadyDot(state: printer.state) }
                        } icon: { Image(systemName: printer.mcpName == "bambu-printer-mcp" ? "printer.fill" : "printer").foregroundStyle(.blue) }
                        .help("\(printer.model ?? printer.name) through \(printer.mcpName)")
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 240, ideal: 260)
        .onDeleteCommand { deleting = model.selected }
        .safeAreaInset(edge: .bottom) { footer }
    }

    /// "David's iPhone connected · Claude": who is paired and what does the work (PRD §7.2). Connected only on
    /// evidence of a recent request; otherwise when it was last heard from.
    private var footer: some View {
        HStack(spacing: 8) {
            let device = model.latestDevice
            let recent = device.map { Date().timeIntervalSince1970 * 1000 - $0.seenAt < 5 * 60_000 } ?? false
            Circle().fill(recent ? Color.okGreen : Color.gray).frame(width: 7).accessibilityHidden(true)
            Group {
                if let device {
                    if recent { Text("\(device.deviceName) connected") }
                    else { Text("\(device.deviceName) · seen \(Date(timeIntervalSince1970: device.seenAt / 1000), format: .relative(presentation: .named))") }
                } else {
                    Text(model.availability == .notRunning ? "Not running" : "No phone paired yet")
                }
            }
            .font(.caption).lineLimit(1)
            Spacer()
            if let ai = model.aiProvider { Text(ai).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(10)
    }
}

/// One sidebar row: the real render, the title and the status line in the state's colour.
struct ProjectRow: View {
    let object: StmObject
    /// Inside the selected row's accent highlight a state colour would vanish, so the line goes secondary there.
    var selected = false
    var body: some View {
        let words = object.words
        HStack(spacing: 10) {
            ProjectThumbnail(object: object).frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(words.title).font(.body.weight(.medium)).lineLimit(1)
                Text(words.status).font(.caption).lineLimit(1)
                    .foregroundStyle(selected ? AnyShapeStyle(.secondary) : AnyShapeStyle(words.stage.tint))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(words.stage.label)
    }
}

/// The first render, else the first photo, else a quiet symbol on the stage colour. Never a fake picture.
struct ProjectThumbnail: View {
    let object: StmObject
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

    /// Opens a copy of the STL, so another app's edits never change the project. Returns a sentence on failure.
    @MainActor static func open(_ source: URL, in editor: ModelEditor) -> String? {
        let workspace = NSWorkspace.shared
        let application: URL?
        switch editor {
        case .bambu: application = workspace.urlForApplication(withBundleIdentifier: "com.bambulab.bambu-studio")
        case .orca: application = workspace.urlForApplication(withBundleIdentifier: "com.orcaslicer.OrcaSlicer")
            ?? workspace.urlForApplication(withBundleIdentifier: "com.softfever3d.orca-slicer")
        case .blender: application = workspace.urlForApplication(withBundleIdentifier: "org.blenderfoundation.blender")
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
        do {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Scan to Make/Editor Copies", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let copy = root.appendingPathComponent(source.lastPathComponent)
            try FileManager.default.copyItem(at: source, to: copy)
            let configuration = NSWorkspace.OpenConfiguration()
            if editor == .blender {
                // Blender imports an STL into a fresh scene, in its own instance so no open session is replaced.
                configuration.createsNewApplicationInstance = true
                configuration.arguments = ["--factory-startup", "--python-expr",
                                           "import bpy,sys; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False); bpy.ops.wm.stl_import(filepath=sys.argv[-1])",
                                           "--", copy.path]
                workspace.openApplication(at: application, configuration: configuration) { _, _ in }
            } else {
                workspace.open([copy], withApplicationAt: application, configuration: configuration) { _, _ in }
            }
            return nil
        } catch { return "The model couldn’t be copied for the other app." }
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
