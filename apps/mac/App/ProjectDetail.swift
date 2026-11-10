import SwiftUI
import UniformTypeIdentifiers
import AppKit
import QuickLook
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

/// One project (PRD §7.2): the model full height on the dark stage, the state in a glass capsule, the size,
/// what the Mac needs or is doing in one glass card, and a glass bar with Ask for changes… and Print….
struct ProjectDetail: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    let print: () -> Void
    @State private var note = ""
    @State private var showingSettings = false
    @State private var choosingModelFiles = false
    @State private var renaming = false
    @State private var projectName = ""
    @FocusState private var noteFocused: Bool
    @State private var photos: [URL] = []
    @State private var dropProblem: String?
    @State private var targeted = false
    @State private var stopping = false

    private var words: ObjectWords { object.words }

    /// The state; with Project Settings, also the menu that sets it (Done for something printed elsewhere, PRD §5.4).
    @ViewBuilder private var statusCapsule: some View {
        if model.capabilities?.projectSettings == true {
            Menu {
                ProjectStatusItems(object: object, model: model)
            } label: {
                StatusCapsule(stage: words.stage, text: words.capsule, done: words.done, menu: true)
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .disabled(working)
            .help("Set the status: Not Printed, Printed, Done or Needs Changes")
            .accessibilityLabel("Status: \(words.capsule)")
        } else {
            StatusCapsule(stage: words.stage, text: words.capsule, done: words.done)
        }
    }
    private var working: Bool { model.working.contains(object.id) }
    private var takesPhotos: Bool { model.capabilities?.objectsCreate == true }

    var body: some View {
        ZStack(alignment: .bottom) {
            stage
                .overlay(alignment: .topLeading) { statusCapsule.padding(.top, 70).padding(.leading, 24) }
                .overlay(alignment: .topTrailing) {
                    if let size = words.size {
                        Text(size).font(.callout.monospacedDigit().weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7).glassEffect(.regular, in: .capsule)
                            .padding(.top, 64).padding(.trailing, 24)
                            .accessibilityLabel("Size \(size)")
                    }
                }
                .ignoresSafeArea(edges: .top)
            VStack(spacing: 12) {
                if (object.plates?.count ?? 0) > 1 {
                    ProjectPlatesView(project: object, busy: working, thumbnail: { plate in
                        if let url = plate.thumbnail.flatMap(object.projectFile) {
                            FillImage(url: url, version: object.updatedAtMs)
                        } else {
                            Image(systemName: "square.stack.3d.up").font(.largeTitle).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }, select: { plate in
                        Task { await model.selectPlate(object.id, plate: plate) }
                    }, printPlate: { plate in
                        Task { if await model.selectPlate(object.id, plate: plate) { print() } }
                    })
                    .padding(12).background(.regularMaterial, in: .rect(cornerRadius: 20))
                }
                if object.kind == "published" {
                    HStack {
                        Button("Add Model Files", systemImage: "doc.badge.plus") { choosingModelFiles = true }
                            .buttonStyle(.glass).disabled(working || object.state == .printing || object.state == .touchingUp || object.print?.uncertain == true)
                        Spacer()
                    }
                }
                card
                bar
            }
            .frame(maxWidth: 680)
            .padding(24)
        }
        .fileImporter(isPresented: $choosingModelFiles, allowedContentTypes: [UTType(filenameExtension: "3mf") ?? .data, UTType(filenameExtension: "stl") ?? .data], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let files): Task {
                for file in files {
                    let access = file.startAccessingSecurityScopedResource()
                    let used = await model.useModelFile(file, for: object.id)
                    if access { file.stopAccessingSecurityScopedResource() }
                    if !used { break }
                }
            }
            case .failure(let error): dropProblem = error.localizedDescription
            }
        }
        .navigationTitle(words.title)
        .navigationSubtitle(words.subtitle(request: object.instructions))
        .toolbar {
            ToolbarItem {
                if model.capabilities?.projectRename == true || model.capabilities?.projectPreferences == true {
                    Menu {
                        if model.capabilities?.projectRename == true {
                            Button("Rename Project…", systemImage: "pencil") { projectName = words.title; renaming = true }
                                .disabled(working)
                        }
                        if model.capabilities?.projectPreferences == true {
                            Button("Project Settings", systemImage: "slider.horizontal.3") { showingSettings = true }
                        }
                    } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("More")
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            MacProjectSettings(opened: object, model: model).frame(width: 560, height: 660)
        }
        .alert("Rename Project", isPresented: $renaming) {
            TextField("Project name", text: $projectName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let title = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await model.rename(object.id, title: title) }
            }.disabled(!Project.validName(projectName))
        }
    }

    // MARK: Stage

    @ViewBuilder private var stage: some View {
        if !object.preservesPublishedFilaments, let url = object.modelURL ?? object.scanURL.flatMap({ $0.pathExtension.lowercased() == "usdz" ? $0 : nil }) {
            ModelStage(url: url, version: FileVersion.of(url, else: object.updatedAtMs), fit: 0.15,
                       accessibilityText: "\(words.title)\(words.size.map { ", \($0)" } ?? ""). Drag to turn it, scroll to zoom.",
                       poster: Self.poster(object))
        } else {
            ZStack {
                StageBackground()
                if let still = object.thumbnailURL {
                    FileImage(url: still, version: object.updatedAtMs, contentMode: .fit).padding(80)
                } else if words.busy {
                    ProgressView().controlSize(.large)
                } else {
                    Image(systemName: "cube").font(.system(size: 54, weight: .ultraLight)).foregroundStyle(.white.opacity(0.35))
                }
            }
            .environment(\.colorScheme, .dark)
            .overlay(alignment: .bottom) {
                if object.preservesPublishedFilaments {
                    Text("Plate preview · 3D unavailable").font(.caption).padding(8).glassEffect(.regular, in: .capsule).padding(16)
                }
            }
        }
    }

    /// The companion's overview render of the current model, the stage's still.
    static func poster(_ object: Project) -> URL? {
        let renders = object.renderURLs
        return renders.first { $0.lastPathComponent.contains("overview") } ?? renders.first
    }

    // MARK: The one card

    /// What the Mac needs, or what it is doing, in one glass card above the bar. Nothing when it's ready.
    @ViewBuilder private var card: some View {
        if model.corrections.failures[object.id] != nil, object.pendingFollowup == nil {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your change is saved. Check the result before trying again.").font(.subheadline)
                HStack {
                    Button("Try Again") { model.retryQueuedChange(object) }.disabled(object.changesWait)
                    Button("Discard Saved Change") { model.discardQueuedChange(object) }
                }.disabled(working)
            }.padding(12).glassEffect(.regular, in: .rect(cornerRadius: 14))
        }
        if let pending = object.pendingFollowup {
            VStack(alignment: .leading, spacing: 8) {
                Text("Message saved").font(.headline)
                Text(pending).font(.subheadline).textSelection(.enabled)
                HStack {
                    Button("Try Again") { Task { await model.perform(.correct, on: object.id, note: pending) } }
                    Button("Mark Done") { Task { await model.setStatus("works", for: object.id) } }
                }.disabled(working)
            }.padding(12).glassEffect(.regular, in: .rect(cornerRadius: 14))
        }
        if let previous = object.completionUndoStatus {
            HStack {
                Label("Marked Done", systemImage: "checkmark.circle.fill")
                Spacer()
                Button("Undo") { Task { await model.setStatus(previous.rawValue, for: object.id) } }.disabled(working)
            }.padding(12).glassEffect(.regular, in: .rect(cornerRadius: 14))
        }
        if let problem = model.problem, problem.id == object.id {
            Label(problem.text, systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(.red).textSelection(.enabled)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular.tint(.red.opacity(0.12)), in: .rect(cornerRadius: 14))
        }
        if let dropProblem {
            Label(dropProblem, systemImage: "photo.badge.exclamationmark")
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 14))
        }
        if let confirmation = object.printConfirmation {
            PrintConfirmationForm(object: object, question: confirmation, model: model).id(object.id + ":" + confirmation.id)
        } else {
            switch words.stage {
            case .needsYou where model.extras[object.id]?.fileAsk != nil:
                FileAskCard(object: object, ask: model.extras[object.id]!.fileAsk!, model: model)
            case .needsYou where model.extras[object.id]?.choiceAsk != nil:
                ChoiceAskCard(object: object, ask: model.extras[object.id]!.choiceAsk!, model: model).id(model.extras[object.id]!.choiceAsk!.id)
            case .printed where !words.done && model.capabilities?.projectSettings == true && DidItFit.asks(object, model.extras[object.id]):
                DidItFitCard(object: object, model: model, published: model.extras[object.id]?.credit != nil) {
                    // Keep a correction the person had already started.
                    if note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { note = "After printing: " }
                    noteFocused = true
                }
                .id(DidItFit.key(object))
            case .needsYou: needsYou
            case .preparing where words.printRunning: printingCard
            case .working, .sending, .preparing: progressCard
            case .printing: printingCard
            case .failed: failedCard
            default: EmptyView()
            }
        }
    }

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(words.question ?? words.status).font(.subheadline.weight(.semibold))
                Text(object.state == .needsCloseup ? "Asked on your iPhone too. Send a close-up from it, or let your Mac make its best guess."
                     : "Asked on your iPhone too.")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
            if words.actions.contains(.bestGuess) { answer("Best Guess", .bestGuess) }
        }
            // The question's picture (David, Nov 9: the phone's was "almost impossible to see"; the Mac showed none).
            if let ask = object.openAsk, let url = object.askPhotoURL ?? object.thumbnailURL {
                MacAskPhoto(url: url, region: ask.photo != nil ? ask.region : nil, caption: AskPicture.caption(ask), version: object.updatedAtMs)
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 14))
    }

    private func answer(_ title: String, _ action: ObjectAction) -> some View {
        Button(title) { Task { await model.perform(action, on: object.id) } }
            .buttonStyle(.glass).controlSize(.large).disabled(working).fixedSize()
    }

    private var progressCard: some View {
        HStack(spacing: 12) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(words.stage == .working ? words.status : words.stage.label).font(.subheadline.weight(.semibold))
                Text("You can leave this. Counterpart tells you when it’s ready.").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }

    private var printingCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                // The companion's words as they are: "Getting ready · …" while the printer prepares, then its progress.
                Text(words.status).font(.subheadline.weight(.semibold))
                Spacer()
            }
            if let progress = words.progress { ProgressView(value: progress).tint(.okGreen) }
            if model.capabilities?.printControl == true { printControls }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }

    /// Pause, Resume and Stop, when the printer's MCP has them. Stop asks first; the MCP may ask its own question too.
    @ViewBuilder private var printControls: some View {
        let capabilities = model.printer(for: object)?.capabilities
        let paused = object.print?.live?.state == "paused"
        HStack(spacing: 8) {
            Spacer()
            if paused, capabilities?.resume ?? true {
                Button("Resume") { Task { await model.control(object.id, .resume) } }.buttonStyle(.glass)
            } else if !paused, capabilities?.pause ?? true {
                Button("Pause") { Task { await model.control(object.id, .pause) } }.buttonStyle(.glass)
            }
            if capabilities?.cancel ?? true {
                Button("Stop…", role: .destructive) { stopping = true }.buttonStyle(.glass)
            }
        }
        .disabled(working)
        .confirmationDialog("Stop the print?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop Printing", role: .destructive) { Task { await model.control(object.id, .cancel) } }
            Button("Keep Printing", role: .cancel) {}
        } message: { Text("The printer stops now.") }
    }

    private var failedCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(words.status).font(.subheadline).lineLimit(4).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            if words.actions.contains(.retry) {
                Button("Try Again") { Task { await model.perform(.retry, on: object.id) } }.buttonStyle(.glass).controlSize(.large).disabled(working).fixedSize()
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.red.opacity(0.12)), in: .rect(cornerRadius: 14))
    }

    // MARK: The bar

    private var canCorrect: Bool { object.canAskForChanges && !working }
    private var canPrint: Bool {
        (words.actions.contains(.print) || words.actions.contains(.printChecked)) && !working && model.printer(for: object) != nil
    }

    private var bar: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    // Part of the field: a click on it is a click in the field.
                    Image(systemName: "text.bubble").foregroundStyle(.secondary)
                        .contentShape(Rectangle()).onTapGesture { if canCorrect { noteFocused = true } }.accessibilityHidden(true)
                    ForEach(photos, id: \.self) { url in
                        FillImage(url: url, version: 0).frame(width: 26, height: 26).clipShape(.rect(cornerRadius: 6))
                            .overlay(alignment: .topTrailing) {
                                Button { photos.removeAll { $0 == url } } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.plain).font(.caption2).offset(x: 5, y: -5).accessibilityLabel("Remove photo")
                            }
                    }
                    TextField(model.corrections.pending(object.id) != nil ? "Will send when this step finishes" : takesPhotos ? "Ask for changes. Drop photos here too…" : "Ask for changes…", text: $note)
                        .textFieldStyle(.plain).focused($noteFocused)
                        .onSubmit(send)
                        .disabled(!canCorrect)
                    if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !photos.isEmpty {
                        Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                            .buttonStyle(.plain).foregroundStyle(Color.filament).disabled(!canCorrect)
                            .keyboardShortcut(.return, modifiers: .command).accessibilityLabel("Send")
                    }
                }
                .padding(.horizontal, 16).frame(height: 44)
                .glassEffect(targeted ? .regular.tint(Color.filament.opacity(0.25)).interactive() : .regular.interactive(), in: .capsule)
                .dropDestination(for: URL.self) { urls, _ in drop(urls) } isTargeted: { targeted = $0 && canCorrect }
                if words.actions.contains(.retry) && object.current == nil {
                    EmptyView()
                } else {
                    Button(action: print) { Label(words.done ? "Print Another…" : object.state == .failed && object.print != nil ? "Print Again…" : "Print…",
                                                       systemImage: "printer.fill").padding(.horizontal, 6).frame(height: 30) }
                        .buttonStyle(.glassProminent).controlSize(.extraLarge)
                        .disabled(!canPrint)
                        .help(model.printer(for: object) == nil ? model.missingPrinterText : "")
                }
            }
        }
    }

    private func drop(_ urls: [URL]) -> Bool {
        let images = urls.filter { ObjectsModel.fileKind($0) == "photos" }
        guard canCorrect, !images.isEmpty else { return false }
        guard takesPhotos else {
            dropProblem = "Send photos from your iPhone for now. This Mac can take them after Counterpart’s next update."
            return false
        }
        dropProblem = nil
        photos = Array((photos + images).prefix(8))
        return true
    }

    private func send() {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canCorrect, !text.isEmpty || !photos.isEmpty else { return }
        let sent = photos
        Task {
            if await model.requestChanges(object.id, note: text, photos: sent) { note = ""; photos = [] }
        }
    }
}

