import SwiftUI
import AppKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// The print sheet (PRD §7.3, screens/mac-print.jpg): the same choices as the phone's (§5.5) laid out as a
// sheet. Printer cards, the model's preview, colours, quality and strength, and Print on *printer*. The printer MCP's
// own confirmation is what the person answers. The printer MCP slices and prints; the companion gives the estimate and
// carries the settings.

struct PrintSheet: View {
    /// The project as it was when the sheet opened; `object` reads the current one, so a printer change shows at once.
    let opened: Project
    @ObservedObject var model: ObjectsModel
    @Environment(\.dismiss) private var dismiss
    @State private var filaments: [PrinterFilament] = []
    @State private var filamentState = Loading.loading
    @State private var slot: Int?
    @State private var keptSuggestion = true
    @State private var quality = PrintSettings.Quality.standard
    @State private var strength = PrintSettings.Strength.standard
    @State private var copies = 1
    /// The person changed Copies; until then the printer profile's own count applies.
    @State private var copiesPicked = false
    @State private var checked = false
    @State private var estimate: PrintEstimate?
    @State private var estimateState = Loading.idle
    /// `refused`: Bambu Studio refused this slice (its words); Print is held for it.
    enum Loading: Equatable { case idle, loading, done, failed(String), refused(String) }

    /// The last print's colour, chosen again when its printer and spool are (Print Another, PRD §5.4).
    private let lastColour: PrintSettings.Colour?

    init(opened: Project, model: ObjectsModel) {
        self.opened = opened
        _model = ObservedObject(wrappedValue: model)
        let last = PrintSettings(saved: opened.resolvedPrintDefaults(destinationId: opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId))
        _quality = State(initialValue: last.quality)
        _strength = State(initialValue: last.strength)
        _copies = State(initialValue: last.copies ?? 1)
        _copiesPicked = State(initialValue: last.copies != nil)
        lastColour = last.colour
    }

