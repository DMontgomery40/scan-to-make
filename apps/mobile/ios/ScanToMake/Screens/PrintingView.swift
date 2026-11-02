import SwiftUI
import CounterpartKit

/// A print in progress (PRD §5.7, screens/phone-printing.jpg): the printer camera as a still refreshed every
/// 3 s with when it was taken, progress, time left, layer, filament and temperatures, and Pause / Stop when the
/// printer's MCP has them. Stop asks first. Never called video.
///
/// Guards: one control at a time (`working`); the camera loop and polling are tied to the screen.
struct PrintingView: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    let id: String
    @State private var feed = CameraFeed()
    @State private var working = false
    @State private var problem: String?
    @State private var confirmStop = false
    @State private var fullScreen = false
    @State private var confirming: IdentifiedProject?

    private var project: Project? { store.project(id) }
    private var printer: PrinterDestination? { store.catalog?.destination(project?.print?.destinationId ?? project?.printerDestinationId) }
    private var printerName: String { project?.print?.destination?.name ?? printer?.name ?? "Your printer" }
    private var live: PrintLive? { project?.print?.live }

    var body: some View {
        ScrollView {
            if let project {
                VStack(alignment: .leading, spacing: 18) {
                    camera
                    summary(project)
                    tiles(project).padding(.horizontal, 16)
                    if let problems = live?.problems, !problems.isEmpty { problemsCard(problems).padding(.horizontal, 16) }
                    if let problem { Label(problem, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red).padding(.horizontal, 20) }
                }
                .padding(.bottom, 16)
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        // The note rides in the bar with the controls, so nothing it says is ever under them.
        .safeAreaBar(edge: .bottom) {
            VStack(spacing: 8) {
                if let project { Text(footer(project)).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 20) }
                controls
            }
        }
        .background(Color.black)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Stop the print?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop Print", role: .destructive) { act(.cancel) }
        } message: { Text("\(printerName) stops \(project.map { ProjectWords.title($0) } ?? "the print") and can't pick it up again.") }
        .fullScreenCover(isPresented: $fullScreen) { CameraFullScreen(feed: feed, printer: printerName) }
        // Pause, Resume and Stop can bring the printer's own question; it's answered here too.
        .modifier(PrinterQuestion(store: store, project: project, confirming: $confirming))
        .task(id: id) {
            // The Mac's still is shared and cached for 3 s; asking more often gets the same photo.
            await feed.run(app.companion, project: id, every: 3)
        }
        .task(id: id) {
            // Pause, Resume and Stop follow the MCP's capabilities, read fresh.
            await store.loadPrinters()
            guard store.events != true else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if UIApplication.shared.applicationState != .background { await store.reload(id) }
            }
        }
    }

    // MARK: Camera

    private var camera: some View {
        Group {
            if let image = feed.image {
                FillImage(image: image, height: 380)
            } else {
                StageBackground().frame(height: 380)
                    .overlay {
                        VStack(spacing: 10) {
                            Image(systemName: feed.unsupported ? "video.slash.fill" : "camera").font(.system(size: 34)).foregroundStyle(.secondary)
                            Text(feed.unsupported ? (feed.problem ?? "No camera Counterpart can use") : feed.problem ?? "Getting a photo from \(printerName)…")
                                .font(.headline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        .padding(.top, 60).padding(.horizontal, 30)
                    }
            }
        }
        .overlay(alignment: .topLeading) {
            if let captured = feed.capturedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack(spacing: 6) { Image(systemName: "camera.fill"); Text("\(printerName) · \(Format.ago(captured, now: context.date))").font(.caption.weight(.bold)) }
                        .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule)
                        .accessibilityLabel("Camera photo from \(printerName), \(Format.ago(captured, now: context.date))")
                }
                .padding(.top, 110).padding(.leading, 16)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if feed.image != nil {
                Button { fullScreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .buttonStyle(.glass).padding(14).accessibilityLabel("Show the camera full screen")
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: Progress

    private func summary(_ project: Project) -> some View {
        let job = live?.job
        let fraction = (job?.progress ?? 0) / 100
        return HStack(alignment: .center, spacing: 20) {
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 10)
                Circle().trim(from: 0, to: fraction).stroke(Color.okGreen, style: .init(lineWidth: 10, lineCap: .round)).rotationEffect(.degrees(-90))
                VStack(spacing: 0) {
                    Text(Format.percent(job?.progress) ?? "–").font(.title.bold().monospacedDigit())
                    Text(stateWord).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(width: 118, height: 118)
            .accessibilityElement(children: .combine)
            VStack(alignment: .leading, spacing: 6) {
                Text(ProjectWords.title(project)).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                if let left = timeLeft { Text(left).foregroundStyle(.secondary) }
                if let layer = job?.layer {
                    Text(job?.totalLayers.map { "Layer \(layer) of \($0)" } ?? "Layer \(layer)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let filament = live?.activeFilament {
                    HStack(spacing: 6) {
                        SpoolDot(color: hexColor(filament.color) ?? .gray, size: 14)
                        Text([filament.slot, filament.material, ColourName.of(filament.color)].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
    }

    private var stateWord: String {
        switch live?.state {
        case "paused": "paused"
        case "preparing": "preparing"
        case "printing": "printing"
        default: live == nil ? "getting ready" : (live?.state ?? "")
        }
    }

    /// "38 min left · done 12:51 PM"
    private var timeLeft: String? {
        guard let remaining = live?.job?.remainingSec, let words = Format.duration(remaining) else { return nil }
        let end = live?.endsAtDate ?? Date().addingTimeInterval(remaining)
        return "\(words) left · done \(end.formatted(date: .omitted, time: .shortened))"
    }

    private func tiles(_ project: Project) -> some View {
        HStack(spacing: 12) {
            InfoTile(title: "Nozzle", value: Format.temperature(live?.temps?.nozzle?.actual) ?? "–", symbol: "flame")
            InfoTile(title: "Bed", value: Format.temperature(live?.temps?.bed?.actual) ?? "–", symbol: "square.fill")
            // PRD §5.7: nozzle, bed and speed. The Mac doesn't report the speed level yet, so it says so.
            InfoTile(title: "Speed", value: "–", symbol: "gauge.with.dots.needle.33percent")
                .accessibilityLabel("Speed not reported")
        }
    }

    private func problemsCard(_ problems: [PrintLive.Problem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(problems, id: \.code) { problem in
                Label(problem.message, systemImage: problem.severity == "fatal" || problem.severity == "serious" ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(problem.severity == "fatal" || problem.severity == "serious" ? .red : .orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 24))
    }

    private func footer(_ project: Project) -> String {
        if project.print?.monitor?.unreachableSince != nil { return "Lost contact with \(printerName). Still trying." }
        return "You'll get a notification when it's done, or if the printer stops."
    }

    // MARK: Controls

    @ViewBuilder private var controls: some View {
        let paused = live?.state == "paused"
        let canPause = printer?.canPause ?? false, canResume = printer?.canResume ?? false, canStop = printer?.canCancel ?? false
        if (paused ? canResume : canPause) || canStop {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if paused && canResume {
                        Button { act(.resume) } label: { Label("Resume", systemImage: "play.fill").frame(maxWidth: .infinity).frame(height: 36) }.buttonStyle(.glass)
                    } else if !paused && canPause {
                        Button { act(.pause) } label: { Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity).frame(height: 36) }.buttonStyle(.glass)
                    }
                    if canStop {
                        Button(role: .destructive) { confirmStop = true } label: { Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity).frame(height: 36) }
                            .buttonStyle(.glass).tint(.red)
                    }
                }
                .controlSize(.large).fontWeight(.semibold)
                .disabled(working || live == nil)
            }
            .padding(.horizontal, 16)
        }
    }

    private func act(_ action: CompanionClient.PrintControl) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do { store.replace(try await store.mac.client.control(id, action)) }
            catch let failure as CompanionError {
                if failure.needsPairing { store.onPair(); return }
                problem = failure.isUnsupported ? "Update Counterpart on your Mac to \(action == .cancel ? "stop" : action.rawValue) prints from here." : failure.message
            } catch { problem = CompanionError.unreachable.message }
        }
    }
}

/// The camera photo filling the screen, still refreshing.
struct CameraFullScreen: View {
    let feed: CameraFeed
    let printer: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let image = feed.image { Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity) }
            Button(role: .close) { dismiss() }.buttonStyle(.glass).padding(20)
        }
        .overlay(alignment: .bottomLeading) {
            if let captured = feed.capturedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("\(printer) · \(Format.updated(captured, now: context.date))").font(.caption.weight(.bold))
                        .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule).padding(20)
                }
            }
        }
    }
}
