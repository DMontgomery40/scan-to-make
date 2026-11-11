import SwiftUI
import QuickLook
import UniformTypeIdentifiers
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
    @State private var attempts = NoteAttempts()
    @State private var showingSettings = false
    @State private var choosingModelFiles = false
    @State private var renaming = false
    @State private var projectName = ""
    @State private var working = false
    @State private var problem: String?
    @State private var fetchFailure: CompanionError?
    @State private var loading = true
    @State private var resumed = false
    @State private var confirmDelete = false
    @State private var modelURL: URL?
    @Environment(\.scenePhase) private var scenePhase
    @State private var arURL: URL?
    @State private var arRequested = false
    @State private var arPreparing = false
    @State private var arProblem: String?
    @State private var arGeneration = UUID()
    @State private var scanURL: URL?
    @State private var captureWarning: String?
    @State private var askWorking = false
    @State private var askProblem: String?
    @State private var askText = ""
    @Environment(\.horizontalSizeClass) private var widthClass
    /// The size card's fields as they stand (`AskSizesFields` reports them), for the card's other answers.
    @State private var askSizes: AskSizesForm?
    @State private var notice: String?
    /// The ask field's width, so its placeholder fits whole.
    @State private var fieldWidth: CGFloat = 0
    /// The printer's own question, shown as a sheet once when it arrives and again from Review.
    @State private var confirming: IdentifiedProject?
    /// What the page measured, for sizing the stage when a card has to be answered (board X80).
    @State private var answerRoom = AnswerRoom()
    @FocusState private var writing: Bool
    private var object: Project? { store.project(id) }
    /// The Mac isn't answering: the page shows what this phone already had and says so, and Print and Send wait (X100).
    private var away: Bool { store.reachable == false }

    var body: some View {
        Group {
            if let object { page(object) }
            else if loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.black) }
            else {
                ContentUnavailableView {
                    Label(fetchFailure == nil || fetchFailure?.code == "not-found" ? "Project unavailable" : "Couldn't load project", systemImage: "cube")
                } description: {
                    Text(fetchFailure?.code == "not-found" ? "This project is no longer available on your Mac."
                         : fetchFailure?.message ?? "This project is no longer available on your Mac.")
                } actions: {
                    Button("Back to Projects", action: close)
                    if let fetchFailure, fetchFailure.code != "not-found" {
                        Button("Try Again") { Task { await reload() } }
                    }
                }
                .background(Color.black)
            }
        }
        .task(id: id) {
            await reload()
            store.refreshStoppedScans()
            captureWarning = store.mac.localScanWarning(id)
            if let object { section = defaultSection(object) }
            #if DEBUG
            if let debug = app.debugSection, let chosen = ProjectSection.allCases.first(where: { "\($0)" == debug }) { section = chosen; app.debugSection = nil }
            #endif
            await resumeSavedCapture()
        }
        .modifier(PrinterQuestion(store: store, project: object, confirming: $confirming))
        // Needs Changes pressed on the finished Printing screen: the change starts here, as it does from this page's card.
        .onChange(of: store.askAfterPrinting, initial: true) { _, asked in
            guard asked == id else { return }
            store.askAfterPrinting = nil
            if !note.hasPrefix(Self.afterPrinting) { note = Self.afterPrinting + note }
            writing = true
        }
        // The link came back (the store's own recovery, #539): the page reads the project again by itself.
        .onChange(of: store.reachable) { _, now in
            if now == true, fetchFailure != nil { Task { await reload() } }
        }
        .onAppear { app.showing(id, true) }
        .onDisappear { app.showing(id, false) }
        // Photos dropped from Files or Safari join the project; the Mac uses them in its next pass (PRD §6).
        .dropDestination(for: Data.self) { items, _ in
            // One action at a time: a drop while something runs is refused, not quietly lost.
            guard let object, !working else { return false }
            let forMessage = object.current != nil || object.changesWait || object.openAsk != nil
            Task { await addDropped(items, to: object.id, forMessage: forMessage) }
            return !items.isEmpty
        }
    }

    private func defaultSection(_ object: Project) -> ProjectSection {
        object.current != nil ? .result : store.words(object).phase == .working || store.words(object).phase == .failed ? .activity : .inputs
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        let failure = await store.reload(id)
        if failure?.code != "cancelled" { fetchFailure = failure }
    }

    private func addDropped(_ items: [Data], to id: String, forMessage: Bool) async {
        let photos = items.prefix(NewObjectView.photoLimit).compactMap { data -> ChosenPhoto? in
            let png = data.starts(with: [0x89, 0x50, 0x4E, 0x47])
            guard let image = UIImage(data: data) else { return nil }
            return MacConnection.keep(PickedPhoto(data: png ? data : (image.jpegData(compressionQuality: 0.9) ?? data), ext: png ? "png" : "jpg"))
        }
        guard !photos.isEmpty else { return }
        act {
            try await store.mac.sendChosen(id, photos, forMessage: forMessage)
            notice = photos.count == 1 ? "Added a photo. Your Mac uses it in the next change." : "Added \(photos.count) photos. Your Mac uses them in the next change."
            return try await store.mac.get(id)
        }
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
        captureWarning = store.mac.localScanWarning(object.id)
        return try await finishSending(object)
    }

    private func act(_ body: @escaping () async throws -> Project?) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            // A scan started, stopped or sent here changes what this phone still holds for the project.
            defer { working = false; store.refreshStoppedScans() }
            do { let ticket = store.startRequest(); if let next = try await body() { store.replace(next, ticket: ticket) } else { await reload() } }
            catch let failure as CompanionError {
                if failure.code == "cancelled" { return }
                if failure.needsPairing { store.onPair(); return }
                problem = failure.message
            } catch { problem = CompanionError.unreachable.message }
        }
    }

    private func selectAndPrint(_ plate: ProjectPlate, object: Project) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do {
                let ticket = store.startRequest()
                let next = try await store.mac.client.selectPlate(object.id, fileIndex: plate.fileIndex, plateIndex: plate.plateIndex)
                store.replace(next, ticket: ticket)
                openPrint(next.id)
            } catch let failure as CompanionError { problem = failure.message }
            catch { problem = CompanionError.unreachable.message }
        }
    }

    // MARK: Page

    @ViewBuilder private func page(_ object: Project) -> some View {
        let words = store.words(object)
        let fit = answerFit(words)
        // The page's content ends where the bottom bar begins (lead, Nov 10, as New and first run): Activity's lines never
        // read through or around "Ask for changes…" and Print, on any tab, with the keyboard up too.
        VStack(spacing: 0) {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                hero(object, words, stage: fit.stage)
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        // The status is one tap away: the capsule opens the same choices as ••• → Status.
                        if store.projectSettings {
                            Menu { statusChoices(object, words, inline: true) } label: {
                                HStack(spacing: 4) { StatusCapsule(phase: words.phase); Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary) }
                            }
                            .accessibilityIdentifier("status-menu")
                            .accessibilityLabel("Status, \(words.phase.label)")
                            .accessibilityHint("Changes the project's status")
                        } else {
                            StatusCapsule(phase: words.phase)
                        }
                        Spacer()
                        Text(Format.when(object.updatedAt)).font(.caption).foregroundStyle(.secondary)
                    }
                    Button { projectName = words.title; renaming = true } label: {
                        Text(words.title).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                    }
                    .buttonStyle(.plain).disabled(working || !store.projectRename)
                    .accessibilityIdentifier("project-title")
                    .accessibilityLabel(words.title).accessibilityHint("Rename project")
                    if let credit = object.credit?.object, let raw = credit["url"]?.string, let url = URL(string: raw), ["http", "https"].contains(url.scheme ?? "") {
                        Link("by \(credit["designer"]?.string ?? "the designer") on \(credit["site"]?.string ?? url.host ?? "the model page")", destination: url)
                            .font(.subheadline)
                        if let licence = credit["licence"]?.string { Text(licence).font(.caption).foregroundStyle(.secondary) }
                    }
                    if !fit.cardFirst { requestText(object, words) }
                }
                .padding(.horizontal, 20)

                if (object.plates?.count ?? 0) > 1 {
                    ProjectPlatesView(project: object, busy: working || away, thumbnail: { plate in
                        ProjectImage(project: object, path: plate.thumbnail, maxPixelSize: 400, contentMode: .fit)
                    }, select: { plate in
                        act { try await store.mac.client.selectPlate(object.id, fileIndex: plate.fileIndex, plateIndex: plate.plateIndex) }
                    }, printPlate: { plate in
                        selectAndPrint(plate, object: object)
                    }).padding(.horizontal, 20)
                }
                if object.kind == "published" {
                    Button("Add Model Files", systemImage: "doc.badge.plus") { choosingModelFiles = true }
                        .buttonStyle(.glass).padding(.horizontal, 20)
                        .disabled(working || object.state == .printing || object.state == .touchingUp || object.print?.uncertain == true)
                }
                if object.current == nil, let captureWarning {
                    Label(captureWarning, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange).padding(.horizontal, 20)
                }
                if away {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Label(KnownProjects.awayLine(heard: store.heard[object.id]), systemImage: "wifi.exclamationmark")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button("Try Again") { Task { await reload() } }.font(.subheadline.weight(.semibold)).disabled(loading)
                            .accessibilityIdentifier("project-away-retry")
                    }
                    .padding(.horizontal, 20)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("project-away")
                }
                if let message = problem ?? (away ? nil : fetchFailure?.message) ?? store.sendFailures[object.id] {
                    Label(message, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange).padding(.horizontal, 20)
                }
                if let notice, problem == nil {
                    Label(notice, systemImage: "photo.badge.checkmark").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
                }
                if store.corrections.failures[object.id] != nil, object.pendingFollowup == nil {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your change is saved. Check the result before trying again.").font(.subheadline)
                        HStack {
                            Button("Try Again") { store.retryQueuedChange(object) }.disabled(object.changesWait)
                            Button("Discard Saved Change") { store.discardQueuedChange(object) }
                        }.disabled(working)
                    }.padding(.horizontal, 20)
                }
                if let pending = object.pendingFollowup {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Message saved").font(.headline)
                        Text(pending).font(.subheadline).textSelection(.enabled)
                        HStack {
                            Button("Try Again") { act {
                                let next = try await store.mac.correct(object.id, pending)
                                store.corrections.sent(pending, for: object.id)
                                return next
                            } }
                            Button("Mark Done") { act {
                                let next = try await store.mac.client.setStatus(object.id, .works)
                                store.corrections.sent(pending, for: object.id)
                                return next
                            } }
                        }.disabled(working)
                    }.padding(.horizontal, 20)
                }
                if let previous = object.completionUndoStatus {
                    HStack {
                        Label("Marked Done", systemImage: "checkmark.circle.fill")
                        Spacer()
                        Button("Undo") { act { try await store.mac.client.setStatus(object.id, previous) } }
                            .disabled(working)
                    }.font(.subheadline).padding(.horizontal, 20)
                }
                stateCard(object, words).padding(.horizontal, 16)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.pageSpace)).maxY.rounded() } action: { bottom in
                        // Where the card ends below the stage, in the order the card sits now under the title.
                        let now = answerFit(store.words(object))
                        answerRoom.belowStage = bottom - now.stage + (now.cardFirst ? answerRoom.request : 0)
                    }
                if fit.cardFirst { requestText(object, words).padding(.horizontal, 20) }

                Picker("Section", selection: $section) {
                    ForEach(ProjectSection.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)

                Group {
                    switch section {
                    case .result: ResultSection(store: store, project: object)
                    case .inputs: InputsSection(project: object, queued: store.corrections.messages[object.id] ?? [], queueFailed: store.corrections.failures[object.id] != nil)
                    case .activity: ActivitySection(store: store, project: object)
                    }
                }
                .padding(.horizontal, 16)
            }
            .coordinateSpace(.named(Self.pageSpace))
            // The bar is below the scroll now, not over it: only a little room after the last line.
            .padding(.bottom, 24)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
        .background(Color.black)
        // The page's height between the bars, where the content's top sits at rest.
        .onScrollGeometryChange(for: CGFloat.self) { ($0.containerSize.height - $0.contentInsets.top - $0.contentInsets.bottom).rounded() } action: { _, height in
            answerRoom.viewport = height
        }
        .scrollEdgeEffectStyle(.soft, for: .all)
        .scrollDismissesKeyboard(.interactively)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if writing { ToolbarItem(placement: .confirmationAction) { Button("Done") { writing = false } } }
            if let modelURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: modelURL, preview: SharePreview("\(words.title).\(object.preservesPublishedFilaments ? "3mf" : "stl")")) { Image(systemName: "square.and.arrow.up") }
                }
            } else if let scanURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: scanURL, preview: SharePreview("\(words.title).usdz")) { Image(systemName: "square.and.arrow.up") }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if store.macCapabilities.contains("projectPreferences") {
                        Button("Project Settings", systemImage: "slider.horizontal.3") { showingSettings = true }
                    }
                    if store.projectRename {
                        Button("Rename Project", systemImage: "pencil") { projectName = words.title; renaming = true }
                    }
                    if store.projectSettings {
                        statusChoices(object, words)
                        Divider()
                    }
                    if let modelURL { ShareLink(object.preservesPublishedFilaments ? "Share 3MF" : "Share STL", item: modelURL) }
                    if let arURL { ShareLink("Share USDZ", item: arURL) } else if let scanURL { ShareLink("Share Your Scan (USDZ)", item: scanURL) }
                    Divider()
                    Button("Delete Project", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("More")
            }
        }
            // A failed pass that left an earlier model still offers changes and Print; with no model, the failed card's Try Again is the way on.
            if object.canAskForChanges || (words.phase != .needsYou && !(words.phase == .failed && object.current == nil)) {
                bottomBar(object, words).padding(.top, 8)
            }
        }
        .background(Color.black)
        .fileImporter(isPresented: $choosingModelFiles, allowedContentTypes: [UTType(filenameExtension: "3mf") ?? .data, UTType(filenameExtension: "stl") ?? .data], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let files): act {
                var updated: Project?
                for file in files { updated = try await store.mac.client.addModelFile(object.id, file: file) }
                return updated
            }
            case .failure(let error): problem = error.localizedDescription
            }
        }
        .sheet(isPresented: $showingSettings) {
            PhoneProjectSettings(store: store, id: id, close: close)
        }
        .alert("Rename Project", isPresented: $renaming) {
            TextField("Project name", text: $projectName)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let title = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
                act { try await store.mac.client.rename(object.id, title: title) }
            }.disabled(!Project.validName(projectName))
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
        .onDisappear { store.models.releaseDemand(object.id) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
            if scenePhase == .active { store.models.recover() }
        }
        .task(id: "\(object.id)#\(object.mediaVersion)#\(object.current?.model ?? "")#\(scenePhase)") {
            // The store fetches it, so leaving the page never stops the download (Nov 10); back in the app, one that
            // failed meanwhile starts again.
            store.models.setActive(scenePhase == .active)
            if object.current != nil, scenePhase == .active { store.models.want(object, "model.stl") }
            let context = store.models.traceContext(object, "model.stl") ?? MediaTrace.Context(project: object.id, version: String(Int64(object.mediaVersion)))
            MediaTrace.record("page.model-begin", ["key": object.current?.model ?? "none", "scene": String(describing: scenePhase)], context: context)
            MediaTrace.record(Task.isCancelled ? "page.model-cancelled" : "page.model-demanded", ["scene": String(describing: scenePhase)], context: context)
        }
        .task(id: "\(store.models.file(object, "model.stl")?.path ?? "")#\(object.spoolColour ?? "")") {
            modelURL = store.models.file(object, "model.stl"); arURL = nil
            MediaTrace.record("page.model-published", ["file": String(modelURL != nil), "scene": String(describing: scenePhase)],
                              context: store.models.traceContext(object, "model.stl") ?? MediaTrace.Context(project: object.id, version: String(Int64(object.mediaVersion))))
        }
    }

    // MARK: Answering a card

    /// The request under the title: what the person asked for, in their own words.
    @ViewBuilder private func requestText(_ object: Project, _ words: ProjectWords) -> some View {
        if let request = object.instructions, !request.isEmpty, request != words.title {
            Text(request).font(.body).foregroundStyle(.secondary).textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self) { $0.size.height.rounded() } action: { answerRoom.request = $0 + 6 }
        }
    }

    static let pageSpace = "project-page"
    static let fullStage: CGFloat = 380
    /// The stage never gets shorter than this, so the model stays a picture of the part.
    static let stageFloor: CGFloat = 160
    /// Air between the card's last line and the bottom bar.
    static let answerMargin: CGFloat = 12

    /// Board X80: when a card has to be answered (a failed pass, Did it fit?), the page opens with the whole card,
    /// buttons included, above the bottom bar. The stage takes what the page has left: the page's height between the
    /// bars, less everything from the stage's bottom to the card's bottom, never less than `stageFloor`. If even that
    /// can't fit the card, the card goes above the request text (the question comes before a repeat of the person's own
    /// words). At large text sizes the card may still be lower than the bar: the page scrolls to it.
    struct AnswerRoom: Equatable {
        /// The scroll view's height inside its insets.
        var viewport: CGFloat = 0
        /// From the stage's bottom to the card's bottom, with the request text above the card.
        var belowStage: CGFloat?
        /// The request text's height with its spacing; 0 without one.
        var request: CGFloat = 0
    }

    private func answerFit(_ words: ProjectWords) -> (stage: CGFloat, cardFirst: Bool) {
        guard words.phase == .failed || words.actions.contains(.itWorks) else { return (Self.fullStage, false) }
        guard let below = answerRoom.belowStage, answerRoom.viewport > 0 else { return (300, false) }
        let room = answerRoom.viewport - Self.answerMargin - below
        if room >= Self.stageFloor || answerRoom.request == 0 { return (min(Self.fullStage, max(Self.stageFloor, room)), false) }
        return (min(Self.fullStage, max(Self.stageFloor, room + answerRoom.request)), true)
    }

    // MARK: Hero

    /// The project's pictures (PRD §5.4): what will print, the two together, what was scanned (`ProjectGalleryView`).
    @ViewBuilder private func hero(_ object: Project, _ words: ProjectWords, stage: CGFloat) -> some View {
        VStack(spacing: 8) {
            ProjectGalleryView(store: store, project: object, words: words,
                               height: stage,
                               modelURL: modelURL, arURL: nil, localScan: scanURL, working: working,
                               locate: { act { try await store.mac.client.locate(object.id) } })
            .task(id: "\(object.id)#\(object.scan ?? "")") {
                // The scan while it's only on this phone, for Share until the Mac has it.
                scanURL = object.current == nil ? store.mac.localScan(object.id) : nil
            }
            .ignoresSafeArea(edges: .top)
            if modelURL != nil, !object.preservesPublishedFilaments {
                Button {
                    if let arURL { ARModel.show(arURL) } else { arRequested = true }
                } label: {
                    HStack {
                        if arPreparing { ProgressView() }
                        Label(arPreparing ? "Preparing AR…" : "View part in your space", systemImage: "arkit")
                    }
                }
                .disabled(arPreparing || scenePhase != .active)
                .accessibilityIdentifier("project-prepare-ar")
                if let arProblem { Text(arProblem).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .task(id: "\(arRequested)#\(scenePhase)#\(modelURL?.path ?? "")#\(object.spoolColour ?? "")") {
            guard arRequested, scenePhase == .active, let url = modelURL else { return }
            let generation = UUID()
            arGeneration = generation; arPreparing = true; arProblem = nil
            defer { if arGeneration == generation { arPreparing = false } }
            let prepared = await MediaTrace.$context.withValue(MediaTrace.Context(file: url, scene: String(describing: scenePhase))) {
                await ARModel.usdz(fromSTL: url, tint: object.spoolColour)
            }
            guard !Task.isCancelled, scenePhase == .active, arGeneration == generation else { return }
            arURL = prepared
            if let prepared { ARModel.show(prepared) }
            else { arProblem = "AR couldn't be prepared. Try again." }
            arRequested = false
        }
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
        case .draft where store.stoppedScanWords(object) != nil: stoppedScanCard(object)
        case .draft: draftCard(object, words)
        case .sent: sentCard(words)
        // After a finished print (PRD §5.4), on a Mac that keeps the answer.
        case .printed where words.actions.contains(.itWorks) && store.projectSettings: didItFitCard(object)
        case .preparing, .printing: PrintStatusCard(store: store, project: object, working: $working, openPrinting: { openPrinting(object.id) },
                                                    openConfirmation: { confirming = object.printConfirmation.map { IdentifiedProject(id: $0.id) } })
        default: EmptyView()
        }
    }

    /// "Did it fit?" (PRD §5.4): It works moves it to Done; Needs changes opens Ask for changes, started for you.
    private func didItFitCard(_ object: Project) -> some View {
        DidItFitCard(project: object, macName: store.macName, working: working,
                     itWorks: { act { try await store.mac.client.setStatus(object.id, .works) } },
                     needsChanges: { needsChanges(object) })
    }

    /// Says so on the Mac, then starts the change in Ask for changes.
    private func needsChanges(_ object: Project) {
        act { try await store.mac.client.setStatus(object.id, .needsChanges) }
        if !note.hasPrefix(Self.afterPrinting) { note = Self.afterPrinting + note }
        writing = true
    }
    static let afterPrinting = NotificationActions.afterPrinting

    /// Status (Not printed, Printed, Done, Needs changes), then Hide from Home apart from it: in ••• and on the capsule.
    @ViewBuilder private func statusChoices(_ object: Project, _ words: ProjectWords, inline: Bool = false) -> some View {
        let picker = Picker(selection: Binding(get: { shownStatus(object, words) }, set: { status in
            act { try await store.mac.client.setStatus(object.id, status) }
        })) {
            ForEach(ProjectStatus.choices, id: \.self) { Label($0.label, systemImage: $0.symbol).tag($0) }
        } label: { Label("Status", systemImage: "flag") }
        // On the capsule the choices are right there, one tap; in ••• they're a Status submenu.
        if inline { picker.pickerStyle(.inline) } else { picker.pickerStyle(.menu) }
        // Apart from the status: a Done project hidden from Home is still Done.
        Section {
            if object.isArchived {
                Button("Show on Home", systemImage: "tray.and.arrow.up") { act { try await store.archive(object, false) } }
            } else {
                Button("Hide from Home", systemImage: "archivebox") { act { try await store.archive(object, true) } }
            }
        }
    }

    /// The status in Project Settings; archived shows what's under it, and none set shows what the state says.
    private func shownStatus(_ object: Project, _ words: ProjectWords) -> ProjectStatus {
        if object.isArchived { return object.statusUnderneath }
        if let status = object.projectStatus { return status }
        switch words.phase {
        case .confirmed: return .works
        case .printed, .sent: return .printed
        default: return .notPrinted
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
                if let fraction = words.phase == .sending ? store.sendProgress[object.id] : work.fraction { ProgressView(value: fraction).tint(.blue) }
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
            // No picture at all (a described project asked without one): nothing, rather than an empty box whose caption
            // would name a picture that isn't there.
            if !["file", "choice"].contains(object.openAsk?.type ?? ""),
               let path = object.openAsk.flatMap({ $0.photo != nil ? "asks/\($0.id).jpg" : nil }) ?? object.thumbnailPath {
                let ask = object.openAsk
                AskPhoto(project: object, path: path, region: ask?.photo != nil ? ask?.region : nil, caption: AskPicture.caption(ask))
            }
            // A size question: its numbers, prefilled, with Confirm as the one obvious action. Words and a caliper
            // photo stay below for whatever the numbers don't say.
            let answerable = object.openAsk?.answerable ?? true
            if let ask = object.openAsk, let form = AskSizesForm(ask) {
                AskSizesFields(form: form, working: askWorking, changed: { askSizes = $0 }) { sizes in answerWithSizes(object, sizes) }
                    .id(ask.id)
            } else if !answerable {
                // A kind this build doesn't know: the question and this sentence, and no answer control at all.
                Text("Update Counterpart on this \(UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone") to answer this kind of question here.")
                    .font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("ask-update")
            }
            if answerable { AskButtons(store: store, project: object, sizes: sizesForm(object), working: $askWorking, problem: $askProblem) }
            // The Mac takes a typed answer when it says so (KAN-214 #204, `answers` includes "text").
            if answerable, object.openAsk?.answers.contains("text") == true {
                HStack(spacing: 8) {
                    TextField(object.openAsk?.kind == "sizes" ? "Anything the numbers don't say…" : "Or answer in words…", text: $askText, axis: .vertical)
                        .lineLimit(1...4).padding(10).glassEffect(.regular, in: .rect(cornerRadius: 16))
                        .accessibilityIdentifier("ask-text")
                    Button { answerInWords(object) } label: { Image(systemName: "arrow.up").fontWeight(.semibold).frame(width: 36, height: 36) }
                        .buttonStyle(.glassProminent).buttonBorderShape(.circle)
                        .disabled(askWorking || askText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Send answer")
                }
            }
            if let askProblem { Text(askProblem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(16)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 24))
    }

    /// The size card's numbers as they stand now, for whichever button is pressed; nil when the open question isn't
    /// a size question. Before the fields report their first state, the Mac's own numbers.
    private func sizesForm(_ object: Project) -> AskSizesForm? {
        guard let ask = object.openAsk, let asked = AskSizesForm(ask) else { return nil }
        if let askSizes, askSizes.fields.map(\.id) == asked.fields.map(\.id) { return askSizes }
        return asked
    }

    /// A size question's numbers, with whatever is typed in the words box beside them.
    private func answerWithSizes(_ object: Project, _ sizes: [AskSizesForm.Answer]) {
        guard !sizes.isEmpty, !askWorking else { return }
        let text = askText.trimmingCharacters(in: .whitespacesAndNewlines)
        askWorking = true; askProblem = nil
        Task {
            defer { askWorking = false }
            do {
                let ticket = store.startRequest()
                store.replace(try await store.mac.client.answerAsk(object.id, text: text.isEmpty ? nil : String(text.prefix(2000)), sizes: sizes), ticket: ticket)
                askText = ""
            }
            catch let failure as CompanionError { askProblem = failure.message }
            catch { askProblem = CompanionError.unreachable.message }
        }
    }

    private func answerInWords(_ object: Project) {
        let text = askText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !askWorking else { return }
        // One answer carries everything the card holds: the words go with the numbers as they stand.
        var sizes: [AskSizesForm.Answer] = []
        switch sizesForm(object)?.carried {
        case .sizes(let carried): sizes = carried
        case .invalid: askProblem = AskSizesForm.invalidWords; return
        case .some(.none), nil: break
        }
        askWorking = true; askProblem = nil
        Task {
            defer { askWorking = false }
            do { let ticket = store.startRequest(); store.replace(try await store.mac.client.answerAsk(object.id, text: String(text.prefix(2000)), sizes: sizes), ticket: ticket); askText = "" }
            catch let failure as CompanionError { askProblem = failure.message }
            catch { askProblem = CompanionError.unreachable.message }
        }
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
            if let note = words.page.printNote {
                Text(note).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("failed-print-note")
            }
            GlassEffectContainer(spacing: 8) {
                // On a phone's width two buttons side by side cut the second one's name ("Print the last v…", seen
                // with a real project): there they stack, each with the card's whole width.
                let stacked = widthClass == .compact && words.actions.contains(.retry) && words.page.printPlace == .card
                let row = stacked ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                row {
                    // One filled control, the page's main action (`PageActions`): Try Again when a pass stopped, or
                    // printing again when the print failed. Printing is offered here under its true name, and then
                    // not in the bar.
                    if words.actions.contains(.retry) {
                        Button { act { try await store.mac.start(object.id) } } label: {
                            Label("Try Again", systemImage: "arrow.clockwise").fontWeight(.semibold).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .mainAction(words.page.main == .retry)
                        .accessibilityIdentifier("failed-retry")
                    }
                    if words.page.printPlace == .card, let print = words.page.printWords {
                        Button { openPrint(object.id) } label: {
                            Label(print, systemImage: "printer").fontWeight(words.page.printIsMain ? .semibold : .regular).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .mainAction(words.page.printIsMain)
                        .disabled(away)
                        .accessibilityIdentifier("failed-print")
                    }
                }
                .controlSize(.large).font(.subheadline)
                .disabled(working)
            }
            if let pass = object.passes.last {
                DisclosureGroup("Details") {
                    Text([pass.endingWords, pass.summary, Format.clock(Date(timeIntervalSince1970: (pass.endedAtMs ?? pass.startedAtMs) / 1000))]
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
    /// A scan stopped after it kept photos: send what's there (the Mac rebuilds it and says plainly if it's too few), or
    /// scan it again. The same card on iPhone and iPad.
    private func stoppedScanCard(_ object: Project) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(store.stoppedScanWords(object) ?? "", systemImage: "photo.stack").font(.headline)
                .accessibilityIdentifier("stopped-scan")
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button {
                        act {
                            guard let stopped = store.stoppedScans[object.id] else { return nil }
                            return try await store.mac.sendStoppedScan(object.id, run: stopped.run)
                        }
                    } label: {
                        Label("Send to your Mac", systemImage: "arrow.up.circle").frame(maxWidth: .infinity).frame(height: 30)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(away)
                    .accessibilityIdentifier("stopped-scan.send")
                    if store.canScan {
                        Button { act { try await scan(object, handheld: false) } } label: {
                            Label("Scan again", systemImage: "cube.transparent").frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("stopped-scan.again")
                    }
                }
                .controlSize(.large).font(.subheadline)
                .disabled(working)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    private func draftCard(_ object: Project, _ words: ProjectWords) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(words.status, systemImage: "square.and.pencil").font(.headline)
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if words.actions.contains(.finishSending) || words.actions.contains(.makeIt) {
                        Button { act { try await finishSending(object) } } label: {
                            Label("Send to your Mac", systemImage: "arrow.up.circle").frame(maxWidth: .infinity).frame(height: 30)
                        }
                        .buttonStyle(.glassProminent)
                        .disabled(away)
                        .accessibilityIdentifier("draft.send")
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
        let canCorrect = object.canAskForChanges
        // Print is in the bar only where the page's one decision puts it there, and filled only when it leads
        // (`PageActions`): never beside a card that already offers it.
        let canPrint = words.page.printInBar
        if canCorrect || canPrint {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if canCorrect {
                        HStack {
                            // A narrow field (beside Print Another) gets a placeholder that fits whole, never cut words.
                            TextField(fieldPlaceholder(pending: store.corrections.pending(object.id) != nil), text: $note, axis: .vertical)
                                .lineLimit(1...4)
                                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { fieldWidth = $0 }
                                .accessibilityLabel("Ask for changes")
                                .focused($writing)
                                .submitLabel(.send)
                                .onSubmit { sendNote(object) }
                                .accessibilityIdentifier("ask-for-changes")
                            // A photo of the part where it goes (PRD §5.4 Needs changes) goes with the next change.
                            Menu {
                                Button("Take Photo", systemImage: "camera") { attach(object, camera: true) }
                                Button("Choose Photos", systemImage: "photo.on.rectangle") { attach(object, camera: false) }
                            } label: { Image(systemName: "camera.fill").foregroundStyle(.secondary) }
                            .disabled(working)
                            .accessibilityLabel("Add photos")
                            .accessibilityIdentifier("attach-photos")
                            // Dictation is the keyboard's own; nothing here that doesn't do something.
                            if !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Button { sendNote(object) } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                                    .disabled(working)
                                    .accessibilityLabel("Send changes")
                            }
                        }
                        .padding(.horizontal, 16).frame(minHeight: 50)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    if canPrint && !writing {
                        // The page's main action never truncates ("Print Ano…", lead review Nov 10): it keeps its whole
                        // label and the ask field gives way.
                        Button { openPrint(object.id) } label: {
                            Label(words.page.printWords ?? "Print", systemImage: "printer.fill").fontWeight(.semibold).lineLimit(1)
                                .fixedSize().padding(.horizontal, 8).frame(height: 36)
                        }
                        .mainAction(words.page.printIsMain)
                        .disabled(away)
                        .controlSize(.large)
                        .fixedSize()
                        .layoutPriority(1)
                        .keyboardShortcut("p", modifiers: .command)
                        .accessibilityIdentifier("print")
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
    }

    /// The longest placeholder that fits the field whole, in the reader's text size: the full sentence, a shorter one, or
    /// none (the field and its camera, with its accessibility label).
    private func fieldPlaceholder(pending: Bool) -> String {
        let choices = pending ? ["Will send when this step finishes", "Sends after this step", "Waiting…"] : ["Ask for changes…", "Changes…"]
        let font = UIFont.preferredFont(forTextStyle: .body)
        guard fieldWidth > 0 else { return choices[0] }
        return choices.first { ($0 as NSString).size(withAttributes: [.font: font]).width <= fieldWidth - 4 } ?? ""
    }

    /// Photos for the next change: the Mac keeps them with the project and uses them in its next pass.
    private func attach(_ object: Project, camera: Bool) {
        act {
            let photos: [ChosenPhoto] = camera
                ? (try await PhotoSources.takePhoto()).flatMap(MacConnection.keep).map { [$0] } ?? []
                : try await store.mac.choosePhotos(limit: NewObjectView.photoLimit)
            guard !photos.isEmpty else { return object }
            try await store.mac.sendChosen(object.id, photos, forMessage: true)
            notice = photos.count == 1 ? "Added a photo. Your Mac uses it in the next change." : "Added \(photos.count) photos. Your Mac uses them in the next change."
            return try await store.mac.get(object.id)
        }
    }

    private func sendNote(_ object: Project) {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        writing = false
        // One id for this note across every try, so the Mac never records it twice.
        let photoNames = store.corrections.availablePhotos(object)
        let messageId = attempts.id(for: text, photos: photoNames ?? [], in: object.id)
        if object.changesWait {
            // The Mac takes changes between passes; this one is sent the moment the pass ends.
            store.queue(note: text, for: object.id, messageId: messageId)
            attempts.settled(object.id)
            note = ""
            return
        }
        act {
            do {
                let next = try await store.mac.correct(object.id, text, photoNames: photoNames, messageId: messageId)
                store.corrections.sent(text, for: object.id)
                attempts.settled(object.id)
                note = ""; section = .activity
                return next
            } catch let failure as CompanionError where CorrectionQueue.waits(failure) {
                store.queue(note: text, for: object.id, messageId: messageId)
                attempts.settled(object.id)
                note = ""
                return nil
            }
        }
    }
}

// MARK: Sections

/// What changed, and the print's time, filament and printer. No card says nothing (first look U9): before slicing
/// there are no numbers, so the printer's row says when they come; with no printer, it says so and offers one.
struct ResultSection: View {
    let store: ProjectsStore
    let project: Project
    @Environment(AppModel.self) private var app

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
                let time = Format.duration(project.print?.estimate?.seconds), grams = Format.grams(project.print?.estimate?.grams)
                let printer = store.printerName(project)
                if time != nil || grams != nil {
                    HStack(spacing: 12) {
                        if let time { InfoTile(title: "Print time", value: time, symbol: "clock") }
                        if let grams { InfoTile(title: "Filament", value: grams, symbol: "scalemass") }
                        if let printer { InfoTile(title: "Printer", value: printer, symbol: "printer") }
                    }
                    if printer == nil { noPrinter }
                } else if let printer {
                    printerRow(printer)
                } else {
                    noPrinter
                }
            }
        }
    }

    /// Before it's sliced: the printer it goes to, and when the numbers come. One row, nothing empty.
    private func printerRow(_ name: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "printer").font(.title3).foregroundStyle(.secondary).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.headline)
                Text("Print time and filament show here once it’s sliced for printing.")
                    .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.card, in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("result-printer")
    }

    /// No printer to print on: say so, with the way to choose one. Nothing while the Mac's printers are still loading.
    /// Review F3: a printer chosen for this project that's no longer on the Mac says so, and Choose a Printer opens this
    /// project's print sheet, whose picker sets its printer. With no printers at all, Add a Printer opens Printers.
    @ViewBuilder private var noPrinter: some View {
        if let catalog = store.catalog {
            let none = catalog.destinations.isEmpty
            HStack(spacing: 12) {
                Image(systemName: "printer").font(.title3).foregroundStyle(.secondary).frame(width: 28)
                Text(none ? "No printer set up yet." : "The printer chosen for this project isn’t on your Mac anymore.")
                    .font(.headline).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("result-no-printer")
                Spacer(minLength: 8)
                Button(none ? "Add a Printer" : "Choose a Printer") { app.route = none ? .printers : .print(project.id) }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("result-choose-printer")
            }
            .padding(14)
            .background(Color.card, in: .rect(cornerRadius: 20))
        } else if let problem = store.printerProblem {
            // Review F3: the printer list can't be had: say so, with the way to try again; never an empty row.
            HStack(spacing: 12) {
                Image(systemName: "printer").font(.title3).foregroundStyle(.secondary).frame(width: 28)
                Text(problem).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("result-printers-problem")
                Spacer(minLength: 8)
                Button("Try Again") { Task { await store.loadPrinters() } }.buttonStyle(.glass)
                    .accessibilityIdentifier("result-printers-retry")
            }
            .padding(14)
            .background(Color.card, in: .rect(cornerRadius: 20))
        } else {
            // While the printer list is on its way: one plain line that says so.
            HStack(spacing: 12) {
                ProgressView().frame(width: 28)
                Text("Asking your Mac about its printers…").font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityIdentifier("result-printers-loading")
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(Color.card, in: .rect(cornerRadius: 20))
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

/// Your request, the photos you added, your scan as one strip, and your follow-ups.
struct InputsSection: View {
    let project: Project
    var queued: [CorrectionQueue.Message] = []
    var queueFailed = false
    @State private var viewing: String?

    var body: some View {
        let conversation = ProjectConversation(project: project, queued: queued, queueFailed: queueFailed)
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(conversation.entries) { entry in
                ConversationBubble(entry: entry) {
                    pictures(entry.photos)
                    if let scan = entry.scan { ScanStrip(project: project, scan: scan) }
                }
            }
            if conversation.entries.isEmpty { Text("No request was saved with this project.").foregroundStyle(.secondary) }
            // A scan with its photos is the strip above; this line is for a scan that came as a model file only.
            if project.scan != nil, project.capture?.isEmpty ?? true {
                Label("Walk-around scan, saved on your Mac", systemImage: "cube.transparent").font(.subheadline).foregroundStyle(.secondary)
            }
            if !conversation.otherPhotos.isEmpty {
                Text("Other project photos").font(.headline)
                Text("These photos aren't linked to a message.").font(.caption).foregroundStyle(.secondary)
                pictures(conversation.otherPhotos)
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

    @ViewBuilder private func pictures(_ paths: [String]) -> some View {
        if !paths.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 8)], spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    Button { viewing = path } label: {
                        ProjectImage(project: project, path: path, maxPixelSize: 400).frame(height: 110).clipShape(.rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain).accessibilityLabel(path.hasPrefix("photos/") ? "Photo" : "Scan image")
                }
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
            // The last stage carries how the pass ended: one that stopped to ask or stopped short is never a green tick.
            let ended: StepState? = pass.ending.map { $0 == .finished ? .done : $0 == .asked ? .asked : .failed }
            return stages.enumerated().map { offset, stage in
                let last = offset == stages.count - 1
                let state: StepState = last && ended != nil ? ended! : stage.endedAtMs != nil ? .done : (pass.failed ? .failed : running ? .current : .done)
                return (stage.words, nil, state)
            }
        }
        let title = pass.note.map { "Your change: “\($0)”" } ?? (index == 0 ? "Your Mac made it" : "Another pass")
        return [(title, pass.summary, running ? .current : pass.failed ? .failed : .done)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Each pass says when it ran and how it ended, in the Mac's words, and what it was asked to change.
            Text([index == 0 ? "First pass" : "Pass \(index + 1)", Format.clock(Date(timeIntervalSince1970: pass.startedAtMs / 1000)), pass.endingWords]
                    .compactMap { $0 }.joined(separator: " · "))
                .font(.caption.weight(.semibold)).foregroundStyle(pass.ending == .stopped ? Color.red : pass.ending == .asked ? .orange : .secondary)
                .padding(.bottom, pass.requestedChange == nil ? 8 : 2)
                .accessibilityIdentifier("pass-\(index + 1)-header")
            if let change = pass.requestedChange {
                Text("Your change: “\(change)”").font(.footnote).foregroundStyle(.secondary).lineLimit(3).padding(.bottom, 8)
            }
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
    /// The pass stopped here to ask the person something.
    case asked
    var symbol: String {
        switch self { case .done: "checkmark.circle.fill"; case .current: "circle.dotted.circle"; case .failed: "xmark.circle.fill"; case .pending: "circle"; case .asked: "questionmark.circle.fill" }
    }
    var color: Color {
        switch self { case .done: .green; case .current: .blue; case .failed: .red; case .pending: .secondary; case .asked: .orange }
    }
}

// MARK: AR

/// Quick Look AR for the model at true size: the STL (millimetres, Z up) converted to USDZ (metres, Y up).
enum ARModel {
    /// The STL as USDZ for AR Quick Look, written once beside it. RealityKit writes the same mesh the stage shows.
    /// AR wears what the stage wears: the spool it prints in, or the neutral material before one is chosen.
    @MainActor static func usdz(fromSTL url: URL, tint hex: String? = nil) async -> URL? {
        let target = url.deletingPathExtension().appendingPathExtension("\(hex.map { $0.dropFirst() + "." } ?? "")usdz")
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let tint = hex.flatMap { Int($0.dropFirst().prefix(6), radix: 16) }.map {
            UIColor(red: CGFloat(($0 >> 16) & 255) / 255, green: CGFloat(($0 >> 8) & 255) / 255, blue: CGFloat($0 & 255) / 255, alpha: 1)
        }
        guard let entity = await ModelStage.load(url, tint: tint, twoTone: false) else { return nil }
        guard !Task.isCancelled else { return nil }
        return await ModelEntityCache.export(entity, to: target)
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

private struct PhoneProjectSettings: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    let id: String
    let close: () -> Void
    var body: some View {
        if let project = store.project(id) {
            ProjectSettingsForm(project: project, files: project.settingsFiles,
                load: { try await context() },
                save: { patch in
                    let ticket = store.startRequest()
                    let saved = try await store.mac.client.setProjectSettings(id, patch)
                    guard store.requestIsCurrent(ticket) else { throw CancellationError() }
                    store.replace(saved, ticket: ticket)
                    if patch["status"] == .string("works"), let pending = project.pendingFollowup { store.corrections.sent(pending, for: id) }
                }, duplicate: {
                    let ticket = store.startRequest()
                    let copied = try await store.mac.client.duplicate(id)
                    guard store.requestIsCurrent(ticket) else { throw CancellationError() }
                    store.replace(copied, ticket: ticket)
                    app.route = .project(copied.id)
                }, delete: {
                    try await store.mac.delete(id)
                    store.remove(id); close()
                }, download: { try await store.mac.client.download(project, $0.id) })
        }
    }
    private func context() async throws -> ProjectSettingsForm.Context {
        let catalog = try await store.mac.printers()
        let fusion = try? await store.mac.client.settings().fusion?.state
        var colours: [ProjectSettingsForm.Colour] = []
        var filamentProblem: String?
        do {
            colours = try await store.mac.filaments(id).map { spool in
                .init(id: String(spool.slot), name: spool.title,
                    value: .object(spool.isExternal ? ["external": .bool(true)] : ["amsSlot": .number(Double(spool.slot))]))
            }
            if !colours.isEmpty { colours.insert(.init(id: "auto", name: "Suggested spool", value: .object(["auto": .bool(true)])), at: 0) }
        } catch { filamentProblem = (error as? CompanionError)?.message ?? "Couldn't read the printer's filament." }
        return .init(printers: catalog.destinations.map { .init(id: $0.id, name: $0.name,
            quality: $0.offersQuality, strength: $0.offersStrength, copies: $0.capabilities?.copies == true, materialChoice: $0.capabilities?.materialChoice == true) },
            defaultPrinter: catalog.defaultDestinationId, colours: colours, fusionAvailable: ["connected", "not-running"].contains(fusion ?? ""), filamentProblem: filamentProblem)
    }
}

/// "Did it fit?" after a finished print (PRD §5.4), on the project page and the finished Printing screen alike.
struct DidItFitCard: View {
    let project: Project
    let macName: String?
    let working: Bool
    let itWorks: () -> Void
    let needsChanges: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(ProjectWords.outcomeQuestion(project), systemImage: "ruler").font(.headline)
            Text("Try it where it goes. Your answer stays with the project on \(macName ?? "your Mac").")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button(action: itWorks) {
                        Label("It Works", systemImage: "checkmark").font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.85)
                            .frame(maxWidth: .infinity).frame(height: 36)
                    }
                    .buttonStyle(.glassProminent).tint(.okGreen)
                    .accessibilityIdentifier("it-works")
                    Button(action: needsChanges) {
                        Label("Needs Changes", systemImage: "pencil").font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.85)
                            .frame(maxWidth: .infinity).frame(height: 36)
                    }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("needs-changes")
                }
                .disabled(working)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

extension View {
    /// The page's one filled control when `main`, a plain glass button otherwise. Views never choose the fill
    /// themselves: it comes from `PageActions.main`.
    @ViewBuilder func mainAction(_ main: Bool) -> some View {
        if main { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
    }
}

/// A size question's fields (PRD §5.4): one row per size the Mac asked about, in its words, prefilled with its
/// number, and one button. The rules for what is sent are `AskSizesForm`'s (CounterpartKit).
struct AskSizesFields: View {
    @State var form: AskSizesForm
    let working: Bool
    /// The fields as they stand, so the card's other answers (words, a caliper photo) carry the same numbers.
    var changed: (AskSizesForm) -> Void = { _ in }
    let send: ([AskSizesForm.Answer]) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach($form.fields) { $field in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.label.prefix(1).uppercased() + field.label.dropFirst()).font(.subheadline.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(AskSizesForm.source(field.from)).font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 4) {
                        AskSizeNumber(text: $field.text, label: field.label, id: field.id)
                        Text("mm").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14))
                }
            }
            Button { if let answer = form.answer { send(answer) } } label: {
                Label(form.unchanged ? "Confirm These Sizes" : "Send These Sizes", systemImage: "checkmark")
                    .fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 30)
            }
            .buttonStyle(.glassProminent).controlSize(.large)
            .disabled(working || form.answer == nil)
            .accessibilityIdentifier("ask-sizes-confirm")
            if form.answer == nil {
                Text(AskSizesForm.invalidWords).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .onAppear { changed(form) }
        .onChange(of: form) { _, now in changed(now) }
    }
}

/// One size's number. Tapping it selects the whole number, so typing replaces the Mac's figure instead of landing
/// in front of it.
private struct AskSizeNumber: View {
    @Binding var text: String
    let label: String
    let id: String
    @State private var selection: TextSelection?
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: $text, selection: $selection)
            .focused($focused)
            .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
            .font(.title3.monospacedDigit().weight(.semibold))
            .frame(width: 84)
            .accessibilityLabel("\(label), millimetres")
            .accessibilityIdentifier("ask-size-\(id)")
            .onChange(of: focused) { _, now in
                if now, !text.isEmpty { selection = TextSelection(range: text.startIndex..<text.endIndex) }
            }
    }
}