    private var object: Project { model.objects.first { $0.id == opened.id } ?? opened }
    private var printer: PrinterDestination? { model.printer(for: object) }
    private var settingsServed: Bool { model.capabilities?.printSettings == true }
    private var words: ObjectWords { object.words }
    private var uncertain: Bool { object.print?.uncertain == true }
    private var chosen: PrinterFilament? { filaments.first { $0.slot == slot } }
    /// The current model's file version (a correction rewrites the same file), or the project's when it can't be read.
    private var modelVersion: Double { object.modelURL.map { FileVersion.of($0, else: object.updatedAtMs) } ?? object.updatedAtMs }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Print \(words.title)").font(.title2.bold())
            printers
            HStack(alignment: .top, spacing: 16) {
                if let url = object.modelURL {
                    // The still only: the window's one live stage is the project's own.
                    ModelStage(url: url, version: FileVersion.of(url, else: object.updatedAtMs), yaw: 0.9, pitch: -0.5, interactive: false, fit: 0.2,
                               poster: ProjectDetail.poster(object))
                        .frame(width: 300, height: 220).clipShape(.rect(cornerRadius: 16))
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("Colors").font(.headline)
                    colours
                    Text("Quality").font(.headline)
                    Picker("Quality", selection: $quality) {
                        Text("Draft").tag(PrintSettings.Quality.draft)
                        Text("Standard").tag(PrintSettings.Quality.standard)
                        Text("Fine").tag(PrintSettings.Quality.fine)
                    }
                    .pickerStyle(.segmented).labelsHidden().disabled(!offersQuality)
                    Text("Strength").font(.headline)
                    Picker("Strength", selection: $strength) {
                        Text("Standard").tag(PrintSettings.Strength.standard)
                        Text("Strong").tag(PrintSettings.Strength.strong)
                        Text("Max").tag(PrintSettings.Strength.max)
                    }
                    .pickerStyle(.segmented).labelsHidden().disabled(!offersStrength)
                    if offersCopies {
                        Stepper(value: Binding(get: { copies }, set: { copies = $0; copiesPicked = true }), in: 1...64) {
                            Text(copiesPicked ? "Copies: \(copies)" : "Copies: as the printer profile says").font(.headline)
                        }
                    }
                    if !offersCopies, object.settings?.printDefaults?.copies != nil { Text("This printer uses one copy.").font(.caption).foregroundStyle(.secondary) }
                    estimateLine
                }
            }
            if uncertain {
                Toggle("I checked the printer: it isn’t already printing this.", isOn: $checked)
            }
            // Bambu Studio's own warning on this slice, word for word (KAN-224). Print stays on: the run asks
            // "Print anyway" with the same words before the printer is asked anything.
            if estimateState == .done, let warning = estimate?.slicerWarning, !warning.isEmpty {
                Label { Text(warning).textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                    .font(.callout).foregroundStyle(.orange)
            }
            if let problem = model.problem, problem.id == object.id {
                Label(problem.text, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red)
            }
            HStack {
                Spacer()
                if model.working.contains(object.id) { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }.controlSize(.large).keyboardShortcut(.cancelAction)
                // No keyboard shortcut: Print starts the printer, so it is always a deliberate click.
                Button("Print on \(printer?.name ?? "Printer")") { send() }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .disabled(!canPrint)
            }
        }
        .padding(24)
        .frame(width: 720)
        .tint(.filament)
        .task(id: printer?.id) { await loadFilaments() }
        // The model's version too: a correction rewrites the same current/model.stl, and a refusal of the old one
        // must not hold Print for the new one.
        .task(id: "\(printer?.id ?? "")|\(quality)|\(strength)|\(copiesPicked ? copies : 0)|\(object.current?.model ?? "")|\(modelVersion)") { await loadEstimate() }
    }

    // MARK: Printers

    private var printers: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.printerCatalog?.destinations ?? []) { destination in
                    Button {
                        guard destination.id != printer?.id else { return }
                        Task { await model.selectPrinter(object.id, destinationId: destination.id) }
                    } label: {
                        PrinterCard(printer: destination, selected: destination.id == printer?.id,
                                    spools: destination.id == printer?.id ? filaments : [])
                    }
                    .buttonStyle(.plain)
                    .disabled(model.working.contains(object.id))
                    .accessibilityAddTraits(destination.id == printer?.id ? .isSelected : [])
                }
            }
        }
        .overlay {
            if model.printerCatalog?.destinations.isEmpty ?? true {
                Text(model.missingPrinterText).foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 72)
    }

    // MARK: Colours (v1: one colour, PRD §5.5)

    @ViewBuilder private var colours: some View {
        switch filamentState {
        case .loading:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading the printer’s filament…").foregroundStyle(.secondary) }
        case .failed(let text):
            HStack(spacing: 8) {
                Text(text).foregroundStyle(.secondary)
                Button("Try Again") { Task { await loadFilaments() } }
            }
        default:
            if filaments.isEmpty {
                Text({ if case .material(let material)? = colour { return "Uses \(material), saved in Project Settings. Load it on the printer before printing." }; return "Uses the loaded filament. Change it on the printer if you need to." }()).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 4).fill(Color.secondary.opacity(0.5)).frame(width: 18, height: 18)
                    Text("Model").frame(width: 60, alignment: .leading)
                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                    Menu {
                        ForEach(filaments) { filament in
                            Button { slot = filament.slot; keptSuggestion = filament.suggested == true } label: {
                                Text(Self.name(filament))
                            }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if let chosen { SpoolDot(hex: chosen.colour, size: 18); Text(Self.name(chosen)) } else { Text("Choose a spool") }
                        }
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                }
            }
        }
    }

    static func name(_ filament: PrinterFilament) -> String {
        let place = filament.external ? "External" : "A\(filament.slot + 1)"
        return "\(place) · \(filament.material) \(filament.name)"
    }

    // MARK: Estimate

    private var offersQuality: Bool { settingsServed && (printer?.capabilities?.quality ?? true) }
    private var offersStrength: Bool { settingsServed && (printer?.capabilities?.strength ?? true) }
    /// Copies need the companion (`printCopies`) and this printer's MCP (`capabilities.copies`): copies are per printer.
    private var offersCopies: Bool { model.capabilities?.printCopies == true && printer?.capabilities?.copies == true }

    @ViewBuilder private var estimateLine: some View {
        switch estimateState {
        case .loading:
            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Slicing to estimate…") }.font(.callout).foregroundStyle(.secondary)
        case .failed(let text):
            Text(text).font(.callout).foregroundStyle(.secondary).lineLimit(3)
        case .refused(let words):
            // Studio refused to slice it: its words in place of the estimate, and Print is held for this file.
            Label { Text(words).textSelection(.enabled) } icon: { Image(systemName: "xmark.octagon.fill") }
                .font(.callout).foregroundStyle(.red)
        default:
            if let estimate {
                Text(Self.summary(estimate)).font(.callout.monospacedDigit()).foregroundStyle(.secondary)
            } else if let last = object.print?.estimate, last.seconds != nil || last.grams != nil {
                Text([last.seconds.map { ObjectWords.formatMinutes($0 / 60) }, last.grams.map { "\(Int($0.rounded())) g" }]
                    .compactMap { $0 }.joined(separator: " · ") + " last time").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
            } else if !settingsServed {
                Text("Your printer MCP slices it with its own preset when you print.").font(.callout).foregroundStyle(.secondary)
            }
        }
        if settingsServed, let printer, printer.capabilities?.quality == false || printer.capabilities?.strength == false,
           let update = printer.capabilities?.update {
            Text(update.message).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// "1 h 12 min · 22 g · 0.20 mm · 15% infill".
    static func summary(_ estimate: PrintEstimate) -> String {
        [estimate.seconds.map { ObjectWords.formatMinutes($0 / 60) }, estimate.grams.map { "\(Int($0.rounded())) g" },
         estimate.layerHeightMm.map { String(format: "%.2f mm", $0) }, estimate.infillPercent.map { "\(Int($0.rounded()))% infill" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: Actions

    /// Bambu Studio refused this slice: printing it would fail the same way.
    private var refused: Bool { if case .refused = estimateState { return true } else { return false } }

    private var canPrint: Bool {
        printer != nil && !model.working.contains(object.id) && (!uncertain || checked) && !refused
            && (words.actions.contains(.print) || words.actions.contains(.printChecked))
            && (settingsServed || chosen != nil || (filamentState == .done && filaments.isEmpty))
    }

    private var colour: PrintSettings.Colour? {
        guard let chosen else {
            if case .material? = lastColour, (opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId) == printer?.id { return lastColour }
            return nil
        }
        if keptSuggestion && chosen.suggested == true { return .auto }
        return chosen.external ? .external : .amsSlot(chosen.slot)
    }

    private func send() {
        let settings = PrintSettings(quality: offersQuality ? quality : .standard, strength: offersStrength ? strength : .standard, colour: colour,
                                     copies: offersCopies && copiesPicked ? copies : (object.settings?.printDefaults?.copies != nil ? 1 : nil))
        let filament = chosen
        Task { if await model.print(object.id, checked: uncertain && checked, settings: settings, filament: filament) { dismiss() } }
    }

    private func loadFilaments() async {
        filamentState = .loading; slot = nil
        do {
            let list = try await model.filaments(object.id)
            guard !Task.isCancelled else { return }
            filaments = list
            let suggested = list.first { $0.suggested == true }
            if let last = PrintSettings.lastSlot(lastColour, lastPrinter: opened.settings?.printDefaults != nil ? (opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId) : (opened.print?.destinationId ?? opened.print?.destination?.id), printer: printer?.id, in: list) {
                slot = last
                keptSuggestion = false
            } else {
                slot = suggested?.slot ?? (list.count == 1 ? list[0].slot : nil)
                keptSuggestion = suggested != nil
            }
            filamentState = .done
        } catch {
            guard !Task.isCancelled else { return }
            filaments = []
            filamentState = .failed((error as? ControlRemoteError)?.message.nilIfEmpty ?? "Couldn’t read the printer’s filament.")
        }
    }

    private func loadEstimate() async {
        guard settingsServed, object.modelURL != nil else { estimateState = .idle; return }
        estimateState = .loading
        do {
            let result = try await model.estimate(object.id, destinationId: printer?.id, quality: offersQuality ? quality : .standard,
                                                  strength: offersStrength ? strength : .standard, copies: offersCopies && copiesPicked ? copies : (object.settings?.printDefaults?.copies != nil ? 1 : nil))
            guard !Task.isCancelled else { return }
            estimate = result
            estimateState = .done
        } catch {
            guard !Task.isCancelled else { return }
            estimate = nil
            switch EstimateOutcome(error: error) {
            case .refused(let words): estimateState = .refused(words)
            case .unavailable(let words): estimateState = .failed(words)
            case .estimate: estimateState = .idle
            }
        }
    }
}

/// One printer in the sheet: name, its MCP, ready dot and the spools it reports.
struct PrinterCard: View {
    let printer: PrinterDestination
    let selected: Bool
    var spools: [PrinterFilament] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: printer.mcpName == "bambu-printer-mcp" ? "printer.fill" : "printer")
                Text(printer.name).font(.headline).lineLimit(1)
                Spacer()
                ReadyDot(state: printer.state)
            }
            Text(printer.state == "offline" ? "Offline" : printer.mcpName).font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 3) { ForEach(spools.prefix(4)) { SpoolDot(hex: $0.colour, size: 11) } }.frame(height: 11)
        }
        .padding(12).frame(width: 200, alignment: .leading)
        .contentShape(.rect(cornerRadius: 14))
        .glassEffect(selected ? .regular.tint(Color.filament.opacity(0.3)) : .regular, in: .rect(cornerRadius: 14))
        .opacity(printer.state == "offline" ? 0.5 : 1)
    }
}

/// A spool's colour, as a filled dot with its hub.
struct SpoolDot: View {
    let hex: String
    var size: CGFloat = 30
    var body: some View {
        ZStack {
            Circle().fill(Color(hex: hex))
            Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1)
            Circle().fill(.black.opacity(0.35)).frame(width: size * 0.32)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

extension Color {
    /// "#RRGGBB" or "RRGGBB(AA)", as the printer reports a filament colour; grey when it can't be read.
    init(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).prefix(6)
        guard digits.count == 6, let value = Int(digits, radix: 16) else { self = .gray; return }
        self = Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
