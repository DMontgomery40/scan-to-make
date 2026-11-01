import SwiftUI
import AppKit
#if canImport(ControlKit)
import ControlKit
#endif

// The objects window (spec §5.1, §5.3–5.6): the same list and object pages as the iPhone app, as a
// standard macOS 27 window. The sidebar, toolbar and dialogs are the system's own, so they take on
// Liquid Glass by themselves; the page adds no backgrounds of its own. Cobalt is the one tint, and
// only on the primary action. All object copy comes from ObjectWords.

enum ObjectsStyle {
    /// The one tint, the same cobalt as the iPhone app: the primary action only.
    static let accent = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red:0x7B/255, green:0x95/255, blue:0xFF/255, alpha:1)
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
    @ViewBuilder func primaryAction() -> some View {
        if #available(macOS 26, *) { buttonStyle(.glassProminent).tint(ObjectsStyle.accent) }
        else { buttonStyle(.borderedProminent).tint(ObjectsStyle.accent) }
    }
    /// Every other button that stands on its own on a page.
    @ViewBuilder func secondaryAction() -> some View {
        if #available(macOS 26, *) { buttonStyle(.glass) } else { buttonStyle(.bordered) }
    }
}

struct ObjectsWindowView: View {
    @ObservedObject var model: ObjectsModel
    var startWith3D = false
    /// The object the Delete dialog is about, fixed when it opens: the selection can move underneath it.
    @State private var deleting: StmObject?

    var body: some View {
        NavigationSplitView {
            List(selection:$model.selection) {
                ForEach(model.objects) { ObjectCard(object:$0).tag($0.id) }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min:220, ideal:264, max:340)
            .onDeleteCommand { deleting = model.selected }
        } detail: {
            detail
        }
        .navigationTitle("Scan to Make")
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
        case .ready: return model.objects.isEmpty ? "" : model.objects.count == 1 ? "1 object" : "\(model.objects.count) objects"
        }
    }

    @ViewBuilder private var detail: some View {
        switch model.availability {
        case .loading where model.objects.isEmpty:
            ProgressView().controlSize(.small).frame(maxWidth:.infinity, maxHeight:.infinity)
        case .notSetUp:
            QuietMessage(title:"Not Set Up Yet", text:"Scan to Make needs Claude Code and your printer set up on this Mac first.")
        case .notRunning:
            QuietMessage(title:"Not Running", text:"Scan to Make couldn’t start in the background.")
        default:
            if let object = model.selected {
                ObjectPage(object:object, model:model, startWith3D:startWith3D).id(object.id)
            } else if model.objects.isEmpty {
                QuietMessage(title:"Nothing Here Yet", text:"Scan something, or say what you want made, in Scan to Make on your iPhone. It shows up here.")
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
                Text(words.title).font(.body.weight(.medium)).lineLimit(1)
                Text(words.headline).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
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

struct ObjectPage: View {
    let object: StmObject
    @ObservedObject var model: ObjectsModel
    @State private var showing: Showing?
    @State private var note = ""
    enum Showing: Hashable { case model, render(Int) }

    init(object: StmObject, model: ObjectsModel, startWith3D: Bool = false) {
        self.object = object
        self.model = model
        _showing = State(initialValue:startWith3D && object.modelURL != nil ? .model : nil)
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
                if words.tone == .accent { ask }
                stage
                if let instructions = object.instructions?.trimmingCharacters(in:.whitespacesAndNewlines), !instructions.isEmpty {
                    section("What You Asked For") {
                        Text(instructions).textSelection(.enabled).fixedSize(horizontal:false, vertical:true)
                    }
                }
                if words.actions.contains(.correct) { corrections }
            }
            .padding(EdgeInsets(top:20, leading:28, bottom:32, trailing:28))
            .frame(maxWidth:820, alignment:.leading)
            .frame(maxWidth:.infinity)
            .keepsScrollerRoom()
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
            Text(words.title).font(.title.weight(.semibold)).textSelection(.enabled)
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
                Button { run(action) } label: {
                    Label(action == .printChecked ? "I Checked. Print Again" : action == .retry ? "Try Again" : "Print",
                          systemImage:action == .retry ? "arrow.clockwise" : "printer")
                }
                .primaryAction().controlSize(.large)
                .disabled(working)
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
                    if words.actions.contains(.plateClear) {
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
                        .accessibilityLabel("Size \(ObjectWords.formatSize(size))")
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
        section("Anything to Fix?") {
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
        Task { if await model.perform(.correct, on:object.id, note:text) { note = "" } }
    }
    private func run(_ action: ObjectAction) { Task { await model.perform(action, on:object.id) } }
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
