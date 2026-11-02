import SwiftUI
import CounterpartKit

/// Printers (PRD §5.8, screens/phone-printers.jpg): one row per printer from the MCP configs on the Mac.
/// Printers are configured in the MCPs; Counterpart picks them up and never duplicates their settings.
struct PrintersView: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    @Environment(\.dismiss) private var dismiss
    @State private var path: [PrinterLink] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    if let catalog = store.catalog {
                        ForEach(catalog.destinations) { printer in
                            NavigationLink(value: PrinterLink.printer(printer.id)) { PrinterRow(store: store, printer: printer) }
                        }
                    } else if let problem = store.printerProblem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else {
                        ProgressView()
                    }
                } footer: {
                    Text("These come from bambu-printer-mcp and mcp-3D-printer-server on your Mac. Add or change printers there; Counterpart picks them up.")
                }
            }
            .navigationTitle("Printers")
            .navigationDestination(for: PrinterLink.self) { link in
                switch link {
                case .printer(let id): PrinterDetailView(store: store, id: id)
                case .printing(let id): PrintingView(store: store, id: id)
                }
            }
            .refreshable { await store.loadPrinters() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task {
            #if DEBUG
            if let printer = app.debugPrinter { path = [.printer(printer)]; app.debugPrinter = nil }
            #endif
            // The Mac reads each printer's state in the background; asking again shows it as it fills in.
            for _ in 0..<6 where !Task.isCancelled {
                await store.loadPrinters()
                await store.loadSpools()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

enum PrinterLink: Hashable { case printer(String), printing(String) }

struct PrinterRow: View {
    let store: ProjectsStore
    let printer: PrinterDestination

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "printer.fill").font(.title2).frame(width: 48, height: 48)
                .glassEffect(.regular, in: .rect(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 3) {
                Text(printer.name).font(.headline)
                Text(PrinterWords.state(printer, store: store)).font(.subheadline).foregroundStyle(printer.isReady == true ? Color.okGreen : .secondary)
                let spools = (store.spools[printer.id] ?? []).filter { !$0.isExternal }
                if !spools.isEmpty { HStack(spacing: 4) { ForEach(spools) { SpoolDot(color: $0.color, size: 14) } } }
                if let update = printer.capabilities?.update?.message {
                    Label(update, systemImage: "arrow.down.circle").font(.caption).foregroundStyle(Color.filament)
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

enum PrinterWords {
    /// "Ready", "Ready · PLA Galaxy Black loaded", "Printing Cable clip", "Offline", or not read yet.
    @MainActor static func state(_ printer: PrinterDestination, store: ProjectsStore) -> String {
        switch printer.state {
        case "ready":
            let spools = store.spools[printer.id] ?? []
            if spools.count == 1, let loaded = spools.first { return "Ready · \(loaded.material) \(loaded.displayName) loaded" }
            return "Ready"
        case "busy": return store.printing(on: printer.id).map { "Printing " + ProjectWords.title($0) } ?? "Busy"
        case "offline": return "Offline"
        default: return printer.state == nil ? "Configured on your Mac" : "Checking…"
        }
    }
}

/// One printer (PRD §5.8, screens/phone-printer.jpg, phone-printer-update.jpg): its camera as a still that
/// refreshes, what it's printing, its filament when it reports it, what Counterpart printed on it, and the
/// update its MCP needs for what's missing.
struct PrinterDetailView: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    let id: String
    @State private var feed = CameraFeed()
    @State private var copied = false
    @State private var fullScreen = false

    private var printer: PrinterDestination? { store.catalog?.destination(id) }
    private var job: Project? { store.printing(on: id) }

    var body: some View {
        ScrollView {
            if let printer {
                VStack(alignment: .leading, spacing: 22) {
                    hero(printer)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            StatusDot(text: job != nil ? "Printing" : printer.isOffline ? "Offline" : printer.isReady == true ? "Ready" : "Busy",
                                      tint: printer.isOffline ? .secondary : job != nil || printer.isReady == true ? .okGreen : .orange)
                            Spacer()
                            Text([printer.via, printer.capabilities?.server?.version].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(printer.name).font(.largeTitle.bold())
                        Text(printer.modelName).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 20)

                    if let update = printer.capabilities?.update { updateCard(printer, update).padding(.horizontal, 16) }

                    if let job {
                        PanelTitle("Now printing")
                        jobCard(job).padding(.horizontal, 16)
                    }

                    PanelTitle("Filament")
                    filamentCard(printer).padding(.horizontal, 16)

                    let history = store.projects.filter { ($0.print?.destinationId ?? $0.print?.destination?.id) == id && $0.print?.monitor?.endState != nil }
                    if !history.isEmpty {
                        PanelTitle("Printed from Counterpart")
                        VStack(spacing: 0) {
                            ForEach(Array(history.enumerated()), id: \.element.id) { index, project in
                                HistoryRow(project: project)
                                if index < history.count - 1 { Divider().padding(.leading, 70) }
                            }
                        }
                        .padding(.vertical, 6)
                        .background(Color(white: 0.09), in: .rect(cornerRadius: 22))
                        .padding(.horizontal, 16)
                    }

                    Text("\(printer.name) comes from \(printer.via) on \(store.macName ?? "your Mac"). Change its settings there; Counterpart picks them up.")
                        .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20)
                }
                .padding(.bottom, 40)
            } else {
                ContentUnavailableView("This printer is no longer on your Mac", systemImage: "printer")
            }
        }
        .background(Color.black)
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $fullScreen) { CameraFullScreen(feed: feed, printer: printer?.name ?? "Printer") }
        // Keyed on whether the Mac says it has a camera, so the photos start once the printers have loaded.
        .task(id: "\(id)#\(printer?.hasCamera == true)") {
            guard printer?.hasCamera == true else { return }
            await feed.run(app.companion, printer: id, every: 3)
        }
    }

    @ViewBuilder private func hero(_ printer: PrinterDestination) -> some View {
        Group {
            if let image = feed.image {
                FillImage(image: image, height: 330)
                    .overlay(alignment: .bottomTrailing) {
                        Button { fullScreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                            .buttonStyle(.glass).padding(14).accessibilityLabel("Show the camera full screen")
                    }
                    .overlay(alignment: .topLeading) {
                        if let captured = feed.capturedAt {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                HStack(spacing: 6) { Image(systemName: "camera.fill"); Text(Format.updated(captured, now: context.date)).font(.caption.weight(.bold)) }
                                    .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule)
                            }
                            .padding(.top, 110).padding(.leading, 16)
                        }
                    }
            } else {
                StageBackground().frame(height: 300)
                    .overlay {
                        VStack(spacing: 10) {
                            Image(systemName: "video.slash.fill").font(.system(size: 34)).foregroundStyle(.secondary)
                            Text(printer.hasCamera && !feed.unsupported ? (feed.problem ?? "Getting a photo…") : "No camera yet").font(.headline).foregroundStyle(.secondary)
                        }
                        .padding(.top, 60)
                    }
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    /// A missing tool says exactly which update unlocks it (PRD §8.2). The update itself runs on the Mac.
    private func updateCard(_ printer: PrinterDestination, _ update: PrinterDestination.Capabilities.Update) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "arrow.down.app.fill").font(.title2).foregroundStyle(Color.filament).frame(width: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(update.message.hasSuffix(".") ? String(update.message.dropLast()) : update.message).font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text("Version \(printer.capabilities?.server?.version ?? "") on your Mac can start prints but can't report \(missingWords(printer)). Update it from Counterpart on \(store.macName ?? "your Mac"); it runs your own package manager there.")
                        .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let command = update.command?.joined(separator: " ") {
                HStack {
                    Text(command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button { UIPasteboard.general.string = command; copied = true } label: {
                        Text(copied ? "Copied" : "Copy").fontWeight(.semibold).padding(.horizontal, 8)
                    }
                    .buttonStyle(.glassProminent).controlSize(.regular)
                    .accessibilityHint("Copies the update command")
                }
            }
        }
        .padding(16)
        .glassEffect(.regular.tint(Color.filament.opacity(0.12)), in: .rect(cornerRadius: 24))
    }

    private func missingWords(_ printer: PrinterDestination) -> String {
        let names = ["progress": "progress", "camera": "its camera", "layers": "layers", "filaments": "its filament", "pause": "pause", "cancel": "stop"]
        let words = (printer.capabilities?.missing ?? []).compactMap { names[$0] }
        return words.isEmpty ? "everything" : (ListFormatter.localizedString(byJoining: words))
    }

    private func jobCard(_ project: Project) -> some View {
        let live = project.print?.live
        return NavigationLink(value: PrinterLink.printing(project.id)) {
            HStack(spacing: 14) {
                ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 200).frame(width: 64, height: 64).clipShape(.rect(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text(ProjectWords.title(project)).font(.headline); Spacer(); Text(Format.percent(live?.job?.progress) ?? "").font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen) }
                    ProgressView(value: (live?.job?.progress ?? 0) / 100).tint(.okGreen)
                    Text([live?.job?.layer.map { layer in live?.job?.totalLayers.map { "Layer \(layer) of \($0)" } ?? "Layer \(layer)" },
                          Format.duration(live?.job?.remainingSec).map { "\($0) left" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(14)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func filamentCard(_ printer: PrinterDestination) -> some View {
        let spools = store.spools[printer.id] ?? []
        let inUse = job?.print?.live?.activeFilament?.slot
        if printer.capabilities?.filaments == "none" {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "questionmark.circle").font(.title3).foregroundStyle(.secondary)
                Text("\(printer.name) doesn't report its filament. You'll pick what's loaded when you print.")
                    .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        } else if spools.count > 1 {
            HStack(spacing: 0) {
                ForEach(spools.filter { !$0.isExternal }) { spool in
                    VStack(spacing: 6) {
                        SpoolDot(color: spool.color, size: 40, selected: spool.slotLabel == inUse)
                        Text(spool.slotLabel).font(.caption.weight(.semibold))
                        Text("\(spool.material) \(spool.displayName)").font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 16).padding(.horizontal, 8)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            .overlay(alignment: .topTrailing) { if let inUse { Text("\(inUse) in use").font(.caption2.weight(.bold)).foregroundStyle(Color.filament).padding(10) } }
        } else if let loaded = spools.first {
            HStack(spacing: 12) {
                SpoolDot(color: loaded.color, size: 36)
                Text("\(loaded.material) \(loaded.displayName)").font(.body.weight(.medium))
                Spacer()
            }
            .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        } else {
            // The Mac reports a printer's spools for a project's print sheet; there's no printer-only route yet.
            Text("Its filament shows here once you open Print for a project on \(printer.name).")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        }
    }
}

struct PanelTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.title3.weight(.bold)).padding(.horizontal, 20).padding(.bottom, -10).accessibilityAddTraits(.isHeader) }
}

struct StatusDot: View {
    let text: String, tint: Color
    var body: some View {
        HStack(spacing: 6) { Circle().fill(tint).frame(width: 8, height: 8); Text(text).font(.caption.weight(.semibold)).foregroundStyle(tint) }
            .padding(.horizontal, 10).padding(.vertical, 5).glassEffect(.regular, in: .capsule)
    }
}

/// A print Counterpart sent to this printer, and how it ended.
struct HistoryRow: View {
    let project: Project

    var body: some View {
        let monitor = project.print?.monitor
        let ok = monitor?.endState == "done"
        let ended = monitor?.endedAt.flatMap(ISO.date)
        let detail = [ok ? "Done" : monitor?.endState.map { $0.replacingOccurrences(of: "-", with: " ").capitalized }, ended.map { Format.when($0) },
                      Format.duration(project.print?.estimate?.seconds), Format.grams(project.print?.estimate?.grams)].compactMap { $0 }.joined(separator: " · ")
        HStack(spacing: 12) {
            ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 160).frame(width: 44, height: 44).clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(ProjectWords.title(project)).font(.body.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: ok ? "checkmark.circle.fill" : monitor?.endState == "sent" ? "paperplane.fill" : "xmark.circle.fill")
                .foregroundStyle(ok ? Color.okGreen : monitor?.endState == "sent" ? .secondary : .red)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}
