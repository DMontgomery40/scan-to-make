import SwiftUI
import QuickLook
import RealityKit
import ARKit
import CounterpartKit

enum ProjectSection: String, CaseIterable { case result = "Result", inputs = "What you sent", activity = "Activity" }

/// A project (PRD §5.4, screens/phone-ready.jpg, phone-working.jpg, phone-ask.jpg, phone-inputs.jpg,
/// phone-failed.jpg): the model on its stage, what's happening in words, and what you sent.
///
/// Guards: actions run through `act`, single flight (`working`), released when they settle. A saved capture
/// is resumed once per page (`resumed`). Polling is tied to the page and stops when it closes.
struct ProjectView: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    let id: String
    let close: () -> Void
    var openPrint: (String) -> Void = { _ in }
    var openPrinting: (String) -> Void = { _ in }
    @State private var section = ProjectSection.result
    @State private var note = ""
    @State private var working = false
    @State private var problem: String?
    @State private var fetchProblem: String?
    @State private var resumed = false
    @State private var confirmDelete = false
    @State private var modelURL: URL?
    @State private var arURL: URL?
    @State private var scanURL: URL?
    @State private var scanSize: String?
    @State private var askWorking = false
    @State private var askProblem: String?
    /// The printer's own question, shown as a sheet once when it arrives and again from Review.
    @State private var confirming: IdentifiedProject?
    @FocusState private var writing: Bool
    private var object: Project? { store.project(id) }

    var body: some View {
        Group {
            if let object { page(object) } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.black) }
        }
        .task(id: id) {
            await reload()
            if let object { section = defaultSection(object) }
            #if DEBUG
            if let debug = app.debugSection, let chosen = ProjectSection.allCases.first(where: { "\($0)" == debug }) { section = chosen; app.debugSection = nil }
            #endif
            await resumeSavedCapture()
        }
        .modifier(PrinterQuestion(store: store, project: object, confirming: $confirming))
        .task(id: object.map { store.words($0).busy } ?? false) {
            guard let object, store.words(object).busy, store.events != true else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if UIApplication.shared.applicationState != .background { await reload() }
            }
        }
    }

    private func defaultSection(_ object: Project) -> ProjectSection {
        object.current != nil ? .result : store.words(object).phase == .working || store.words(object).phase == .failed ? .activity : .inputs
    }

    private func reload() async {
        do { store.replace(try await store.mac.get(id)); fetchProblem = nil }
        catch let failure as CompanionError { if failure.code != "cancelled" { fetchProblem = failure.message } }
        catch { fetchProblem = CompanionError.unreachable.message }
    }

    // MARK: Sending and resuming (the same paths New uses; see MacConnection.sendProject)

    /// Resume a send cut short (after relaunch too), even when the model or some photos already reached the
    /// Mac. Only a send you asked for: a draft whose scan is attached but never sent waits for Send.
    private func resumeSavedCapture() async {
        guard !resumed, let object, object.state == .new, !store.sending.contains(object.id), MacConnection.sendRequested(object.id) else { return }
        resumed = true
        let saved = HandheldCapture.finished(object.id) ? true : await store.mac.finishedScan(object.id) != nil
        if saved { act { try await finishSending(object) } }
    }

    private func finishSending(_ object: Project) async throws -> Project? {
        try await store.mac.sendProject(object.id, photos: MacConnection.pendingPhotos(object.id))
    }

    private func scan(_ object: Project, handheld: Bool) async throws -> Project? {
        let saved = HandheldCapture.finished(object.id) ? true : await store.mac.finishedScan(object.id) != nil
        if saved { return try await finishSending(object) }
        guard object.scan == nil, (object.capture ?? []).isEmpty else {
            throw CompanionError(code: "missing-capture", message: "This project's saved scan is no longer on this phone. Start a new project to scan it again.")
        }
        if handheld { return await HandheldCapture.run(objectId: object.id) ? try await finishSending(object) : nil }
        guard try await store.mac.scan(object.id) != nil else { return nil }
        return try await finishSending(object)
    }

    private func act(_ body: @escaping () async throws -> Project?) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do { if let next = try await body() { store.replace(next) } else { await reload() } }
            catch let failure as CompanionError {
                if failure.code == "cancelled" { return }
                if failure.needsPairing { store.onPair(); return }
                problem = failure.message
            } catch { problem = CompanionError.unreachable.message }
        }
    }

    // MARK: Page

    @ViewBuilder private func page(_ object: Project) -> some View {
        let words = store.words(object)
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                hero(object, words)
                VStack(alignment: .leading, spacing: 6) {
                    HStack { StatusCapsule(phase: words.phase); Spacer(); Text(Format.when(object.updatedAt)).font(.caption).foregroundStyle(.secondary) }
                    Text(words.title).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                    if let request = object.instructions, !request.isEmpty, request != words.title {
                        Text(request).font(.body).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .padding(.horizontal, 20)

                if let message = problem ?? fetchProblem ?? store.sendFailures[object.id] {
                    Label(message, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange).padding(.horizontal, 20)
                }
                stateCard(object, words).padding(.horizontal, 16)

                Picker("Section", selection: $section) {
                    ForEach(ProjectSection.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)

                Group {
                    switch section {
                    case .result: ResultSection(store: store, project: object)
                    case .inputs: InputsSection(project: object)
                    case .activity: ActivitySection(store: store, project: object)
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 120)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
        .background(Color.black)
        .scrollEdgeEffectStyle(.soft, for: .all)
        .scrollDismissesKeyboard(.interactively)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if writing { ToolbarItem(placement: .confirmationAction) { Button("Done") { writing = false } } }
            if let modelURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: modelURL, preview: SharePreview("\(words.title).stl")) { Image(systemName: "square.and.arrow.up") }
                }
            } else if let scanURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: scanURL, preview: SharePreview("\(words.title).usdz")) { Image(systemName: "square.and.arrow.up") }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let modelURL { ShareLink("Share STL", item: modelURL) }
                    if let arURL { ShareLink("Share USDZ", item: arURL) } else if let scanURL { ShareLink("Share Your Scan (USDZ)", item: scanURL) }
                    Divider()
                    Button("Delete Project", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("More")
            }
        }
        .safeAreaBar(edge: .bottom) {
            // A failed pass that left an earlier model still offers changes and Print; with no model, the failed card's Try Again is the way on.
            if words.phase != .needsYou && !(words.phase == .failed && object.current == nil) { bottomBar(object, words) }
        }
        .confirmationDialog("Delete this project from your Mac?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Project", role: .destructive) {
                Task {
                    do { try await store.mac.delete(object.id); store.remove(object.id); close() }
                    catch let failure as CompanionError { problem = failure.message }
                    catch { problem = CompanionError.unreachable.message }
                }
            }
        } message: { Text("Its model, photos and activity are removed from your Mac.") }
        .task(id: "\(object.id)#\(object.mediaVersion)#\(object.current?.model ?? "")") {
            modelURL = nil; arURL = nil
            guard object.current != nil, let url = try? await store.mac.download(object, "model.stl") else { return }
            modelURL = url
            arURL = await ARModel.usdz(fromSTL: url)
        }
    }

    // MARK: Hero

    @ViewBuilder private func hero(_ object: Project, _ words: ProjectWords) -> some View {
        Group {
            if object.current != nil {
                ModelStage(url: modelURL, twoTone: false)
            } else if let scanURL {
                ModelStage(url: scanURL, twoTone: false)
            } else if let path = object.thumbnailPath {
                ProjectImage(project: object, path: path, maxPixelSize: 1200)
            } else {
                ZStack {
                    StageBackground()
                    Image(systemName: words.phase.symbol).font(.system(size: 44)).foregroundStyle(words.phase.color.opacity(0.7))
                        .symbolEffect(.pulse, isActive: words.busy)
                }
            }
        }
        .frame(height: words.phase == .failed ? 300 : 380)
        .clipped()
        .overlay(alignment: .bottom) {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    // The Mac's model, else your own scan (Object Capture writes it at true size).
                    if let arURL = arURL ?? (object.current == nil ? scanURL : nil) {
                        Button { ARModel.show(arURL) } label: { Label("AR", systemImage: "arkit") }.buttonStyle(.glass)
                            .accessibilityHint("Places the model at true size in your room")
                    }
                    Spacer()
                    if let size = words.size ?? (object.current == nil ? scanSize : nil) {
                        Text(size).font(.caption.monospacedDigit().weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                            .accessibilityLabel("Size \(size)")
                    }
                }
                .labelStyle(.titleAndIcon).font(.caption.weight(.semibold))
            }
            .padding(14)
        }
        .task(id: "\(object.id)#\(object.scan ?? "")") {
            scanURL = object.current == nil && object.scan != nil ? store.mac.localScan(object.id) : nil
            // Object Capture writes the scan at true size, so its bounds are the object's size until the Mac measures it.
            scanSize = nil
            if let scanURL, let entity = try? await Entity(contentsOf: scanURL) {
                let e = entity.visualBounds(relativeTo: nil).extents
                scanSize = Format.size([Double(e.x), Double(e.z), Double(e.y)].map { $0 * 1000 })
            }
        }
        .overlay(alignment: .topTrailing) {
            if object.current != nil || scanURL != nil {
                Image(systemName: "rotate.3d").font(.caption).padding(8).glassEffect(.regular, in: .circle).padding(.top, 104).padding(.trailing, 14)
                    .accessibilityHidden(true)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: State cards

    @ViewBuilder private func stateCard(_ object: Project, _ words: ProjectWords) -> some View {
        switch words.phase {
        case .working, .sending: workingCard(object, words)
        // A printer question needs you too (an older Mac sends no status); it's answered in its sheet, not with photos.
        case .needsYou where object.printConfirmation != nil:
            PrintStatusCard(store: store, project: object, working: $working, openPrinting: { openPrinting(object.id) },
                            openConfirmation: { confirming = object.printConfirmation.map { IdentifiedProject(id: $0.id) } })
        case .needsYou: askCard(object)
        case .failed: failedCard(object, words)
        case .draft: draftCard(object, words)
        case .sent: sentCard(words)
        case .preparing, .printing: PrintStatusCard(store: store, project: object, working: $working, openPrinting: { openPrinting(object.id) },
                                                    openConfirmation: { confirming = object.printConfirmation.map { IdentifiedProject(id: $0.id) } })
        default: EmptyView()
        }
    }

    /// The printer has it but Counterpart can't follow it; with Bambu Connect, you still press Print on the Mac.
    private func sentCard(_ words: ProjectWords) -> some View {
        Label { Text(words.status).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: words.phase.symbol) }
            .font(.subheadline.weight(.medium))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    private func workingCard(_ object: Project, _ words: ProjectWords) -> some View {
        TimelineView(.periodic(from: .now, by: 10)) { context in
            let work = WorkProgress(object, now: context.date)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: words.phase.symbol).foregroundStyle(.blue).symbolEffect(.pulse)
                    Text(words.phase == .sending ? "Sending to your Mac" : "Your Mac is working on it").font(.headline)
                    Spacer()
                    if let left = work.remainingSec, let about = Format.about(max(60, left)) {
                        Text(about).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                if let fraction = work.fraction { ProgressView(value: fraction).tint(.blue) }
                else { ProgressView().progressViewStyle(.linear).tint(.blue) }
                Text(words.phase == .sending ? "Keep the app open until your files are sent." : ProjectWords.putDown)
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
            .glassEffect(.regular.tint(.blue.opacity(0.15)), in: .rect(cornerRadius: 24))
        }
    }

    private func askCard(_ object: Project) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Your Mac has a question", systemImage: "questionmark.bubble.fill").font(.headline).foregroundStyle(.orange)
            Text(ProjectWords.question(object))
            HStack(spacing: 10) {
                ProjectImage(project: object, path: object.openAsk.flatMap { $0.photo != nil ? "asks/\($0.id).jpg" : nil } ?? object.thumbnailPath, maxPixelSize: 300)
                    .frame(width: 64, height: 64).clipShape(.rect(cornerRadius: 12))
                    .overlay { RegionOverlay(region: object.openAsk?.region) }
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.orange, lineWidth: 2) }
                Text(object.openAsk?.photo != nil ? "Here's where. The highlighted part is what I can't see." : "This is the closest view I have.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            AskButtons(store: store, project: object, working: $askWorking, problem: $askProblem)
            if let askProblem { Text(askProblem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(16)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 24))
    }

    /// What happened and what to do, in plain words; the raw record stays under Details (PRD §2.6).
    private func failedCard(_ object: Project, _ words: ProjectWords) -> some View {
        let (happened, todo) = Self.split(object.failure)
        return VStack(alignment: .leading, spacing: 12) {
            Label(object.state == .failed && object.print != nil && object.current != nil ? "The print didn't finish" : "Your Mac couldn't finish",
                  systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.red)
            Text(happened)
            if let todo {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "lightbulb.fill").foregroundStyle(.yellow).frame(width: 20)
                    Text(todo).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if words.actions.contains(.retry) {
                        Button { act { try await store.mac.start(object.id) } } label: {
                            Label("Try Again", systemImage: "arrow.clockwise").fontWeight(.semibold).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glassProminent)
                    }
                    if words.actions.contains(.print) || words.actions.contains(.printChecked) {
                        Button { openPrint(object.id) } label: {
                            Label("Print Again", systemImage: "printer").lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glass)
                    }
                }
                .controlSize(.large).font(.subheadline)
                .disabled(working)
            }
            if let pass = object.passes.last {
                DisclosureGroup("Details") {
                    Text([pass.status, pass.summary, Format.clock(Date(timeIntervalSince1970: (pass.endedAtMs ?? pass.startedAtMs) / 1000))]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2.monospaced()).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                        .textSelection(.enabled)
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .glassEffect(.regular.tint(.red.opacity(0.14)), in: .rect(cornerRadius: 24))
    }

    /// The Mac's failure sentence and, after it, what to do.
    static func split(_ failure: String?) -> (String, String?) {
        let text = (failure ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return ("Something went wrong on your Mac.", "Try again. Your scan and photos are kept.") }
        if let end = text.range(of: #"[.!?]\s+"#, options: .regularExpression) {
            let first = String(text[..<end.lowerBound]) + String(text[end.lowerBound])
            let rest = text[end.upperBound...].trimmingCharacters(in: .whitespaces)
            return (first, rest.isEmpty ? nil : rest)
        }
        return (text, nil)
    }

    /// A project that hasn't been sent: finish sending it, or add what it needs.
    private func draftCard(_ object: Project, _ words: ProjectWords) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(words.status, systemImage: "square.and.pencil").font(.headline)
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if words.actions.contains(.finishSending) || words.actions.contains(.makeIt) {
                        Button { act { try await finishSending(object) } } label: {
                            Label(words.actions.contains(.makeIt) ? "Send" : "Finish Sending", systemImage: "arrow.up.circle").frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glassProminent)
                    }
                    if words.actions.contains(.scan) && store.canScan {
                        Button { act { try await scan(object, handheld: false) } } label: { Label("Scan", systemImage: "cube.transparent").frame(maxWidth: .infinity).frame(height: 30) }
                            .buttonStyle(.glass)
                    }
                    if words.actions.contains(.attachPhotos) {
                        Button { act { _ = try await store.mac.addCloseups(object.id, camera: false); return nil } } label: {
                            Label("Photos", systemImage: "photo").frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glass)
                    }
                }
                .controlSize(.large).font(.subheadline)
                .disabled(working)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    // MARK: Bottom bar

    @ViewBuilder private func bottomBar(_ object: Project, _ words: ProjectWords) -> some View {
        // While the Mac works, a change waits and goes in when this pass finishes.
        let canCorrect = words.actions.contains(.correct) || words.phase == .working
        let canPrint = words.actions.contains(.print) || words.actions.contains(.printChecked)
        if canCorrect || canPrint {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if canCorrect {
                        HStack {
                            TextField(store.queuedNotes[object.id] != nil ? "Your change goes in when this pass finishes" : "Ask for changes…", text: $note, axis: .vertical)
                                .lineLimit(1...4)
                                .focused($writing)
                                .submitLabel(.send)
                                .onSubmit { sendNote(object) }
                                .accessibilityIdentifier("ask-for-changes")
                            if note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Image(systemName: "mic.fill").foregroundStyle(.secondary).accessibilityHidden(true)
                            } else {
                                Button { sendNote(object) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                                    .disabled(working)
                                    .accessibilityLabel("Send changes")
                            }
                        }
                        .padding(.horizontal, 16).frame(minHeight: 50)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    if canPrint && !writing {
                        Button { openPrint(object.id) } label: {
                            Label("Print", systemImage: "printer.fill").fontWeight(.semibold).padding(.horizontal, 8).frame(height: 36)
                        }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                        .keyboardShortcut("p", modifiers: .command)
                        .accessibilityIdentifier("print")
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
    }

    private func sendNote(_ object: Project) {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        writing = false
        if store.words(object).phase == .working {
            // The Mac takes changes between passes; this one is sent the moment the pass ends.
            store.queue(note: text, for: object.id)
            note = ""
            return
        }
        act {
            let next = try await store.mac.correct(object.id, text)
            note = ""; section = .activity
            return next
        }
    }
}

/// The highlighted region on an Ask's picture.
struct RegionOverlay: View {
    let region: Project.Region?
    var body: some View {
        GeometryReader { g in
            if let r = region {
                RoundedRectangle(cornerRadius: 6).strokeBorder(.orange, lineWidth: 2)
                    .background(RoundedRectangle(cornerRadius: 6).fill(.orange.opacity(0.18)))
                    .frame(width: g.size.width * r.width, height: g.size.height * r.height)
                    .offset(x: g.size.width * r.x, y: g.size.height * r.y)
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: Sections

/// What changed, and the print's time, filament and printer.
struct ResultSection: View {
    let store: ProjectsStore
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let changes = project.current?.changes, !changes.isEmpty {
                Text("What changed").font(.headline)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(changes.enumerated()), id: \.offset) { _, change in ChangeRow(change: change) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color.card, in: .rect(cornerRadius: 22))
            } else if let summary = project.current?.summary, !summary.isEmpty {
                Text("From your Mac").font(.headline)
                Text((try? AttributedString(markdown: summary, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(summary))
                    .font(.subheadline).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Color.card, in: .rect(cornerRadius: 22))
            } else if project.current == nil {
                Text(store.words(project).busy ? "The model shows here when your Mac has made it." : "No model yet.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if project.current != nil {
                HStack(spacing: 12) {
                    InfoTile(title: "Print time", value: Format.duration(project.print?.estimate?.seconds) ?? "—", symbol: "clock")
                    InfoTile(title: "Filament", value: Format.grams(project.print?.estimate?.grams) ?? "—", symbol: "scalemass")
                    InfoTile(title: "Printer", value: store.printerName(project) ?? "—", symbol: "printer")
                }
                if project.print?.estimate == nil {
                    Text("Time and filament come from slicing on your Mac when you print.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct ChangeRow: View {
    let change: Project.Change
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 20)
            Text(text).font(.subheadline)
        }
        .accessibilityElement(children: .combine)
    }
    private var symbol: String {
        switch change.tag {
        case "added": "plus.circle.fill"
        case "changed": "pencil.circle.fill"
        case "assumed": "ruler"
        default: "exclamationmark.triangle.fill"
        }
    }
    private var tint: Color {
        switch change.tag {
        case "added": .green
        case "changed", "assumed": .blue
        default: .yellow
        }
    }
    private var text: String {
        guard let tolerance = change.toleranceMm else { return change.text }
        return change.text + String(format: " (±%.1f mm)", tolerance)
    }
}

/// Your request, every photo and scan full size, and your follow-ups.
struct InputsSection: View {
    let project: Project
    @State private var viewing: String?

    private var images: [String] { project.photos.map { "photos/\($0)" } + (project.capture ?? []).map { "capture/\($0)" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your request").font(.headline)
            Text(project.instructions?.isEmpty == false ? project.instructions! : project.hasScan ? "A copy of the scanned object." : "No description was sent.")
                .textSelection(.enabled)
                .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color.card, in: .rect(cornerRadius: 22))
            Text("Photos and scans").font(.headline)
            if project.scan != nil {
                Label("Walk-around scan, saved on your Mac", systemImage: "cube.transparent").font(.subheadline).foregroundStyle(.secondary)
            }
            if images.isEmpty {
                Text(project.scan != nil ? "No photos besides the scan." : "No photos were sent.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                    ForEach(images, id: \.self) { path in
                        Button { viewing = path } label: {
                            ProjectImage(project: project, path: path, maxPixelSize: 400).frame(height: 110).clipShape(.rect(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(path.hasPrefix("photos/") ? "Photo" : "Scan image")
                    }
                }
            }
            let followUps = project.passes.compactMap { pass in pass.note.map { ($0, pass.startedAtMs) } }
            if !followUps.isEmpty {
                Text("Your follow-ups").font(.headline)
                ForEach(Array(followUps.enumerated()), id: \.offset) { _, item in
                    Text("“\(item.0)”  · \(Format.clock(Date(timeIntervalSince1970: item.1 / 1000)))").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .sheet(item: Binding(get: { viewing.map(IdentifiedPath.init) }, set: { viewing = $0?.id })) { item in
            NavigationStack {
                ProjectImage(project: project, path: item.id, maxPixelSize: 2400)
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { viewing = nil } } }
            }
        }
    }
}

private struct IdentifiedPath: Identifiable { let id: String }

/// The passes as a stage timeline: the current stage pulses, and each step shows the worker's own words.
struct ActivitySection: View {
    let store: ProjectsStore
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if project.passes.isEmpty {
                Text("Work shows here once your Mac starts.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(project.passes.enumerated().reversed()), id: \.offset) { index, pass in
                PassTimeline(store: store, project: project, index: index, pass: pass, latest: index == project.passes.count - 1)
            }
        }
    }
}

struct PassTimeline: View {
    let store: ProjectsStore
    let project: Project
    let index: Int
    let pass: Project.Pass
    let latest: Bool
    @State private var lines: [Project.Activity] = []
    @State private var expanded = false

    private var running: Bool { pass.endedAtMs == nil && project.state == .touchingUp }

    private var steps: [(title: String, detail: String?, state: StepState)] {
        if let stages = pass.stages, !stages.isEmpty {
            return stages.map { stage in
                let state: StepState = stage.endedAtMs != nil ? .done : (pass.failed ? .failed : running ? .current : .done)
                return (stage.words, nil, state)
            }
        }
        let title = pass.note.map { "Your change: “\($0)”" } ?? (index == 0 ? "Your Mac made it" : "Another pass")
        return [(title, pass.summary, running ? .current : pass.failed ? .failed : .done)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(index == 0 ? "First pass · \(Format.clock(Date(timeIntervalSince1970: pass.startedAtMs / 1000)))"
                 : "Pass \(index + 1) · \(Format.clock(Date(timeIntervalSince1970: pass.startedAtMs / 1000)))")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.bottom, 8)
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 0) {
                        Image(systemName: step.state.symbol).foregroundStyle(step.state.color)
                            .symbolEffect(.pulse, isActive: step.state == .current)
                        if i < steps.count - 1 { Rectangle().fill(.quaternary).frame(width: 2).frame(minHeight: 22) }
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.title).font(.body.weight(.semibold)).foregroundStyle(step.state == .pending ? .secondary : .primary)
                        if let detail = step.detail, !detail.isEmpty { Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(expanded ? nil : 4) }
                        if (step.state == .current || step.state == .failed || i == steps.count - 1) && pass.count > 0 {
                            DisclosureGroup(isExpanded: $expanded) {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                        Text("\(Format.clock(Date(timeIntervalSince1970: line.atMs / 1000)))  \(line.text)")
                                            .font(line.kind == "tool" ? .caption2.monospaced() : .caption)
                                            .foregroundStyle(.secondary).textSelection(.enabled)
                                    }
                                    if lines.isEmpty { ProgressView() }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10).background(Color.well, in: .rect(cornerRadius: 12)).padding(.top, 6)
                            } label: {
                                Text("What your Mac did (\(pass.count))").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.bottom, 14)
                }
            }
        }
        .task(id: expanded ? "\(project.updatedAtMs)" : "closed") {
            guard expanded else { return }
            if let activity = try? await store.mac.passActivity(project.id, index: index) { lines = activity }
        }
        .onAppear { if latest && running { expanded = true } }
    }
}

enum StepState: Equatable {
    case done, current, failed, pending
    var symbol: String {
        switch self { case .done: "checkmark.circle.fill"; case .current: "circle.dotted.circle"; case .failed: "xmark.circle.fill"; case .pending: "circle" }
    }
    var color: Color {
        switch self { case .done: .green; case .current: .blue; case .failed: .red; case .pending: .secondary }
    }
}

// MARK: AR

/// Quick Look AR for the model at true size: the STL (millimetres, Z up) converted to USDZ (metres, Y up).
enum ARModel {
    /// The STL as USDZ for AR Quick Look, written once beside it. RealityKit writes the same mesh the stage shows.
    @MainActor static func usdz(fromSTL url: URL) async -> URL? {
        let target = url.deletingPathExtension().appendingPathExtension("usdz")
        if FileManager.default.fileExists(atPath: target.path) { return target }
        guard let entity = ModelStage.stl(url, tint: UIColor(Color.filament), twoTone: false) else { return nil }
        do { try await entity.write(to: target); return target } catch { return nil }
    }

    @MainActor static func show(_ url: URL) {
        guard let presenter = PhotoSources.topViewController() else { return }
        let controller = QLPreviewController()
        let source = ARSource(url: url)
        controller.dataSource = source
        objc_setAssociatedObject(controller, &ARSource.key, source, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        presenter.present(controller, animated: true)
    }

    private final class ARSource: NSObject, QLPreviewControllerDataSource {
        nonisolated(unsafe) static var key = 0
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            let item = ARQuickLookPreviewItem(fileAt: url)
            item.allowsContentScaling = false
            return item
        }
    }
}
