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
        guard available, let state = try? await Self.client(for:"printers.mcps").printerSetupState() else { return }
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

/// One printer MCP that no printer uses yet: Installed (where, which version) or **Download**.
struct McpPackageRow: View {
    let package: PrinterMcpPackage
    let status: McpUpdateStatus?
    let download: () -> Void

    private var busy: Bool { status?.busy == true }
    private var place: String? {
        guard let install = package.installs.first else { return nil }
        switch install.kind {
        case "app": return "Counterpart’s copy"
        case "npx": return "Run with npx"
        case "folder", "checkout": return install.path.map { ($0 as NSString).abbreviatingWithTildeInPath }
        default: return install.path.map { ($0 as NSString).abbreviatingWithTildeInPath }
        }
    }

    var body: some View {
        HStack(alignment:.top, spacing:10) {
            VStack(alignment:.leading, spacing:3) {
                HStack(spacing:6) {
                    Text(package.label).font(.body.weight(.medium))
                    if package.installed, let version = package.version { Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                Text(package.description).font(.caption).foregroundStyle(.secondary)
                if let status { statusLine(status) }
                else if package.installed {
                    Text(["Installed", place].compactMap { $0 }.joined(separator:" · ") + ". No printer uses it yet.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            if !package.installed {
                Button(failed ? "Try Again" : "Download", action:download)
                    .buttonStyle(.glassProminent).disabled(busy || installedNow)
                    .help("Installs the latest \(package.label) for Counterpart only. Nothing else changes.")
            }
        }
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
    static func label(_ backend: String) -> String { backend == "bambu-printer-mcp" ? "bambu-printer-mcp" : "mcp-3D-printer-server" }
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

    private var options: PrinterSetupOptions? { discovery?.options }
    private var type: PrinterSetupOptions.PrinterType? { options?.types.first { $0.printerType == form.printerType } }
    private var models: [PrinterSetupOptions.Model] { options?.models[form.backend] ?? [] }
    private var missingMcp: PrinterMcpPackage? { setup.package(form.backend).flatMap { $0.installed ? nil : $0 } }
    private var formReady: Bool {
        guard !form.host.trimmingCharacters(in: .whitespaces).isEmpty, missingMcp == nil else { return false }
        if type?.serial == true && (form.serial.isEmpty || form.model == nil) { return false }
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
            if discovery?.network == "unavailable" {
                Text("Counterpart couldn’t listen for Bambu printers on this network (another app, such as Bambu Studio, may be using it). Enter the address instead.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        if let problem { Section { Text(problem).font(.caption).foregroundStyle(.red) } }
        Section {
            Button("Enter Address…") { start(PrinterForm()) }.disabled(options == nil)
            Button("Other Brand…") { var other = PrinterForm(); other.printerType = "octoprint"; other.backend = "mcp-3d-printer-server"; start(other) }
                .disabled(options == nil)
        } footer: {
            Text("Bambu Lab printers use bambu-printer-mcp; other brands use mcp-3D-printer-server. Settings for anything else live in each printer’s .env.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func candidateRow(_ candidate: PrinterCandidate) -> some View {
        HStack(spacing:12) {
            Image(systemName:candidate.folder != nil ? "folder" : candidate.printerType == "bambu" ? "printer.fill" : "printer").font(.title3).frame(width:26)
            VStack(alignment:.leading, spacing:2) {
                Text(candidate.name).font(.body.weight(.medium))
                Text([PrinterSetupModel.label(candidate.backend), candidate.host, candidate.folder.map { ($0 as NSString).abbreviatingWithTildeInPath }]
                    .compactMap { $0 }.joined(separator:" · ")).font(.caption).foregroundStyle(.secondary)
                if candidate.folder != nil { SettingsGapNote(missing:candidate.missing ?? [], fill:fill(for:candidate)) }
            }
            Spacer()
            if candidate.added { Text("Added").font(.caption).foregroundStyle(.secondary) }
            else if let folder = candidate.folder {
                if candidate.needsModel {
                    Picker("Model", selection:Binding(get: { folderModels[candidate.id] ?? "" }, set: { folderModels[candidate.id] = $0.isEmpty ? nil : $0 })) {
                        Text("Model…").tag("")
                        ForEach(options?.models[candidate.backend] ?? []) { Text($0.label).tag($0.value) }
                    }
                    .labelsHidden().fixedSize()
                }
                // Configured already: it runs where it is, with its own settings (plus only what its MCP lacks).
                Button(saving == candidate.id ? "Adding…" : "Add") {
                    // Exactly what the row says it will add: the chosen model, else the one Counterpart found.
                    var value = PrinterForm(folder:folder); value.model = folderModels[candidate.id] ?? candidate.fill?["BAMBU_MODEL"]
                    save(value, id:candidate.id)
                }
                .buttonStyle(.glassProminent).disabled(saving != nil || (candidate.needsModel && folderModels[candidate.id] == nil))
            } else {
                Button("Set Up…") { start(prefilled(candidate)) }.disabled(saving != nil)
            }
        }
    }

    /// What Add writes to a found folder's settings: what it would fill, or the model chosen here.
    private func fill(for candidate: PrinterCandidate) -> [String: String] {
        var fill = candidate.fill ?? [:]
        if let chosen = folderModels[candidate.id] { fill["BAMBU_MODEL"] = chosen }
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
                form.model = nil; check = nil
            })) {
                ForEach(options?.types ?? []) { Text($0.label).tag($0.printerType) }
            }
            if type?.serial == true {
                Picker("Model", selection:Binding(get: { form.model ?? "" }, set: { form.model = $0.isEmpty ? nil : $0; check = nil })) {
                    if form.model == nil { Text("Choose…").tag("") }
                    ForEach(models) { Text($0.label).tag($0.value) }
                }
            }
            TextField("Address", text:$form.host, prompt:Text("192.168.1.20 or printer.local"))
            if form.printerType != "bambu" {
                TextField("Port (optional)", text:Binding(get: { form.port ?? "" }, set: { form.port = $0.isEmpty ? nil : $0 }), prompt:Text("Default"))
            }
            if type?.serial == true {
                TextField("Serial number", text:Binding(get: { form.serial }, set: { value in
                    form.serial = value
                    // The serial names the model (bambu-printer-mcp's table): filled unless one was chosen.
                    if form.model == nil, let model = options?.model(forSerial:value), models.contains(where: { $0.value == model }) { form.model = model }
                }), prompt:Text("On the printer: Settings → Device"))
            }
            if let secret = type?.secret {
                VStack(alignment:.leading, spacing:4) {
                    SecureField(secret.label + (secret.required ? "" : " (optional)"), text:$form.secret)
                    Text(secret.hint).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if let backends = type?.backends, backends.count > 1 {
            Section {
                Picker("Printer MCP", selection:Binding(get: { form.backend }, set: { form.backend = $0; form.model = nil; check = nil })) {
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
            Text("Check asks the printer for its status\(form.printerType == "bambu" ? " and a camera picture" : ""). It never starts a print.")
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
        if form.printerType == "bambu", form.model == nil, models.count == 1 { form.model = models.first?.value }
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
struct SettingsGapNote: View {
    let missing: [String]
    let fill: [String: String]

    var body: some View {
        let unfilled = missing.filter { fill[$0] == nil }
        let others = unfilled.filter { $0 != "BAMBU_MODEL" }
        VStack(alignment:.leading, spacing:2) {
            if !fill.isEmpty {
                Text("Counterpart will add " + fill.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator:", ") + " to its settings.")
                    .font(.caption).foregroundStyle(Color.filament).textSelection(.enabled)
            }
            if fill["BAMBU_DEFAULT_CONNECTION_MODE"] != nil {
                Text("The connection settings are the authenticated route bambu-printer-mcp uses for this printer.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if unfilled.contains("BAMBU_MODEL") { Text("Choose its model: its MCP needs one.").font(.caption).foregroundStyle(.secondary) }
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

    private var needsModel: Bool { printer.incomplete?.missing.contains("BAMBU_MODEL") == true && printer.incomplete?.fill["BAMBU_MODEL"] == nil }
    /// Anything to add: a model (filled or chosen here), or settings Counterpart found for this printer.
    private var canComplete: Bool { printer.incomplete.map { $0.missing.contains("BAMBU_MODEL") || !$0.fill.isEmpty } ?? false }

    var body: some View {
        VStack(alignment:.leading, spacing:6) {
            if let incomplete = printer.incomplete {
                SettingsGapNote(missing:incomplete.missing, fill:model.isEmpty ? incomplete.fill : incomplete.fill.merging(["BAMBU_MODEL": model]) { $1 })
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
