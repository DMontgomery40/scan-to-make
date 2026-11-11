import SwiftUI
import CounterpartKit

/// New (PRD §5.2, screens/phone-new.jpg): say what you need, show it five ways, and send. The text is kept
/// whatever you do; a scan returns here attached; Send creates the project at once and the files follow
/// while the project shows Sending.
///
/// Guards: every action runs through `run`, single flight (`working`), released when it settles. A capture
/// finished for this draft is never reopened or replaced; its files are sent from the project page if a
/// send is cut short.
struct NewObjectView: View {
    let store: ProjectsStore
    var job: NewProjectJob? = nil
    /// "Make something else from this scan" on a project's page (design §3.3): New opens already holding that project's
    /// scan, which the Mac has. Nothing is scanned or sent from this phone; the Mac copies the scan into the new project.
    var reusing: Project? = nil
    /// The project was created: the sheet closes and its page opens.
    let started: (Project) -> Void
    @AppStorage("CounterpartNewDraft") private var instructions = ""
    /// The draft project this sheet made, kept so closing New and coming back finishes the same one.
    @AppStorage("CounterpartNewDraftId") private var draftId = ""
    @State private var photos: [ChosenPhoto] = []
    /// A scan chosen under "Use a scan you already have" (design §3.3).
    @State private var picked: Project?
    /// The words for a project made from a kept scan: never the saved draft's, which stays for its own scan.
    @State private var reuseWords = ""
    @State private var working: String?
    @State private var problem: String?
    @State private var askedForDescription = false
    @State private var created: Project?
    @State private var attached: Attached?
    @State private var scanUse: ScanUse?
    @State private var dimensionSource: DimensionSource = .lookup
    @State private var measuredLongest = ""
    @State private var measuredMiddle = ""
    @State private var measuredShortest = ""
    @State private var captureWarning: String?
    /// One of the finished scan's own frames, shown beside its question.
    @State private var scanPicture: URL?
    @FocusState private var describing: Bool
    /// The first measurement, focused when a fit's Send needs one (review F4).
    @FocusState private var measuring: Bool
    /// Send on a fit missing its measurement: counts each time it has to take you to the fields (X86).
    @State private var showMeasurement = 0
    /// Longest is focused when the scroll that brings it into view has stopped (X86).
    @State private var focusWhenSettled = false
    /// The scroll's own position, so "the top" is the top of the content below the glass header, not the scroll view's
    /// edge under it (`proxy.scrollTo(_, anchor: .top)` put the question under the header on the iPhone).
    @State private var scrollPosition = ScrollPosition(edge: .top)
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// A scan finished for this draft, kept on this phone until Send.
    enum Attached: Equatable { case walkAround, inHand }

    /// What a finished scan is for: the printed thing itself, the thing a new part must fit, or undecided.
    enum ScanUse: String, Equatable { case copy, fit, later }

    /// How a fit gets its exact size: a maker's published size you confirm, your own measurements, or the scan.
    enum DimensionSource: String, CaseIterable, Hashable {
        case lookup, measured, scan
        var label: String {
            switch self {
            case .lookup: "Look up"
            case .measured: "I measured"
            case .scan: "Use scan"
            }
        }
    }