/// The printer MCP's own confirmation, answered here exactly as asked (PRD §5.5): every field it asks, with its own
/// title and description, as a checkbox, a choice, text or a number (CounterpartKit's schema and checks, shared with
/// the phone). Each check is the person's to tick; the camera photo is only a reference.
struct PrintConfirmationForm: View {
    let object: Project
    let question: Project.PrintConfirmation
    @ObservedObject var model: ObjectsModel
    @State private var draft: PrintConfirmationDraft

    init(object: Project, question: Project.PrintConfirmation, model: ObjectsModel) {
        self.object = object; self.question = question; self.model = model
        _draft = State(initialValue: PrintConfirmationDraft(question))
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let answer = draft.answer(question, at: context.date.timeIntervalSince1970 * 1000)
            let expired = question.expiresAtMs <= context.date.timeIntervalSince1970 * 1000
            // The original Resume call waits for this answer; it must not disable its own form.
            let working = model.answeringPrintConfirmations.contains(object.id)
            VStack(alignment: .leading, spacing: 10) {
                Label(object.words.question ?? "Your printer needs a yes before printing", systemImage: "hand.raised.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                // The printer MCP's own safety checks, every word of them: scrolling when they are long, never cut.
                ViewThatFits(in: .vertical) {
                    details(working: working, expired: expired)
                    ScrollView { details(working: working, expired: expired) }
                }
                .frame(maxHeight: 360)
                HStack(spacing: 10) {
                    Spacer()
                    if working { ProgressView().controlSize(.small) }
                    Button(object.print?.live?.state == "paused" ? "Cancel Resume" : "Cancel Print", role: .destructive) {
                        Task { await model.answerPrintConfirmation(object.id, confirmationId: question.id, answer: .init(action: .cancel)) }
                    }
                    .buttonStyle(.glass).disabled(working || expired)
                    if question.isRenderable {
                        Button(object.print?.live?.state == "paused" ? "Resume" : "Print") {
                            guard let answer = draft.answer(question, at: Date().timeIntervalSince1970 * 1000) else { return }
                            Task { await model.answerPrintConfirmation(object.id, confirmationId: question.id, answer: answer) }
                        }
                        .buttonStyle(.glassProminent).disabled(working || answer == nil)
                    }
                }
            }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 14))
        }
    }

    private func details(working: Bool, expired: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: question.message).font(.callout).textSelection(.enabled).lineLimit(nil)
            if question.isRenderable {
                ForEach(question.fields, id: \.name) { field in
                    ConfirmationFieldRow(field: field, draft: $draft).disabled(working || expired)
                }
            } else {
                Text("This question can’t be answered here. Cancel the print to continue.").font(.callout).foregroundStyle(.secondary)
            }
            if expired { Text("This question has expired.").font(.callout).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One field of the printer's form, as its type asks: a checkbox, a choice, text, or a number.
private struct ConfirmationFieldRow: View {
    let field: Project.PrintConfirmation.Field
    @Binding var draft: PrintConfirmationDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch field.type {
            case .boolean:
                Toggle(isOn: Binding(get: { draft.values[field.name] == .bool(true) }, set: { draft.values[field.name] = .bool($0) })) { label }
                    .toggleStyle(.checkbox)
            case .string where field.enumValues != nil:
                Picker(selection: Binding(get: { if case .string(let value)? = draft.values[field.name] { return value } else { return "" } },
                                          set: { draft.values[field.name] = $0.isEmpty ? nil : .string($0) })) {
                    if !field.required || draft.values[field.name] == nil { Text("Choose…").tag("") }
                    ForEach(field.enumValues ?? [], id: \.self) { value in Text(verbatim: field.displayName(of: value)).tag(value) }
                } label: { label }
                .pickerStyle(.menu).fixedSize()
            case .string, .number, .integer:
                label
                TextField(field.title, text: Binding(get: { draft.text[field.name] ?? "" }, set: { draft.text[field.name] = $0 }),
                          prompt: prompt.map { Text($0) })
                    .textFieldStyle(.roundedBorder).labelsHidden().frame(maxWidth: field.type == .string ? 360 : 140, alignment: .leading)
            case .unknown:
                label
            }
            if let problem = draft.problem(field) { Text(problem).font(.caption).foregroundStyle(.orange) }
        }
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: field.title + (field.required && field.type != .boolean ? " (required)" : ""))
            if let description = field.description { Text(verbatim: description).font(.caption).foregroundStyle(.secondary) }
        }
        .lineLimit(nil)
    }

    /// A hint at what fits: the range for a number, the shape for a formatted string.
    private var prompt: String? {
        switch field.type {
        case .number, .integer:
            switch (field.minimum, field.maximum) {
            case let (low?, high?): return "\(PrintConfirmationDraft.plain(low))–\(PrintConfirmationDraft.plain(high))"
            case let (low?, nil): return "\(PrintConfirmationDraft.plain(low)) or more"
            case let (nil, high?): return "up to \(PrintConfirmationDraft.plain(high))"
            default: return field.type == .integer ? "a whole number" : nil
            }
        default:
            switch field.format {
            case "email": return "name@example.com"
            case "uri": return "https://"
            case "date": return "2026-11-01"
            case "date-time": return "2026-11-01T10:00:00Z"
            default: return nil
            }
        }
    }
}

