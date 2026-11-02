import SwiftUI
import CounterpartKit

/// Home (PRD §5.1, screens/phone-home.jpg): what's running now, what needs you, and every project as a
/// real render. New sits at the bottom trailing edge, the only prominent control.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Bindable var store: ProjectsStore
    @Binding var path: [String]
    let newProject: (NewProjectJob?) -> Void
    let openPrinters: () -> Void
    let openSettings: () -> Void
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var showArchived = false

    private var searched: [Project] {
        store.projects.filter { $0.matchesSearch(query, additional: [store.printerName($0) ?? ""]) }
    }
    /// Archived projects stay out of every section but their own (PRD §5.4).
    private var filtered: [Project] { searched.filter { !$0.isArchived } }
    private var archived: [Project] { searched.filter(\.isArchived).sorted { $0.updatedAtMs > $1.updatedAtMs } }
    /// Works: the ones you said came out right.
    private var done: [Project] { filtered.filter { store.words($0).phase == .confirmed }.sorted { $0.updatedAtMs > $1.updatedAtMs } }
    /// Prints first, then work on the Mac.
    private var running: [Project] {
        let printing = filtered.filter { [.printing, .preparing].contains(store.words($0).phase) }
        let working = filtered.filter { [.working, .sending].contains(store.words($0).phase) }
        return printing + working
    }
    private var needsYou: [Project] { filtered.filter { store.words($0).phase == .needsYou } }
    /// Ready first, then the rest by recency.
    private var grid: [Project] {
        filtered.filter { store.words($0).phase != .confirmed }.sorted { a, b in
            let ra = store.words(a).phase == .ready, rb = store.words(b).phase == .ready
            return ra != rb ? ra : a.updatedAtMs > b.updatedAtMs
        }
    }

    var body: some View {
        ScrollView {
            if store.loaded && store.projects.isEmpty && store.error == nil {
                EmptyHome(start: newProject).padding(.horizontal, 16).padding(.bottom, 24)
            } else {
                VStack(alignment: .leading, spacing: 26) {
                    if let error = store.error { ConnectionBanner(error: error, pair: store.onPair) }
                    if !running.isEmpty {
                        HomeSection("Now") {
                        VStack(spacing: 12) {
                            ForEach(running) { project in
                                // A print opens the Printing screen; anything else, its project page.
                                Button { path.append(ProjectWords.watchable(project, phase: store.words(project).phase) ? Page.printing(project.id) : project.id) } label: {
                                    if [.printing, .preparing].contains(store.words(project).phase) { NowPrintingCard(store: store, project: project) }
                                    else { NowWorkingCard(store: store, project: project) }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        }
                    }
                    if !needsYou.isEmpty {
                        HomeSection("Needs you") {
                            ForEach(needsYou) { project in NeedsYouCard(store: store, project: project) { path.append(project.id) } }
                        }
                    }
                    if !grid.isEmpty { HomeSection("All projects") { projectGrid(grid) } }
                    if !done.isEmpty { HomeSection("Done") { projectGrid(done) } }
                    if !archived.isEmpty {
                        Button { withAnimation { showArchived.toggle() } } label: {
                            Label("Archived · \(archived.count)", systemImage: showArchived ? "chevron.down" : "chevron.right")
                                .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("show-archived")
                        if showArchived {
                            VStack(spacing: 8) { ForEach(archived) { ArchivedRow(store: store, project: $0) { path.append($0.id) } } }
                        }
                    }
                    if !store.loaded && store.error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    } else if searched.isEmpty && !query.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
                .padding(.horizontal, 16)
                // The last row scrolls clear of the search and New bar.
                .padding(.bottom, 96)
            }
        }
        .background(Color.black)
        .refreshable { await store.load(); await store.loadPrinters() }
        .navigationTitle("Projects")
        .navigationSubtitle(subtitle)
        .searchable(text: $query, prompt: "Projects, printers, notes")
        .searchFocused($searching)
        .background { Button("Search") { searching = true }.keyboardShortcut("f", modifiers: .command).hidden() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: openPrinters) { Image(systemName: "printer.fill") }
                    .badge(printerProblems)
                    .accessibilityLabel(printerProblems > 0 ? "Printers, \(printerProblems) need attention" : "Printers")
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: openSettings) { Image(systemName: "person.crop.circle") }
                    .accessibilityLabel("Settings")
            }
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.fixed, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                Button { newProject(nil) } label: {
                    Label("New", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold).padding(.horizontal, 6)
                }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("new-project")
                .keyboardShortcut("n", modifiers: .command)
            }
        }
    }

    private func projectGrid(_ projects: [Project]) -> some View {
        // Two equal columns, 12 pt gutters both ways; the card's own shape sets its size, never its content.
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(projects) { project in
                Button { path.append(project.id) } label: { ProjectCard(store: store, project: project) }
                    .buttonStyle(.plain)
                    .contextMenu { DeleteProjectButton(store: store, project: project) }
            }
        }
    }

    /// "Mac mini connected · 2 printers ready"
    private var subtitle: String {
        let mac = store.macName ?? "Your Mac"
        let connection = store.reachable == false ? "\(mac) isn't answering" : store.reachable == true ? "\(mac) connected" : mac
        guard let catalog = store.catalog, !catalog.destinations.isEmpty else { return connection }
        // What the printers are doing: printing first ("Bambu Lab P1S printing"), then how many are ready.
        // Printing, not getting ready: a print the printer is still preparing isn't "printing" yet.
        let printing = catalog.destinations.filter { destination in
            destination.state == "printing" || (store.printing(on: destination.id).map { store.words($0).phase == .printing } ?? false)
        }
        if printing.count == 1 { return "\(connection) · \(printing[0].model ?? printing[0].name) printing" }
        if printing.count > 1 { return "\(connection) · \(printing.count) printers printing" }
        let count = catalog.destinations.count
        let ready = catalog.destinations.filter { $0.isReady == true }.count
        if ready == 0 { return "\(connection) · \(count) \(count == 1 ? "printer" : "printers")" }
        return "\(connection) · \(ready) \(ready == 1 ? "printer" : "printers") ready"
    }

    /// Printers that are offline or need an MCP update.
    private var printerProblems: Int {
        store.catalog?.destinations.filter { $0.isOffline || $0.capabilities?.update != nil }.count ?? 0
    }
}

