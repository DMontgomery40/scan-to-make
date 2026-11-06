import SwiftUI
import CounterpartKit

/// Add Printer (PRD §5.8, §6.1): the Mac's Add printer… on the iPhone and iPad. The printers the MCPs found come first,
/// one tap each and filled in from discovery; the form asks only what discovery can't know (an access code or API key).
/// Every brand, field, label and hint is the printer MCPs' own (`counterpart_setup_fields`); Check and Add are the
/// companion's `printers.check` and `printers.add`, the same calls the Mac and Linux make.
struct AddPrinterView: View {
    let store: ProjectsStore
    let added: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var model: AddPrinterModel

    init(store: ProjectsStore, added: @escaping () -> Void) {
        self.store = store; self.added = added
        let model = AddPrinterModel(client: store.mac.client)
        model.macName = store.macName ?? "your Mac"
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack(path: $model.path) {
            List {
                if let done = model.done { AddPrinterDone(words: done) } else { found }
            }
            .navigationTitle("Add Printer")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: AddPrinterModel.Step.self) { _ in AddPrinterForm(model: model, added: added) }
            .refreshable { await model.discover() }
            .toolbar {
                if model.done != nil {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("add-printer-done") }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } }
                }
            }
        }
        .task { await model.discover() }
        .onDisappear { model.stopObtaining() }
    }

    @ViewBuilder private var found: some View {
        Section {
            if model.looking && model.discovery == nil {
                HStack(spacing: 10) { ProgressView(); Text("Looking for printers…").foregroundStyle(.secondary) }
            } else if model.discovery?.found.isEmpty != false {
                Text("No printers found on \(store.macName ?? "your Mac")’s network.").foregroundStyle(.secondary)
            }
            ForEach(model.discovery?.found ?? []) { candidate in AddPrinterCandidateRow(model: model, candidate: candidate, added: added) }
        } header: { Text("Found") } footer: {
            if model.discovery?.network == "unavailable" {
                Text("\(store.macName ?? "Your Mac") couldn’t listen for printers on this network (another app may be using it). Enter the address instead.")
            }
        }
        if let problem = model.problem { Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) } }
        if let updates = model.options?.updates, !updates.isEmpty {
            Section { ForEach(updates) { Label($0.message, systemImage: "arrow.down.circle").foregroundStyle(Color.filament) } }
        }
        Section {
            Button { model.start(PrinterForm()) } label: { Label("Enter Details…", systemImage: "square.and.pencil") }
                .disabled(model.options?.types.isEmpty != false)
                .accessibilityIdentifier("add-printer-manual")
        } footer: {
            Text("Each printer MCP lists the printers it can drive and the settings it needs. \(store.macName ?? "Your Mac") keeps them in that MCP’s own settings.")
        }
    }
}

/// One printer the MCPs found: Set Up… opens the form filled in from discovery; a configured MCP folder adds in one tap.
private struct AddPrinterCandidateRow: View {
    let model: AddPrinterModel
    let candidate: PrinterCandidate
    let added: () -> Void

    var body: some View {
        if candidate.added || candidate.folder != nil {
            content.accessibilityElement(children: .contain)
        } else {
            Button { model.start(model.prefilled(candidate)) } label: { content }
                .tint(.primary)
                .accessibilityIdentifier("add-printer-found-\(candidate.id)")
        }
    }