/// PRD §8.11: the project waits for the designer's own file. The worker tries the person's browser and `~/Downloads`
/// first; this is the last step, never a look-alike. The file can come from a drop, Choose File…, the model page in the
/// browser, or a new download ("Use *name*?").
private struct FileAskCard: View {
    let object: Project
    let ask: PublishedExtras.Ask
    @ObservedObject var model: ObjectsModel
    @ObservedObject private var downloads = DownloadsWatcher.shared
    @State private var targeted = false

    private var working: Bool { model.working.contains(object.id) }
    private var accepts: [String] { ask.accepts ?? ["3mf", "stl"] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "arrow.down.doc.fill").font(.title2).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: ask.question).font(.subheadline.weight(.semibold)).lineLimit(nil)
                    Text("Drop the \(accepts.map { $0.uppercased() }.joined(separator: " or ")) here, choose it, or download it in your browser: Counterpart sees it arrive in Downloads.")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(4)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(downloads.candidates[object.id] ?? [], id: \.self) { file in
                HStack(spacing: 8) {
                    Image(systemName: "cube.fill").foregroundStyle(Color.filament)
                    Text("Use \(file.lastPathComponent)?").font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button("Not This") { downloads.dismiss(file, for: object.id) }.buttonStyle(.glass)
                    Button("Use") { Task { await model.useModelFile(file, for: object.id) } }.buttonStyle(.glassProminent).disabled(working)
                }
                .padding(8).glassEffect(.regular, in: .rect(cornerRadius: 10))
            }
            HStack(spacing: 10) {
                if let page = ask.url.flatMap(URL.init(string:)) {
                    Button("Open in Browser") { NSWorkspace.shared.open(page) }.buttonStyle(.glass)
                }
                Button("Choose File…") { choose() }.buttonStyle(.glass).disabled(working)
                Spacer()
                if working { ProgressView().controlSize(.small) }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(targeted ? 0.3 : 0.15)), in: .rect(cornerRadius: 14))
        .dropDestination(for: URL.self) { urls, _ in
            guard let file = urls.first(where: { accepts.contains($0.pathExtension.lowercased()) }) else { return false }
            Task { await model.useModelFile(file, for: object.id) }
            return true
        } isTargeted: { targeted = $0 }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = accepts.compactMap { UTType(filenameExtension: $0) }
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        panel.prompt = "Use"
        if panel.runModal() == .OK, let file = panel.url { Task { await model.useModelFile(file, for: object.id) } }
    }
}

