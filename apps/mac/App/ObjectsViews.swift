import SwiftUI
import AppKit
import UniformTypeIdentifiers
#if canImport(ControlKit)
import ControlKit
#endif

// The objects window (spec §5.1, §5.3–5.6): the same list and object pages as the iPhone app, as a
// standard macOS 27 window. The sidebar, toolbar and dialogs are the system's own, so they take on
// Liquid Glass by themselves; the page adds no backgrounds of its own. Cobalt is the one tint, and
// only on the primary action. All object copy comes from ObjectWords.

enum ObjectsStyle {
    /// The one tint, the same cobalt as the iPhone app: the primary action only. It fills a button under a
    /// white label, so both variants keep 4.5:1 with white (light #2448D8 about 7:1, dark #3A63F2 about 4.9:1).
    static let accent = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red:0x3A/255, green:0x63/255, blue:0xF2/255, alpha:1)
            : NSColor(red:0x24/255, green:0x48/255, blue:0xD8/255, alpha:1)
    })
    /// The model's stage: the iPhone's dark build plate, which the touch-up's renders sit on.
    static let stage = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red:0x0E/255, green:0x10/255, blue:0x13/255, alpha:1)
            : NSColor(red:0x2C/255, green:0x31/255, blue:0x38/255, alpha:1)
    })
}

extension View {
    /// The one prominent button on a page: Liquid Glass in cobalt on macOS 26 and later.
    func primaryAction() -> some View { modifier(ActionStyle(prominent:true)) }
    /// Every other button that stands on its own on a page.
    func secondaryAction() -> some View { modifier(ActionStyle(prominent:false)) }
}

private struct ActionStyle: ViewModifier {
    let prominent: Bool
    @Environment(\.solidMaterialStandIns) private var standIns
    func body(content: Content) -> some View {
        if standIns {
            content.buttonStyle(SolidStandIn(prominent:prominent))
        } else {
            // The glass styles exist only in the macOS 26 SDK (Swift 6.2 and later): an older Xcode, such as
            // CI's macos-15 runner, builds the bordered fallback. `STM_NO_GLASS` builds that branch here too.
            #if compiler(>=6.2) && !STM_NO_GLASS
            if #available(macOS 26, *) {
                if prominent { content.buttonStyle(.glassProminent).tint(ObjectsStyle.accent) } else { content.buttonStyle(.glass) }
            } else {
                bordered(content)
            }
            #else
            bordered(content)
            #endif
        }
    }
    @ViewBuilder private func bordered(_ content: Content) -> some View {
        if prominent { content.buttonStyle(.borderedProminent).tint(ObjectsStyle.accent) } else { content.buttonStyle(.bordered) }
    }
}

private struct SolidMaterialStandInsKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// Debug design renders only. An offscreen capture can't draw Liquid Glass (the window server composites
    /// it), so the renderer can ask for solid stand-ins in the same colours: a cobalt capsule with a white
    /// label for glass-prominent, a light capsule with the primary label colour for glass.
    var solidMaterialStandIns: Bool {
        get { self[SolidMaterialStandInsKey.self] }
        set { self[SolidMaterialStandInsKey.self] = newValue }
    }
}

/// The render-only stand-in for the glass button styles. Never used outside `solidMaterialStandIns`.
private struct SolidStandIn: ButtonStyle {
    let prominent: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 14).padding(.vertical, 7)
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .background(Capsule().fill(prominent ? ObjectsStyle.accent : Color.primary.opacity(0.1)))
            .overlay(Capsule().strokeBorder(Color.primary.opacity(prominent ? 0 : 0.12), lineWidth:0.5))
    }
}

struct ObjectsWindowView: View {
    @ObservedObject var model: ObjectsModel
    var startWith3D = false
    /// The object the Delete dialog is about, fixed when it opens: the selection can move underneath it.
    @State private var deleting: StmObject?
    @State private var search = ""

