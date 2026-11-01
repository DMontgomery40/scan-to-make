import SwiftUI
import AppKit
#if canImport(ControlKit)
import ControlKit
#endif

// The objects window (spec §5.1, §5.3–5.6): the same list and object pages as the iPhone app.
// A sidebar of cards, and a page that leads with what the object needs from the user, then the
// model itself, then Print and the corrections box. All copy comes from ObjectWords.

enum ObjectsStyle {
    /// The one action colour, the same cobalt as the iPhone app: Print, and what the object needs.
    static let accent = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red:0x7B/255, green:0x95/255, blue:0xFF/255, alpha:1)
            : NSColor(red:0x24/255, green:0x48/255, blue:0xD8/255, alpha:1)
    })
    /// Accent for text; cobalt keeps 4.5:1 on both window backgrounds.
    static let accentText = accent
    /// The model's stage: the iPhone's dark build plate, which the touch-up's renders sit on.
    static let stage = Color(nsColor:NSColor(name:nil) { appearance in
        appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
            ? NSColor(red:0x0E/255, green:0x10/255, blue:0x13/255, alpha:1)
            : NSColor(red:0x2C/255, green:0x31/255, blue:0x38/255, alpha:1)
    })
    static func color(_ tone: ObjectWords.Tone) -> Color {
        switch tone {
        case .pass: return Color(nsColor:.systemGreen)
        case .fail: return Color(nsColor:.systemRed)
        case .accent: return accent
        case .pending, .neutral: return Color(nsColor:.tertiaryLabelColor)
        }
    }
}

struct ObjectsWindowView: View {
    @ObservedObject var model: ObjectsModel
    var startWith3D = false
    var body: some View {
        Group {
            switch model.availability {
            case .loading where model.objects.isEmpty:
                ProgressView().controlSize(.small).frame(maxWidth:.infinity, maxHeight:.infinity)
            case .notSetUp:
                QuietMessage(text:"Scan to Make needs Claude Code and your printer set up on this Mac first.")
            case .notRunning:
                QuietMessage(text:"Scan to Make couldn’t start in the background.")
            default:
                if model.objects.isEmpty {
                    QuietMessage(title:"Nothing here yet",
                                 text:"Scan something, or say what you want made, on your iPhone. It shows up here.")
                } else {
                    split
                }
            }
        }
        .frame(minWidth:760, minHeight:520)
    }
    private var split: some View {
        NavigationSplitView {
            List(selection:$model.selection) {
                ForEach(model.objects) { ObjectCard(object:$0).tag($0.id) }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min:240, ideal:280, max:360)
        } detail: {
            if let object = model.selected {
                ObjectPage(object:object, model:model, startWith3D:startWith3D).id(object.id)
            } else {
                QuietMessage(text:"Choose something on the left.")
            }
        }
    }
}

/// One calm sentence in the middle of the window, for the states that have nothing else to show.
struct QuietMessage: View {
    var title: String?
    let text: String
    var body: some View {
        VStack(spacing:10) {
            Image(nsImage:.menuBarCube).resizable().renderingMode(.template).frame(width:34, height:34)
                .foregroundStyle(.tertiary).padding(.bottom, 4).accessibilityHidden(true)
            if let title { Text(title).font(.system(size:17, weight:.semibold)) }
            Text(text).font(.system(size:13)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).fixedSize(horizontal:false, vertical:true)
        }
        .frame(maxWidth:340)
        .frame(maxWidth:.infinity, maxHeight:.infinity)
        .padding(24)
    }
}

// MARK: - The list

