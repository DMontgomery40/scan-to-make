import SwiftUI
import AppKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// Settings → Printers: both printer MCPs (Download for one this Mac hasn't), and Add printer… (journey M3, MAC-6).
// The MCPs are the backend: every button here is one companion call that finds, installs or runs them.

/// What Settings → Printers knows about printer setup on this Mac, read from the companion.
@MainActor final class PrinterSetupModel: ObservableObject {
    static let shared = PrinterSetupModel()
    /// The companion has `printers.mcps` and the setup methods (`capabilities.printerSetup`).
    @Published private(set) var available = false
    @Published private(set) var packages: [PrinterMcpPackage] = []
    /// The list couldn't be read just now: said under the MCPs, with Try Again, never a silently shorter list.
    @Published private(set) var problem: String?
    /// The MCPs' own choices (models by package), for Complete Settings.
    @Published private(set) var options: PrinterSetupOptions?
    func models(_ backend: String) -> [PrinterSetupOptions.Model] { options?.models[backend] ?? [] }

    static var socket: String { ModelAccessModel.socketPath(for:Installation(bundle:.main)) }
    /// A client that waits as long as the companion may take for this method (local-control.md "Deadlines").
    static func client(for method: String) throws -> ControlClient {
        try ControlClient(socketPath:socket, timeout:ControlClient.timeout(for:method))
    }

    func refresh() async {
        #if DEBUG
        if let fixture = DesignFixtures.printerMcps() { available = true; packages = fixture; return }
        #endif
        guard let status = try? await Self.client(for:"status.get").status() else { return }
        available = status.capabilities.printerSetup
        guard available else { return }
        // Read twice before saying it couldn't: a busy Mac may miss the first deadline (Nov 6, 14:43).
        var answer: (packages: [PrinterMcpPackage], options: PrinterSetupOptions?)?
        for attempt in 0..<2 where answer == nil {
            if attempt > 0 { try? await Task.sleep(for:.seconds(1)) }
            answer = try? await Self.client(for:"printers.mcps").printerSetupState()
        }
        guard let state = answer else {
            problem = "Counterpart couldn’t list the printer MCPs just now. Try Again in a moment."
            return
        }
        problem = nil
        if packages != state.packages { packages = state.packages }
        if options != state.options { options = state.options }
    }

    /// Download: the companion installs only that package; `mcp.update.*` events carry the progress.
    func download(_ package: PrinterMcpPackage) {
        let updates = PrinterUpdates.shared
        updates.set(package.appMcpId, .updating(from:nil, to:package.latestVersion))
        Task {
            do {
                switch try await Self.client(for:"printers.installMcp").installPrinterMcp(package.package) {
                case .installed:
                    updates.set(package.appMcpId, nil)
                    await refresh()
                case .started(let update):
                    if case .updating = updates.status[package.appMcpId] ?? .updating(from:nil, to:nil) { updates.set(package.appMcpId, McpUpdateStatus(update)) }
                }
            } catch let error as ControlRemoteError where !error.message.isEmpty {
                updates.set(package.appMcpId, .problem(error.message))
            } catch {
                updates.set(package.appMcpId, .problem("Counterpart couldn’t start the download. Try again."))
            }
        }
    }
}

/// One printer MCP in Settings → Printer software (#775; David, Nov 12: "messy af looking, double entries, confusing
/// wording"): its name and version; "Up to date", or "<version> available" with one **Update** (Counterpart's own copy,
/// `printers.updateMcp` with `appMcpId`); the printers that use it, each once; and only when a printer runs another copy,
/// one line and **Use Counterpart’s** (the Move). One this Mac hasn't is offered as **Download**. The words are
/// CounterpartKit's `PrinterSoftwareRow`, the same on the iPhone and iPad.
struct McpPackageRow: View {
    let package: PrinterMcpPackage
    let status: McpUpdateStatus?
    let download: () -> Void
    var update: (() -> Void)? = nil
    var move: ((String) -> Void)? = nil
    @ObservedObject private var updates = PrinterUpdates.shared

    private var row: PrinterSoftwareRow { package.softwareRow }
    private var busy: Bool { status?.busy == true }