/// PRD §8.11: a question with the companion's own options (which plate or object, which colour), answered here or on
/// the phone. Several can be picked when the Ask allows it.
private struct ChoiceAskCard: View {
    let object: Project
    let ask: PublishedExtras.Ask
    @ObservedObject var model: ObjectsModel
    @State private var picked: Set<String> = []

    private var working: Bool { model.working.contains(object.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label { Text(verbatim: ask.question).font(.subheadline.weight(.semibold)).lineLimit(nil) } icon: {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(ask.options ?? []) { option in
                        Button { toggle(option.id) } label: { tile(option) }.buttonStyle(.plain).disabled(working)
                    }
                }
            }
            if ask.multiple == true {
                HStack {
                    Spacer()
                    if working { ProgressView().controlSize(.small) }
                    Button("Use These") { send(Array(picked)) }.buttonStyle(.glassProminent).disabled(picked.isEmpty || working)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 14))
    }

    private func tile(_ option: PublishedExtras.Option) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let thumbnail = option.thumbnail.flatMap(object.projectFile) {
                FillImage(url: thumbnail, version: object.updatedAtMs).frame(width: 120, height: 84).clipShape(.rect(cornerRadius: 8))
            }
            Text(verbatim: option.label).font(.callout.weight(.medium)).lineLimit(2)
            if let detail = option.detail { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
        .frame(width: 132, alignment: .leading)
        .padding(8)
        .glassEffect(picked.contains(option.id) ? .regular.tint(Color.filament.opacity(0.35)) : .regular, in: .rect(cornerRadius: 10))
    }