struct ObjectCard: View {
    let object: StmObject
    var body: some View {
        let words = object.words
        HStack(spacing:11) {
            Thumbnail(object:object, busy:words.busy).frame(width:46, height:46)
            VStack(alignment:.leading, spacing:3) {
                Text(words.title).font(.system(size:13, weight:.semibold)).lineLimit(1)
                HStack(alignment:.firstTextBaseline, spacing:6) {
                    Circle().fill(ObjectsStyle.color(words.tone)).frame(width:6, height:6).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 0.5 }
                    Text(words.headline).font(.system(size:12)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 5)
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
                Image(systemName:"cube").font(.system(size:17, weight:.light)).foregroundStyle(.tertiary)
            }
        }
        .environment(\.colorScheme, .dark)  // The stage is always the dark plate.
        .clipShape(RoundedRectangle(cornerRadius:9, style:.continuous))
        .overlay(RoundedRectangle(cornerRadius:9, style:.continuous).strokeBorder(Color(nsColor:.separatorColor), lineWidth:0.5))
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
            VStack(alignment:.leading, spacing:20) {
                header
                if let problem = model.problem, problem.id == object.id {
                    Label(problem.text, systemImage:"exclamationmark.circle")
                        .font(.system(size:12.5)).foregroundStyle(Color(nsColor:.systemRed))
                }
                stage
                if words.actions.contains(.correct) {
                    Divider().padding(.top, 2)
                    corrections
                }
            }
            .padding(EdgeInsets(top:8, leading:32, bottom:32, trailing:32))
            .frame(maxWidth:860, alignment:.leading)
            .frame(maxWidth:.infinity)
        }
    }

    // The title, what's happening, and the one thing to do about it.
    private var header: some View {
        VStack(alignment:.leading, spacing:12) {
            HStack(alignment:.firstTextBaseline, spacing:16) {
                Text(words.title).font(.system(size:22, weight:.semibold)).textSelection(.enabled)
                    .fixedSize(horizontal:false, vertical:true)
                Spacer(minLength:0)
                printButton.alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 7 }
            }
            if words.tone == .accent {
                ask
            } else {
                VStack(alignment:.leading, spacing:4) {
                    // Ready says its size and "ready to print" in one line, rather than twice.
                    statusLine(object.state == .ready ? (words.size ?? words.status) : words.status)
                    if object.state != .ready, let size = words.size {
                        Text(size).font(.system(size:12.5)).foregroundStyle(.secondary).padding(.leading, 14)
                    }
                }
            }
        }
    }

    private func statusLine(_ text: String) -> some View {
        HStack(alignment:.firstTextBaseline, spacing:8) {
            if words.busy {
                ProgressView().controlSize(.mini).frame(width:8, height:8).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            } else {
                Circle().fill(ObjectsStyle.color(words.tone)).frame(width:7, height:7).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 0.5 }
            }
            Text(text).font(.system(size:13.5)).foregroundStyle(words.tone == .fail ? Color.primary : Color.secondary)
                .fixedSize(horizontal:false, vertical:true).textSelection(.enabled)
        }
    }

    @ViewBuilder private var printButton: some View {
        let action: ObjectAction? = words.actions.contains(.printChecked) ? .printChecked : words.actions.contains(.print) ? .print
            : words.actions.contains(.retry) ? .retry : nil
        if let action {
            HStack(spacing:10) {
                if working { ProgressView().controlSize(.small) }
                Button(action == .printChecked ? "I checked. Print again" : action == .retry ? "Try again" : "Print") { run(action) }
                    // No keyboard shortcut: Print starts the printer, so it is always a deliberate click.
                    .buttonStyle(.borderedProminent).controlSize(.large).tint(ObjectsStyle.accent)
                    .disabled(working)
                    .help(action == .printChecked ? "Only if the printer isn’t already printing this" : "")
            }
        }
    }

    /// The question (a close-up, or what's on the plate), with the photo and the answer this Mac can give.
    private var ask: some View {
        HStack(alignment:.top, spacing:16) {
            if let photo = object.platePhotoURL {
                FileImage(url:photo, version:object.updatedAtMs, contentMode:.fill)
                    .frame(width:200, height:150)
                    .clipShape(RoundedRectangle(cornerRadius:8, style:.continuous))
                    .accessibilityLabel("The printer camera’s photo of the plate")
            }
            VStack(alignment:.leading, spacing:10) {
                Text(words.status).font(.system(size:14, weight:.medium)).fixedSize(horizontal:false, vertical:true)
                if words.actions.contains(.bestGuess) {
                    Text("Send a close-up from your iPhone, or let me guess.").font(.system(size:12.5)).foregroundStyle(.secondary)
                    answer("Make your best guess", .bestGuess)
                }
                if words.actions.contains(.plateClear) { answer("It's actually clear", .plateClear) }
            }
            Spacer(minLength:0)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius:12, style:.continuous).fill(ObjectsStyle.accent.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius:12, style:.continuous).strokeBorder(ObjectsStyle.accent.opacity(0.24), lineWidth:1))
    }

    private func answer(_ title: String, _ action: ObjectAction) -> some View {
        HStack(spacing:10) {
            Button(title) { run(action) }.controlSize(.large).disabled(working)
            if working { ProgressView().controlSize(.small) }
        }
        .padding(.top, 2)
    }

    // The model: the chosen render or the turnable STL, with a strip to switch between them.
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
            .frame(minHeight:300, idealHeight:430, maxHeight:520)
            .aspectRatio(4 / 3, contentMode:.fit)
            .frame(maxWidth:.infinity)
            .clipShape(RoundedRectangle(cornerRadius:14, style:.continuous))
            .overlay(alignment:.bottomLeading) {
                if shown == .model {
                    Text("Drag to turn it").font(.system(size:11)).foregroundStyle(Color.white.opacity(0.72)).padding(12).allowsHitTesting(false)
                }
            }
            if object.modelURL != nil || object.renderURLs.count > 1 { strip }
        }
    }

    private var strip: some View {
        ScrollView(.horizontal, showsIndicators:false) {
            HStack(spacing:8) {
                if object.modelURL != nil {
                    tile(.model) {
                        VStack(spacing:3) {
                            Image(systemName:"rotate.3d").font(.system(size:17, weight:.regular))
                            Text("3D").font(.system(size:10.5, weight:.semibold))
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
            .padding(2)
        }
    }

    private func tile<Content: View>(_ view: Showing, @ViewBuilder content: () -> Content) -> some View {
        let selected = shown == view
        return Button { showing = view } label: {
            ZStack { ObjectsStyle.stage; content() }
                .environment(\.colorScheme, .dark)
                .frame(width:72, height:54)
                .clipShape(RoundedRectangle(cornerRadius:8, style:.continuous))
                .overlay(RoundedRectangle(cornerRadius:8, style:.continuous)
                    .strokeBorder(selected ? ObjectsStyle.accent : Color(nsColor:.separatorColor), lineWidth:selected ? 2 : 0.5))
        }
        .buttonStyle(.plain)
    }

    // "Anything to fix?": the note goes back to the touch-up, which starts again from this model.
    private var corrections: some View {
        VStack(alignment:.leading, spacing:8) {
            Text("Anything to fix?").font(.system(size:14, weight:.semibold))
            HStack(alignment:.bottom, spacing:10) {
                TextField("For example: you missed the clip on the side, or it's 70 mm long.", text:$note, axis:.vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...6).font(.system(size:13))
                    .onSubmit(send)
                Button("Send", action:send).controlSize(.large)
                    .keyboardShortcut(.return, modifiers:.command)
                    .disabled(working || note.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func send() {
        let text = note.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty, !working else { return }
        Task { if await model.perform(.correct, on:object.id, note:text) { note = "" } }
    }
    private func run(_ action: ObjectAction) { Task { await model.perform(action, on:object.id) } }
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

/// A file's modification time, so a picture or model reloads when its file is rewritten (a new pass
/// reuses the same names) and not when only the object's state changes. `fallback` if it can't be read.
enum FileVersion {
    static func of(_ url: URL, else fallback: Double) -> Double {
        ((try? FileManager.default.attributesOfItem(atPath:url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? fallback
    }
}

@MainActor enum FileImages {
    private static let cache: NSCache<NSString, NSImage> = { let cache = NSCache<NSString, NSImage>(); cache.countLimit = 120; return cache }()
    static func cached(_ key: String) -> NSImage? { cache.object(forKey:key as NSString) }
    static func store(_ image: NSImage, _ key: String) { cache.setObject(image, forKey:key as NSString) }
}