    private var content: some View {
        HStack(spacing: 14) {
            Image(systemName: candidate.folder != nil ? "folder" : "printer.fill").font(.title3).frame(width: 44, height: 44)
                .glassEffect(.regular, in: .rect(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.name).font(.headline).foregroundStyle(.primary)
                Text([candidate.host, model.label(candidate.backend)].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)
                if candidate.folder != nil, let missing = candidate.missing, !missing.isEmpty {
                    Text("Its settings lack \(missing.joined(separator: ", ")).").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if candidate.added {
                Text("Added").font(.subheadline).foregroundStyle(.secondary)
            } else if let folder = candidate.folder {
                if candidate.needsModel(model.options) {
                    Picker("Model", selection: Binding(get: { model.folderModels[candidate.id] ?? "" }, set: { model.folderModels[candidate.id] = $0.isEmpty ? nil : $0 })) {
                        Text("Model…").tag("")
                        ForEach(model.options?.models[candidate.backend] ?? []) { Text($0.label).tag($0.value) }
                    }
                    .labelsHidden().fixedSize()
                }
                Button(model.saving == candidate.id ? "Adding…" : "Add") {
                    var value = PrinterForm(folder: folder); value.model = model.folderModels[candidate.id] ?? candidate.filledModel(model.options)
                    Task { await model.save(value, id: candidate.id, added: added) }
                }
                .buttonStyle(.glassProminent)
                .disabled(model.saving != nil || (candidate.needsModel(model.options) && model.folderModels[candidate.id] == nil))
                .accessibilityIdentifier("add-printer-folder-\(candidate.id)")
            } else {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The form: the chosen MCP's own fields, in its words. Only what discovery couldn't fill is left to type.
private struct AddPrinterForm: View {
    @Bindable var model: AddPrinterModel
    let added: () -> Void
    @FocusState private var focused: String?

    private var type: PrinterSetupOptions.PrinterType? { model.type }

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if let done = model.done { AddPrinterDone(words: done) } else { printer; mcp; slicer; checkSection }
            }
            .accessibilityIdentifier("add-printer-form")
            // Check's answer comes into view, even in the iPad's shorter sheet.
            .onChange(of: model.check) { _, check in if check != nil { withAnimation { proxy.scrollTo("add-printer-check-result", anchor: .bottom) } } }
            .onChange(of: model.problem) { _, problem in if problem != nil { withAnimation { proxy.scrollTo("add-printer-check-result", anchor: .bottom) } } }
        }
        .navigationTitle(model.form.name ?? type?.label ?? "Printer")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.done == nil {
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.saving == "form" ? "Adding…" : "Add") { Task { await model.save(model.form, added: added) } }
                        .disabled(!model.formReady || model.checking || model.saving != nil)
                        .accessibilityIdentifier("add-printer-add")
                }
            }
        }
        .onChange(of: model.form) { _, _ in model.formChanged() }
        // The one thing left to type gets the keyboard, unless the MCP can fetch it (its approval button stays in view).
        .onAppear { if model.secretMissing && ObtainControl(options: model.options, form: model.form) == nil { focused = "secret" } }
    }

    @ViewBuilder private var printer: some View {
        Section {
            Picker("Brand", selection: Binding(get: { model.form.printerType }, set: { model.choose(type: $0) })) {
                ForEach(model.options?.types ?? []) { Text($0.label).tag($0.printerType) }
            }
            if type?.serial == true {
                Picker(type?.field("model")?.label ?? "Model", selection: Binding(get: { model.form.model ?? "" }, set: { model.form.model = $0.isEmpty ? nil : $0 })) {
                    if model.form.model == nil { Text("Choose…").tag("") }
                    ForEach(model.models) { Text($0.label).tag($0.value) }
                }
            }
            field("host", label: type?.field("host")?.label ?? "Address") {
                TextField(type?.field("host")?.label ?? "Address", text: $model.form.host, prompt: Text("192.168.1.20"))
                    .keyboardType(type?.field("host")?.input == "url" ? .URL : .asciiCapable)
            }
            if type?.field("port") != nil {
                field("port", label: type?.field("port")?.label ?? "Port") {
                    TextField(type?.field("port")?.label ?? "Port", text: Binding(get: { model.form.port ?? "" }, set: { model.form.port = $0.isEmpty ? nil : $0 }), prompt: Text("Default"))
                        .keyboardType(.numberPad)
                }
            }
            if type?.serial == true {
                field("serial", label: type?.field("serial")?.label ?? "Serial number") {
                    TextField(type?.field("serial")?.label ?? "Serial number", text: Binding(get: { model.form.serial }, set: { model.type(serial: $0) }))
                        .textInputAutocapitalization(.characters)
                }
            }
            if let secret = type?.secret {
                VStack(alignment: .leading, spacing: 6) {
                    LabeledContent(secret.label) {
                        SecureField(secret.label, text: $model.form.secret, prompt: Text(secret.required ? "Required" : "Optional"))
                            .multilineTextAlignment(.trailing)
                            // A printer's code, not a website password: no Passwords bar, no "Save Password?" after Add.
                            .textContentType(.oneTimeCode)
                            .focused($focused, equals: "secret")
                            .accessibilityIdentifier("add-printer-secret")
                    }
                    if let hint = secret.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
                }
                if let obtain = ObtainControl(options: model.options, form: model.form) { obtainRow(obtain) }
            }
        } header: { Text("Printer") } footer: {
            if model.prefilledFromDiscovery { Text("Filled in from what \(model.label(model.form.backend)) found on the network.") }
        }
    }