    private func toggle(_ id: String) {
        if ask.multiple == true {
            if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
        } else {
            send([id])
        }
    }

    private func send(_ choices: [String]) {
        Task { await model.answerAsk(object.id, askId: ask.id, choices: choices) }
    }
}

private struct DidItFitCard: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    /// A published model: "Did it come out right?" (PRD §8.11).
    let published: Bool
    let needsChanges: () -> Void
    @State private var hidden = false
    private var working: Bool { model.working.contains(object.id) }

    var body: some View {
        if !hidden {
            HStack(spacing: 12) {
                Image(systemName: "questionmark.circle.fill").font(.title2).foregroundStyle(Color.filament)
                Text(published ? "Did it come out right?" : "Did it fit?").font(.subheadline.weight(.semibold))
                Spacer()
                Button("Not Now") { DidItFit.dismiss(object); hidden = true }.buttonStyle(.plain).foregroundStyle(.secondary)
                Button("Needs Changes") {
                    Task {
                        guard await model.setStatus("needs-changes", for: object.id) else { return }
                        DidItFit.dismiss(object)
                        hidden = true
                        needsChanges()
                    }
                }
                .buttonStyle(.glass).disabled(working)
                Button {
                    Task { if await model.setStatus("works", for: object.id) { DidItFit.dismiss(object); hidden = true } }
                } label: { Label("It Works", systemImage: "checkmark.circle.fill") }
                    .buttonStyle(.glassProminent).disabled(working)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 14))
        }
    }
}