    var body: some View {
        NavigationSplitView {
            List(selection:$model.selection) {
                Section("Projects") {
                    ForEach(model.objects.filter { search.isEmpty || ($0.instructions ?? $0.words.title).localizedCaseInsensitiveContains(search) }) {
                        ObjectCard(object:$0).tag($0.id)
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text:$search, prompt:"Find a project")
            .navigationSplitViewColumnWidth(min:220, ideal:264, max:340)
            .onDeleteCommand { deleting = model.selected }
        } detail: {
            detail
        }
        .navigationTitle("Counterpart")
        .navigationSubtitle(subtitle)
        .frame(minWidth:ObjectsWindow.minimumSize.width, minHeight:ObjectsWindow.minimumSize.height)
        .toolbar {
            ToolbarItemGroup(placement:.primaryAction) {
                Button { Task { await model.refresh() } } label: { Label("Refresh", systemImage:"arrow.clockwise") }
                    .help("Refresh")
                Button { deleting = model.selected } label: { Label("Delete", systemImage:"trash") }
                    .help("Delete")
                    .disabled(model.selected == nil || model.selected.map { model.working.contains($0.id) } == true)
            }
            ToolbarItem(placement:.primaryAction) {
                Button { SettingsWindow.shared.show() } label: { Label("Settings", systemImage:"gearshape") }
                    .help("Settings")
            }
        }
        .confirmationDialog(deleting.map { "Delete “\($0.words.title)”?" } ?? "Delete?",
                            isPresented:Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility:.visible, presenting:deleting) { object in
            Button("Delete", role:.destructive) { Task { await model.delete(object.id) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("Its scan, pictures and model are removed from this Mac. This can’t be undone.")
        }
    }

    /// Under the window's title: whether Scan to Make is answering on this Mac, and how much is here.
    private var subtitle: String {
        switch model.availability {
        case .loading: return ""
        case .notSetUp: return "Not set up"
        case .notRunning: return "Not running"
        case .ready: return model.objects.isEmpty ? "" : model.objects.count == 1 ? "1 project" : "\(model.objects.count) projects"
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.availability {
        case .loading where model.objects.isEmpty:
            ProgressView().controlSize(.small).frame(maxWidth:.infinity, maxHeight:.infinity)
        case .notSetUp:
            QuietMessage(title:"Not Set Up Yet", text:"Counterpart needs Claude Code and your printer set up on this Mac first.")
        case .notRunning:
            QuietMessage(title:"Not Running", text:"Counterpart couldn’t start in the background.")
        default:
            if let object = model.selected {
                ObjectPage(object:object, model:model, startWith3D:startWith3D).id(object.id)
            } else if model.objects.isEmpty {
                QuietMessage(title:"Nothing Here Yet", text:"Scan something, or say what you want made, in Counterpart on your iPhone. It shows up here.")
            } else {
                QuietMessage(text:"Choose something on the left.")
            }
        }
    }
}

/// The app's mark, a title and one calm sentence, for the states that have nothing else to show.
struct QuietMessage: View {
    var title: String?
    let text: String
    var body: some View {
        VStack(spacing:10) {
            AppMark(size:64).padding(.bottom, 4)
            if let title { Text(title).font(.title3.weight(.semibold)) }
            Text(text).font(.body).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).fixedSize(horizontal:false, vertical:true)
        }
        .frame(maxWidth:360)
        .frame(maxWidth:.infinity, maxHeight:.infinity)
        .padding(24)
    }
}

/// The app icon's art, wherever the app introduces itself: drawn from the asset catalog (the system's
/// own icon image can still be a placeholder while it is rendered) and rounded like the icon.
struct AppMark: View {
    let size: CGFloat
    var body: some View {
        Image("AppMark")
            .resizable().interpolation(.high).frame(width:size, height:size)
            .clipShape(RoundedRectangle(cornerRadius:size * 0.225, style:.continuous))
            .accessibilityHidden(true)
    }
}

// MARK: - The list

/// One row of the sidebar: the first render, the title and where it is, each on one line so a row's
/// height never depends on the sidebar's width.
struct ObjectCard: View {
    let object: StmObject
    var body: some View {
        let words = object.words
        HStack(spacing:10) {
            Thumbnail(object:object, busy:words.busy).frame(width:40, height:40)
            VStack(alignment:.leading, spacing:2) {
                Text(words.title).font(.body.weight(.medium)).lineLimit(2)
                Label(object.state == .failed ? "Needs attention" : words.headline,
                      systemImage:object.state == .failed ? "exclamationmark.circle" : "circle.fill")
                    .font(.caption).foregroundStyle(object.state == .failed ? Color.orange : Color.secondary).lineLimit(1)
                Text(Date(timeIntervalSince1970:object.createdAtMs / 1000), format:.dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children:.combine)
    }
}

/// The first render, or a quiet placeholder until there is one.
private struct Thumbnail: View {
    let object: StmObject
    let busy: Bool
    var body: some View {
        ZStack {
            ObjectsStyle.stage
            if let url = object.renderURLs.first {
                FileImage(url:url, version:object.updatedAtMs, contentMode:.fill)
            } else if let url = object.photoURLs.first ?? object.captureURLs.first {
                FileImage(url:url, version:object.updatedAtMs, contentMode:.fill)
            } else if busy {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName:"cube").font(.system(size:16, weight:.light)).foregroundStyle(.tertiary)
            }
        }
        .environment(\.colorScheme, .dark)  // The stage is always the dark plate.
        .clipShape(RoundedRectangle(cornerRadius:8, style:.continuous))
    }
}

// MARK: - The object page

private struct PrintConfirmationForm: View {
    let object: StmObject
    let question: StmObject.PrintConfirmation
    @ObservedObject var model: ObjectsModel
    @State private var draft: PrintConfirmationDraft

    init(object: StmObject, question: StmObject.PrintConfirmation, model: ObjectsModel) {
        self.object = object; self.question = question; self.model = model
        _draft = State(initialValue:PrintConfirmationDraft(question))
    }

    var body: some View {
        TimelineView(.periodic(from:.now, by:1)) { context in
            let answer = draft.answer(for:question, at:context.date.timeIntervalSince1970 * 1000)
            let expired = question.expiresAtMs <= context.date.timeIntervalSince1970 * 1000
            let working = model.working.contains(object.id)
            GroupBox {
                VStack(alignment:.leading, spacing:14) {
                    Text("Waiting for Your Print Confirmation").font(.headline)
                    Text(verbatim:question.message).textSelection(.enabled).fixedSize(horizontal:false, vertical:true)
                    if let item = object.plate?.item, !item.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
                        Label("The camera check saw \(item) on the plate. Check and clear it before confirming.", systemImage:"exclamationmark.triangle.fill")
                            .foregroundStyle(.orange).fixedSize(horizontal:false, vertical:true)
                    }
                    if let photo = object.platePhotoURL {
                        FileImage(url:photo, version:object.updatedAtMs, contentMode:.fit)
                            .frame(maxWidth:320, maxHeight:220)
                            .accessibilityLabel("Printer camera photo for reference")
                        Text("The camera photo is for reference. Check the printer and answer each item yourself.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if question.supported {
                        ForEach(question.fields, id:\.name) { field in
                            Toggle(isOn:Binding(get:{ draft.values[field.name] ?? false }, set:{ draft.values[field.name] = $0 })) {
                                VStack(alignment:.leading, spacing:4) {
                                    Text(verbatim:field.title)
                                    if let description = field.description {
                                        Text(verbatim:description).font(.callout).foregroundStyle(.secondary)
                                    }
                                    if field.required { Text("Required").font(.caption).foregroundStyle(.secondary) }
                                }
                                .fixedSize(horizontal:false, vertical:true)
                            }
                            .toggleStyle(.checkbox).disabled(working || expired)
                        }
                    } else {
                        Text("This confirmation cannot be answered here. Cancel this print to continue.")
                            .foregroundStyle(.secondary)
                    }
                    if expired { Text("This confirmation has expired.").foregroundStyle(.secondary) }
                    HStack(spacing:12) {
                        if question.supported {
                            Button("Confirm and Continue") {
                                guard let answer = draft.answer(for:question, at:Date().timeIntervalSince1970 * 1000) else { return }
                                Task { await model.answerPrintConfirmation(object.id, confirmationId:question.id, answer:answer) }
                            }
                            .primaryAction().disabled(working || answer == nil)
                        }
                        Button("Cancel Print", role:.destructive) {
                            Task { await model.answerPrintConfirmation(object.id, confirmationId:question.id, answer:.init(action:.cancel)) }
                        }
                        .disabled(working || expired)
                        if working { ProgressView().controlSize(.small) }
                    }
                }
                .frame(maxWidth:.infinity, alignment:.leading).padding(8)
            }
        }
    }
}

private struct PrepareObjectPrint: View {
    let object: StmObject
    @ObservedObject var model: ObjectsModel
    @Environment(\.dismiss) private var dismiss
    @State private var choices: [PrinterFilament] = []
    @State private var selected: Int?
    @State private var loading = true
    @State private var failure: String?
    @State private var checked = false

    private func swatch(_ hex: String) -> Color {
        let value = Int(hex.dropFirst(), radix:16) ?? 0
        return Color(red:Double((value >> 16) & 255)/255, green:Double((value >> 8) & 255)/255, blue:Double(value & 255)/255)
    }

    var body: some View {
        VStack(alignment:.leading, spacing:20) {
            HStack {
                VStack(alignment:.leading, spacing:4) {
                    Text("Prepare to Print").font(.title2.weight(.semibold))
                    Text(object.instructions?.isEmpty == false ? object.instructions! : "Your model")
                        .lineLimit(1).font(.callout)
                    if let printer = model.printer(for:object) { Label(printer.name, systemImage:"printer").foregroundStyle(.secondary) }
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                Text("Choose Filament").font(.headline)
                Spacer()
                if !loading && failure == nil { Button("Refresh") { Task { await load() } } }
            }
            if loading {
                ProgressView("Reading filament from your printer…").frame(maxWidth:.infinity, minHeight:100)
            } else if let failure {
                Label(failure, systemImage:"exclamationmark.circle").foregroundStyle(.secondary)
                Button("Try Again") { Task { await load() } }
            } else if choices.isEmpty {
                Text("No selectable filament was reported. Check the printer’s filament or open the model in your slicer.").foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVGrid(columns:[GridItem(.adaptive(minimum:145), spacing:10)], spacing:10) {
                        ForEach(choices) { filament in
                            Button { selected = filament.slot } label: {
                                VStack(alignment:.leading, spacing:8) {
                                    HStack {
                                        Circle().fill(swatch(filament.colour)).frame(width:34, height:34)
                                            .overlay(Circle().strokeBorder(.secondary.opacity(0.4)))
                                        Spacer()
                                        if selected == filament.slot { Image(systemName:"checkmark.circle.fill").foregroundStyle(ObjectsStyle.accent) }
                                    }
                                    Text(filament.material).font(.headline)
                                    Text(filament.slot >= 254 ? "External spool" : "Slot \(filament.slot + 1)").font(.caption).foregroundStyle(.secondary)
                                }.padding(12).frame(maxWidth:.infinity, alignment:.leading)
                                    .background(RoundedRectangle(cornerRadius:12).fill(Color(nsColor:.controlBackgroundColor)))
                                    .overlay(RoundedRectangle(cornerRadius:12).stroke(selected == filament.slot ? ObjectsStyle.accent : Color.secondary.opacity(0.25), lineWidth:selected == filament.slot ? 2 : 1))
                            }.buttonStyle(.plain).accessibilityLabel("\(filament.material), \(filament.colour), slot \(filament.slot + 1)")
                        }
                    }
                }.frame(maxHeight:240)
            }
            if object.print?.uncertain == true {
                Toggle("I checked the printer; it isn’t already printing this model.", isOn:$checked)
            }
            if let problem = model.problem, problem.id == object.id { Text(problem.text).foregroundStyle(.red) }
            Spacer(minLength:0)
            HStack {
                Text("The printer may ask you to confirm its checks next.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Print") {
                    guard let filament = choices.first(where:{ $0.slot == selected }) else { return }
                    Task { if await model.print(object.id, checked:object.print?.uncertain == true && checked, filament:filament) { dismiss() } }
                }.primaryAction().controlSize(.large)
                    .disabled(selected == nil || model.working.contains(object.id) || (object.print?.uncertain == true && !checked))
            }
        }
        .padding(24).frame(width:540).frame(minHeight:400)
        .task { await load() }
    }

    private func load() async {
        loading = true; failure = nil; selected = nil
        do { choices = try await model.filaments(object.id) }
        catch { failure = (error as? ControlRemoteError)?.message ?? "Couldn’t read filament from this printer." }
        loading = false
    }
}

struct ObjectPage: View {
    let object: StmObject
    @ObservedObject var model: ObjectsModel
    @State private var showing: Showing?
    @State private var note = ""
    @State private var projectSection = MacProjectSection.model
    @State private var editorError: String?
    @State private var preparingPrint = false
    enum Showing: Hashable { case model, render(Int) }

    init(object: StmObject, model: ObjectsModel, startWith3D: Bool = false) {
        self.object = object
        self.model = model
        _showing = State(initialValue:object.modelURL != nil ? .model : nil)
        _projectSection = State(initialValue:object.state == .touchingUp ? .activity : object.current == nil ? .inputs : .model)
    }

    private var words: ObjectWords { object.words }
    private var working: Bool { model.working.contains(object.id) }
    /// What the stage shows: the chosen view, else the first render, else the model.
    private var shown: Showing? {
        switch showing {
        case .render(let index)? where index < object.renderURLs.count: return .render(index)
        case .model? where object.modelURL != nil: return .model
        default: return object.renderURLs.isEmpty ? (object.modelURL == nil ? nil : .model) : .render(0)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment:.leading, spacing:24) {
                header
                if let problem = model.problem, problem.id == object.id {
                    Label(problem.text, systemImage:"exclamationmark.circle.fill")
                        .foregroundStyle(Color(nsColor:.systemRed)).textSelection(.enabled)
                }
                if let confirmation = object.printConfirmation {
                    PrintConfirmationForm(object:object, question:confirmation, model:model)
                        .id(object.id + ":" + confirmation.id)
                } else if words.tone == .accent { ask }
                printerSelection
                if let report = object.print?.printerStatus {
                    VStack(alignment:.leading, spacing:6) {
                        Label("Printer: \(report.state.capitalized)", systemImage:"printer").font(.headline)
                        if let job = report.job { Text("Reported job: \(job)").foregroundStyle(.secondary) }
                        if let percent = report.percent { ProgressView(value:percent,total:100); Text("\(Int(percent))% of reported printer job").monospacedDigit() }
                        if let remaining = report.remainingMinutes { Text("\(Int(remaining)) min remaining").monospacedDigit() }
                        if report.state == "FAILED" { Text("The printer service blocks a new print while the printer reports this failed job.").foregroundStyle(.orange) }
                    }.textSelection(.enabled)
                }
                if object.modelURL != nil { editorActions }
                Picker("Project section", selection:$projectSection) {
                    ForEach(MacProjectSection.allCases, id:\.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).frame(maxWidth:420)
                switch projectSection {
                case .model:
                    if object.modelURL != nil || !object.renderURLs.isEmpty {
                        stage
                        if let summary = object.current?.summary { Text(summary).textSelection(.enabled) }
                    } else {
                        QuietMessage(title:words.busy ? "Your Mac Is Working" : "No Model Yet",
                                     text:"Your request and source photos are saved in Inputs. Follow Activity to see each pass.")
                            .frame(minHeight:220)
                    }
                    if !object.photoURLs.isEmpty {
                        section("Reference Photos") { MacProjectPhotos(object:object, photos:object.photoURLs) }
                    }
                case .inputs:
                    section("Your Request") {
                        Text(object.instructions?.isEmpty == false ? object.instructions! : object.scan != nil || !(object.capture ?? []).isEmpty ? "A copy of the scanned object." : "No description was saved with this project.")
                            .textSelection(.enabled).fixedSize(horizontal:false, vertical:true)
                    }
                    if !object.photoURLs.isEmpty {
                        section("Reference Photos") { MacProjectPhotos(object:object, photos:object.photoURLs) }
                    }
                    if !object.captureURLs.isEmpty {
                        DisclosureGroup("Scan Images (\(object.captureURLs.count))") {
                            MacProjectPhotos(object:object, photos:object.captureURLs)
                        }
                    }
                    if object.scan != nil { Label("Original scan saved with this project", systemImage:"viewfinder").foregroundStyle(.secondary) }
                case .activity:
                    MacProjectActivity(object:object, model:model)
                }
                if words.actions.contains(.correct) { corrections }
            }
            .padding(EdgeInsets(top:20, leading:28, bottom:32, trailing:28))
            .frame(maxWidth:1000, alignment:.leading)
            .frame(maxWidth:.infinity)
            .keepsScrollerRoom()
        }
        .alert("Couldn’t Open the Model", isPresented: Binding(get:{ editorError != nil }, set:{ if !$0 { editorError = nil } })) {
            Button("OK", role:.cancel) { editorError = nil }
        } message: { Text(editorError ?? "") }
        .sheet(isPresented:$preparingPrint) { PrepareObjectPrint(object:object, model:model) }
    }

    private var editorActions: some View {
        VStack(alignment:.leading, spacing:6) {
            HStack(spacing:12) {
                Menu {
                    Button("Bambu Studio") { openModel(in:.bambu) }
                    Button("OrcaSlicer") { openModel(in:.orca) }
                    Divider()
                    Button("Choose Another App…") { openModel(in:.other) }
                } label: { Label("Open in Slicer", systemImage:"square.and.arrow.up") }
                Button { openModel(in:.blender) } label: { Label("Open in Blender", systemImage:"cube") }
                    .secondaryAction()
            }
            Text("Opens a copy; changes in another app don’t update this project.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private enum ModelEditor { case bambu, orca, blender, other }

    private func openModel(in editor: ModelEditor) {
        guard let source = object.modelURL else { return }
        let workspace = NSWorkspace.shared
        let application: URL?
        switch editor {
        case .bambu: application = workspace.urlForApplication(withBundleIdentifier:"com.bambulab.bambu-studio")
        case .orca: application = workspace.urlForApplication(withBundleIdentifier:"com.orcaslicer.OrcaSlicer")
            ?? workspace.urlForApplication(withBundleIdentifier:"com.softfever3d.orca-slicer")
        case .blender: application = workspace.urlForApplication(withBundleIdentifier:"org.blenderfoundation.blender")
        case .other:
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.applicationBundle]
            panel.prompt = "Choose App"
            panel.message = "Choose the slicer to open this model."
            application = panel.runModal() == .OK ? panel.url : nil
            if application == nil { return }
        }
        guard let application else {
            editorError = "That app isn’t available on this Mac. Install it or choose another slicer."
            return
        }
        do {
            let root = try FileManager.default.url(for:.applicationSupportDirectory, in:.userDomainMask, appropriateFor:nil, create:true)
                .appendingPathComponent("Scan to Make/Editor Copies", isDirectory:true)
                .appendingPathComponent(UUID().uuidString, isDirectory:true)
            try FileManager.default.createDirectory(at:root, withIntermediateDirectories:true)
            let copy = root.appendingPathComponent(source.lastPathComponent)
            try FileManager.default.copyItem(at:source, to:copy)
            let configuration = NSWorkspace.OpenConfiguration()
            if editor == .blender {
                // Blender opens .blend files directly, but an STL must be imported into a scene.
                // Start a separate instance so this never replaces an existing Blender session.
                configuration.createsNewApplicationInstance = true
                configuration.arguments = ["--factory-startup", "--python-expr", "import bpy,sys; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False); bpy.ops.wm.stl_import(filepath=sys.argv[-1])", "--", copy.path]
                workspace.openApplication(at:application, configuration:configuration) { _, error in
                    if let error { Task { @MainActor in editorError = error.localizedDescription } }
                }
            } else {
                workspace.open([copy], withApplicationAt:application, configuration:configuration) { _, error in
                    if let error { Task { @MainActor in editorError = error.localizedDescription } }
                }
            }
        } catch { editorError = error.localizedDescription }
    }

    @ViewBuilder private var printerSelection: some View {
        if let catalog = model.printerCatalog, !catalog.destinations.isEmpty {
            HStack(spacing:16) {
                Picker(selection:Binding(get:{ object.printerDestinationId ?? catalog.defaultDestinationId }, set:{ destination in
                    Task { await model.selectPrinter(object.id, destinationId:destination) }
                })) {
                    ForEach(catalog.destinations) { Text($0.name).tag($0.id) }
                } label: { Label("Printer", systemImage:"printer") }
                .frame(maxWidth:360)
                .disabled(working || object.state == .touchingUp || object.state == .printing || object.print?.uncertain == true)
                if let destination = object.print?.destination {
                    Text("Last print: \(destination.name)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength:0)
            }
        } else {
            Label("Printer information is unavailable. Check the companion connection in Settings.", systemImage:"printer")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    // The title, where it is, and the one thing to do about it: beside the title when the title fits on
    // one line, else under it, so a long title is never squeezed into a narrow column.
    private var header: some View {
        ViewThatFits(in:.horizontal) {
            HStack(alignment:.center, spacing:16) {
                titleAndStatus
                Spacer(minLength:16)
                primaryButton
            }
            VStack(alignment:.leading, spacing:14) {
                titleAndStatus
                primaryButton
            }
        }
    }

    private var titleAndStatus: some View {
        VStack(alignment:.leading, spacing:6) {
            Text(object.instructions?.isEmpty == false ? object.instructions! : words.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                .lineLimit(3)
                .fixedSize(horizontal:false, vertical:true)
            if words.tone != .accent { statusLine }
        }
    }

    private var statusLine: some View {
        HStack(alignment:.firstTextBaseline, spacing:6) {
            if words.busy {
                ProgressView().controlSize(.mini)
            } else if words.tone == .pass {
                Image(systemName:"checkmark.circle.fill").foregroundStyle(Color(nsColor:.systemGreen))
            } else if words.tone == .fail {
                Image(systemName:"exclamationmark.triangle.fill").foregroundStyle(Color(nsColor:.systemRed))
            }
            Text(words.status).foregroundStyle(words.tone == .fail ? Color.primary : Color.secondary)
                .fixedSize(horizontal:false, vertical:true).textSelection(.enabled)
        }
        .font(.body)
    }

    @ViewBuilder private var primaryButton: some View {
        let action: ObjectAction? = words.actions.contains(.printChecked) ? .printChecked : words.actions.contains(.print) ? .print
            : words.actions.contains(.retry) ? .retry : nil
        if let action {
            HStack(spacing:10) {
                if working { ProgressView().controlSize(.small) }
                // No keyboard shortcut: Print starts the printer, so it is always a deliberate click.
                Button { if action == .retry { run(action) } else { preparingPrint = true } } label: {
                    Label(action == .retry ? "Try Again" : "Prepare to Print",
                          systemImage:action == .retry ? "arrow.clockwise" : "printer")
                }
                .primaryAction().controlSize(.large)
                .disabled(working || (action != .retry && model.printer(for:object) == nil))
                .help(action == .printChecked ? "Only if the printer isn’t already printing this" : "")
            }
            .fixedSize() // never squeezed by the title beside it
        }
    }

    /// What the object needs from the person (a close-up, or what's on the plate), with the printer
    /// camera's photo and the answer this Mac can give.
    private var ask: some View {
        GroupBox {
            HStack(alignment:.top, spacing:16) {
                if let photo = object.platePhotoURL {
                    FileImage(url:photo, version:object.updatedAtMs, contentMode:.fill)
                        .frame(width:200, height:150)
                        .clipShape(RoundedRectangle(cornerRadius:10, style:.continuous))
                        .accessibilityLabel("The printer camera’s photo of the plate")
                }
                VStack(alignment:.leading, spacing:10) {
                    Text(words.status).font(.body.weight(.medium)).fixedSize(horizontal:false, vertical:true)
                    if words.actions.contains(.bestGuess) {
                        Text("Send a close-up from your iPhone, or let me guess.").foregroundStyle(.secondary)
                        answer("Make Your Best Guess", .bestGuess)
                    }
                    if object.printConfirmation == nil, words.actions.contains(.plateClear) {
                        answer(object.plate?.noCamera == true ? "The Plate Is Clear" : "It’s Actually Clear", .plateClear)
                    }
                }
                Spacer(minLength:0)
            }
            .padding(8)
        }
    }

    private func answer(_ title: String, _ action: ObjectAction) -> some View {
        HStack(spacing:10) {
            Button(title) { run(action) }.secondaryAction().controlSize(.large).disabled(working)
            if working { ProgressView().controlSize(.small) }
        }
        .padding(.top, 2)
    }

    // The model: the chosen render or the turnable STL, a strip to switch between them, and its size.
    private var stage: some View {
        VStack(alignment:.leading, spacing:10) {
            if let estimate = object.print?.estimate {
                HStack(spacing:20) {
                    Label("Sliced", systemImage:"checkmark.circle.fill").foregroundStyle(.green)
                    if let seconds = estimate.seconds { Label("\(Int(ceil(seconds / 60))) min", systemImage:"clock") }
                    if let grams = estimate.grams { Label("\(grams, specifier: "%.2f") g", systemImage:"scalemass") }
                    Text("Estimated").foregroundStyle(.secondary)
                }.font(.headline).monospacedDigit()
            }
            ZStack {
                ObjectsStyle.stage
                switch shown {
                case .model?:
                    if let url = object.modelURL { ModelViewer(url:url, version:object.updatedAtMs) }
                case .render(let index)?:
                    FileImage(url:object.renderURLs[index], version:object.updatedAtMs, contentMode:.fit)
                case nil:
                    if words.busy { ProgressView().controlSize(.regular) }
                    else { Image(systemName:"cube").font(.system(size:40, weight:.ultraLight)).foregroundStyle(.tertiary) }
                }
            }
            .environment(\.colorScheme, .dark)  // The stage is always the dark plate.
            // A fixed height: a stage whose height follows its width makes the page's height follow the window's width.
            .frame(maxWidth:.infinity)
            .frame(height:400)
            .clipShape(RoundedRectangle(cornerRadius:16, style:.continuous))
            .overlay(alignment:.bottomLeading) {
                if shown == .model {
                    Text("Drag to turn it").font(.caption).foregroundStyle(Color.white.opacity(0.72)).padding(12).allowsHitTesting(false)
                }
            }
            HStack(alignment:.center, spacing:12) {
                if object.modelURL != nil || object.renderURLs.count > 1 { strip } else { Spacer(minLength:0) }
                if let size = object.current?.sizeMm, size.count == 3 {
                    Label(ObjectWords.formatSize(size), systemImage:"ruler").foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon).textSelection(.enabled)
                        .fixedSize()
                }
            }
        }
    }

    /// In its own horizontal scroll (no indicators, so it takes no room): any number of renders fits any width.
    private var strip: some View {
        ScrollView(.horizontal, showsIndicators:false) { HStack(spacing:8) {
            if object.modelURL != nil {
                tile(.model) {
                    VStack(spacing:2) {
                        Image(systemName:"rotate.3d").font(.system(size:16))
                        Text("3D").font(.system(size:10, weight:.semibold))
                    }
                    .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Turn the model in 3D")
            }
            ForEach(Array(object.renderURLs.enumerated()), id:\.offset) { index, url in
                tile(.render(index)) { FileImage(url:url, version:object.updatedAtMs, contentMode:.fill) }
                    .accessibilityLabel("Picture \(index + 1)")
            }
        }
        .padding(2) }
    }

    private func tile<Content: View>(_ view: Showing, @ViewBuilder content: () -> Content) -> some View {
        let selected = shown == view
        return Button { showing = view } label: {
            ZStack { ObjectsStyle.stage; content() }
                .environment(\.colorScheme, .dark)
                .frame(width:64, height:48)
                .clipShape(RoundedRectangle(cornerRadius:8, style:.continuous))
                .overlay(RoundedRectangle(cornerRadius:8, style:.continuous)
                    .strokeBorder(selected ? Color.primary : Color(nsColor:.separatorColor), lineWidth:selected ? 2 : 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // "Anything to Fix?": the note goes back to the touch-up, which starts again from this model.
    private var corrections: some View {
        section(object.current == nil ? "Revise Your Request" : "Refine This Version") {
            if object.current == nil {
                Text("Explain what you want made from these photos, or clarify what went wrong. Your existing photos stay with the project.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            HStack(alignment:.bottom, spacing:10) {
                TextField("For example: you missed the clip on the side, or it’s 70 mm long.", text:$note, axis:.vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...6)
                    .onSubmit(send)
                Button("Send", action:send).secondaryAction().controlSize(.large)
                    .keyboardShortcut(.return, modifiers:.command)
                    .disabled(working || note.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment:.leading, spacing:8) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func send() {
        let text = note.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty, !working else { return }
        Task { if await model.perform(.correct, on:object.id, note:text) { note = ""; projectSection = .activity } }
    }
    private func run(_ action: ObjectAction) { Task { await model.perform(action, on:object.id) } }
}

enum MacProjectSection: String, CaseIterable { case model = "Model", inputs = "Inputs", activity = "Activity" }

struct MacProjectPhotos: View {
    let object: StmObject
    let photos: [URL]
    @State private var selected: URL?
    var body: some View {
        ScrollView(.horizontal, showsIndicators:false) {
            HStack(spacing:12) {
                ForEach(Array(photos.enumerated()), id:\.element) { index, url in
                    Button { selected = url } label: {
                        FileImage(url:url, version:object.updatedAtMs, contentMode:.fill)
                            .frame(width:160, height:130).clipped()
                            .clipShape(RoundedRectangle(cornerRadius:12))
                    }
                    .buttonStyle(.plain).help("Open reference photo \(index + 1)")
                    .accessibilityLabel("Reference photo \(index + 1)")
                }
            }.padding(.vertical, 4)
        }
        .sheet(isPresented:Binding(get:{ selected != nil }, set:{ if !$0 { selected = nil } })) {
            VStack(spacing:16) {
                if let selected { FileImage(url:selected, version:object.updatedAtMs).frame(maxWidth:.infinity, maxHeight:.infinity) }
                Button("Done") { selected = nil }.keyboardShortcut(.cancelAction)
            }.padding(20).frame(minWidth:600, minHeight:500)
        }
    }
}

struct MacProjectActivity: View {
    let object: StmObject
    let model: ObjectsModel
    var body: some View {
        VStack(alignment:.leading, spacing:18) {
            Label("Project Created", systemImage:"plus.circle.fill").font(.headline)
            Text(Date(timeIntervalSince1970:object.createdAtMs / 1000), format:.dateTime.month().day().hour().minute())
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(object.passes.enumerated()), id:\.offset) { index, pass in
                VStack(alignment:.leading, spacing:10) {
                    Divider()
                    HStack {
                        Label("Pass \(index + 1)", systemImage:pass.endedAtMs == nil ? "sparkles" : "clock.arrow.circlepath")
                            .font(.headline)
                        Spacer()
                        Text(pass.status?.replacingOccurrences(of:"_", with:" ").capitalized ?? "In progress")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text(Date(timeIntervalSince1970:pass.startedAtMs / 1000), format:.dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption).foregroundStyle(.secondary)
                    if let note = pass.note, !note.isEmpty {
                        Text("Your change").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(note).textSelection(.enabled)
                    }
                    if let summary = pass.summary, !summary.isEmpty { Text(summary).textSelection(.enabled) }
                    if (pass.activityCount ?? pass.activity?.count ?? 0) > 0 {
                        MacPassActivity(object:object, model:model, index:index, count:pass.activityCount ?? pass.activity?.count ?? 0)
                    } else if pass.endedAtMs != nil {
                        Text("Detailed activity wasn't recorded for this earlier pass.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if object.passes.isEmpty { Text("Work will appear here when you send this project from your iPhone.").foregroundStyle(.secondary) }
        }
    }
}

struct MacPassActivity: View {
    let object: StmObject
    let model: ObjectsModel
    let index: Int
    let count: Int
    @State private var expanded = false
    @State private var entries: [StmObject.Activity] = []
    @State private var failed = false
    @State private var loading = false

    var body: some View {
        DisclosureGroup("Model Activity (\(count))", isExpanded:$expanded) {
            VStack(alignment:.leading, spacing:12) {
                if failed {
                    Button("Couldn't load this pass. Try again.") { Task { await load() } }
                } else if loading && entries.isEmpty { ProgressView().controlSize(.small) }
                ForEach(Array(entries.enumerated()), id:\.offset) { _, entry in
                    HStack(alignment:.top, spacing:12) {
                        Image(systemName:entry.kind == "tool" ? "wrench.and.screwdriver" : "text.bubble")
                            .foregroundStyle(.secondary).frame(width:20)
                        VStack(alignment:.leading, spacing:4) {
                            Text(entry.text).textSelection(.enabled)
                            Text(Date(timeIntervalSince1970:entry.atMs / 1000), format:.dateTime.hour().minute().second())
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }.padding(.top,12)
        }
        .task(id:expanded ? object.updatedAtMs : -1) { if expanded { await load() } }
    }
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let activity = try await model.passActivity(object.id, index:index)
            guard !Task.isCancelled else { return }
            entries = activity; failed = false
        } catch { if !Task.isCancelled { failed = true } }
    }
}

// MARK: - Steady scrolling

extension View {
    /// Inside a vertical ScrollView: its page's width never depends on whether it scrolls. AppKit hides a
    /// legacy (always-shown) scroller once the page fits and gives its 15–17 pt back to the page; a page
    /// whose height depends on its width then gets shorter, needs the scroller again, gets narrower and
    /// taller, and so on: on screen the window shakes (KAN-207). Keeping the scroller tiled ends the loop.
    /// Overlay scrollers take no room and are unaffected.
    func keepsScrollerRoom() -> some View { background(ScrollerRoom()) }
}

private struct ScrollerRoom: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.apply() }
    final class Probe: NSView {
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); apply() }
        override func layout() { super.layout(); apply() }
        func apply() {
            guard let scroll = enclosingScrollView, scroll.autohidesScrollers else { return }
            scroll.autohidesScrollers = false
        }
    }
}

// MARK: - Files on this Mac

/// A picture from the object's folder, read off the main thread and keyed on the file's modification
/// time. `version` (the object's `updatedAtMs`) stands in when that can't be read.
struct FileImage: View {
    let url: URL
    let version: Double
    var contentMode: ContentMode = .fit
    @State private var image: NSImage?
    private var key: String { "\(url.path)#\(FileVersion.of(url, else:version))" }
    var body: some View {
        Group {
            if let image = image ?? FileImages.cached(key) {
                Image(nsImage:image).resizable().interpolation(.high).aspectRatio(contentMode:contentMode)
            } else {
                Color.clear
            }
        }
        .task(id:key) {
            if let cached = FileImages.cached(key) { image = cached; return }
            let url = url, key = key
            let loaded = await Task.detached(priority:.userInitiated) { NSImage(contentsOf:url).map(SendableImage.init) }.value
            guard !Task.isCancelled else { return }
            if let loaded { FileImages.store(loaded.image, key) }
            image = loaded?.image
        }
    }
}

private struct SendableImage: @unchecked Sendable { let image: NSImage }

@MainActor enum FileImages {
    private static let cache: NSCache<NSString, NSImage> = { let cache = NSCache<NSString, NSImage>(); cache.countLimit = 120; return cache }()
    static func cached(_ key: String) -> NSImage? { cache.object(forKey:key as NSString) }
    static func store(_ image: NSImage, _ key: String) { cache.setObject(image, forKey:key as NSString) }
}
