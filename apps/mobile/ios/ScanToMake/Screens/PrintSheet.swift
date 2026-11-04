import SwiftUI
import CounterpartKit

/// The print sheet (PRD §5.5, screens/phone-print-one.jpg, phone-print-noams.jpg, phone-print-loaded.jpg): pick
/// the printer, see the model and its sliced estimate, choose the filament the printer reports (or the material,
/// when it doesn't say), quality and strength when its MCP takes them, then Print. The printer's own
/// confirmation follows on the project page.
///
/// Guards: one load or print at a time (`busy`); a printer change cancels the estimate in flight
/// (`estimateTask`) and a stale estimate never lands (`estimateKey`). Print is single flight.
struct PrintSheet: View {
    let store: ProjectsStore
    let projectId: String
    @Environment(\.dismiss) private var dismiss
    @State private var destinationId = ""
    @State private var filaments: [PrinterFilament] = []
    @State private var spool: Int?
    @State private var quality = PrintQuality.standard
    @State private var strength = PrintStrength.standard
    /// How many on the plate, where `offersCopies`; nil until you choose (the printer profile's count).
    @State private var copies: Int?
    /// "Before layer N" pauses (the slicer's Add pause, for magnets or nuts), where `offersPauses`. Empty: none.
    @State private var pauseRows: [PauseRow] = []
    /// The layers, in order. Setting them keeps each remaining row's identity, so SwiftUI animates the right one.
    private var pauses: [Int] {
        get { pauseRows.map(\.layer) }
        nonmutating set { pauseRows = newValue.enumerated().map { PauseRow(id: $0.offset < pauseRows.count ? pauseRows[$0.offset].id : UUID(), layer: $0.element) } }
    }
    /// The pause whose layer is being typed, and what's typed.
    @State private var editingPause: Int?
    @State private var typedLayer = ""
    @State private var slice = EstimateState()
    @State private var shownPrinter: String?
    @Environment(\.horizontalSizeClass) private var widthClass
    private var wide: Bool { widthClass == .regular }
    @State private var checked = false
    @State private var busy: String?
    @State private var problem: String?
    @State private var modelURL: URL?
    /// What each printer last reported, so its card keeps its spools after you move on.
    @State private var spools: [String: [PrinterFilament]] = [:]
    /// A multi-part model: its filaments, the loaded spools, and the spool chosen for each (filament index → slot).
    @State private var mapping: ColourMapping?
    @State private var mappingSlots: [Int: Int] = [:]
    @State private var mappingState: MappingState = .loading
    private enum MappingState: Equatable { case loading, done, failed(String) }

    private var project: Project? { store.project(projectId) }
    private var published: Bool { project?.preservesPublishedFilaments == true }
    private var slicedOriginal: Bool { project?.publishedSelection?.sliced == true }
    private var title: String { project.map { ProjectWords.title($0) } ?? "Model" }
    private var destinations: [PrinterDestination] { store.catalog?.destinations ?? [] }
    private var printer: PrinterDestination? { destinations.first { $0.id == destinationId } }
    /// What the printer's MCP says about its filament: ams, single or none.
    private var filamentKind: String {
        if let reported = printer?.capabilities?.filaments { return reported }
        return filaments.count > 1 ? "ams" : filaments.isEmpty ? "none" : "single"
    }
    private var chosen: PrinterFilament? { filaments.first { $0.slot == spool } }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let plate = project?.selectedPlate, (project?.plates?.count ?? 0) > 1 {
                            Label(plate.name, systemImage: "square.stack.3d.up").font(.headline)
                        }
                        printers
                        preview
                        if case .failed(let message) = slice.shown(for: estimateKey, fallback: project?.print?.estimate) {
                            Label(message, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Group { if published { multiColours } else { colourSection } }
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .glassEffect(.regular, in: .rect(cornerRadius: 24))
                        if slicedOriginal { Text("Uses the quality, strength and copies already saved in this sliced file. Share an editable 3MF to change them.").font(.footnote).foregroundStyle(.secondary) } else { settingsSection.id("settings") }
                        if offersPauses { pauseSection.id("pauses") }
                        if !offersCopies, project?.settings?.printDefaults?.copies != nil {
                            Text("This printer uses one copy.").font(.caption).foregroundStyle(.secondary)
                        }
                        if uncertain { uncertainCard }
                        if let problem {
                            Label(problem, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                // The bar belongs to this scroll view: its content insets above it and fades under it.
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                // The last card keeps the same gap above the Print button as the cards keep between them.
                .contentMargins(.bottom, 16, for: .scrollContent)
                .safeAreaBar(edge: .bottom) { printButton }
                #if DEBUG
                .onChange(of: pauses.count) { old, new in if old == 0 && new > 1 { withAnimation { scroll.scrollTo("pauses", anchor: .bottom) } } }
                #endif
                .navigationTitle("Print \(title)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.disabled(busy == "print") }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { withAnimation { scroll.scrollTo("settings", anchor: .top) } } label: { Image(systemName: "slider.horizontal.3") }
                            .accessibilityLabel("Quality and strength")
                    }
                }
            }

        }
        .presentationDetents([.large])
        .task {
            await start()
            #if DEBUG
            if !Fixtures.pauses.isEmpty { pauses = Fixtures.pauses; Fixtures.pauses = [] }
            #endif
        }
        .task(id: estimateKey) { await refreshEstimate() }
        // The spool rows belong to this printer, plate and model version; any of them changing reloads them,
        // so a mapping made for another printer, plate or model is never reused.
        .task(id: mappingLoadKey) { await loadMapping() }
    }