/// Native file access and the socket stay outside the shared settings form.
private struct MacProjectSettings: View {
    let opened: Project
    @ObservedObject var model: ObjectsModel
    private var project: Project { model.objects.first { $0.id == opened.id } ?? opened }
    var body: some View {
        ProjectSettingsForm(project: project, files: project.settingsFiles,
            reveal: { if let folder = project.folderURL { NSWorkspace.shared.activateFileViewerSelecting([folder]) } },
            load: { try await model.projectSettingsContext(project.id) },
            save: { try await model.savePreferences(project.id, patch: $0) },
            duplicate: { try await model.duplicate(project.id) },
            delete: {
                guard await model.delete(project.id) else { throw CompanionError(code: "delete-failed", message: model.problem?.text ?? "Couldn't delete the project.") }
            }, download: { file in
                var relative = file.id
                if file.id.hasPrefix("original/"), let index = Int(file.id.dropFirst(9)),
                   case .array(let files)? = project.files?.object?["original"], files.indices.contains(index), let path = files[index].string { relative = path }
                guard let url = file.id == "model.stl" ? project.modelURL : project.file(relative), FileManager.default.fileExists(atPath: url.path) else {
                    throw CompanionError(code: "not-found", message: "This file is no longer on your Mac.")
                }
                let resolved = url.resolvingSymlinksInPath()
                guard let root = project.folderURL?.resolvingSymlinksInPath(), resolved.path.hasPrefix(root.path + "/"),
                      (try resolved.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else {
                    throw CompanionError(code: "not-found", message: "This file isn't inside the project's folder.")
                }
                return resolved
            })
    }
}

/// The question's picture on the Mac: the card's width at the photo's own aspect ratio, the rest dimmed and the asked-about
/// part outlined. Click (or Space) opens it in Quick Look with the region marked, where it zooms.
struct MacAskPhoto: View {
    let url: URL
    let region: Project.Region?
    let caption: String
    let version: Double
    @State private var image: CGImage?
    @State private var preview: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { open() } label: {
                ZStack {
                    if let image { Image(decorative: image, scale: 1).resizable() } else { Color.black.opacity(0.25) }
                    AskRegionOverlay(region: image == nil ? nil : region)
                }
                .aspectRatio(image.map { CGFloat($0.width) / CGFloat(max($0.height, 1)) } ?? 4 / 3, contentMode: .fit)
                .clipShape(.rect(cornerRadius: 10))
                .frame(maxWidth: .infinity, maxHeight: 420)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.space, modifiers: [])
            .help("Open in Quick Look")
            .accessibilityLabel(caption)
            .accessibilityHint("Opens the picture in Quick Look")
            .accessibilityIdentifier("ask-picture")
            Text(caption).font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
        }
        .quickLookPreview($preview)
        .task(id: "\(url.path)#\(version)") {
            let url = url
            image = await Task.detached(priority: .userInitiated) { AskPicture.upright(url, maxPixels: 1600) }.value
        }
    }

    private func open() {
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("counterpart-ask-\(abs(url.path.hashValue))-\(Int64(version)).jpg")
        let url = url, region = region
        Task {
            let ok = await Task.detached { FileManager.default.fileExists(atPath: target.path) || AskPicture.markedFile(from: url, region: region, to: target) }.value
            preview = ok ? target : url
        }
    }
}