    var body: some View {
        HStack(alignment:.top, spacing:10) {
            VStack(alignment:.leading, spacing:3) {
                HStack(alignment:.firstTextBaseline, spacing:6) {
                    Text(row.name).font(.body.weight(.medium))
                    Spacer(minLength:8)
                    if let version = row.version { Text(version).font(.callout.monospacedDigit()).foregroundStyle(.secondary) }
                }
                if !package.installed { Text(package.description).font(.caption).foregroundStyle(.secondary) }
                // While it updates, its progress in place of "available" and the button. A finished update earlier in
                // this session never hides the row's status or the next version's Update.
                if let status, status.busy || row.status == nil { statusLine(status) }
                else if let words = row.status {
                    HStack(alignment:.firstTextBaseline) {
                        switch words {
                        case .upToDate: Label(words.words, systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(.secondary)
                        case .available: Text(words.words).font(.caption.weight(.medium)).foregroundStyle(Color.filament)
                        }
                        Spacer(minLength:8)
                        if update != nil, package.showsUpdate(status:status), let update {
                            Button(failed ? "Try Again" : "Update", action:update)
                                .buttonStyle(.glassProminent).controlSize(.small)
                                .accessibilityLabel(package.updateLabel(failed:failed))
                                .help("Installs \(package.available ?? "the latest version") for Counterpart. Other copies on this Mac are left as they are.")
                        }
                    }
                    if failed, let status { statusLine(status) }
                }
                if package.installed { Text(row.usedBy).font(.caption).foregroundStyle(.secondary) }
                ForEach(row.others, id:\.mcpId) { other in
                    VStack(alignment:.leading, spacing:4) {
                        Text(other.words).font(.caption)
                        if let progress = updates.status[other.mcpId], progress.busy {
                            Text(progress.words).font(.caption).foregroundStyle(.secondary)
                        } else if let move {
                            Button(other.button) { move(other.mcpId) }
                                .controlSize(.small)
                                .accessibilityLabel(other.accessibilityLabel)
                            if let progress = updates.status[other.mcpId] { Text(progress.words).font(.caption) }
                        }
                        Text(other.footnote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal:false, vertical:true)
                    }
                    .padding(.top, 4)
                }
            }
            if status?.spinning == true { ProgressView().controlSize(.small) }
            if !package.installed {
                Button(failed ? "Try Again" : "Download", action:download)
                    .buttonStyle(.glassProminent).disabled(busy || installedNow)
                    .accessibilityLabel(failed ? "Try downloading \(package.label) again" : "Download \(package.label)")
                    .help("Installs the latest \(package.label) for Counterpart only. Nothing else changes.")
            }
        }
        // One container per MCP: VoiceOver reads its name first, and its Update and Use Counterpart’s buttons belong to it.
        .accessibilityElement(children:.contain)
        .accessibilityLabel(package.label)
        .accessibilityIdentifier("mcp-row-" + package.package)
    }

    private var failed: Bool { if case .failed = status { return true }; if case .problem = status { return true }; return false }
    private var installedNow: Bool { if case .updated = status { return true }; return false }

    @ViewBuilder private func statusLine(_ status: McpUpdateStatus) -> some View {
        switch status {
        case .updated(let version): Text(version.map { "Installed \($0)." } ?? "Installed.").font(.caption).foregroundStyle(Color.okGreen)
        case .updating(_, let to): Text(to.map { "Downloading \($0)…" } ?? "Downloading…").font(.caption).foregroundStyle(.secondary)
        case .failed: Text("The download didn’t finish. Nothing was changed.").font(.caption).foregroundStyle(.red)
        case .problem(let text): Text(text).font(.caption).foregroundStyle(.red)
        default: Text(status.words).font(.caption).foregroundStyle(.secondary)
        }
    }
}

extension PrinterSetupModel {
    /// The package for an MCP name, when the companion listed it.
    func package(_ backend: String) -> PrinterMcpPackage? { packages.first { $0.package == backend } }
    static func label(_ backend: String) -> String { PrinterMCP.label(backend) }
    static func words(_ error: Error, otherwise: String) -> String {
        if let error = error as? ControlRemoteError, !error.message.isEmpty { return error.message }
        return otherwise
    }
}

/// Add printer… (journey M3, MAC-6): printers found on this Mac and the network first, one tap each; then
/// Other Brand… / Enter Address…, all dropdowns except the access code or API key. Check asks the printer before saving.
struct AddPrinterSheet: View {
    @ObservedObject var setup: PrinterSetupModel
    let added: () -> Void
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var updates = PrinterUpdates.shared
    @State private var discovery: PrinterDiscovery?
    @State private var looking = true
    @State private var editing = false
    @State private var form = PrinterForm()
    @State private var check: PrinterCheckResult?
    @State private var checking = false
    @State private var saving: String?
    @State private var problem: String?
    @State private var done: String?
    /// A found folder's model, chosen when Counterpart couldn't tell it.
    @State private var folderModels: [String: String] = [:]
    /// The key being fetched through the MCP (approved in the printer's own page), and the task asking for it.
    @State private var obtaining: ObtainStep?
    @State private var obtainTask: Task<Void, Never>?