    // MARK: Sections

    private var printers: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(destinations) { destination in
                    Button { Task { await choose(destination.id) } } label: {
                        PrinterChoice(printer: destination, selected: destination.id == destinationId, spools: spools[destination.id] ?? [])
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil || destination.isOffline)
                    .accessibilityAddTraits(destination.id == destinationId ? .isSelected : [])
                    // Two whole cards across a phone (three on a wide screen): none is ever cut off at an edge.
                    .containerRelativeFrame(.horizontal, count: wide ? 3 : 2, spacing: 10)
                    .id(destination.id)
                }
                if destinations.isEmpty {
                    Text(store.printerProblem ?? "Reading your Mac's printers…").font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 30)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .contentMargins(.horizontal, 16, for: .scrollContent)
        .scrollPosition(id: $shownPrinter, anchor: .leading)
        .padding(.horizontal, -20)
        // The chosen printer is in view, snapped whole to the leading edge.
        .onChange(of: destinationId, initial: true) { _, id in if !id.isEmpty { withAnimation { shownPrinter = id } } }
    }

    private var preview: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
            if published, let project {
                ProjectImage(project: project, path: project.thumbnailPath, maxPixelSize: 600, contentMode: .fit)
            } else {
            ModelStage(url: modelURL, yaw: 0.9, pitch: -0.5, interactive: false, tint: UIColor(spoolColour))
            }
            }
                .frame(height: 220)
                .overlay(alignment: .bottom) { BedGrid().frame(height: 70).opacity(0.5).allowsHitTesting(false) }
                .clipShape(.rect(cornerRadius: 24))
            HStack(spacing: 8) {
                switch slice.shown(for: estimateKey, fallback: project?.print?.estimate) {
                case .pending: Metric(symbol: "clock", text: "Slicing…")
                case .failed: Metric(symbol: "exclamationmark.triangle", text: "Couldn't slice")
                case .ready(let seconds, let grams, let layers):
                    if let time = Format.duration(seconds) { Metric(symbol: "clock", text: time) }
                    if let grams = Format.grams(grams) { Metric(symbol: "scalemass", text: grams) }
                    if let layers { Metric(symbol: "square.stack.3d.up", text: "\(layers) layers") }
                }
            }
            .padding(12)
        }
        .accessibilityElement(children: .combine)
    }

    /// The model's preview takes the chosen spool's colour; light grey when the printer doesn't say.
    private var spoolColour: Color { chosen?.color ?? Color(white: 0.72) }

    @ViewBuilder private var colourSection: some View {
        let name = printer?.name ?? "the printer"
        switch filamentKind {
        case "ams" where !filaments.isEmpty:
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Color").font(.headline); Spacer(); Text("AMS · \(filaments.filter { !$0.isExternal }.count) slots").font(.caption).foregroundStyle(.secondary) }
                if let chosen {
                    HStack(spacing: 12) {
                        SpoolDot(color: chosen.color, size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(chosen.slotLabel) · \(chosen.material) \(chosen.displayName)").font(.body.weight(.medium))
                            Text([Format.grams(estimate?.grams), chosen.suggested == true ? "suggested by your Mac" : nil].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
                SpoolPickerRow(filaments: filaments, selected: $spool).disabled(busy != nil)
            }
        case "ams":
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Color").font(.headline); Spacer(); Text("AMS").font(.caption).foregroundStyle(.secondary) }
                Text(busy == "load" ? "Reading \(name)'s spools…" : "Couldn't read \(name)'s spools, so there's nothing to choose yet.")
                    .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if busy != "load" { Button("Read Again") { Task { await loadFilaments() } }.buttonStyle(.glass) }
            }
        case "single":
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Filament").font(.headline); Spacer(); Text("No AMS").font(.caption).foregroundStyle(.secondary) }
                if let loaded = filaments.first {
                    HStack(spacing: 12) {
                        SpoolDot(color: loaded.color, size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Uses the loaded filament: \(loaded.material) \(loaded.displayName)").font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                            if let grams = Format.grams(estimate?.grams) { Text(grams).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                } else {
                    Text(busy == "load" ? "Reading \(name)'s filament…" : "\(name) didn't report its filament.").font(.subheadline).foregroundStyle(.secondary)
                }
                Label("Want a different one? Change the spool on \(name) before you print.", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        default:
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("What's loaded?").font(.headline); Spacer(); if let g = Format.grams(estimate?.grams) { Text(g).font(.caption).foregroundStyle(.secondary) } }
                // The Mac can't switch a printer that doesn't report its filament to another material yet, so it
                // prints with the profile's own; saying so beats offering choices it would refuse.
                Text(project?.settings?.printDefaults?.colour?.object?["material"]?.string.map { "Uses \($0), saved in Project Settings. Load it before printing." } ?? "\(name) doesn't say which filament it has, so your Mac prints with its profile's material. Load that before you print.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Colours (multi-part: one spool per part colour, as on the Mac)

    /// The spool currently chosen for one of the model's filaments.
    private func chosenTray(_ filament: ModelColourFilament) -> PrinterFilament? {
        mapping?.trays.first { $0.slot == mappingSlots[filament.index] }
    }

    /// The mapping choices as a task key, so editing a spool re-slices the estimate with it.
    private var mappingSignature: String { mappingSlots.keys.sorted().map { "\($0):\(mappingSlots[$0] ?? -1)" }.joined(separator: ",") }

    /// AMS trays and the external spool can't feed one print together (the companion refuses the mix).
    private var mixedFeedSources: Bool {
        let external = mappingSlots.values.map { $0 >= 254 }
        return external.contains(true) && external.contains(false)
    }

    /// The chosen spools in filament order, when every colour has one: what Print sends.
    private var chosenSpoolPerColour: [PrinterFilament]? { mapping?.spools(slots: mappingSlots) }

    @ViewBuilder private var multiColours: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Colors").font(.headline); Spacer(); if let mapping, !mapping.trays.isEmpty { Text("AMS · \(mapping.trays.filter { !$0.isExternal }.count) slots").font(.caption).foregroundStyle(.secondary) } }
            switch mappingState {
            case .loading:
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading the printer’s filament…").foregroundStyle(.secondary) }
            case .failed(let text):
                Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { Task { await loadMapping() } }.buttonStyle(.glass)
            case .done:
                if let mapping, !mapping.filaments.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(mapping.filaments) { filament in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 10) {
                                    SpoolDot(color: hexColor(filament.colour) ?? Color(white: 0.5), size: 26)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(filament.name ?? "Part \(filament.index)").font(.body.weight(.medium)).lineLimit(1)
                                        let wanted = [filament.colour, filament.material].compactMap { $0 }.joined(separator: " · ")
                                        if !wanted.isEmpty { Text(wanted).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                                    }
                                    Spacer(minLength: 4)
                                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                                    if let tray = chosenTray(filament) { SpoolDot(color: tray.color, size: 26) }
                                    Menu {
                                        ForEach(mapping.trays) { tray in
                                            Button { mappingSlots[filament.index] = tray.slot } label: {
                                                Text(mappingSlots[filament.index] == tray.slot ? "✓ \(Self.spoolName(tray))" : Self.spoolName(tray))
                                            }
                                            // Mixed AMS/external choices stay selectable (else no row could be the
                                            // first to switch source); the note below and Print say what's wrong.
                                            .disabled(slicedOriginal && filament.material != nil && tray.material.caseInsensitiveCompare(filament.material!) != .orderedSame)
                                        }
                                    } label: {
                                        Text(chosenTray(filament).map(Self.spoolName) ?? "Choose a spool").lineLimit(1)
                                    }
                                    .disabled(mapping.trays.isEmpty || busy != nil)
                                    .accessibilityLabel("Spool for \(filament.name ?? "Part \(filament.index)")")
                                    .accessibilityValue(chosenTray(filament).map(Self.spoolName) ?? "None chosen")
                                }
                                if let note = mappingNote(filament) {
                                    Text(note).font(.caption).foregroundStyle(.secondary).padding(.leading, 36)
                                }
                            }
                        }
                        if mapping.trays.isEmpty {
                            Text("No filament is loaded. Load a spool, then reopen this sheet.").font(.subheadline).foregroundStyle(.secondary)
                        }
                        if mixedFeedSources {
                            Text("One print feeds from one source: put every colour on AMS spools, or every colour on the external spool.")
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text("Keeps the model’s filament assignments. The printer service confirms the loaded spools.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .disabled(busy == "print")
    }

    /// What the person should know about this row's match, in their words (the Mac's notes).
    private func mappingNote(_ filament: ModelColourFilament) -> String? {
        if filament.colour == nil { return "The model doesn’t say this part’s colour — pick its spool." }
        guard let tray = chosenTray(filament) else { return nil }
        if let other = mapping?.filaments.first(where: { $0.index != filament.index && mappingSlots[$0.index] == tray.slot
                && $0.colour != nil && $0.colour?.caseInsensitiveCompare(filament.colour ?? "") != .orderedSame }) {
            return "Shares this spool with \(other.name ?? "Part \(other.index)") — both parts print this colour."
        }
        if let material = filament.material, tray.material.caseInsensitiveCompare(material) != .orderedSame {
            return "Closest colour loaded; prints in \(tray.material), not \(material)."
        }
        if mappingSlots[filament.index] == filament.slot, let distance = filament.distance, distance > 0.08 {
            return "Closest colour loaded."
        }
        return nil
    }

    /// "A1 · PLA Bambu PLA Basic": AMS units are lettered A–D, four trays each (slot 4 is B1); AMS-HT units
    /// report from 128 (the Mac's spool names).
    private static func spoolName(_ filament: PrinterFilament) -> String {
        let place = filament.slot == 255 ? "External 2"
            : filament.isExternal ? "External"
            : filament.slot >= 128 ? "AMS-HT \(String(UnicodeScalar(65 + min(filament.slot - 128, 25))!))"
            : "\(String(UnicodeScalar(65 + min(filament.slot / 4, 25))!))\(filament.slot % 4 + 1)"
        return "\(place) · \(filament.material) \(filament.displayName)"
    }

    @ViewBuilder private var settingsSection: some View {
        let offersQuality = printer?.offersQuality ?? false, offersStrength = printer?.offersStrength ?? false
        VStack(alignment: .leading, spacing: 12) {
            if offersQuality || offersStrength {
                if offersQuality {
                    Text("Quality").font(.headline)
                    Picker("Quality", selection: $quality) { ForEach(PrintQuality.allCases, id: \.self) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
                }
                if offersStrength {
                    Text("Strength").font(.headline)
                    Picker("Strength", selection: $strength) { ForEach(PrintStrength.allCases, id: \.self) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
                }
            } else {
                HStack { Text("Quality").font(.headline); Spacer(); Text("Standard").foregroundStyle(.secondary) }
                Text(presetOnlyWords).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text(profileLine).font(.caption).foregroundStyle(.secondary)
            if offersCopies {
                Stepper {
                    HStack {
                        Text("Copies").font(.headline)
                        Spacer()
                        Text(copies.map { "\($0)" } ?? "From printer profile").monospacedDigit().foregroundStyle(.secondary)
                    }
                } onIncrement: { copies = min(64, (copies ?? 1) + 1) } onDecrement: { copies = max(1, (copies ?? 2) - 1) }
                .accessibilityIdentifier("copies")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .disabled(busy == "print")
    }

    // MARK: Pauses

    /// The slicer's "Add pause" through the printer's MCP (`pause_at_layers`): the printer stops by itself before
    /// each layer, as on the Mac. Only for an MCP that takes it, and not for a file that's already sliced.
    private var offersPauses: Bool { !slicedOriginal && printer?.offersLayerPauses == true }
    /// The slice's layer count, once the estimate has it.
    private var layerCount: Int? { estimate?.layers.flatMap { $0 > 1 ? $0 : nil } }
    private var pauseTooLate: Bool { layerCount.map { count in pauses.contains { $0 > count } } ?? false }

    /// The layers a row may take: above the pause before it and below the one after, so the list stays in order.
    private func pauseRange(_ index: Int) -> ClosedRange<Int> {
        let low = index > 0 ? pauses[index - 1] + 1 : 2
        let high = index + 1 < pauses.count ? pauses[index + 1] - 1 : (layerCount ?? 100_000)
        return low...max(low, high)
    }
    /// Room for another pause after the last one.
    private var canAddPause: Bool { pauses.count < PrintChoice.maxPauses && (pauses.max() ?? 1) < (layerCount ?? 100_000) }

    private var pauseSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pause").font(.headline)
            ForEach(Array(pauseRows.enumerated()), id: \.element.id) { index, row in
                HStack(spacing: 4) {
                    Button { withAnimation { pauseRows.removeAll { $0.id == row.id } } } label: {
                        Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.secondary)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, -10)
                    .accessibilityLabel("Remove the pause before layer \(row.layer)")
                    Button { typedLayer = String(row.layer); editingPause = index } label: {
                        HStack(spacing: 0) {
                            Text("Before layer ")
                            // A tinted capsule: the number is the thing to tap to type one.
                            Text("\(row.layer)").fontWeight(.semibold).foregroundStyle(Color.filament)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(Color.filament.opacity(0.16), in: .capsule)
                            if let count = layerCount { Text(" of \(count)").foregroundStyle(.secondary) }
                        }
                        .monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
                        .frame(minHeight: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Type the layer")
                    Spacer(minLength: 8)
                    Stepper("Before layer \(row.layer)", value: Binding(get: { row.layer }, set: { value in
                        if let at = pauseRows.firstIndex(where: { $0.id == row.id }) { pauseRows[at].layer = value } }), in: pauseRange(index))
                        .labelsHidden()
                        .accessibilityIdentifier("pause-\(index)")
                }
                .foregroundStyle(layerCount.map { row.layer > $0 } == true ? .red : .primary)
            }
            if canAddPause {
                Button {
                    let next = (pauses.max() ?? 1) + 1
                    withAnimation { pauseRows.append(PauseRow(layer: min(next, layerCount ?? next))) }
                } label: {
                    Label(pauses.isEmpty ? "Add a Pause" : "Add Another Pause", systemImage: "plus.circle.fill")
                }
                .frame(minHeight: 44)
                .accessibilityIdentifier("add-pause")
            }
            Text(pauses.isEmpty
                 ? "Stop before a layer to drop in magnets or nuts."
                 : "The printer stops before each of these layers and waits, so you can drop in magnets or nuts. Press Resume on the printer when they’re in. Layers count as in Bambu Studio’s and OrcaSlicer’s preview.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if pauseTooLate, let count = layerCount {
                Label("This print has \(count) layers.", systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .disabled(busy == "print")
        .alert("Pause before layer", isPresented: Binding(get: { editingPause != nil }, set: { if !$0 { editingPause = nil } })) {
            TextField("Layer", text: $typedLayer).keyboardType(.numberPad)
            Button("Cancel", role: .cancel) { editingPause = nil }
            Button("Done") { setTypedLayer() }
        } message: {
            Text(layerCount.map { "A layer from 2 to \($0)." } ?? "A layer from 2 up.")
        }
    }

    /// A typed layer: kept within the print, and the list sorted with no layer twice.
    private func setTypedLayer() {
        defer { editingPause = nil }
        guard let index = editingPause, pauses.indices.contains(index), let typed = Int(typedLayer.trimmingCharacters(in: .whitespaces)) else { return }
        var next = pauseRows
        next[index].layer = min(max(2, typed), layerCount ?? 100_000)
        // In order, and no layer twice (the row just typed wins).
        let edited = next[index].id
        next.sort { $0.layer < $1.layer }
        withAnimation { pauseRows = next.filter { row in !next.contains { $0.layer == row.layer && $0.id == edited && row.id != edited } } }
    }

    /// Why Draft, Fine and Strength aren't offered: the update that unlocks them, in the Mac's words when it gives them.
    private var presetOnlyWords: String {
        if printer?.capabilities == nil { return "Your Mac hasn't read this printer's MCP yet, so the printer's preset is used." }
        return "Draft, Fine and Strength need a newer \(printer?.via ?? "printer MCP") on your Mac. Until then the printer's preset is used."
    }

    /// "0.20 mm layers · 2 walls · 15% infill · Bambu PLA Basic profile", from the slice when it's back.
    private var profileLine: String {
        let layer = estimate?.layerHeightMm ?? quality.layerHeightMm
        var parts = [String(format: "%.2f mm layers", layer)]
        if let walls = estimate?.wallLoops ?? (printer?.offersStrength == true ? strength.walls : nil) { parts.append("\(walls) walls") }
        if let infill = estimate?.infillPercent ?? (printer?.offersStrength == true ? Double(strength.infillPercent) : nil) { parts.append("\(Int(infill))% infill") }
        if let chosen { parts.append("\(chosen.displayName) profile") }
        return parts.joined(separator: " · ")
    }

    /// The last print may still be running. A Done project (the Mac's confirmed) prints again without the check.
    private var uncertain: Bool {
        guard let project, project.print?.uncertain == true else { return false }
        return project.state != .confirmed
    }
    /// Copies on a Mac that takes them, for a printer whose MCP really makes them (KAN-214 PR 8b).
    private var offersCopies: Bool { store.macCapabilities.contains("printCopies") && printer?.offersCopies == true }


    private var uncertainCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Check the previous print", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.orange)
            Text("The last request may have reached \(project?.print?.destination?.name ?? "the printer"). Check it before printing again.")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("I checked; it isn't printing this model", isOn: $checked)
        }
        .padding(16)
        .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 24))
    }

    private var printButton: some View {
        Button { Task { await print() } } label: {
            VStack(spacing: 0) {
                Text(busy == "print" ? "Sending to \(printer?.name ?? "the printer")…" : "Print on \(printer?.name ?? "printer")").fontWeight(.semibold)
                if let done = doneAround { Text("Done around \(done)").font(.caption).opacity(0.8) }
            }
            .frame(maxWidth: .infinity).frame(height: 44)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .padding(.horizontal, 20)
        .disabled(!canPrint)
        .accessibilityIdentifier("print-now")
    }

    private var doneAround: String? {
        guard case .ready(let seconds?, _, _) = slice.shown(for: estimateKey, fallback: project?.print?.estimate) else { return nil }
        return Date().addingTimeInterval(seconds).formatted(date: .omitted, time: .shortened)
    }

    /// A multi-part model whose colours are known prints only once every colour has a spool.
    /// While the mapping loads Print waits; when it can't be read, the companion's own matching applies.
    private var mappingReady: Bool {
        guard published else { return true }
        if mappingState == .loading { return false }
        guard let mapping, !mapping.filaments.isEmpty else { return true }
        return chosenSpoolPerColour != nil && !mixedFeedSources
    }

    private var canPrint: Bool {
        guard busy == nil, printer != nil, printer?.isOffline != true else { return false }
        if uncertain && !checked { return false }
        if !mappingReady { return false }
        // An AMS printer prints the spool you can see chosen here, never whatever the Mac last had set.
        if !published && filamentKind == "ams" && chosen == nil { return false }
        // A pause after the last layer would never happen: the Mac refuses it the same way.
        if offersPauses && pauseTooLate { return false }
        return true
    }

    // MARK: Actions

    private func start() async {
        // Fresh capabilities: a Mac that just started reads its printers in the background (Copies depends on them).
        await store.loadPrinters()
        await store.loadCapabilities()
        let saved = project?.printerDestinationId ?? store.catalog?.defaultDestinationId ?? ""
        // A printer whose MCP was changed since has another id; the project's choice follows it.
        destinationId = store.catalog?.listed(saved) ?? saved
        // Print another: the last print's quality and strength again (its printer is the project's).
        if let last = project?.resolvedPrintDefaults(destinationId: destinationId) {
            quality = last.quality.flatMap(PrintQuality.init(rawValue:)) ?? quality
            strength = last.strength.flatMap(PrintStrength.init(rawValue:)) ?? strength
            copies = last.copies
        }
        // Print Another keeps the last print's pauses (the magnets go in at the same layers), as on the Mac.
        pauses = project?.print?.settings?.pauseBeforeLayers ?? []
        await loadFilaments()
        await store.loadPrinters()
        if let project, project.current != nil, !published { modelURL = try? await store.mac.download(project, "model.stl") }
    }

    private func choose(_ id: String) async {
        guard id != destinationId, busy == nil else { return }
        busy = "load"; problem = nil
        defer { busy = nil }
        do {
            let ticket = store.startRequest()
            store.replace(try await store.mac.selectPrinter(projectId, destinationId: id), ticket: ticket)
            destinationId = id
            // Another printer's spools are not this one's: the old mapping must not outlive the change.
            mapping = nil; mappingSlots = [:]; mappingState = .loading
            slice.forget()
        } catch let failure as CompanionError { problem = failure.message; return }
        catch { problem = CompanionError.unreachable.message; return }
        busy = nil
        await loadFilaments()
    }

    private func loadFilaments() async {
        guard !destinationId.isEmpty else { problem = store.printerProblem ?? "No printer is set up on your Mac."; return }
        let id = destinationId
        busy = "load"; filaments = []; spool = nil
        defer { busy = nil }
        do {
            let reported = try await store.mac.filaments(projectId)
            guard id == destinationId else { return }
            filaments = reported
            spools[id] = reported
            // The last print's spool on the same printer: the Mac's record (a tray, or the external spool), else the
            // tray this phone sent; else the one the Mac suggests.
            let recorded = project?.resolvedPrintDefaults(destinationId: id).colour?.object
            let last: PrinterFilament? = if let slot = recorded?["amsSlot"]?.number {
                reported.first { $0.slot == Int(slot) }
            } else if recorded?["external"] == .bool(true) {
                reported.first { $0.isExternal }
            } else if let material = recorded?["material"]?.string {
                reported.first { $0.material.caseInsensitiveCompare(material) == .orderedSame }
            } else if project?.settings?.printDefaults != nil {
                nil
            } else {
                LastTray.slot(projectId, destinationId: id).flatMap { slot in reported.first { $0.slot == slot } }
            }
            spool = (last ?? reported.first { $0.suggested == true } ?? reported.first { !$0.isExternal } ?? reported.first)?.slot
        } catch let failure as CompanionError {
            // A printer that doesn't report filament still prints; you pick the material.
            if !failure.isUnsupported { problem = failure.message }
        } catch { problem = CompanionError.unreachable.message }
    }

    /// What the spool rows are for: this printer, plate and model. The mapping reloads when any of them changes.
    private var mappingLoadKey: String { "\(published)#\(project?.selectedPlate?.id ?? "")#\(project?.mediaVersion ?? 0)#\(destinationId)" }

    /// The spool per colour for a multi-part model; the suggestions arrive chosen. A reply for another
    /// printer, plate or model version (a change while it ran) is dropped, never shown or sent.
    private func loadMapping() async {
        guard published, !destinationId.isEmpty else { return }
        let key = mappingLoadKey
        mappingState = .loading; mapping = nil; mappingSlots = [:]
        do {
            let loaded = try await store.mac.colourMapping(projectId)
            guard !Task.isCancelled, key == mappingLoadKey else { return }
            mapping = loaded
            mappingSlots = loaded.suggestedSlots
            mappingState = .done
        } catch let failure as CompanionError {
            guard !Task.isCancelled, key == mappingLoadKey, failure.code != "cancelled" else { return }
            mapping = nil; mappingSlots = [:]
            mappingState = .failed(failure.message)
        } catch {
            guard !Task.isCancelled, key == mappingLoadKey else { return }
            mapping = nil; mappingSlots = [:]
            mappingState = .failed("Couldn’t match this model’s colours to the loaded spools.")
        }
    }

    /// The model, printer and settings an estimate is for. Only an estimate for exactly these is shown.
    /// The chosen spools are part of it, so changing one drops the old estimate and slices again.
    private var estimateKey: String { "\(project?.selectedPlate?.id ?? "")#\(project?.mediaVersion ?? 0)#\(destinationId)#\(quality)#\(strength)#\(offersCopies ? copies.map(String.init) ?? "profile" : "profile")#\(published ? mappingSignature : "")#\(published ? mapping?.modelVersion ?? "" : "")" }
    /// The slice estimate on screen: always for these settings, or pending.
    private var estimate: SliceEstimate? { slice.estimate(for: estimateKey) }

    /// The slice with exactly these settings (PR 2 of KAN-214). An older Mac keeps the pass's own estimate.
    private func refreshEstimate() async {
        guard !destinationId.isEmpty, project?.current != nil else { return }
        let key = estimateKey
        slice.start(key)
        do {
            let next = try await store.mac.client.estimate(projectId, destinationId: destinationId,
                                                           quality: !slicedOriginal && printer?.offersQuality == true ? quality : .standard,
                                                           strength: !slicedOriginal && printer?.offersStrength == true ? strength : .standard,
                                                           copies: slicedOriginal ? 1 : offersCopies ? copies : (project?.settings?.printDefaults?.copies != nil ? 1 : nil), overrideDefaults: true,
                                                           filaments: published ? chosenSpoolPerColour ?? [] : [],
                                                           filamentsModelVersion: published ? mapping?.modelVersion : nil)
            guard !Task.isCancelled else { return }
            slice.finish(key, next)
        } catch let failure as CompanionError {
            guard !Task.isCancelled, failure.code != "cancelled" else { return }
            if failure.isUnsupported { slice.unsupported(key) } else { slice.fail(key, failure.message) }
        } catch {}
    }

    private func print() async {
        guard canPrint else { return }
        busy = "print"; problem = nil
        defer { busy = nil }
        let colour: PrintColour? = switch filamentKind {
        // The tray as reported, so the Mac slices with its profile and routes it (AMS or external) as shown.
        case "ams": chosen.map { .tray($0) }
        case "single": filaments.first.map { .tray($0) }
        // A printer that doesn't report its filament prints with its own profile's material.
        default: (project?.settings?.printDefaults?.colour?.object?["material"]?.string).map(PrintColour.material)
        }
        // A multi-part model prints from the spool chosen for each colour, bound to the model version
        // those choices were made against; with no complete mapping the companion's own matching applies.
        let perColour = published ? chosenSpoolPerColour : nil
        let choice = PrintChoice(colour: published ? nil : colour,
                                 quality: !slicedOriginal && printer?.offersQuality == true ? quality : .standard,
                                 strength: !slicedOriginal && printer?.offersStrength == true ? strength : .standard,
                                 checked: uncertain && checked, copies: slicedOriginal ? 1 : offersCopies ? copies : (project?.settings?.printDefaults?.copies != nil ? 1 : nil),
                                 pauseBeforeLayers: offersPauses ? pauses : [],
                                 filaments: perColour ?? [],
                                 filamentsModelVersion: perColour != nil ? mapping?.modelVersion : nil)
        do {
            let ticket = store.startRequest()
            store.replace(try await store.mac.client.print(projectId, choice: choice, overrideDefaults: true, expectedPlate: project?.selectedPlate?.id), ticket: ticket)
            if case .tray(let tray)? = colour { LastTray.save(projectId, destinationId: destinationId, slot: tray.slot) }
            dismiss()
        } catch let failure as CompanionError {
            if failure.needsPairing { dismiss(); store.onPair(); return }
            problem = failure.message
        } catch { problem = CompanionError.unreachable.message }
    }
}

/// One "Pause before layer" row, with an identity of its own so removing or reordering animates the right row.
struct PauseRow: Identifiable, Equatable {
    var id = UUID()
    var layer: Int
}

/// One printer in the sheet's row: name, model, whether it's ready, and its spools when it reported them.
struct PrinterChoice: View {
    let printer: PrinterDestination
    let selected: Bool
    var spools: [PrinterFilament] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "printer.fill").font(.title3)
                Spacer()
                Circle().fill(printer.isReady == true ? Color.okGreen : printer.isOffline ? Color.gray : Color.orange).frame(width: 8, height: 8)
            }
            Text(printer.name).font(.headline).lineLimit(1)
            Text(printer.modelName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 3) {
                ForEach(spools.filter { !$0.isExternal }.prefix(4)) { SpoolDot(color: $0.color, size: 12) }
                if spools.isEmpty {
                    Text(printer.isOffline ? "Offline" : printer.capabilities?.filaments == "none" ? "Filament not reported" : " ")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassEffect(selected ? .regular.tint(Color.filament.opacity(0.35)).interactive() : .regular.interactive(), in: .rect(cornerRadius: 22))
        .overlay { if selected { RoundedRectangle(cornerRadius: 22).strokeBorder(Color.filament, lineWidth: 2) } }
        .opacity(printer.isOffline ? 0.5 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(printer.name), \(printer.modelName), \(printer.isOffline ? "offline" : printer.isReady == true ? "ready" : "busy")")
    }
}

/// The AMS slots and the external spool, the chosen one ringed.
struct SpoolPickerRow: View {
    let filaments: [PrinterFilament]
    @Binding var selected: Int?

    var body: some View {
        // Two AMS units and an external spool don't fit across a phone; the row scrolls.
        ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 16) {
            ForEach(filaments) { spool in
                Button { selected = spool.slot } label: {
                    VStack(spacing: 4) {
                        if spool.isExternal {
                            Image(systemName: "plus").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                                .frame(width: 34, height: 34)
                                .overlay { Circle().strokeBorder(selected == spool.slot ? Color.filament : .secondary, style: .init(lineWidth: 1.5, dash: [3, 3])) }
                        } else {
                            SpoolDot(color: spool.color, size: 34, selected: selected == spool.slot)
                        }
                        Text(spool.isExternal ? "External" : "\(spool.slotLabel) \(spool.material)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(spool.slotLabel), \(spool.material) \(spool.displayName)")
                .accessibilityAddTraits(selected == spool.slot ? .isSelected : [])
            }
        }
        .padding(.horizontal, 4)
        .frame(minWidth: 280)
        }
        .padding(.top, 4)
    }
}

struct MaterialChip: View {
    let name: String, selected: Bool, note: String?
    var body: some View {
        HStack(spacing: 5) {
            if selected { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
            Text(name).font(.subheadline.weight(.semibold))
            if let note { Text(note).font(.caption2.weight(.semibold)).opacity(0.75) }
        }
        .lineLimit(1).fixedSize()
        .padding(.horizontal, 14).padding(.vertical, 9)
        .foregroundStyle(selected ? .white : .primary)
        .glassEffect(selected ? .regular.tint(Color.filament).interactive() : .regular.interactive(), in: .capsule)
    }
}

/// The print bed's perspective lines under the model.
struct BedGrid: View {
    var body: some View {
        Canvas { ctx, size in
            for i in 0...14 {
                let x = size.width * CGFloat(i) / 14
                var p = Path(); p.move(to: .init(x: size.width / 2 + (x - size.width / 2) * 0.55, y: 0)); p.addLine(to: .init(x: x, y: size.height))
                ctx.stroke(p, with: .color(.white.opacity(0.18)), lineWidth: 1)
            }
            for j in 0...4 {
                let y = size.height * CGFloat(j) / 4
                var p = Path(); p.move(to: .init(x: 0, y: y)); p.addLine(to: .init(x: size.width, y: y))
                ctx.stroke(p, with: .color(.white.opacity(0.12)), lineWidth: 1)
            }
        }
    }
}

/// Chips that wrap onto the next line.
struct FlowRow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width { y += row + spacing; x = 0; row = 0 }
            x += size.width + spacing; row = max(row, size.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX { y += row + spacing; x = bounds.minX; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing; row = max(row, size.height)
        }
    }
}

/// The tray this phone last printed a project with, so Print Another starts on it. The companion records a
/// colour choice in `print.settings`, but not the tray a print was sent with.
enum LastTray {
    private static func key(_ projectId: String) -> String { "CounterpartLastTray." + projectId }
    static func save(_ projectId: String, destinationId: String, slot: Int) {
        UserDefaults.standard.set(["destinationId": destinationId, "slot": slot], forKey: key(projectId))
    }
    static func slot(_ projectId: String, destinationId: String) -> Int? {
        guard let saved = UserDefaults.standard.dictionary(forKey: key(projectId)), saved["destinationId"] as? String == destinationId else { return nil }
        return saved["slot"] as? Int
    }
}

/// What the preview's estimate shows: a slice for exactly these settings, pending while it runs, or the
/// failure. The pass's own estimate stands in only on a Mac without the estimate route.
struct EstimateState: Equatable {
    enum Shown: Equatable { case pending, failed(String), ready(seconds: Double?, grams: Double?, layers: Int?) }
    private(set) var key = ""
    private(set) var result: SliceEstimate?
    private(set) var failure: String?
    private(set) var older = false

    mutating func start(_ key: String) {
        if key != self.key { result = nil; failure = nil }
        self.key = key
    }
    mutating func finish(_ key: String, _ estimate: SliceEstimate) { guard key == self.key else { return }; result = estimate; failure = nil }
    mutating func fail(_ key: String, _ message: String) { guard key == self.key else { return }; result = nil; failure = message }
    mutating func unsupported(_ key: String) { guard key == self.key else { return }; older = true }
    mutating func forget() { key = ""; result = nil; failure = nil }

    func estimate(for key: String) -> SliceEstimate? { key == self.key ? result : nil }

    func shown(for key: String, fallback: Project.PrintEstimate?) -> Shown {
        if older { return .ready(seconds: fallback?.seconds, grams: fallback?.grams, layers: nil) }
        guard key == self.key else { return .pending }
        if let result { return .ready(seconds: result.seconds, grams: result.grams, layers: result.layers) }
        if let failure { return .failed(failure) }
        return .pending
    }
}

