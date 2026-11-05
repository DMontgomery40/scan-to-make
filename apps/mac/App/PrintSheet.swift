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
    /// A multi-part model: its filaments, the loaded spools, and the spool chosen for each (filament index → slot).
    @State private var mapping: ColourMapping?
    @State private var mappingSlots: [Int: Int] = [:]
    @State private var mappingState = Loading.idle
    @State private var quality = PrintSettings.Quality.standard
    @State private var strength = PrintSettings.Strength.standard
    /// The person chose Quality / Strength in this sheet; until then each starts at a designer's file's own settings.
    @State private var qualityPicked = false
    @State private var strengthPicked = false
    @State private var copies = 1
    /// The person changed Copies; until then the printer profile's own count applies.
    @State private var copiesPicked = false
    @State private var checked = false
    /// "Pause before layer" rows (the slicer's Add pause), e.g. to drop in magnets. Empty: no pause.
    @State private var pauses: [Int] = []
    @State private var estimate: PrintEstimate?
    @State private var estimateState = Loading.idle
    /// `refused`: Bambu Studio refused this slice (its words); Print is held for it.
    enum Loading: Equatable { case idle, loading, done, failed(String), refused(String) }

    /// The last print's colour, chosen again when its printer and spool are (Print Another, PRD §5.4).
    private let lastColour: PrintSettings.Colour?

    init(opened: Project, model: ObjectsModel) {
        self.opened = opened
        _model = ObservedObject(wrappedValue: model)
        let last = PrintSettings(saved: opened.printSheetStart(destinationId: opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId))
        _quality = State(initialValue: last.quality)
        _strength = State(initialValue: last.strength)
        _copies = State(initialValue: last.copies ?? 1)
        _copiesPicked = State(initialValue: last.copies != nil)
        // Print Another keeps the last print's pauses (the magnets go in at the same layers); saved defaults have none.
        _pauses = State(initialValue: opened.print?.settings?.pauseBeforeLayers ?? [])
        lastColour = last.colour
    }

    private var object: Project { model.objects.first { $0.id == opened.id } ?? opened }
    private var published: Bool { object.preservesPublishedFilaments }
    private var slicedOriginal: Bool { object.publishedSelection?.sliced == true }
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
            if let plate = object.selectedPlate, (object.plates?.count ?? 0) > 1 {
                Label(plate.name, systemImage: "square.stack.3d.up").font(.headline)
            }
            printers
            HStack(alignment: .top, spacing: 16) {
                // What will print (Nov 5): the printer MCP's pictures of the exact sliced file Print sends, never a
                // design render or a thumbnail the file carried along.
                whatWillPrint.frame(width: 300)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Colors").font(.headline)
                    if published { multiColours } else { colours }
                    if slicedOriginal { Text("Uses the quality, strength and copies saved in this sliced file. Share an editable 3MF to change them.").font(.callout) } else {
                    Text("Quality").font(.headline)
                    Picker("Quality", selection: Binding(get: { quality }, set: { quality = $0; qualityPicked = true })) {
                        Text("Draft").tag(PrintSettings.Quality.draft)
                        Text("Standard").tag(PrintSettings.Quality.standard)
                        Text("Fine").tag(PrintSettings.Quality.fine)
                    }
                    .pickerStyle(.segmented).labelsHidden().disabled(!offersQuality)
                    Text("Strength").font(.headline)
                    Picker("Strength", selection: Binding(get: { strength }, set: { strength = $0; strengthPicked = true })) {
                        Text("Standard").tag(PrintSettings.Strength.standard)
                        Text("Strong").tag(PrintSettings.Strength.strong)
                        Text("Max").tag(PrintSettings.Strength.max)
                    }
                    .pickerStyle(.segmented).labelsHidden().disabled(!offersStrength)
                    if let words = object.designerSettingsWords(quality: quality.rawValue, strength: strength.rawValue) {
                        Text(words).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if estimateState == .done, let update = estimate?.ownSettingsUpdate {
                        Text(update).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if offersCopies { copiesRow }
                    if !offersCopies, object.settings?.printDefaults?.copies != nil { Text("This printer uses one copy.").font(.caption).foregroundStyle(.secondary) }
                    }
                    if offersPauses { pauseRows }
                    estimateLine
                }
            }
            if uncertain {
                // Why Print waits (Nov 2–3 review: the toggle blocked Print and nothing said why).
                Label { Text(object.uncertainPrintWords).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                    .font(.callout).foregroundStyle(.orange)
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
        .task(id: "\(printer?.id ?? "")|\(object.current?.model ?? "")|\(modelVersion)") { await loadFilaments() }
        // The MCP's answer can arrive while the sheet is open: a designer's file then starts at its own settings.
        .onChange(of: object.printsWithOwnSettings) { _, own in
            if own && !qualityPicked { quality = .standard }
            if own && !strengthPicked { strength = .standard }
        }
        // The model's version too: a correction rewrites the same current/model.stl, and a refusal of the old one
        // must not hold Print for the new one. The chosen spools too: they change what the estimate slices.
        .task(id: "\(printer?.id ?? "")|\(quality)|\(strength)|\(copiesPicked ? copies : 0)|\(object.current?.model ?? "")|\(object.selectedPlate?.id ?? "")|\(modelVersion)|\(mappingSignature)|\(String(describing: colour))|\(offersPauses ? Array(Set(pauses)).sorted() : [])") { await loadEstimate() }
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
                            Button { slot = filament.slot } label: {
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

    /// "A2 · Sunflower Yellow PLA Basic", in the printer MCP's words.
    static func name(_ filament: PrinterFilament) -> String { filament.title }

    // MARK: Pauses

    /// The slicer's "Add pause" through the printer's MCP (`pause_at_layers`): the printer stops by itself before the layer.
    private var offersPauses: Bool { !slicedOriginal && printer?.capabilities?.layerPauses == true }
    /// The slice's layer count once the estimate has it.
    private var layerCount: Int? { estimate?.layers.flatMap { $0 > 1 ? $0 : nil } }

    private static let maxPauses = 16

    @ViewBuilder private var pauseRows: some View {
        Text("Pause").font(.headline)
        ForEach(pauses.indices, id: \.self) { index in
            HStack {
                Stepper(value: Binding(get: { pauses[index] }, set: { pauses[index] = $0 }), in: 2...(layerCount ?? 100_000)) {
                    Text(layerCount.map { "Before layer \(pauses[index]) of \($0)" } ?? "Before layer \(pauses[index])").monospacedDigit()
                }
                Button { pauses.remove(at: index) } label: { Image(systemName: "minus.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Remove this pause")
            }
        }
        // Print takes at most 16 pauses (PrintSettingsSchema.pauseBeforeLayers).
        if pauses.count < Self.maxPauses {
            Button(pauses.isEmpty ? "Add a Pause…" : "Add Another Pause") {
                let next = (pauses.max() ?? 1) + 1
                pauses.append(min(next, layerCount ?? next))
            }
            .accessibilityIdentifier("add-pause")
        }
        if !pauses.isEmpty {
            Text("The printer stops before each of these layers and waits, so you can drop in magnets or nuts. Press Resume on the printer when they’re in. Layers count as in Bambu Studio’s and OrcaSlicer’s preview.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        if let count = layerCount, pauses.contains(where: { $0 > count }) {
            Text("This print has \(count) layers.").font(.caption).foregroundStyle(.red)
        }
    }

    // MARK: Colours (multi-part: one spool per part colour)

    /// The spool currently chosen for one of the model's filaments.
    private func chosenTray(_ filament: ModelColourFilament) -> PrinterFilament? {
        mapping?.trays.first { $0.slot == mappingSlots[filament.index] }
    }

    /// The mapping choices as a task key, so editing a spool re-slices the estimate with it.
    private var mappingSignature: String { mappingSlots.keys.sorted().map { "\($0):\(mappingSlots[$0] ?? -1)" }.joined(separator: ",") }

    /// The chosen spools come from more than one of the MCP's feeds (it refuses the mix).
    private var mixedFeedSources: Bool { mapping?.mixesFeeds(slots: mappingSlots) ?? false }

    /// The chosen spools in filament order, when every colour has one: what Print sends.
    private var chosenSpoolPerColour: [PrinterFilament]? { mapping?.spools(slots: mappingSlots) }

    @ViewBuilder private var multiColours: some View {
        switch mappingState {
        case .loading:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading the printer’s filament…").foregroundStyle(.secondary) }
        case .failed(let text):
            HStack(spacing: 8) {
                Text(text).foregroundStyle(.secondary)
                Button("Try Again") { Task { await loadFilaments() } }
            }
        default:
            if let mapping, !mapping.filaments.isEmpty {
                ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(mapping.filaments) { filament in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 10) {
                                SpoolDot(hex: filament.colour ?? "#808080", size: 18)
                                Text(filament.name ?? "Part \(filament.index)").frame(minWidth: 60, alignment: .leading).lineLimit(1)
                                Image(systemName: "arrow.right").foregroundStyle(.secondary)
                                if let tray = chosenTray(filament) { SpoolDot(hex: tray.colour, size: 18) }
                                Menu {
                                    ForEach(mapping.trays) { tray in
                                        Button { mappingSlots[filament.index] = tray.slot } label: {
                                            Text(mappingSlots[filament.index] == tray.slot ? "✓ \(Self.name(tray))" : Self.name(tray))
                                        }
                                        // Mixed AMS/external choices stay selectable (else no row could be the
                                        // first to switch source); the note below and Print say what's wrong.
                                        .disabled(slicedOriginal && filament.material != nil && tray.material.caseInsensitiveCompare(filament.material!) != .orderedSame)
                                    }
                                } label: {
                                    Text(chosenTray(filament).map(Self.name) ?? "Choose a spool")
                                }
                                .menuStyle(.borderlessButton).fixedSize()
                                .disabled(mapping.trays.isEmpty)
                            }
                            if let note = mappingNote(filament) {
                                Text(note).font(.caption).foregroundStyle(.secondary).padding(.leading, 28)
                            }
                        }
                    }
                    if mapping.trays.isEmpty {
                        Text("No filament is loaded. Load a spool, then reopen this sheet.").foregroundStyle(.secondary)
                    }
                    if mixedFeedSources {
                        Text("One print feeds from one source: put every colour on AMS spools, or every colour on the external spool.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                }
                .frame(maxHeight: 176)
            } else {
                Text("Keeps the model’s filament assignments. The printer service confirms the loaded spools.").font(.callout)
            }
        }
    }

    /// What the person should know about this row's match, in their words.
    private func mappingNote(_ filament: ModelColourFilament) -> String? {
        if filament.colour == nil { return "The model doesn’t say this part’s colour — pick its spool." }
        guard let tray = chosenTray(filament) else { return nil }
        if let other = mapping?.filaments.first(where: { $0.index != filament.index && mappingSlots[$0.index] == tray.slot
                && $0.colour != nil && $0.colour?.caseInsensitiveCompare(filament.colour ?? "") != .orderedSame }) {
            return "Shares this spool with \(other.name ?? "Part \(other.index)") — both parts print this colour."
        }
        // The printer MCP's own words while its proposal stands; the person's other choice in another material, said plainly.
        if let note = mapping?.note(filament, slots: mappingSlots) { return note }
        if let material = filament.material, tray.material.caseInsensitiveCompare(material) != .orderedSame {
            return "Prints in \(tray.material), not \(material)."
        }
        return nil
    }

    // MARK: Estimate

    private var offersQuality: Bool { !slicedOriginal && settingsServed && (printer?.capabilities?.quality ?? true) }
    private var offersStrength: Bool { !slicedOriginal && settingsServed && (printer?.capabilities?.strength ?? true) }
    /// Copies need the companion (`printCopies`) and this printer's MCP (`capabilities.copies`): copies are per printer.
    private var offersCopies: Bool { !slicedOriginal && model.capabilities?.printCopies == true && printer?.capabilities?.copies == true }

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
                Text([last.seconds.map { ObjectWords.formatMinutes($0 / 60) }, Format.grams(last.grams)]
                    .compactMap { $0 }.joined(separator: " · ") + " last time").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
            } else if !settingsServed {
                Text("Uses your printer’s saved settings when you print.").font(.callout).foregroundStyle(.secondary)
            }
        }
        if settingsServed, let printer, printer.capabilities?.quality == false || printer.capabilities?.strength == false,
           let update = printer.capabilities?.update {
            Text(update.message).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Copies: the printer profile's count until the person chooses one, then a stepper that reads what it sends.
    @ViewBuilder private var copiesRow: some View {
        if copiesPicked {
            HStack {
                Stepper(value: $copies, in: 1...64) { Text("Copies: \(copies)").font(.headline) }
                    .accessibilityValue("\(copies)")
                Button("Use the profile’s count") { copiesPicked = false; copies = 1 }.buttonStyle(.link)
            }
        } else {
            HStack {
                Text("Copies: as the printer profile says").font(.headline)
                Button("Choose") { copies = 1; copiesPicked = true }.buttonStyle(.link)
            }
        }
    }

    /// "1 h 12 min · 22 g · 0.20 mm · 15% infill".
    static func summary(_ estimate: PrintEstimate) -> String {
        [estimate.seconds.map { ObjectWords.formatMinutes($0 / 60) }, Format.grams(estimate.grams),
         estimate.layerHeightMm.map { String(format: "%.2f mm", $0) }, estimate.infillPercent.map { "\(Int($0.rounded()))% infill" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// The two pictures of the sliced file, labelled; while it slices, or when the MCP can't draw them, the reason.
    @ViewBuilder private var whatWillPrint: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What will print").font(.headline)
            if estimateState == .done, let preview = estimate?.preview, estimate?.sliceSha256 == preview.sha256 {
                ForEach(preview.views) { view in
                    VStack(alignment: .leading, spacing: 4) {
                        if let data = view.pngData, let image = NSImage(data: data) {
                            Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                                .frame(maxWidth: .infinity, maxHeight: 200).background(.white, in: .rect(cornerRadius: 12))
                                .accessibilityLabel(view.label)
                        }
                        Text(view.label).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("Drawn from the sliced file this button sends.").font(.caption2).foregroundStyle(.tertiary)
            } else if estimateState == .loading {
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Slicing it to show you…") }.font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else if estimateState == .done {
                Text("Update \(printer?.mcpName ?? "your printer service") in Settings → Printers so Counterpart can show you what will print.")
                    .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            } else {
                Text("Nothing to show yet.").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            }
        }
    }

    /// The sliced file shown above, when its pictures are of it: the only file Print may send.
    private var shownSlice: String? {
        guard estimateState == .done, let estimate, let sha = estimate.sliceSha256, estimate.preview?.sha256 == sha else { return nil }
        return sha
    }

    // MARK: Actions

    /// Bambu Studio refused this slice: printing it would fail the same way.
    private var refused: Bool { if case .refused = estimateState { return true } else { return false } }

    /// A multi-part model whose colours are known prints only once every colour has a spool.
    /// While the mapping loads Print waits; when it can't be read, the companion's own matching applies.
    private var mappingReady: Bool {
        guard published else { return true }
        if mappingState == .loading { return false }
        guard let mapping, !mapping.filaments.isEmpty else { return true }
        return chosenSpoolPerColour != nil && !mixedFeedSources
    }

    private var canPrint: Bool {
        printer != nil && shownSlice != nil && !model.working.contains(object.id) && (!uncertain || checked) && !refused && mappingReady
            && (words.actions.contains(.print) || words.actions.contains(.printChecked))
            && (settingsServed || chosen != nil || (filamentState == .done && filaments.isEmpty))
            && !(offersPauses && (layerCount.map { count in pauses.contains { $0 > count } } ?? false))
    }

    private var colour: PrintSettings.Colour? {
        if published { return nil }
        guard let chosen else {
            if case .material? = lastColour, (opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId) == printer?.id { return lastColour }
            return nil
        }
        return chosen.external ? .external : .amsSlot(chosen.slot)
    }

    private func send() {
        let settings = PrintSettings(quality: offersQuality ? quality : .standard, strength: offersStrength ? strength : .standard, colour: colour,
                                     copies: slicedOriginal ? 1 : offersCopies && copiesPicked ? copies : (object.settings?.printDefaults?.copies != nil ? 1 : nil),
                                     pauseBeforeLayers: offersPauses ? Array(Set(pauses)).sorted() : [], sliceSha256: shownSlice)
        if published, let spools = chosenSpoolPerColour {
            Task { if await model.print(object.id, checked: uncertain && checked, settings: settings, filaments: spools, modelVersion: mapping?.modelVersion, expectedPlate: object.selectedPlate?.id) { dismiss() } }
            return
        }
        let filament = published ? nil : chosen
        Task { if await model.print(object.id, checked: uncertain && checked, settings: settings, filament: filament, expectedPlate: object.selectedPlate?.id) { dismiss() } }
    }

    private func loadFilaments() async {
        filamentState = .loading; slot = nil
        if published { mappingState = .loading; mapping = nil; mappingSlots = [:] }
        do {
            let list = try await model.filaments(object.id)
            guard !Task.isCancelled else { return }
            filaments = list
            let suggested = list.first { $0.suggested == true }
            if let last = PrintSettings.lastSlot(lastColour, lastPrinter: opened.settings?.printDefaults != nil ? (opened.printerDestinationId ?? model.printerCatalog?.defaultDestinationId) : (opened.print?.destinationId ?? opened.print?.destination?.id), printer: printer?.id, in: list) {
                slot = last
            } else {
                slot = suggested?.slot ?? (list.count == 1 ? list[0].slot : nil)
            }
            filamentState = .done
            if published { await loadMapping() }
        } catch {
            guard !Task.isCancelled else { return }
            filaments = []
            filamentState = .failed((error as? ControlRemoteError)?.message.nilIfEmpty ?? "Couldn’t read the printer’s filament.")
            if published { mappingState = filamentState }
        }
    }

    /// The spool per colour for a multi-part model; the suggestions arrive chosen.
    private func loadMapping() async {
        do {
            let loaded = try await model.colourMapping(object.id)
            guard !Task.isCancelled else { return }
            mapping = loaded
            if !loaded.trays.isEmpty { filaments = loaded.trays }
            mappingSlots = loaded.suggestedSlots
            mappingState = .done
        } catch {
            guard !Task.isCancelled else { return }
            mapping = nil
            mappingState = .failed((error as? ControlRemoteError)?.message.nilIfEmpty ?? "Couldn’t match this model’s colours to the loaded spools.")
        }
    }

    private func loadEstimate() async {
        guard settingsServed, object.modelURL != nil else { estimateState = .idle; return }
        estimateState = .loading
        do {
            let result = try await model.estimate(object.id, destinationId: printer?.id, quality: offersQuality ? quality : .standard,
                                                  strength: offersStrength ? strength : .standard, copies: slicedOriginal ? 1 : offersCopies && copiesPicked ? copies : (object.settings?.printDefaults?.copies != nil ? 1 : nil),
                                                  filaments: published ? chosenSpoolPerColour ?? [] : [], modelVersion: mapping?.modelVersion,
                                                  colour: colour, pauseBeforeLayers: offersPauses ? Array(Set(pauses)).sorted() : [])
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
