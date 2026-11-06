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
                    Text(store.macCapabilities.contains("printerChoices") ? "Add printers in Counterpart on your Mac. Pick a printer here to change its MCP or connection." : "These come from bambu-printer-mcp and mcp-3D-printer-server on your Mac. Add or change printers there; Counterpart picks them up.")
                }
                Section("Printer software") { MCPCopiesView(store: store) }
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
            // Which pickers this Mac offers (`printerChoices`).
            await store.loadCapabilities()
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
            if spools.count == 1, let loaded = spools.first { return "Ready · \(loaded.spoolName) loaded" }
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
    @Environment(\.scenePhase) private var scenePhase
    let store: ProjectsStore
    /// The printer's id when the page opened; a Printer MCP change can give it another (`moved`).
    let openedAs: String
    @State private var moved: String?
    private var id: String { moved ?? openedAs }
    init(store: ProjectsStore, id: String) { self.store = store; self.openedAs = id }
    @State private var feed = CameraFeed()
    @State private var copied = false
    @State private var fullScreen = false

    private var printer: PrinterDestination? { store.catalog?.destination(id) }
    private var job: Project? { store.printing(on: id) }

    var body: some View {
        ScrollViewReader { scroll in
        ScrollView {
            if let printer {
                VStack(alignment: .leading, spacing: 22) {
                    hero(printer)
                    MCPCopiesView(store: store, printerId: printer.id)
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

                    // Settings → Printers on the Mac, here: which MCP and which connection. Hidden on a Mac without them.
                    if store.macCapabilities.contains("printerChoices") {
                        PrinterConnectionCard(store: store, printer: printer, printing: job != nil) { moved = $0 }.id("connection")
                    }

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

                    Text(store.macCapabilities.contains("printerChoices")
                         ? "\(printer.name) comes from \(printer.via) on \(store.macName ?? "your Mac"). Its other settings stay in that MCP’s own files."
                         : "\(printer.name) comes from \(printer.via) on \(store.macName ?? "your Mac"). Change its settings there; Counterpart picks them up.")
                        .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20)
                }
                .padding(.bottom, 40)
            } else {
                ContentUnavailableView("This printer is no longer on your Mac", systemImage: "printer")
            }
        }
        #if DEBUG
        .task(id: store.macCapabilities.contains("printerChoices")) {
            guard app.debugSection == "connection", store.macCapabilities.contains("printerChoices") else { return }
            try? await Task.sleep(for: .seconds(2)); withAnimation { scroll.scrollTo("connection", anchor: .top) }
        }
        #endif
        }
        .background(Color.black)
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented: $fullScreen) { CameraFullScreen(feed: feed, printer: printer?.name ?? "Printer") }
        // Keyed on whether the Mac says it has a camera, so the photos start once the printers have loaded.
        .task(id: "\(id)#\(printer?.hasCamera == true)#\(scenePhase)#\(fullScreen)") {
            guard scenePhase == .active, printer?.hasCamera == true else { return }
            await feed.run(app.companion, printer: id, every: fullScreen ? 3 : 10)
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
        // The progress report names the spool in use by its slot index ("1") or its label ("A1"); show it by the MCP's own label.
        let inUse = job?.print?.live?.activeFilament?.slot
        let inUseSpool = spools.first { inUse == String($0.slot) || (inUse != nil && inUse == $0.label) }
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
                        SpoolDot(color: spool.color, size: 40, selected: spool.slot == inUseSpool?.slot)
                        Text(spool.slotLabel).font(.caption.weight(.semibold))
                        Text(spool.spoolName).font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 16).padding(.horizontal, 8)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            .overlay(alignment: .topTrailing) { if let inUseSpool { Text("\(inUseSpool.slotLabel) in use").font(.caption2.weight(.bold)).foregroundStyle(Color.filament).padding(10) } }
        } else if let loaded = spools.first {
            HStack(spacing: 12) {
                SpoolDot(color: loaded.color, size: 36)
                Text(loaded.spoolName).font(.body.weight(.medium))
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

/// Which printer MCP a printer uses (when both reach it) and how that MCP reaches the printer, as in the Mac's
/// Settings → Printers: two panels on the printer's page. The MCP keeps the connection in its own settings and
/// words each choice; Counterpart only shows and changes it. The Mac refuses either change while the printer prints.
struct PrinterConnectionCard: View {
    let store: ProjectsStore
    let printer: PrinterDestination
    /// A Counterpart project is printing on it (the Mac also refuses a change for any other print, in its own words).
    let printing: Bool
    /// The printer's id after a Printer MCP change.
    let moved: (String) -> Void
    @State private var connection: PrinterConnection?
    @State private var loaded = false
    @State private var saving: String?
    /// A refusal, and which card it belongs to (`mcp` or `route`).
    @State private var problem: (kind: String, text: String)?

    var body: some View {
        // Something is always on screen before the first answer, so `.task` runs (Mac fix 0cdb625).
        VStack(alignment: .leading, spacing: 22) {
            if printer.offersMcpChoice, let mcps = printer.mcps {
                PanelTitle("Printer MCP")
                card("mcp", footnote: "Prints go through \(printer.via). This printer is set up in both MCPs.") {
                    rows(mcps.map { mcp in
                        Row(key: "mcp:" + mcp.backend, title: mcp.name, reason: nil, chosen: mcp.backend == printer.backend, available: true)
                    }) { key in await chooseMcp(String(key.dropFirst(4))) }
                }
            }
            if let connection {
                PanelTitle("Connection")
                card("route", footnote: connection.current?.controls ?? "Prints, Stop, Pause and Resume go this way.") {
                    rows(connection.shown.map { option in
                        Row(key: "route:" + option.id, title: option.label, reason: option.available ? nil : option.reason,
                            chosen: option.id == connection.route, available: option.available)
                    }) { key in await choose(String(key.dropFirst(6))) }
                }
            } else if let problem, problem.kind == "route" {
                // The Mac didn't answer: say so, and offer to ask again (an MCP without the choice shows nothing).
                PanelTitle("Connection")
                VStack(alignment: .leading, spacing: 12) {
                    Label(problem.text, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try Again") { Task { loaded = false; self.problem = nil; await load() } }.buttonStyle(.glass)
                }
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 24)).padding(.horizontal, 16)
            } else if !loaded {
                PanelTitle("Connection")
                HStack(spacing: 10) { ProgressView(); Text("Reading \(printer.via)’s connection…").font(.subheadline).foregroundStyle(.secondary) }
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24)).padding(.horizontal, 16)
            }
        }
        .task(id: printer.id) { await load() }
    }

    private struct Row: Identifiable { let key: String, title: String, reason: String?, chosen: Bool, available: Bool; var id: String { key } }

    /// One glass card of rows, with what to know under it as a Settings group footer: why it can't change now,
    /// a refusal, or the MCP's own words about the choice.
    private func card(_ kind: String, footnote: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 24))
            Group {
                if let problem, problem.kind == kind {
                    Label(problem.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
                } else if printing {
                    Label("Change this when the print finishes.", systemImage: "printer.fill").foregroundStyle(.orange)
                } else {
                    Text(footnote).foregroundStyle(.secondary)
                }
            }
            .font(.footnote).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 16)
        }
        .padding(.horizontal, 16)
    }

    @ViewBuilder private func rows(_ rows: [Row], choose: @escaping (String) async -> Void) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
            if index > 0 { Divider().padding(.leading, 16) }
            if row.available {
                Button { Task { await choose(row.key) } } label: { label(row) }
                    .buttonStyle(.plain)
                    .disabled(saving != nil || printing)
                    .accessibilityAddTraits(row.chosen ? .isSelected : [])
            } else {
                // Not a disabled button: its reason is what to do, so it stays readable.
                label(row).accessibilityElement(children: .combine).accessibilityHint("Not available")
            }
        }
    }

    private func label(_ row: Row) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).font(.body).foregroundStyle(row.available && !printing ? .primary : .secondary)
                if let reason = row.reason { Text(reason).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            if saving == row.key { ProgressView() }
            else if row.chosen { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.filament) }
        }
        .padding(.horizontal, 16).frame(minHeight: 48).padding(.vertical, 2)
        .contentShape(.rect)
    }

    private func load() async {
        do { connection = try await store.mac.client.printerConnection(printer.id); problem = nil }
        catch let failure as CompanionError { connection = nil; if !failure.isUnsupported { problem = ("route", failure.message) } }
        catch { connection = nil; problem = ("route", CompanionError.unreachable.message) }
        loaded = true
    }

    private func choose(_ route: String) async {
        guard saving == nil, route != connection?.route else { return }
        saving = "route:" + route; problem = nil
        defer { saving = nil }
        do { connection = try await store.mac.client.setPrinterConnection(printer.id, route: route) }
        catch let failure as CompanionError { problem = ("route", failure.message) }
        catch { problem = ("route", CompanionError.unreachable.message) }
    }

    private func chooseMcp(_ backend: String) async {
        guard saving == nil, backend != printer.backend else { return }
        saving = "mcp:" + backend; problem = nil
        defer { saving = nil }
        do {
            let id = try await store.mac.client.choosePrinterMcp(printer.id, backend: backend)
            await store.loadPrinters()
            moved(id)
            // Another MCP has its own connections.
            loaded = false; connection = nil
            await load()
        } catch let failure as CompanionError { problem = ("mcp", failure.message) }
        catch { problem = ("mcp", CompanionError.unreachable.message) }
    }
}