    private var options: PrinterSetupOptions? { discovery?.options }
    private var type: PrinterSetupOptions.PrinterType? { options?.types.first { $0.printerType == form.printerType } }
    private var models: [PrinterSetupOptions.Model] { options?.models[form.backend] ?? [] }
    private var missingMcp: PrinterMcpPackage? { setup.package(form.backend).flatMap { $0.installed ? nil : $0 } }
    private var formReady: Bool {
        guard !form.host.trimmingCharacters(in: .whitespaces).isEmpty, missingMcp == nil, form.lacks(type).isEmpty else { return false }
        return type?.secret?.required != true || !form.secret.isEmpty
    }

    var body: some View {
        VStack(spacing:0) {
            Form {
                if let done { finished(done) } else if editing { formSections } else { foundSections }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                if editing && done == nil { Button("Back") { editing = false; check = nil; problem = nil } }
                Spacer()
                if done != nil { Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(.glassProminent) }
                else {
                    Button("Cancel", role:.cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                    if editing {
                        Button(checking ? "Checking…" : "Check") { runCheck() }.disabled(!formReady || checking || saving != nil)
                        Button("Add Printer") { save(form) }.keyboardShortcut(.defaultAction).buttonStyle(.glassProminent)
                            .disabled(!formReady || checking || saving != nil)
                    }
                }
            }
            .padding(16)
        }
        .frame(width:540, height:600)
        .task { await discover() }
        // An MCP downloaded from this sheet brings its own kinds and fields: read them again, so setup goes on here.
        .onChange(of: missingMcp == nil) { _, installed in if installed { Task { await discover() } } }
        .onChange(of:form) { _, _ in check = nil; problem = nil }
    }

    // MARK: Found printers

    @ViewBuilder private var foundSections: some View {
        Section {
            if looking {
                HStack(spacing:8) { ProgressView().controlSize(.small); Text("Looking for printers…").foregroundStyle(.secondary) }
            } else if discovery?.found.isEmpty != false {
                Text("No printers found on this Mac or your network.").foregroundStyle(.secondary)
            }
            ForEach(discovery?.found ?? []) { candidate in candidateRow(candidate) }
        } header: { Text("Found") } footer: {
            ForEach(options?.updates ?? []) { update in Text(update.message).font(.caption).foregroundStyle(.orange) }
            if discovery?.network == "unavailable" {
                Text("Counterpart couldn’t listen for Bambu printers on this network (another app, such as Bambu Studio, may be using it). Enter the address instead.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        if let problem { Section { Text(problem).font(.caption).foregroundStyle(.red) } }
        Section {
            Button("Enter Address…") { start(PrinterForm()) }.disabled(options?.types.isEmpty != false)
            // The next kind the MCPs list after the first: start() picks the MCP that drives it.
            Button("Other Brand…") { var other = PrinterForm(); other.printerType = options?.types.dropFirst().first?.printerType ?? ""; start(other) }
                .disabled((options?.types.count ?? 0) < 2)
        } footer: {
            Text("Bambu Lab printers use bambu-printer-mcp; other brands use mcp-3D-printer-server. Settings for anything else live in each printer’s .env.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func candidateRow(_ candidate: PrinterCandidate) -> some View {
        HStack(spacing:12) {
            Image(systemName:candidate.folder != nil ? "folder" : "printer.fill").font(.title3).frame(width:26)
            VStack(alignment:.leading, spacing:2) {
                Text(candidate.name).font(.body.weight(.medium))
                Text([PrinterSetupModel.label(candidate.backend), candidate.host, candidate.folder.map { ($0 as NSString).abbreviatingWithTildeInPath }]
                    .compactMap { $0 }.joined(separator:" · ")).font(.caption).foregroundStyle(.secondary)
                if candidate.folder != nil {
                    SettingsGapNote(missing:candidate.missing ?? [], fill:fill(for:candidate), modelSetting:candidate.modelSetting(options), route:candidate.route == true)
                }
            }
            Spacer()
            if candidate.added { Text("Added").font(.caption).foregroundStyle(.secondary) }
            else if let folder = candidate.folder {
                if candidate.needsModel(options) {
                    Picker("Model", selection:Binding(get: { folderModels[candidate.id] ?? "" }, set: { folderModels[candidate.id] = $0.isEmpty ? nil : $0 })) {
                        Text("Model…").tag("")
                        ForEach(options?.models[candidate.backend] ?? []) { Text($0.label).tag($0.value) }
                    }
                    .labelsHidden().fixedSize()
                }
                // Configured already: it runs where it is, with its own settings (plus only what its MCP lacks).
                Button(saving == candidate.id ? "Adding…" : "Add") {
                    // Exactly what the row says it will add: the chosen model, else the one Counterpart found.
                    var value = PrinterForm(folder:folder); value.model = folderModels[candidate.id] ?? candidate.filledModel(options)
                    save(value, id:candidate.id)
                }
                .buttonStyle(.glassProminent).disabled(saving != nil || (candidate.needsModel(options) && folderModels[candidate.id] == nil))
            } else {
                Button("Set Up…") { start(prefilled(candidate)) }.disabled(saving != nil)
            }
        }
    }

    /// What Add writes to a found folder's settings: what it would fill, or the model chosen here.
    private func fill(for candidate: PrinterCandidate) -> [String: String] {
        var fill = candidate.fill ?? [:]
        if let chosen = folderModels[candidate.id], let setting = candidate.modelSetting(options) { fill[setting] = chosen }
        return fill
    }

    private func prefilled(_ candidate: PrinterCandidate) -> PrinterForm {
        var form = PrinterForm()
        form.printerType = candidate.printerType
        form.backend = candidate.backend
        form.host = candidate.host ?? ""
        form.port = candidate.port
        form.serial = candidate.serial ?? ""
        form.model = candidate.model
        form.name = candidate.source == "ssdp" ? candidate.name : nil
        return form
    }

    // MARK: The form

    @ViewBuilder private var formSections: some View {
        Section("Printer") {
            Picker("Brand", selection:Binding(get: { form.printerType }, set: { value in
                form.printerType = value
                form.backend = options?.types.first { $0.printerType == value }?.backends.first ?? form.backend
                // A slicer choice belongs to the MCP that offered it; values the new kind's MCP doesn't read go.
                form.model = nil; form.slicer = nil; form.keepFields(of:type); check = nil
            })) {
                ForEach(options?.types ?? []) { Text($0.label).tag($0.printerType) }
            }
            if let field = type?.field("model") {
                Picker(field.label, selection:Binding(get: { form.model ?? "" }, set: { form.model = $0.isEmpty ? nil : $0; check = nil })) {
                    if form.model == nil { Text("Choose…").tag("") }
                    ForEach(models) { Text($0.label).tag($0.value) }
                }
            }
            let address = AddressField(options:options, printerType:form.printerType)
            VStack(alignment:.leading, spacing:4) {
                TextField("Address", text:$form.host, prompt:Text(address.prompt))
                if let hint = address.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
            }
            if type?.field("port") != nil {
                TextField("Port (optional)", text:Binding(get: { form.port ?? "" }, set: { form.port = $0.isEmpty ? nil : $0 }), prompt:Text("Default"))
            }
            if let serialField = type?.field("serial") {
                TextField(serialField.label, text:Binding(get: { form.serial }, set: { value in
                    form.serial = value
                    // The serial names the model (the MCP's own table): filled unless one was chosen.
                    if form.model == nil, let model = options?.model(forSerial:value), models.contains(where: { $0.value == model }) { form.model = model }
                }), prompt:Text(serialField.hint ?? ""))
            }
            if let secret = type?.secret {
                VStack(alignment:.leading, spacing:4) {
                    SecureField(secret.label + (secret.required ? "" : " (optional)"), text:$form.secret)
                    if let hint = secret.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
                }
            }
            if let obtain = ObtainControl(options:options, form:form) { obtainRow(obtain) }
        }
        if let controls = SlicerControls(options:options, backend:form.backend) {
            let slicer = controls.slicer
            // The slicer the MCP would run and where its profiles are, in the MCP's words: set only what it can't find.
            Section {
                if let field = controls.choice {
                    // The slicer the MCP runs, from its own list: chosen with its app below, so the two always agree.
                    Picker(field.label, selection:Binding(get: { controls.selected(in:form) }, set: { controls.choose($0, in:&form) })) {
                        ForEach(field.choices ?? []) { Text($0.label).tag($0.value) }
                    }
                }
                if let field = controls.path {
                    VStack(alignment:.leading, spacing:4) {
                        TextField(field.label + (field.required ? "" : " (optional)"), text:Binding(get: { form.slicerPath ?? "" }, set: { form.slicerPath = $0.isEmpty ? nil : $0 }),
                                  prompt:Text(slicer.path ?? "/Applications/…"))
                        if let hint = field.hint { Text(hint).font(.caption).foregroundStyle(field.required ? .orange : .secondary) }
                    }
                }
                if let field = controls.profiles {
                    VStack(alignment:.leading, spacing:4) {
                        TextField(field.label + (field.required ? "" : " (optional)"), text:Binding(get: { form.profiles ?? "" }, set: { form.profiles = $0.isEmpty ? nil : $0 }),
                                  prompt:Text(slicer.profilesRoot ?? "…/profiles"))
                        if let hint = field.hint { Text(hint).font(.caption).foregroundStyle(field.required ? .orange : .secondary) }
                    }
                }
            } header: { Text("Slicer") }
        }
        if let backends = type?.backends, backends.count > 1 {
            Section {
                Picker("Printer MCP", selection:Binding(get: { form.backend }, set: { form.backend = $0; form.model = nil; form.slicer = nil; check = nil })) {
                    ForEach(backends, id:\.self) { Text(PrinterSetupModel.label($0)).tag($0) }
                }
            } footer: { Text("Counterpart sends this printer’s prints through this MCP.").font(.caption).foregroundStyle(.secondary) }
        }
        if let missing = missingMcp {
            Section {
                McpPackageRow(package:missing, status:updates.status[missing.appMcpId], download:{ setup.download(missing) })
            } footer: { Text("\(missing.label) isn’t on this Mac yet. Download it to add this printer.").font(.caption).foregroundStyle(.secondary) }
        }
        Section { checkResult }
    }

    /// The MCP fetches the key for the person: they approve it in the printer's own page, and it fills the field.
    @ViewBuilder private func obtainRow(_ obtain: ObtainControl) -> some View {
        VStack(alignment:.leading, spacing:6) {
            HStack(spacing:8) {
                Button(obtain.label) { startObtaining(obtain) }
                    .disabled(form.host.trimmingCharacters(in: .whitespaces).isEmpty || obtaining?.pending == true)
                if obtaining?.pending == true { ProgressView().controlSize(.small) }
            }
            if let step = obtaining {
                if step.status == "approved" {
                    Label(step.message, systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                } else {
                    Text(step.message).font(.caption).foregroundStyle(step.status == "failed" ? .orange : .secondary)
                }
                if step.pending, let page = step.approvalPage { Link("Open the approval page", destination:page).font(.caption) }
            } else if let hint = obtain.hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: "\(form.backend)|\(form.printerType)|\(form.host)|\(form.port ?? "")") { stopObtaining() }
        .onDisappear { stopObtaining() }
    }

    private func startObtaining(_ obtain: ObtainControl) {
        stopObtaining()
        let asked = form
        obtainTask = Task {
            do {
                let client = try PrinterSetupModel.client(for:"printers.obtain")
                let last = try await obtainSetupValue(asked, field:obtain.field, step: { try await client.obtainSetupValue($0, field:$1, session:$2) },
                                                      shown: { obtaining = $0 })
                if !Task.isCancelled, last.status == "approved", let value = last.value { form.secret = value; check = nil }
            } catch {
                if !Task.isCancelled { obtaining = ObtainStep(status:"failed", message:PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t ask for the key. Enter it instead.")) }
            }
        }
    }

    private func stopObtaining() { obtainTask?.cancel(); obtainTask = nil; obtaining = nil }

    @ViewBuilder private var checkResult: some View {
        if checking {
            HStack(spacing:8) { ProgressView().controlSize(.small); Text("Asking the printer…").foregroundStyle(.secondary) }
        } else if let check, check.reached {
            VStack(alignment:.leading, spacing:8) {
                if let data = check.image.flatMap({ Data(base64Encoded:$0.base64) }), let image = NSImage(data:data) {
                    Text("Here’s what your printer sees").font(.body.weight(.medium))
                    Image(nsImage:image).resizable().scaledToFit().frame(maxHeight:220).clipShape(.rect(cornerRadius:10))
                } else {
                    Label(check.camera == "failed" ? "Connected. The camera didn’t send a picture." : "Connected. This printer has no camera to show.",
                          systemImage:"checkmark.circle.fill").foregroundStyle(Color.okGreen)
                }
            }
        } else if check != nil {
            Label("Counterpart couldn’t reach the printer. Check the address\(type?.secret == nil ? "" : " and \(type!.secret!.label.lowercased())").",
                  systemImage:"exclamationmark.triangle.fill").foregroundStyle(.orange)
        } else {
            Text("Check asks the printer for its status\(type?.checksCamera(form.backend) == true ? " and a camera picture" : ""). It never starts a print.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if check?.reached != true && !checking && formReady {
            Text(check == nil ? "Not checked yet: Add Printer saves it without reaching the printer." : "Add Printer saves it anyway; Counterpart couldn’t reach it.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
    }

    @ViewBuilder private func finished(_ words: String) -> some View {
        Section { Label(words, systemImage:"checkmark.circle.fill").foregroundStyle(Color.okGreen) }
    }

    // MARK: Actions

    private func start(_ value: PrinterForm) {
        form = value
        // A kind the MCPs list (the first, when none is chosen), and the MCP that drives it on this Mac: never one that isn't installed.
        if let first = options?.types.first, options?.types.contains(where: { $0.printerType == form.printerType }) != true { form.printerType = first.printerType }
        if let backends = options?.types.first(where: { $0.printerType == form.printerType })?.backends,
           !backends.contains(form.backend), let first = backends.first { form.backend = first; form.slicer = nil }
        form.keepFields(of:type)
        if type?.field("model") != nil, form.model == nil, models.count == 1 { form.model = models.first?.value }
        check = nil; problem = nil; editing = true
    }

    private func discover() async {
        looking = true
        await setup.refresh()
        do { discovery = try await PrinterSetupModel.client(for:"printers.discover").discoverPrinters(); problem = nil }
        catch { problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t look for printers. You can still enter an address.") }
        looking = false
    }

    private func runCheck() {
        checking = true; problem = nil
        let value = form
        Task {
            defer { checking = false }
            do {
                let result = try await PrinterSetupModel.client(for:"printers.check").checkPrinter(value)
                guard form == value else { return }
                check = result
            } catch {
                guard form == value else { return }
                problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t run the check. Try again.")
            }
        }
    }

    private func save(_ value: PrinterForm, id: String = "form") {
        saving = id; problem = nil
        Task {
            defer { saving = nil }
            do {
                let result = try await PrinterSetupModel.client(for:"printers.add").addPrinter(value)
                added()
                done = result.destinationId == nil
                    ? "Saved. It shows in Printers once printing is set up on this Mac."
                    : result.sameAs != nil
                    ? "Added. It’s the same printer as one you have, so Counterpart can use either MCP: choose in Settings → Printers → Printer MCP."
                    : value.folder == nil && check?.reached != true ? "Added. Counterpart couldn’t reach the printer yet; it shows as Offline until it can." : "Added."
            } catch { problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t add the printer. Try again.") }
        }
    }
}

/// Which MCP a printer reachable through both uses (`printers.chooseMcp`). Counterpart's own preference.
struct PrinterMcpPicker: View {
    let printer: PrinterDestination
    let changed: () -> Void
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        if let choices = printer.mcps, choices.count > 1 {
            VStack(alignment:.leading, spacing:6) {
                Picker("Printer MCP", selection:Binding(get: { printer.backend }, set: { choose($0) })) {
                    ForEach(choices.map(\.backend), id:\.self) { Text(PrinterSetupModel.label($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(saving)
                Text(problem ?? "This printer is set up in both MCPs. Prints go through this one.")
                    .font(.caption).foregroundStyle(problem == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
            }
        }
    }

    private func choose(_ backend: String) {
        guard backend != printer.backend, !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            do { _ = try await PrinterSetupModel.client(for:"printers.chooseMcp").choosePrinterMcp(printer.id, backend:backend); problem = nil; changed() }
            catch { problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t change the MCP. Try again.") }
        }
    }
}

/// What a found or added printer's `.env` lacks, and what Counterpart adds to it (only the model; never a secret).
/// `modelSetting` is the variable its MCP reads the model from; `route` says the fill copies another MCP's route.
struct SettingsGapNote: View {
    let missing: [String]
    let fill: [String: String]
    let modelSetting: String?
    let route: Bool

    var body: some View {
        let unfilled = missing.filter { fill[$0] == nil }
        let others = unfilled.filter { $0 != modelSetting }
        VStack(alignment:.leading, spacing:2) {
            if !fill.isEmpty {
                Text("Counterpart will add " + fill.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator:", ") + " to its settings.")
                    .font(.caption).foregroundStyle(Color.filament).textSelection(.enabled)
            }
            if route {
                Text("The connection settings are the authenticated route bambu-printer-mcp uses for this printer.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let modelSetting, unfilled.contains(modelSetting) { Text("Choose its model: its MCP needs one.").font(.caption).foregroundStyle(.secondary) }
            if !others.isEmpty {
                Text("Its settings have no " + others.joined(separator:", ") + ". Add \(others.count == 1 ? "it" : "them") in its .env.")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

/// A printer added in Counterpart: its settings file, Complete Settings when its `.env` lacks the model, and Remove.
struct AddedPrinterActions: View {
    let printer: PrinterDestination
    let models: [PrinterSetupOptions.Model]
    let removed: () -> Void
    @State private var confirming = false
    @State private var problem: String?
    @State private var model = ""
    @State private var completing = false

    private var needsModel: Bool { printer.incomplete?.needsModel == true }
    /// Anything to add: a model (filled or chosen here), or settings Counterpart found for this printer.
    private var canComplete: Bool { printer.incomplete.map { incomplete in incomplete.modelSetting.map(incomplete.missing.contains) == true || !incomplete.fill.isEmpty } ?? false }

    var body: some View {
        VStack(alignment:.leading, spacing:6) {
            if let incomplete = printer.incomplete {
                SettingsGapNote(missing:incomplete.missing, fill:model.isEmpty || incomplete.modelSetting == nil ? incomplete.fill : incomplete.fill.merging([incomplete.modelSetting!: model]) { $1 },
                                modelSetting:incomplete.modelSetting, route:incomplete.route == true)
                if canComplete {
                    HStack(spacing:8) {
                        if needsModel {
                            Picker("Model", selection:$model) { Text("Model…").tag(""); ForEach(models) { Text($0.label).tag($0.value) } }
                                .labelsHidden().fixedSize()
                        }
                        Button(completing ? "Completing…" : "Complete Settings") { complete() }
                            .buttonStyle(.glassProminent).controlSize(.small).disabled(completing || (needsModel && model.isEmpty))
                    }
                }
            }
            actions
        }
    }

    private func complete() {
        completing = true
        Task {
            defer { completing = false }
            do {
                try await PrinterSetupModel.client(for:"printers.completeSettings").completePrinterSettings(printer.id, model:model.isEmpty ? nil : model)
                problem = nil; removed()
            } catch { problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t complete its settings. Try again.") }
        }
    }

    private var actions: some View {
        HStack(spacing:12) {
            if let folder = printer.folder {
                let env = URL(fileURLWithPath:folder).appendingPathComponent(".env")
                Button("Show Settings in Finder") { NSWorkspace.shared.activateFileViewerSelecting([env]) }
                    .buttonStyle(.link).font(.caption).help(env.path)
            }
            Button("Remove…", role:.destructive) { confirming = true }.buttonStyle(.link).font(.caption)
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
        }
        .confirmationDialog("Remove \(printer.name)?", isPresented:$confirming) {
            Button("Remove", role:.destructive) { remove() }
        } message: { Text("Counterpart stops using this printer. A printer MCP folder you set up yourself stays where it is.") }
    }

    private func remove() {
        Task {
            do { try await PrinterSetupModel.client(for:"printers.remove").removePrinter(printer.id); problem = nil; removed() }
            catch { problem = PrinterSetupModel.words(error, otherwise:"Counterpart couldn’t remove it. Try again.") }
        }
    }
}

#if DEBUG
/// Review screenshots of Settings → Printer software (#775) from a `printers.mcps` answer, drawn in a window that is never
/// shown (no window on the person's screen, no companion, nothing saved): `ScanToMake --render-printer-software
/// <answer.json> <out.png> [dark]`, then it exits.
@MainActor enum PrinterSoftwareSnapshot {
    static func render(_ arguments: [String]) -> Never {
        struct Reply: Decodable { let packages: [PrinterMcpPackage] }
        do {
            let input = URL(fileURLWithPath:arguments[0]), output = URL(fileURLWithPath:arguments[1])
            let packages = try JSONDecoder().decode(Reply.self, from:Data(contentsOf:input)).packages
            let app = NSApplication.shared
            app.setActivationPolicy(.prohibited)
            app.appearance = NSAppearance(named:arguments.count > 2 && arguments[2] == "dark" ? .darkAqua : .aqua)
            let item = CounterpartKit.SettingsSchema.autoUpdateMcps
            let view = Form {
                Section {
                    Toggle(isOn:.constant(true)) { Text(item.label); Text(item.footer) }
                    ForEach(packages) { package in
                        McpPackageRow(package:package, status:nil, download:{}, update:{}, move:{ _ in })
                    }
                } header: { Text("Printer software") }
            }
            .formStyle(.grouped)
            let size = NSSize(width:620, height:CGFloat(220 + packages.count * 90 + packages.flatMap { $0.moves }.count * 90))
            let host = NSHostingView(rootView:view.frame(width:size.width, height:size.height))
            host.frame = NSRect(origin:.zero, size:size)
            let window = NSWindow(contentRect:NSRect(origin:NSPoint(x:-20_000, y:-20_000), size:size), styleMask:[.borderless], backing:.buffered, defer:false)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until:Date().addingTimeInterval(1.5))
            host.layoutSubtreeIfNeeded()
            guard let bitmap = host.bitmapImageRepForCachingDisplay(in:host.bounds) else { exit(2) }
            host.cacheDisplay(in:host.bounds, to:bitmap)
            try bitmap.representation(using:.png, properties:[:])?.write(to:output)
            exit(0)
        } catch {
            fputs("render-printer-software: \(error)\n", stderr)
            exit(1)
        }
    }
}
#endif