/// The Mac isn't answering, or this phone has to pair again.
struct ConnectionBanner: View {
    let error: CompanionError
    let pair: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: error.needsPairing ? "desktopcomputer.trianglebadge.exclamationmark" : "wifi.exclamationmark")
                .font(.title3).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 8) {
                Text(error.message).font(.subheadline)
                if error.needsPairing { Button("Connect to Your Mac", action: pair).buttonStyle(.glassProminent) }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassEffect(.regular.tint(.orange.opacity(0.14)), in: .rect(cornerRadius: 22))
    }
}

// MARK: Cards

/// A print that's running: the printer camera, percent, layer, time left and filament.
struct NowPrintingCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let store: ProjectsStore
    let project: Project
    @State private var camera = CameraFeed()

    var body: some View {
        let words = store.words(project)
        let live = project.print?.live
        HStack(spacing: 14) {
            ZStack(alignment: .topLeading) {
                if let image = camera.image {
                    FillImage(image: image, height: 96).frame(width: 96)
                } else {
                    ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 300).frame(width: 96, height: 96)
                }
                if let at = camera.capturedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(Format.ago(at, now: context.date)).font(.system(size: 9, weight: .heavy))
                            .padding(.horizontal, 5).padding(.vertical, 2).background(.black.opacity(0.6), in: .capsule).padding(6)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 18))
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(words.title).font(.headline).lineLimit(1)
                    Spacer()
                    // A percent only once the Mac says it's printing: while the printer gets ready (layer 0) there's none.
                    if words.phase == .printing, let percent = Format.percent(live?.job?.progress) {
                        Text(percent).font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen)
                    }
                }
                // The Mac's own words when it gives them ("Getting ready · …", "The printer stopped: …").
                Text(project.status?.text.isEmpty == false ? words.line : detail(live)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                if words.phase == .printing, let progress = live?.job?.progress { ProgressView(value: progress, total: 100).tint(.okGreen) }
                else { ProgressView().progressViewStyle(.linear).tint(words.phase.color) }
                if let filament = live?.activeFilament, let material = filament.material {
                    HStack(spacing: 6) {
                        SpoolDot(color: hexColor(filament.color) ?? .gray, size: 14)
                        Text([material, ColourName.of(filament.color)].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        // Scene changes cancel the active stream; returning to the app starts a fresh watch.
        .task(id: "\(project.id)#\(store.words(project).phase)#\(scenePhase)") {
            guard scenePhase == .active, store.words(project).phase == .printing else { return }
            await camera.run(app.companion, project: project.id, every: 10, maxPixelSize: 300)
        }
        .accessibilityElement(children: .combine)
    }

    /// "P1S · layer 84 of 212 · 38 min left", or the preparation step while it isn't printing yet.
    private func detail(_ live: PrintLive?) -> String {
        let words = store.words(project)
        guard words.phase == .printing else { return words.line }
        let printer = store.printerName(project) ?? "Your printer"
        var parts = [printer]
        if let layer = live?.job?.layer, let total = live?.job?.totalLayers { parts.append("layer \(layer) of \(total)") }
        if let left = Format.duration(live?.job?.remainingSec) { parts.append("\(left) left") }
        if live?.state == "paused" { parts.append("paused") }
        return parts.joined(separator: " · ")
    }
}

/// Work on the Mac: the stage in plain words, the estimate, and step n of m.
struct NowWorkingCard: View {
    let store: ProjectsStore
    let project: Project

    var body: some View {
        let words = store.words(project)
        TimelineView(.periodic(from: .now, by: 10)) { context in
            let work = WorkProgress(project, now: context.date)
            HStack(spacing: 14) {
                ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 300)
                    .frame(width: 96, height: 96).clipShape(.rect(cornerRadius: 18))
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(words.title).font(.headline).lineLimit(1)
                        Spacer()
                        if let left = work.remainingSec, let text = Format.duration(max(60, left)) {
                            Text("~" + text).font(.subheadline.monospacedDigit()).foregroundStyle(.blue)
                        }
                    }
                    Text(work.stage ?? stageText(words)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    if let fraction = work.fraction { ProgressView(value: fraction).tint(.blue) }
                    else { ProgressView().progressViewStyle(.linear).tint(.blue) }
                    Text(footer(work)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .accessibilityElement(children: .combine)
    }

    private func stageText(_ words: ProjectWords) -> String {
        words.phase == .sending ? "Sending your files" : (project.progress ?? words.line)
    }

    /// "Step 3 of 4 · your Mac"
    private func footer(_ work: WorkProgress) -> String {
        if store.words(project).phase == .sending { return "Keep the app open until it's sent" }
        if let step = work.step, let steps = work.steps { return "Step \(step) of \(steps) · your Mac" }
        return "On your Mac · you can put your phone down"
    }
}

/// A question from the Mac, answerable right here: Camera, Photos or Best guess.
struct NeedsYouCard: View {
    let store: ProjectsStore
    let project: Project
    let open: () -> Void
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        let words = store.words(project)
        VStack(alignment: .leading, spacing: 12) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 12) {
                    ProjectImage(project: project, path: askPicture, maxPixelSize: 200)
                        .frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(words.title).font(.headline)
                        Text(project.printConfirmation != nil ? words.line : "“\(ProjectWords.question(project))”").font(.subheadline).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            // A printer's question is answered in its sheet on the project page.
            if project.printConfirmation != nil {
                Button(action: open) { Label("Review", systemImage: "checkmark.shield").frame(maxWidth: .infinity).frame(height: 36) }
                    .buttonStyle(.glassProminent)
            } else {
                AskButtons(store: store, project: project, working: $working, problem: $problem)
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(14)
        .glassEffect(.regular.tint(.orange.opacity(0.18)), in: .rect(cornerRadius: 26))
    }

    private var askPicture: String? {
        if let ask = project.openAsk, ask.photo != nil { return "asks/\(ask.id).jpg" }
        return project.thumbnailPath
    }
}

/// Camera, Photos and Best guess for an open question, as the Mac allows them.
struct AskButtons: View {
    let store: ProjectsStore
    let project: Project
    @Binding var working: Bool
    @Binding var problem: String?

    private var answers: Set<String> { Set(project.openAsk?.answers ?? ["camera", "photos", "best-guess"]) }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                if answers.contains("camera") {
                    Button { answer(camera: true) } label: { StackLabel(text: "Camera", symbol: "camera.fill") }.buttonStyle(.glassProminent)
                }
                if answers.contains("photos") {
                    Button { answer(camera: false) } label: { StackLabel(text: "Photos", symbol: "photo") }.buttonStyle(.glass)
                }
                if answers.contains("best-guess") {
                    Button { bestGuess() } label: { StackLabel(text: "Best guess", symbol: "sparkles") }.buttonStyle(.glass)
                }
            }
            .controlSize(.large)
            .labelStyle(.titleAndIcon)
            .font(.footnote.weight(.semibold))
            .disabled(working)
        }
    }

    private func answer(camera: Bool) {
        act {
            let sent = try await store.mac.addCloseups(project.id, camera: camera, forMessage: true)
            guard !sent.isEmpty else { return nil }
            return try await store.mac.closeup(project.id, bestGuess: false, photoNames: sent)
        }
    }
    private func bestGuess() { act { try await store.mac.closeup(project.id, bestGuess: true) } }

    private func act(_ body: @escaping () async throws -> Project?) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do { let ticket = store.startRequest(); if let next = try await body() { store.replace(next, ticket: ticket) } }
            catch let failure as CompanionError {
                if failure.code == "cancelled" { return }
                if failure.needsPairing { store.onPair(); return }
                problem = failure.message
            } catch { problem = CompanionError.unreachable.message }
        }
    }
}