    /// The kept scan this sheet holds: the page's, or one picked here.
    private var seed: Project? { picked ?? reusing }
    /// A scan is attached: one taken for this draft, or one the Mac already has.
    private var holdsScan: Bool { attached != nil || seed != nil }
    /// What the person is typing: a kept scan's own words, else the draft's.
    private var text: Binding<String> { seed != nil ? $reuseWords : $instructions }
    private var publishedLink: URL? { seed != nil ? nil : PublishedModelLink.find(in: instructions) }
    private var described: Bool { !text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// Measurements you typed, by the edge you named: blank sides are simply unknown.
    private var measuredValues: [(edge: String, mm: Double)] {
        [("longest", measuredLongest), ("middle", measuredMiddle), ("shortest", measuredShortest)].compactMap { edge, text in
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, let mm = Double(value.replacingOccurrences(of: ",", with: ".")), mm > 0, mm <= 10_000 else { return nil }
            return (edge, mm)
        }
    }
    private var measuredValid: Bool {
        let typed = [measuredLongest, measuredMiddle, measuredShortest].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !typed.isEmpty && measuredValues.count == typed.count
    }
    /// The Mac's own rule for starting, in its words: photos show what something looks like, so without a
    /// scan the description says what to make. A scan always goes with its own photos.
    private var missing: String? {
        if holdsScan {
            guard let scanUse, seed == nil || scanUse != .later else {
                return seed != nil ? "Choose whether to copy it or make something that fits it." : "Choose whether to copy it, make something that fits it, or save the scan."
            }
            if scanUse == .fit {
                if !described { return "Say what it should hold, mount or adapt to." }
                if dimensionSource == .measured && !measuredValid { return "Enter at least one measurement in millimetres." }
            }
            return nil
        }
        return described ? nil : "Describe what to make, or add a scan."
    }
    private var canSend: Bool { missing == nil }

    /// The one bottom action, in the words for what it will do now. After a scan it is greyed out and says what to
    /// do until a use is chosen, then names that use's action: an instruction never looks like the action (U5).
    private var sendLabel: String {
        if working == "make" { return scanUse == .later ? "Saving…" : "Sending…" }
        if holdsScan {
            switch scanUse {
            case .copy: return "Copy this object"
            // A fit needs words first: Continue takes you to them, then Send.
            case .fit: return described ? "Send to \(store.macName ?? "your Mac")" : "Continue"
            case .later: return "Save this scan"
            case nil: return "Choose what this scan becomes"
            }
        }
        return "Send to \(store.macName ?? "your Mac")"
    }
    private var sendSymbol: String? {
        guard holdsScan else { return "arrow.up" }
        switch scanUse {
        case .copy: return "doc.on.doc"
        case .fit: return described ? "arrow.up" : nil
        case .later: return "tray.and.arrow.down"
        case nil: return nil
        }
    }
    /// Greyed out after a scan until its use is chosen.
    private var awaitingUse: Bool { holdsScan && (scanUse == nil || (seed != nil && scanUse == .later)) }

    /// A job card's choice, kept as the starting answer but still changeable after the scan.
    private func useJobDefault() {
        if scanUse == nil, let job { scanUse = job == .fit ? .fit : .copy }
    }

    /// What the person typed: the request, sent and shown as written.
    private var typedInstructions: String { text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// For a fit made from a scan: how its exact size is settled, sent as fields beside the request. The Mac turns
    /// them into its worker's brief; nothing is appended to the person's words.
    private var fitChoice: ProjectFit? {
        guard holdsScan, scanUse == .fit, !typedInstructions.isEmpty else { return nil }
        let source = ProjectFit.SizeSource(rawValue: dimensionSource.rawValue) ?? .lookup
        return ProjectFit(sizeSource: source, measured: measuredValues.map { .init(id: $0.edge, label: "\($0.edge) side", mm: $0.mm) })
    }

    var body: some View {
        NavigationStack {
            // The scroll ends where the bottom bar begins (lead, Nov 10): nothing scrolls under the action, so nothing
            // can be read or reached through it, disabled or not. A bar over the scroll left the covered rows reachable
            // to VoiceOver and taps even behind an opaque backing.
            VStack(spacing: 0) {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // After a scan the sheet opens on its question, first and whole (U5): nothing half-hidden above it.
                    if holdsScan { scanUseSection }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What do you need?").font(.headline)
                        TextField(seed != nil ? (scanUse == .copy ? "Copy this. Close up the bottom." : "A belt case for it…")
                                  : job == .copy ? "Copy this. Close up the bottom." : "A hook for my stroller handle…", text: text, axis: .vertical)
                            .lineLimit(3...6)
                            .focused($describing)
                            .padding(14)
                            .glassEffect(.regular, in: .rect(cornerRadius: 20))
                            .accessibilityIdentifier("describe")
                            .id("describe")
                        Text(askedForDescription && !measurementMissing ? missing ?? hint : hint)
                            .font(.footnote).foregroundStyle(askedForDescription && !canSend && !measurementMissing ? .red : .secondary)
                    }

                    if let publishedLink {
                        Label(publishedLink.host ?? "Published model", systemImage: "link").font(.headline)
                        Text("Your Mac will get the designer’s file and keep its credit.").font(.footnote).foregroundStyle(.secondary)
                    }
                    // A kept scan is the whole of what's shown: the Mac has it, its photos and its checked sizes.
                    if seed == nil {
                    Text("Show it").font(.headline)
                    // One way to scan: walking round it and the scan rig are the same capture (David, Nov 9).
                    ScanTile(enabled: store.canScan && working == nil, canScan: store.canScan,
                             scan: { Task { await scan(handheld: false) } },
                             printRig: { openURL(CounterpartIdentifiers.scanRig) })
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        // Scan in hand is off until it's rebuilt on Apple's still-photo capture: its LiDAR session
                        // left the phone's camera black (KAN-217 P0, Davica3 2026-11-02 02:07).
                        if HandheldCapture.offered {
                            SourceTile(symbol: "hand.raised.fingers.spread", title: "Scan in hand",
                                       detail: HandheldCapture.isAvailable ? "Hold it up and turn it." : "Needs an iPhone or iPad with LiDAR.",
                                       tint: .blue, enabled: HandheldCapture.isAvailable && working == nil) { Task { await scan(handheld: true) } }
                                .accessibilityIdentifier("capture-photos")
                        }
                        SourceTile(symbol: "camera", title: "Take photos", detail: photos.count < Self.photoLimit ? "A few angles is plenty." : "24 photos is the most.", tint: .purple,
                                   enabled: working == nil && !photosLocked && photos.count < Self.photoLimit) { Task { await addPhotos(camera: true) } }
                        SourceTile(symbol: "photo.on.rectangle.angled", title: "From Photos", detail: photos.count < Self.photoLimit ? "Pick what you have." : "24 photos is the most.", tint: .green,
                                   enabled: working == nil && !photosLocked && photos.count < Self.photoLimit) { Task { await addPhotos(camera: false) } }
                    }
                    if attached == nil { existingScans }
                    }

                    // The scan itself sits beside its question (above); Added is what else you attach.
                    if !photos.isEmpty {
                        Text("Added").font(.headline)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(photos) { photo in
                                    AttachmentChip(url: photo.url, label: "Photo", remove: photosLocked ? nil : { photos.removeAll { $0.id == photo.id } })
                                }
                            }
                        }
                    }
                    if let captureWarning {
                        Label(captureWarning, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange)
                    }
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red)
                    }
                }
                .padding(20)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            // A scan arrives after the sheet opens (a saved draft resolves, or a capture returns while the Scan tile is
            // in view): back to the top, where its question now is.
            .scrollPosition($scrollPosition)
            .onChange(of: attached, initial: true) { _, now in
                guard now != nil else { scanPicture = nil; return }
                if let created { scanPicture = store.mac.scanPicture(created.id) }
                withAnimation { scrollPosition.scrollTo(edge: .top) }
            }
            // Continue on a fit takes you to the words it still needs.
            .onChange(of: picked) { _, now in
                if now != nil { withAnimation { scrollPosition.scrollTo(edge: .top) } }
            }
            .onChange(of: describing) { _, now in
                if now, holdsScan { withAnimation { proxy.scrollTo("describe", anchor: .center) } }
            }
            // Send on a fit still missing its measurement takes you to the fields that need it (review F4), and focuses
            // the first only once they have stopped moving (X86). The size card goes to the top of the sheet, its line
            // above the fields: the docked keyboard rises from the bottom, and on an iPad with a hardware keyboard the
            // floating number pad is placed beside the focused field when it appears and stays there. Focused first and
            // scrolled after, the pad stayed where the field had been and covered the line; with the fields near the top
            // there is no room for it above them, so it opens below, away from the line.
            .onChange(of: showMeasurement) {
                focusWhenSettled = true
                withAnimation { proxy.scrollTo("fit-dimensions", anchor: .top) }
                // Already in place, the scroll doesn't move and never settles: focus anyway, a moment later.
                Task { try? await Task.sleep(for: .seconds(1)); focusMeasurementIfSettling() }
            }
            .onScrollPhaseChange { _, phase in
                if phase == .idle { focusMeasurementIfSettling() }
            }
            }
            .scrollDismissesKeyboard(.interactively)
            // The scroll's bottom edge meets the bar with the system's hard edge, so a row cut there reads as cut, not
            // as floating behind the button.
            .scrollEdgeEffectStyle(.hard, for: .bottom)
                Button { Task { await make() } } label: {
                    Group {
                        if let sendSymbol { Label(sendLabel, systemImage: sendSymbol) } else { Text(sendLabel) }
                    }
                    .fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40)
                }
                .buttonStyle(.glassProminent).controlSize(.large).padding(.horizontal, 20)
                .disabled(working != nil || awaitingUse)
                .accessibilityIdentifier("send")
                .frame(maxWidth: 640)
                // A full-width bar with the system's bar background, below the scroll.
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(.bar, ignoresSafeAreaEdges: .bottom)
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.disabled(working == "make") }
                if describing { ToolbarItem(placement: .confirmationAction) { Button("Done") { describing = false } } }
            }
            .interactiveDismissDisabled(working != nil)
            .dropDestination(for: Data.self) { items, _ in
                Task { await addDropped(items) }
                return !items.isEmpty
            }
        }
        .task {
            // A scan the Mac already has: no draft, no scan on this phone (design §3.3).
            if reusing != nil { store.refreshStoppedScans(); return }
            // A draft from an earlier sheet keeps its project and its finished scan.
            useJobDefault()
            _ = try? await savedDraft()
            if let created, attached == nil { attached = await savedCapture(created.id) }
            #if DEBUG
            // `-CounterpartNewScan walk-around` (scripts/ux_screens.py): New as it looks after a scan, which a simulator can't take.
            if attached == nil, UserDefaults.standard.string(forKey: "CounterpartNewScan") == "walk-around" { attached = .walkAround }
            #endif
            store.refreshStoppedScans()
        }
    }

    // MARK: A scan you already have

    /// New → "Use a scan you already have" (design §3.3): the scans the Mac keeps on other projects, by their pictures
    /// and names. Choosing one attaches it as if it had just been taken; no scan, no upload.
    @ViewBuilder private var existingScans: some View {
        let scans = ScanLineage.scans(in: store.projects)
        if !scans.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(ScanLineage.useExisting).font(.headline).accessibilityAddTraits(.isHeader)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(scans) { project in
                            Button { picked = project; scanUse = nil; describing = false } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    ProjectImage(project: project, path: project.pictures?["scan"] ?? project.picture, maxPixelSize: 300, placeholderSymbol: "cube.transparent")
                                        .frame(width: 128, height: 96).clipShape(.rect(cornerRadius: 16))
                                    Text(ProjectWords.title(project)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
                                    Text(ScanLineage.scannedLine(project)).font(.caption).foregroundStyle(.secondary)
                                }
                                .frame(width: 128, alignment: .topLeading)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .disabled(working != nil)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Makes something new from this scan, without scanning again")
                            .accessibilityIdentifier("existing-scan-\(project.id)")
                        }
                    }
                }
                .accessibilityIdentifier("use-existing-scan")
            }
        }
    }

    // MARK: After a scan

    /// The question a finished scan always gets: a scan is just as often the thing a holder must fit
    /// as the thing to print, so neither is assumed.
    @ViewBuilder private var scanUseSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // The thing being decided about, next to the question (lead, Nov 10): small, so all three answers still fit.
            HStack(spacing: 12) {
                if let seed {
                    ProjectImage(project: seed, path: seed.pictures?["scan"] ?? seed.picture, maxPixelSize: 168, placeholderSymbol: "cube.transparent")
                        .frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 14))
                        .accessibilityLabel("The scan from \(ProjectWords.title(seed))")
                        .accessibilityIdentifier("scan-use-scan")
                } else {
                    ScanThumb(picture: scanPicture, symbol: attached == .inHand ? "hand.raised.fingers.spread" : "cube.transparent")
                        .accessibilityLabel(attached == .inHand ? "Your scan in hand" : "Your scan")
                        .accessibilityIdentifier("scan-use-scan")
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("What should this scan become?").font(.headline)
                        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("scan-use-question")
                    if let seed {
                        // Which scan, by its project's name: the one already on the Mac, nothing to scan again.
                        Text("\(ProjectWords.title(seed)) · \(ScanLineage.scannedLine(seed))").font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2).accessibilityIdentifier("scan-use-source")
                    }
                }
                Spacer(minLength: 0)
                if picked != nil {
                    Button("Remove") { picked = nil; scanUse = nil }.font(.subheadline)
                        .disabled(working != nil).accessibilityIdentifier("scan-use-remove")
                }
            }
            ScanUseRow(symbol: "doc.on.doc", title: ScanLineage.copyChoice,
                       detail: "Clean up the scan and print the same thing.",
                       selected: scanUse == .copy, identifier: "scan-use-copy") { scanUse = .copy }
            ScanUseRow(symbol: "ruler", title: ScanLineage.fitChoice,
                       detail: "A holder, mount, case or adapter. The scan is what it must fit, not the print.",
                       selected: scanUse == .fit, identifier: "scan-use-fit") { scanUse = .fit }
            // A kept scan is already saved, on its own project.
            if seed == nil {
                ScanUseRow(symbol: "tray.and.arrow.down", title: "Just save this scan",
                           detail: "Keep its shape with this project and decide later.",
                           selected: scanUse == .later, identifier: "scan-use-later") { scanUse = .later }
            }
            if seed != nil {
                Text("Your Mac copies this scan, its photos and its checked sizes into a new project. The project it came from stays as it is.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if scanUse == .fit { fitDimensions }
            if scanUse == .later {
                Text("No pass starts and nothing is printed. The scan stays with this draft, so you can choose here later.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        // No identifier on the whole block: it would replace each answer's own (ux_screens' taps missed them).
        .id("scan-use")
    }

    /// How the fit's exact size is settled, chosen before the scan is sent.
    @ViewBuilder private var fitDimensions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Exact size").font(.subheadline.weight(.semibold))
            Picker("Exact size", selection: $dimensionSource) {
                ForEach(DimensionSource.allCases, id: \.self) { source in Text(source.label).tag(source) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("fit-dimension-source")
            switch dimensionSource {
            case .lookup:
                Text("Your Mac identifies it, finds the maker's published size, and asks “I found this exact size — is that right?” before designing to it.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            case .measured:
                // What's missing sits right above the fields, and Send brings this card to the top of the sheet before
                // it focuses a field: below them the docked keyboard covers it, and the iPad's floating number pad opens
                // below a field near the top (X86; iPad Air, landscape).
                VStack(alignment: .leading, spacing: 10) {
                    if askedForDescription, measurementMissing, let missing {
                        Text(missing).font(.footnote).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("fit-size-missing")
                    }
                    Text("Measure the outside of the real thing. Leave a side blank if you don't know it.")
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        measuredField("Longest", text: $measuredLongest, identifier: "fit-size-longest", focus: $measuring)
                        measuredField("Middle", text: $measuredMiddle, identifier: "fit-size-middle")
                        measuredField("Shortest", text: $measuredShortest, identifier: "fit-size-shortest")
                    }
                }
                .id("fit-sizes")
            case .scan:
                Text("Uses the scan's size as an estimate. Best for loose holders; your Mac says the clearance it allowed.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            // A kept scan's project starts on the Mac with what it has; a caliper photo goes in its conversation after.
            if seed == nil {
                Button { Task { await addPhotos(camera: true) } } label: {
                    Label("Add a caliper photo", systemImage: "camera").frame(maxWidth: .infinity).frame(height: 32)
                }
                .buttonStyle(.glass)
                .disabled(working != nil || photosLocked || photos.count >= Self.photoLimit)
                .accessibilityIdentifier("fit-caliper-photo")
            }
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .id("fit-dimensions")
    }

    private func measuredField(_ label: String, text: Binding<String>, identifier: String, focus: FocusState<Bool>.Binding? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Group {
                    if let focus { TextField("0", text: text).focused(focus) } else { TextField("0", text: text) }
                }
                .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                Text("mm").font(.caption).foregroundStyle(.secondary)
            }
            .padding(9)
            .glassEffect(.regular, in: .rect(cornerRadius: 12))
        }
        .accessibilityIdentifier(identifier)
    }

    /// The Mac takes up to 24 photos with a project.
    static let photoLimit = 24

    static let hint = "Describe it, scan it, or both. Your Mac can look up published sizes, like a phone or a mic."

    /// What the line under "What do you need?" says: once there's a scan, what's true for the use chosen (review F8).
    private var hint: String {
        guard holdsScan else { return Self.hint }
        switch scanUse {
        case .fit: return "Say what it should hold, mount or adapt to."
        case .copy: return "Optional: anything to change from the scan, like “close up the bottom”."
        case .later: return "Optional: a note to remember it by."
        case nil: return "Choose what this scan becomes, then add anything your Mac should know."
        }
    }
    private func focusMeasurementIfSettling() {
        guard focusWhenSettled else { return }
        focusWhenSettled = false
        if measurementMissing { measuring = true }
    }

    /// A fit with words and "I measured", but no valid measurement yet.
    private var measurementMissing: Bool {
        holdsScan && scanUse == .fit && described && dimensionSource == .measured && !measuredValid
    }

    /// Chosen photos stay put while something is running.
    private var photosLocked: Bool { working != nil }

    private func run(_ kind: String, _ body: () async throws -> Void) async {
        guard working == nil else { return }
        working = kind; problem = nil
        defer { working = nil }
        do { try await body() }
        catch let failure as CompanionError {
            if failure.code == "cancelled" { return }
            if failure.needsPairing { dismiss(); store.onPair(); return }
            problem = failure.message
        } catch { problem = CompanionError.unreachable.message }
    }

    private func addPhotos(camera: Bool) async {
        describing = false
        await run("photos") {
            if camera {
                guard photos.count < Self.photoLimit else { return }
                if let photo = try await PhotoSources.takePhoto(), let chosen = MacConnection.keep(photo) { photos.append(chosen) }
            } else {
                guard photos.count < Self.photoLimit else { return }
                photos += try await store.mac.choosePhotos(limit: Self.photoLimit - photos.count)
            }
        }
    }

    private func addDropped(_ items: [Data]) async {
        for data in items.prefix(max(0, Self.photoLimit - photos.count)) {
            let ext = data.starts(with: [0x89, 0x50, 0x4E, 0x47]) ? "png" : "jpg"
            if let image = UIImage(data: data), let chosen = MacConnection.keep(PickedPhoto(data: ext == "png" ? data : (image.jpegData(compressionQuality: 0.9) ?? data), ext: ext)) {
                photos.append(chosen)
            }
        }
    }

    /// The draft this sheet made, kept so a retry finishes it instead of making another.
    /// The draft an earlier New sheet made, resolved before anything could make a second one. Nil when
    /// there's none or the Mac no longer has it; any other failure throws, so Send never duplicates it.
    private func savedDraft() async throws -> Project? {
        guard created == nil, !draftId.isEmpty else { return nil }
        do {
            let saved = try await store.mac.get(draftId)
            // An unsent draft can still change job: a scan first taken to copy can become the thing a
            // holder must fit, without losing the scan already attached to this draft.
            if saved.state == .new { created = saved } else { draftId = "" }
            return saved
        } catch let failure as CompanionError where failure.code == "not-found" { draftId = ""; return nil }
    }

    /// `fit` or `copy`, only once it is known: a starting card, or the answer after a scan. A scan by
    /// itself no longer means copy. Nil lets the Mac infer a text-only request.
    private var chosenKind: String? {
        if let scanUse { return scanUse == .later ? nil : scanUse.rawValue }
        return job?.rawValue
    }
    private func kind(scanning _: Bool) -> String? { chosenKind }

    private func object(scanning: Bool = false) async throws -> Project {
        // A sent draft (started elsewhere) opens as it is.
        if let saved = try await savedDraft(), saved.state != .new { return saved }
        if let created {
            let latest = try await store.mac.get(created.id)
            // Start may have succeeded even when its reply was lost; never PATCH a started request.
            guard latest.state == .new else { return latest }
            do {
                let updated = try await store.mac.updateDraft(created.id, instructions: typedInstructions, kind: chosenKind, fit: fitChoice)
                if let chosenKind, updated.kind != chosenKind {
                    throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac so a scan can become a fit instead of a copy.")
                }
                return updated
            } catch {
                if let current = try? await store.mac.get(created.id), current.state != .new { return current }
                throw error
            }
        }
        let object = try await store.mac.create(typedInstructions, kind: kind(scanning: scanning), fit: fitChoice)
        created = object
        draftId = object.id
        return object
    }

    /// Send: the project is made at once and its page opens; its files follow while it shows Sending.
    /// Everything the send needs is captured now: this sheet is gone by the time the files go.
    private func make() async {
        guard canSend else {
            askedForDescription = true
            // A missing measurement is asked for at its fields, not under the description (review F4).
            if measurementMissing { describing = false; measuring = false; showMeasurement += 1; return }
            describing = !holdsScan || (scanUse == .fit && !described)
            return
        }
        describing = false
        if let seed, let scanUse, scanUse != .later {
            await run("make") {
                let ticket = store.startRequest()
                let made: Project
                do { made = try await store.mac.client.makeFromScan(seed.id, kind: scanUse.rawValue, instructions: typedInstructions, fit: fitChoice) }
                catch let failure as CompanionError where failure.code == "not-found" || failure.code == "method-not-allowed" {
                    // A Mac from before this route: the action stays offered, and says how to get it.
                    throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac to make something else from a scan you already have.")
                }
                store.replace(made, ticket: ticket)
                reuseWords = ""
                started(made)
            }
            return
        }
        await run("make") {
            // Saving a scan starts nothing: the draft and its scan stay here for the next open of New.
            if attached != nil && scanUse == .later {
                store.refreshStoppedScans()
                dismiss()
                return
            }
            let ticket = store.startRequest()
            let returned = try await object()
            guard let object = store.prepareDraftSend(returned, ticket: ticket) else { return }
            guard object.state == .new else { started(object); return }
            let chosen = photos, mac = store.mac
            instructions = ""
            draftId = ""
            started(object)
            await store.sendAfterUpload(object.id) { [store] in
                guard store.requestIsCurrent(ticket) else { return }
                let sendTicket = store.startRequest()
                store.replace(try await mac.sendProject(object.id, photos: chosen), ticket: sendTicket)
            }
        }
    }

    /// The scan's own files go to the Mac while Copy or Fit is chosen; no pass starts until Send.
    private func beginUpload(_ object: Project) {
        let mac = store.mac
        store.beginUpload(object.id) { try await mac.uploadProject(object.id) }
    }

    private func savedCapture(_ id: String) async -> Attached? {
        if HandheldCapture.finished(id) { return .inHand }
        if await store.mac.finishedScan(id) != nil {
            captureWarning = store.mac.localScanWarning(id)
            return .walkAround
        }
        return nil
    }

    /// Scans for this draft and comes back here with the scan attached; Send sends it with the rest.
    private func scan(handheld: Bool) async {
        describing = false
        await run("scan") {
            let object = try await object(scanning: true)
            guard object.state == .new else { started(object); return }
            if let saved = await savedCapture(object.id) { attached = saved; useJobDefault(); store.refreshStoppedScans(); return }
            guard object.scan == nil, (object.capture ?? []).isEmpty else {
                throw CompanionError(code: "missing-capture", message: "This project's saved scan is no longer on this phone. Start a new project to scan it again.")
            }
            if handheld {
                if await HandheldCapture.run(objectId: object.id) { attached = .inHand; beginUpload(object) }
            } else if try await store.mac.scan(object.id) != nil {
                attached = .walkAround
                captureWarning = store.mac.localScanWarning(object.id)
                beginUpload(object)
            } else if let saved = await savedCapture(object.id) {
                // "Keep for later" in the capture still comes back here with the scan attached, not to a
                // project page that can only offer Scan again.
                attached = saved
            }
            if attached != nil { useJobDefault(); store.refreshStoppedScans() }
        }
    }
}

/// The scan beside its question: one of its own frames, or the scan symbol when there's no picture.
private struct ScanThumb: View {
    let picture: URL?
    let symbol: String
    @State private var loaded: UIImage?
    var body: some View {
        ZStack {
            StageBackground()
            if let loaded { Image(uiImage: loaded).resizable().scaledToFill() }
            else { Image(systemName: symbol).font(.title3).foregroundStyle(Color.filament) }
        }
        .frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 14))
        .accessibilityElement()
        .task(id: picture) {
            guard let picture else { loaded = nil; return }
            loaded = await Task.detached { ImageMemory.thumbnail(at: picture, maxPixelSize: 168) }.value
        }
    }
}

/// One answer to "What should this scan become?": the chosen one carries a checkmark, never colour alone.
private struct ScanUseRow: View {
    let symbol: String, title: String, detail: String
    let selected: Bool
    let identifier: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.title3.weight(.semibold)).foregroundStyle(Color.filament)
                    .frame(width: 40, height: 40)
                    .glassEffect(.regular.tint(Color.filament.opacity(0.25)), in: .circle)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.filament) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
        .overlay { if selected { RoundedRectangle(cornerRadius: 20).strokeBorder(Color.filament, lineWidth: 2) } }
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Scan it (PRD §5.2, §11.1): the one scan, walking round it or swinging round it on a scan rig, with Kass 3D's rig
/// credited and linked underneath. Both run Apple's same freeform capture, so there is one tile, not two modes.
struct ScanTile: View {
    let enabled: Bool
    /// This phone or iPad has LiDAR (an iPhone Duo or a LiDAR-less iPad doesn't).
    let canScan: Bool
    let scan: () -> Void
    let printRig: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: scan) {
                HStack(spacing: 14) {
                    Image(systemName: "cube.transparent").font(.title2.weight(.semibold)).foregroundStyle(Color.filament)
                        .frame(width: 44, height: 44)
                        .glassEffect(.regular.tint(Color.filament.opacity(0.25)), in: .circle)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Scan it").font(.headline).foregroundStyle(.primary)
                        Text(canScan ? "Walk round it, or use a scan rig. LiDAR measures it." : "Needs an iPhone or iPad with LiDAR.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.55)
            .accessibilityIdentifier("scan-object")
            Button(action: printRig) {
                Text("No scan rig? Print one by Kass 3D →").font(.caption.weight(.semibold)).foregroundStyle(Color.filament)
            }
            .buttonStyle(.plain)
            .padding(.leading, 58)
            .accessibilityHint("Opens the rig's page on MakerWorld")
            .accessibilityIdentifier("scan-rig-link")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
    }
}

/// One way to show it.
struct SourceTile: View {
    let symbol: String, title: String, detail: String, tint: Color
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: symbol).font(.title2.weight(.semibold)).foregroundStyle(tint)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.tint(tint.opacity(0.25)), in: .circle)
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
            .padding(14)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
    }
}

/// Something attached to the new project, with a remove button.
struct AttachmentChip: View {
    var url: URL? = nil
    var image: UIImage? = nil
    var symbol: String = "photo"
    let label: String
    var remove: (() -> Void)?
    @State private var loaded: UIImage?

    init(url: URL, label: String, remove: (() -> Void)?) { self.url = url; self.label = label; self.remove = remove }
    init(image: UIImage?, symbol: String, label: String, remove: (() -> Void)?) { self.image = image; self.symbol = symbol; self.label = label; self.remove = remove }

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                StageBackground()
                if let shown = loaded ?? image { Image(uiImage: shown).resizable().scaledToFill() }
                else { Image(systemName: symbol).font(.title2).foregroundStyle(Color.filament) }
            }
            .frame(width: 76, height: 76).clipShape(.rect(cornerRadius: 16))
            .overlay(alignment: .topTrailing) {
                if let remove {
                    Button(action: remove) {
                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                    }
                    .padding(4)
                    .accessibilityLabel("Remove this \(label.lowercased())")
                }
            }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .task(id: url) {
            guard let url else { return }
            loaded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: 228) }.value
        }
    }
}