    /// A labelled text field (the MCP's label, so a filled-in value still says what it is), with the MCP's hint under it.
    @ViewBuilder private func field<Content: View>(_ name: String, label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent(label) {
                content().multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(name == "serial" ? .characters : .never).autocorrectionDisabled()
                    .accessibilityIdentifier("add-printer-\(name)")
            }
            if let hint = type?.field(name)?.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private func obtainRow(_ obtain: ObtainControl) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button(obtain.label) { model.startObtaining(obtain) }
                    .buttonStyle(.glass)
                    .disabled(model.form.host.trimmingCharacters(in: .whitespaces).isEmpty || model.obtaining?.pending == true)
                    .accessibilityIdentifier("add-printer-obtain")
                if model.obtaining?.pending == true { ProgressView() }
            }
            if let step = model.obtaining {
                Text(step.message).font(.caption)
                    .foregroundStyle(step.status == "failed" ? AnyShapeStyle(.orange) : step.status == "approved" ? AnyShapeStyle(Color.okGreen) : AnyShapeStyle(.secondary))
                if step.pending, let page = step.approvalPage { Link("Open the approval page", destination: page).font(.caption) }
            } else if let hint = obtain.hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var mcp: some View {
        if let backends = type?.backends, backends.count > 1 {
            Section {
                Picker("Printer MCP", selection: Binding(get: { model.form.backend }, set: { model.choose(backend: $0) })) {
                    ForEach(backends, id: \.self) { Text(model.label($0)).tag($0) }
                }
            } footer: { Text("Counterpart sends this printer’s prints through this MCP.") }
        }
    }

    /// The slicer the MCP would run, in its words; its paths only when the MCP can't find them.
    @ViewBuilder private var slicer: some View {
        if let controls = SlicerControls(options: model.options, backend: model.form.backend) {
            let slicer = controls.slicer
            Section {
                if let choice = controls.choice {
                    Picker(choice.label, selection: Binding(get: { controls.selected(in: model.form) }, set: { controls.choose($0, in: &model.form) })) {
                        ForEach(choice.choices ?? []) { Text($0.label).tag($0.value) }
                    }
                }
                if !slicer.found, let path = controls.path {
                    pathField(path, text: Binding(get: { model.form.slicerPath ?? "" }, set: { model.form.slicerPath = $0.isEmpty ? nil : $0 }), prompt: slicer.path)
                }
                if slicer.profilesFound == false, let profiles = controls.profiles {
                    pathField(profiles, text: Binding(get: { model.form.profiles ?? "" }, set: { model.form.profiles = $0.isEmpty ? nil : $0 }), prompt: slicer.profilesRoot)
                }
            } header: { Text("Slicer") } footer: {
                if !slicer.found || slicer.profilesFound == false { Text("\(model.label(model.form.backend)) couldn’t find these on \(model.macName). Enter where they are there, or leave them for later.") }
            }
        }
    }