/// One project in the grid: its render with its state on top.
struct ProjectCard: View {
    let store: ProjectsStore
    let project: Project

    var body: some View {
        let words = store.words(project)
        VStack(alignment: .leading, spacing: 0) {
            Color.clear
                .aspectRatio(4/3, contentMode: .fit)
                .overlay { ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 500) }
                .clipped()
                .overlay(alignment: .topLeading) { StatusCapsule(phase: words.phase, text: capsuleText(words)).padding(8) }
            VStack(alignment: .leading, spacing: 2) {
                Text(words.title).font(.headline).lineLimit(1)
                Text(Format.when(project.updatedAt)).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
        .background(Color.card)
        .clipShape(.rect(cornerRadius: 24))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the project")
    }

    private func capsuleText(_ words: ProjectWords) -> String? {
        switch words.phase {
        case .confirmed: ProjectWords.doneLine
        case .printed: "Printed"
        case .sent: "Sent"
        // The Mac's own words while it prints or gets ready, never a percent worked out here.
        case .printing, .preparing: project.status?.text.isEmpty == false ? project.status?.text : nil
        default: nil
        }
    }
}

/// A Home section: its title tight above its cards.
struct HomeSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle(title)
            content
        }
    }
}

/// An archived project, hidden from Home's sections, with Unarchive.
struct ArchivedRow: View {
    let store: ProjectsStore
    let project: Project
    let open: (Project) -> Void
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        HStack(spacing: 12) {
            Button { open(project) } label: {
                HStack(spacing: 12) {
                    ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 160)
                        .frame(width: 52, height: 52).clipShape(.rect(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.words(project).title).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(problem ?? store.words(project).phase.label).font(.caption).foregroundStyle(problem == nil ? Color.secondary : .orange).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            Button("Unarchive") {
                working = true; problem = nil
                Task {
                    defer { working = false }
                    do { let ticket = store.startRequest(); if let next = try await store.archive(project, false) { store.replace(next, ticket: ticket) } else { await store.reload(project.id) } }
                    catch let failure as CompanionError { problem = failure.message }
                    catch { problem = CompanionError.unreachable.message }
                }
            }
            .buttonStyle(.glass).controlSize(.small).disabled(working)
            .accessibilityIdentifier("unarchive")
        }
        .padding(10)
        .background(Color.card, in: .rect(cornerRadius: 18))
    }
}

struct DeleteProjectButton: View {
    let store: ProjectsStore
    let project: Project
    var body: some View {
        Button("Delete Project", systemImage: "trash", role: .destructive) {
            Task {
                do { try await store.mac.delete(project.id); store.remove(project.id) }
                catch let failure as CompanionError { store.error = failure.isUnreachable || failure.needsPairing ? failure : nil }
                catch { store.error = .unreachable }
            }
        }
    }
}

// MARK: Empty Home (screens/phone-home-empty.jpg)

/// What New opens with when chosen from an empty Home's job cards.
enum NewProjectJob: String, Identifiable { case fit, copy; var id: String { rawValue } }

struct EmptyHome: View {
    let start: (NewProjectJob?) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What do you want to make?").font(.title3.weight(.bold)).padding(.top, 6)
            Button { start(.fit) } label: {
                JobHeroCard(illustration: .model("example-fit", "stl"), title: "Make something that fits",
                            detail: "Describe it and show what it fits. Your Mac designs the part.",
                            steps: [("text.bubble.fill", "Describe it"), ("camera.fill", "Show it"), ("printer.fill", "Print it")])
            }
            .buttonStyle(.plain)
            Button { start(.copy) } label: {
                JobHeroCard(illustration: .image("example-copy"), title: "Copy something",
                            detail: "Scan it. Your Mac fixes what the scanner missed.",
                            steps: [("cube.transparent.fill", "Scan it"), ("wand.and.sparkles", "Fixed for you"), ("printer.fill", "Print it")])
            }
            .buttonStyle(.plain)
            Label("You'll get a notification when it's ready.", systemImage: "bell.badge")
                .font(.footnote).foregroundStyle(.secondary).padding(.top, 4).padding(.horizontal, 4)
        }
    }
}

/// One of the two jobs, illustrated by a real model or render shipped with the app.
struct JobHeroCard: View {
    enum Illustration { case model(String, String), image(String) }
    let illustration: Illustration
    let title: String, detail: String
    let steps: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group {
                switch illustration {
                case let .model(name, ext):
                    ModelStage(url: Bundle.main.url(forResource: name, withExtension: ext), yaw: 0.75, pitch: -0.3, interactive: false, fit: 0.2, twoTone: true)
                case let .image(name):
                    // The render's own dark backdrop lightens into the stage.
                    ZStack { StageBackground(); Image(name).resizable().scaledToFit().padding(.vertical, 18).blendMode(.lighten) }
                }
            }
            .frame(height: 132)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: 6) {
                    ForEach(steps, id: \.1) { step in
                        Label(step.1, systemImage: step.0).labelStyle(.titleAndIcon).font(.caption2.weight(.semibold))
                            .padding(.horizontal, 9).padding(.vertical, 5).glassEffect(.regular, in: .capsule)
                    }
                }
                .padding(12)
            }
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.title3.weight(.semibold))
                    Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").font(.headline).foregroundStyle(.white)
                    .frame(width: 40, height: 40).glassEffect(.regular.tint(Color.filament).interactive(), in: .circle)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
        }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .clipShape(.rect(cornerRadius: 28))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}