    private func pathField(_ field: PrinterSetupOptions.Field, text: Binding<String>, prompt: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(field.label + (field.required ? "" : " (optional)"))
            TextField(field.label + (field.required ? "" : " (optional)"), text: text, prompt: prompt.map { Text($0) })
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            if let hint = field.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private var checkSection: some View {
        Section {
            Button { Task { await model.runCheck() } } label: {
                HStack { Text(model.checking ? "Asking the printer…" : "Check Connection"); if model.checking { Spacer(); ProgressView() } }
            }
            .disabled(!model.formReady || model.checking || model.saving != nil)
            .accessibilityIdentifier("add-printer-check")
            if let check = model.check, check.reached {
                if let data = check.image.flatMap({ Data(base64Encoded: $0.base64) }), let image = UIImage(data: data) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Connected. Here’s what your printer sees.", systemImage: "checkmark.circle.fill").foregroundStyle(Color.okGreen)
                        Image(uiImage: image).resizable().scaledToFit().clipShape(.rect(cornerRadius: 12))
                    }
                } else {
                    Label(check.camera == "failed" ? "Connected. The camera didn’t send a picture." : "Connected.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Color.okGreen).accessibilityIdentifier("add-printer-connected")
                }
            } else if model.check != nil {
                Label("Counterpart couldn’t reach the printer. Check the address\(type?.secret.map { " and \($0.label.lowercased())" } ?? "").",
                      systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            if let problem = model.problem { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
            Color.clear.frame(height: 1).listRowBackground(Color.clear).listRowSeparator(.hidden).listRowInsets(EdgeInsets()).id("add-printer-check-result").accessibilityHidden(true)
        } footer: {
            if model.check?.reached != true && !model.checking {
                Text(model.formReady
                     ? (model.check == nil ? "Check asks the printer for its status through its MCP. It never starts a print. Add saves it either way." : "Add saves it anyway; it shows as Offline until Counterpart can reach it.")
                     : model.missingWords)
            }
        }
    }
}

private struct AddPrinterDone: View {
    let words: String
    var body: some View {
        Section {
            Label(words, systemImage: "checkmark.circle.fill").foregroundStyle(Color.okGreen).font(.headline)
                .accessibilityIdentifier("add-printer-added")
        }
    }
}

/// Add Printer's state: discovery, the form, Check, the MCP's approval flow and Add, all through the companion.
@MainActor @Observable final class AddPrinterModel {
    enum Step: Hashable { case form }
    let client: CompanionClient
    var path: [Step] = []
    var discovery: PrinterDiscovery?
    var looking = false
    var problem: String?
    var form = PrinterForm()
    var prefilledFromDiscovery = false
    var check: PrinterCheckResult?
    var checking = false
    var saving: String?
    var done: String?
    var obtaining: ObtainStep?
    var folderModels: [String: String] = [:]
    var macName = "your Mac"
    private var obtainTask: Task<Void, Never>?
    private var checkedForm: PrinterForm?

    init(client: CompanionClient) { self.client = client }

    var options: PrinterSetupOptions? { discovery?.options }
    var type: PrinterSetupOptions.PrinterType? { options?.types.first { $0.printerType == form.printerType } }
    var models: [PrinterSetupOptions.Model] { options?.models[form.backend] ?? [] }
    var secretMissing: Bool { type?.secret?.required == true && form.secret.isEmpty }
    var formReady: Bool {
        guard !form.host.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if type?.serial == true && (form.serial.trimmingCharacters(in: .whitespaces).isEmpty || form.model == nil) { return false }
        return !secretMissing
    }
    /// What the form still needs, in the MCP's words.
    var missingWords: String {
        var missing: [String] = []
        if form.host.trimmingCharacters(in: .whitespaces).isEmpty { missing.append(type?.field("host")?.label ?? "Address") }
        if type?.serial == true && form.serial.trimmingCharacters(in: .whitespaces).isEmpty { missing.append(type?.field("serial")?.label ?? "Serial number") }
        if type?.serial == true && form.model == nil { missing.append(type?.field("model")?.label ?? "Model") }
        if secretMissing, let secret = type?.secret { missing.append(secret.label) }
        return missing.isEmpty ? "" : "Still needed: " + missing.joined(separator: ", ") + "."
    }

    func label(_ backend: String) -> String { backend == "bambu-printer-mcp" ? "bambu-printer-mcp" : "mcp-3D-printer-server" }

    func discover() async {
        looking = true
        defer { looking = false }
        do { discovery = try await client.discoverPrinters(); problem = nil }
        catch { problem = Self.words(error, otherwise: "Counterpart couldn’t look for printers. You can still enter the details.") }
    }

    func prefilled(_ candidate: PrinterCandidate) -> PrinterForm {
        var form = PrinterForm()
        form.printerType = candidate.printerType
        form.backend = candidate.backend
        form.host = candidate.host ?? ""
        form.port = candidate.port
        form.serial = candidate.serial ?? ""
        form.model = candidate.model
        form.name = candidate.name
        return form
    }

    /// Opens the form: a found printer's values, or the first brand the MCPs list.
    func start(_ value: PrinterForm) {
        var value = value
        prefilledFromDiscovery = !value.host.isEmpty
        if !prefilledFromDiscovery, let first = options?.types.first, options?.types.contains(where: { $0.printerType == value.printerType }) != true {
            value.printerType = first.printerType
        }
        if let backends = options?.types.first(where: { $0.printerType == value.printerType })?.backends, !backends.contains(value.backend), let first = backends.first {
            value.backend = first
        }
        form = value
        if type?.serial == true, form.model == nil, models.count == 1 { form.model = models.first?.value }
        check = nil; problem = nil; stopObtaining()
        path = [.form]
    }

    func choose(type value: String) {
        form.printerType = value
        form.backend = options?.types.first { $0.printerType == value }?.backends.first ?? form.backend
        form.model = nil; form.slicer = nil
    }

    func choose(backend: String) { form.backend = backend; form.model = nil; form.slicer = nil }

    /// The serial names the model (the MCP's own table), unless one was chosen.
    func type(serial value: String) {
        form.serial = value
        if form.model == nil, let model = options?.model(forSerial: value), models.contains(where: { $0.value == model }) { form.model = model }
    }

    /// A changed printer drops the last check, and stops asking for a key for the old one.
    func formChanged() {
        if check != nil, checkedForm != form { check = nil }
        if let asked = obtainFor, asked.host != form.host || asked.port != form.port || asked.printerType != form.printerType || asked.backend != form.backend { stopObtaining() }
    }

    func runCheck() async {
        checking = true; problem = nil
        let value = form
        defer { checking = false }
        do {
            let result = try await client.checkPrinter(value)
            guard form == value else { return }
            check = result; checkedForm = value
        } catch {
            guard form == value else { return }
            problem = Self.words(error, otherwise: "Counterpart couldn’t run the check. Try again.")
        }
    }

    func save(_ value: PrinterForm, id: String = "form", added: () -> Void) async {
        saving = id; problem = nil
        defer { saving = nil }
        do {
            let result = try await client.addPrinter(value)
            stopObtaining()
            added()
            done = result.destinationId == nil
                ? "Saved. It shows in Printers once printing is set up on \(macName)."
                : result.sameAs != nil
                ? "Added. It’s the same printer as one you have, so Counterpart can use either MCP: choose on the printer’s page."
                : value.folder == nil && check?.reached != true ? "Added. Counterpart couldn’t reach it yet; it shows as Offline until it can." : "Added."
            path = []
        } catch { problem = Self.words(error, otherwise: "Counterpart couldn’t add the printer. Try again.") }
    }

    // MARK: The MCP fetches the value (`obtain`, e.g. "Approve in OctoPrint")

    private var obtainFor: PrinterForm?

    func startObtaining(_ obtain: ObtainControl) {
        stopObtaining()
        let asked = form
        obtainFor = asked
        let client = client
        obtainTask = Task { [weak self] in
            do {
                let last = try await obtainSetupValue(asked, field: obtain.field, step: { try await client.obtainSetupValue($0, field: $1, session: $2) },
                                                      shown: { step in self?.obtaining = step })
                if !Task.isCancelled, last.status == "approved", let value = last.value { self?.form.secret = value }
            } catch {
                if !Task.isCancelled { self?.obtaining = ObtainStep(status: "failed", message: Self.words(error, otherwise: "Counterpart couldn’t ask for it. Enter it instead.")) }
            }
        }
    }

    func stopObtaining() { obtainTask?.cancel(); obtainTask = nil; obtaining = nil; obtainFor = nil }

    nonisolated static func words(_ error: Error, otherwise: String) -> String {
        if let error = error as? CompanionError, !error.message.isEmpty { return error.message }
        return otherwise
    }
}
