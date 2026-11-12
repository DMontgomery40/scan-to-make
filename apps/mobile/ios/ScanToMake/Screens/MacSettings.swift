import SwiftUI
import CounterpartKit

/// Every setting the Mac has, on the phone (PRD §5.9, docs/protocols/settings.md): a window onto the companion's
/// settings, never a copy. Values are read on appear, after each change and on `settings.changed`.
@MainActor @Observable final class MacSettingsModel {
    var settings: CompanionSettings?
    var devices: [CompanionDevice]?
    /// What the Mac said no to, or an action that failed. It stays until the next change.
    var refusal: String?
    /// The last read failed. The next read that works clears it.
    var readFailure: String?
    var problem: String? { refusal ?? readFailure }
    var working: String?
    let store: ProjectsStore

    init(store: ProjectsStore) { self.store = store }

    var deviceId: String? { store.connection?.deviceId }
    var macName: String { store.macName ?? "your Mac" }

    /// Reads the Mac's values. A refusal from the last change stays on screen.
    func load() async {
        do { settings = try await store.mac.client.settings(); readFailure = nil }
        catch let failure as CompanionError { readFailure = failure.isUnsupported ? nil : failure.message }
        catch { readFailure = CompanionError.unreachable.message }
        if settings?.isFull == true { devices = try? await store.mac.client.devices() }
    }

    /// One change, then the companion's values (it's the source of truth). A sentence it refuses with is shown as is.
    @discardableResult func change(_ key: String, _ patch: [String: Any]) async -> Bool {
        guard working == nil else { return false }
        working = key; refusal = nil
        defer { working = nil }
        do { settings = try await store.mac.client.changeSettings(patch); readFailure = nil; return true }
        catch let failure as CompanionError { refusal = failure.message; await load(); return false }
        catch { refusal = CompanionError.unreachable.message; return false }
    }

    /// A new AI choice, then its test. A choice the Mac refuses keeps its reason and isn't tested.
    func chooseAI(_ kind: String) async {
        if await change("ai", SettingsPatch.ai(kind: kind, expectedRevision: settings?.ai?.revision)) { await testAI() }
    }

    func testAI() async {
        guard let revision = settings?.ai?.revision, working == nil else { return }
        working = "ai.test"; refusal = nil
        defer { working = nil }
        do { try await store.mac.client.testAI(revision: revision) } catch let failure as CompanionError { refusal = failure.message } catch {}
        // The check runs on the Mac; read it as it goes.
        for _ in 0..<20 where !Task.isCancelled {
            await load()
            if settings?.ai?.check?.state != "checking" { break }
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    func setUpFusion() async {
        guard working == nil else { return }
        working = "fusion"; refusal = nil
        defer { working = nil }
        do { try await store.mac.client.setUpFusion(); await load() }
        catch let failure as CompanionError { refusal = failure.message } catch {}
    }

    func remove(_ ids: [String]) async {
        guard working == nil else { return }
        working = "devices"; refusal = nil
        defer { working = nil }
        for id in ids where id != deviceId && devices?.first(where: { $0.deviceId == id })?.current != true {
            do { try await store.mac.client.removeDevice(id) }
            catch let failure as CompanionError { refusal = failure.message; break } catch { break }
        }
        devices = try? await store.mac.client.devices()
    }

    func update(_ printer: PrinterDestination, fresh: Bool = false) async {
        guard let mcpId = printer.mcpId, working == nil else { return }
        working = "mcp." + mcpId; refusal = nil
        defer { working = nil }
        do { store.recordMCPUpdate(mcpId, MCPUpdateProgress(try await store.mac.client.updateMCP(mcpId, fresh: fresh))) }
        catch let failure as CompanionError { refusal = failure.message } catch {}
        await store.loadPrinters()
    }
}

/// Settings → Notifications: this iPhone's alerts and the Mac's switches, and the progress updates
/// (PRD §9.1). Per-event switches for this iPhone aren't ready yet, so instead of a disabled list
/// (F9) the top says so in one sentence and links to the app's iOS notification settings; the Mac's
/// own switches below are live.
struct MacNotificationSettings: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let model: MacSettingsModel

    var body: some View {
        List {
            // Skipped or denied: Turn On, or the way to iOS Settings.
            NotificationPermissionRow()
            Section {
                Text("Counterpart sends every alert to this iPhone; turn them off in iOS Settings → Notifications.")
                Button("Open Notification Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
                .accessibilityIdentifier("open-notification-settings")
            } footer: {
                Text(app.cloud.alertsMessage + " Your saved choices are kept.")
            }
            if let settings = model.settings, settings.notifications != nil {
                Section {
                    ForEach(SettingsSchema.notificationTypes) { type in
                        toggle(type.label, settings.macNotifies(type.id)) { on in SettingsPatch.macNotification(type.id, on) }
                    }
                } header: { Text("On \(model.macName)") }
            }
            Section {
                Picker("Progress updates", selection: Binding(get: { model.settings?.milestones ?? "50" },
                                                               set: { value in Task { await model.change("milestones", SettingsPatch.milestones(value)) } })) {
                    ForEach(SettingsSchema.milestones, id: \.value) { Text($0.label).tag($0.value) }
                }
                .pickerStyle(.menu)
            } footer: {
                if let problem = model.problem { Text(problem).foregroundStyle(.red) }
                else { Text("Sent from your Mac through iCloud, so use the same Apple Account on both.") }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(model.working != nil)
        .task { await app.refreshCloud(); await model.load() }
    }

    private func toggle(_ label: String, _ on: Bool, _ patch: @escaping (Bool) -> [String: Any]) -> some View {
        Toggle(label, isOn: Binding(get: { on }, set: { value in Task { await model.change(label, patch(value)) } }))
    }
}

/// The Settings sections that change the Mac (PRD §5.9): printers, AI, Fusion, phones and iPads, general.
struct MacSettingsSections: View {
    let model: MacSettingsModel
    @State private var confirmRemoveAll = false

    var body: some View {
        printers
        Section("Printer software") {
            autoUpdateSwitch
            MCPCopiesView(store: model.store)
        }
        // PRD §8.9: the printer MCP's code design engine; hidden when the computer's companion predates it.
        CodeEngineSettingsSection { action in try await model.store.mac.client.codeEngine(action) }
        if model.store.macCapabilities.contains("blenderAddon") {
            BlenderAddonSettingsSection { action in try await model.store.mac.client.blenderAddon(action) }
        }
        if let settings = model.settings, settings.isFull {
            if let ai = settings.ai { aiSection(ai) }
            if let fusion = settings.fusion { fusionSection(fusion) }
            devicesSection
            generalSection(settings.general)
        }
        if let problem = model.problem {
            Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.subheadline) }
        }
    }

    // MARK: Printer software

    /// Q9, `general.autoUpdateMcps`: beside the MCP copies and their Update buttons, as on the Mac (Settings → Printers),
    /// Linux (Printer tools) and Android (Printers). Only when the Mac sends it; an older companion has no automatic updates.
    @ViewBuilder private var autoUpdateSwitch: some View {
        let item = SettingsSchema.autoUpdateMcps
        if let on = model.settings?.general?.autoUpdateMcps {
            VStack(alignment: .leading, spacing: 6) {
                Toggle(item.label, isOn: Binding(get: { on },
                    set: { value in Task { await model.change(item.key, SettingsPatch.general(item.key, value)) } }))
                    .accessibilityIdentifier("auto-update-mcps")
                    .disabled(model.working != nil)
                Text(item.footer).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("auto-update-mcps-words")
            }
        }
    }

    // MARK: Printers

    private var printers: some View {
        Section {
            ForEach(model.store.catalog?.destinations ?? []) { printer in
                VStack(alignment: .leading, spacing: 6) {
                    NavigationLink {
                        PrinterDetailView(store: model.store, id: printer.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(printer.name).font(.headline)
                                Spacer()
                                Text(PrinterWords.state(printer, store: model.store)).font(.caption).foregroundStyle(printer.isReady == true ? Color.okGreen : .secondary)
                            }
                            Text([printer.via, printer.capabilities?.server?.version].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let missing = printer.capabilities?.update?.message { Text(missing).font(.caption).foregroundStyle(.secondary) }
                    if let progress = printer.mcpId.flatMap({ model.store.mcpUpdates[$0] }) {
                        HStack(spacing: 6) {
                            if progress.isWorking { ProgressView().controlSize(.small) }
                            Text(progress.words).font(.caption).foregroundStyle(progress.state == "failed" ? .red : .secondary)
                        }
                        if progress.state == "unresolved" {
                            Button("Install a Fresh Copy") { Task { await model.update(printer, fresh: true) } }.font(.caption.weight(.semibold))
                        }
                    }
                    if !model.store.macCapabilities.contains("mcpCopies"), model.store.macCapabilities.contains("mcpUpdates"), let words = printer.updateWords,
                       !(printer.mcpId.flatMap { model.store.mcpUpdates[$0]?.isRunning } ?? false) {
                        Button { Task { await model.update(printer) } } label: { Text("Update · \(words)").fontWeight(.semibold) }
                            .buttonStyle(.glassProminent).controlSize(.small)
                            .disabled(model.working != nil)
                    }
                }
                .padding(.vertical, 2)
            }
        } header: { Text("Printers") } footer: {
            Text("They come from bambu-printer-mcp and mcp-3D-printer-server on \(model.macName). Updates run there.")
        }
    }

    // MARK: AI

    private func aiSection(_ ai: CompanionSettings.AI) -> some View {
        Section {
            Picker("AI provider", selection: Binding(get: { ai.choice?.kind ?? "none" }, set: { kind in Task { await model.chooseAI(kind) } })) {
                ForEach(SettingsSchema.aiKinds.filter { $0.fromPhone || $0.kind == ai.choice?.kind }, id: \.kind) { Text($0.kind == "none" ? "Off" : $0.label).tag($0.kind) }
            }
            .pickerStyle(.menu)
            HStack {
                if let check = ai.check {
                    if check.state == "checking" { ProgressView().controlSize(.small) }
                    Text(checkWords(check)).font(.subheadline).foregroundStyle(check.state == "connected" ? Color.okGreen : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Not tested yet").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Test") { Task { await model.testAI() } }.disabled(model.working != nil || ai.revision == nil)
            }
        } header: { Text("AI model jobs") } footer: {
            Text("Save and test an AI connection on \(model.macName). New scan cleanup, designs and corrections use this choice. Jobs already running keep their provider. API keys and endpoints are set up on the Mac, where keys stay.")
        }
    }

    private func checkWords(_ check: CompanionSettings.AI.Check) -> String {
        if check.outcome == "needs-gui-session" { return "Finish signing in on \(model.macName)" }
        switch check.state {
        case "connected": return "Connected"
        case "checking": return "Testing…"
        case "skipped": return "AI off"
        default: return check.message ?? "Not connected"
        }
    }

    // MARK: Fusion

    private func fusionSection(_ fusion: CompanionSettings.Fusion) -> some View {
        Section {
            HStack {
                if fusion.state == "setting-up" { ProgressView().controlSize(.small) }
                Text(fusion.message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                Spacer()
                if fusion.state == "not-set-up" || fusion.state == "not-running" || fusion.state == "connected" {
                    Button(fusion.state == "not-set-up" ? "Set Up" : "Set Up Again") { Task { await model.setUpFusion() } }.disabled(model.working != nil)
                }
            }
        } header: { Text("Design with Fusion · Optional") }
        .task(id: fusion.state) {
            guard fusion.state == "setting-up" else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await model.load()
                if model.settings?.fusion?.state != "setting-up" { return }
            }
        }
    }

    // MARK: Phones and iPads

    @ViewBuilder private var devicesSection: some View {
        let isCurrent: (CompanionDevice) -> Bool = { $0.current == true || $0.deviceId == model.deviceId }
        let current = (model.devices ?? []).filter { $0.legacy != true || isCurrent($0) }
        let older = (model.devices ?? []).filter { $0.legacy == true && !isCurrent($0) }
        Section {
            ForEach(current) { device in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.deviceName ?? device.model ?? "A phone").font(.body)
                        TimelineView(.periodic(from: .now, by: 15)) { context in
                            Text(isCurrent(device) ? "This iPhone" : device.connectedNow(at: context.date) ? "Connected" : (device.lastSeenAt.flatMap(ISO.date).map { "Seen " + Format.whenInSentence($0, now: context.date) } ?? "Not seen yet"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if !isCurrent(device) {
                        Button("Remove", role: .destructive) { Task { await model.remove([device.deviceId]) } }.disabled(model.working != nil)
                    }
                }
            }
        } header: { Text("Phones and iPads") }
        if !older.isEmpty {
            Section {
                ForEach(older) { device in Text(device.deviceName ?? "An older pairing").foregroundStyle(.secondary) }
                Button("Remove All", role: .destructive) { confirmRemoveAll = true }.disabled(model.working != nil)
            } header: { Text("Older connections") } footer: { Text("Remove these only if you no longer use those devices. They'll need to connect again.") }
            .confirmationDialog("Remove \(older.count) older pairings?", isPresented: $confirmRemoveAll, titleVisibility: .visible) {
                Button("Remove All", role: .destructive) { Task { await model.remove(older.map(\.deviceId)) } }
            }
        }
    }

    // MARK: General

    private func generalSection(_ general: CompanionSettings.General?) -> some View {
        Section {
            ForEach(SettingsSchema.general, id: \.key) { item in
                if let value = general?[item.key] {
                    Toggle(item.label, isOn: Binding(get: { value },
                        set: { on in Task { await model.change(item.key, SettingsPatch.general(item.key, on)) } }))
                }
            }
            if general == nil || SettingsSchema.general.allSatisfy({ general?[$0.key] == nil }) {
                Text("Open Counterpart on your Mac to share its current General settings.").foregroundStyle(.secondary)
            }
        } header: { Text("General") } footer: { Text("Each one changes \(model.macName).") }
        .disabled(model.working != nil)
    }
}


/// Shared by Settings and Printers on compact and regular-width layouts.
struct MCPCopiesView: View {
    let store: ProjectsStore
    var printerId: String? = nil
    @State private var working: String?
    @State private var problem: String?
    private var packages: [MCPPackageCopies] {
        (store.mcpCopies ?? []).filter { package in printerId == nil || package.uses.contains { $0.printerId == printerId } }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(packages) { package in
                VStack(alignment: .leading, spacing: 6) {
                    Text(package.label).font(.headline)
                    if let copy = package.appCopy { Text("Counterpart’s copy \(copy.version ?? "version unknown")").font(.caption) }
                    ForEach(package.uses.filter { printerId == nil || $0.printerId == printerId }) { use in
                        Text(use.words).font(.footnote).fixedSize(horizontal: false, vertical: true)
                    }
                    if store.macCapabilities.contains("mcpUpdates") {
                        // In the order the uses above are listed, each titled by its printers, MCP and copy.
                        ForEach(package.moves.filter { move in printerId == nil || package.uses.contains { $0.printerId == printerId && $0.mcpId == move.mcpId } }, id: \.mcpId) { move in
                            Button(move.title) { Task { await update(move.mcpId, fresh: true, moveTitle: move.title) } }
                                .disabled(working != nil || store.mcpCopiesProblem != nil || store.mcpUpdates[move.mcpId]?.isRunning == true)
                                .accessibilityIdentifier("mcp-move-" + move.mcpId)
                            if store.attemptedMcpMoves[move.mcpId] == nil { progress(move.mcpId) }
                        }
                        if package.appCopy != nil {
                            Button("Update Counterpart’s copy") { Task { await update(package.appMcpId, fresh: false) } }
                                .disabled(working != nil || store.mcpCopiesProblem != nil || store.mcpUpdates[package.appMcpId]?.isRunning == true)
                                .accessibilityLabel("Update Counterpart’s copy of \(package.label)")
                            progress(package.appMcpId)
                        }
                    }
                }
                // One container per MCP: VoiceOver reads its name first, and its buttons belong to it.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(package.label)
                .accessibilityIdentifier("mcp-package-" + package.package)
            }
            ForEach(store.attemptedMcpMoves.keys.sorted(), id: \.self) { id in
                VStack(alignment: .leading, spacing: 4) {
                    if let title = store.attemptedMcpMoves[id] { Text(title).font(.caption).foregroundStyle(.secondary) }
                    progress(id)
                }
            }
            if !packages.isEmpty { Text("Moving updates Counterpart’s copy and uses it for the named printers. Your copy is left untouched.").font(.caption).foregroundStyle(.secondary) }
            if let problem = problem ?? store.mcpCopiesProblem { Text(problem).font(.footnote).foregroundStyle(.orange) }
            if !store.macCapabilities.contains("mcpCopies") { Text("Update Counterpart on your computer to see each printer’s software copy.").font(.footnote) }
        }
        .buttonStyle(.borderless)
        .task { await store.loadCapabilities(); await store.loadMCPCopies() }
    }
    @ViewBuilder private func progress(_ id: String) -> some View {
        if let progress = store.mcpUpdates[id] { Text(progress.words).font(.caption) }
    }
    private func update(_ id: String, fresh: Bool, moveTitle: String? = nil) async {
        guard working == nil else { return }
        working = id; problem = nil
        if let moveTitle { store.attemptedMcpMoves[id] = moveTitle }
        defer { working = nil }
        do { store.recordMCPUpdate(id, MCPUpdateProgress(try await store.mac.client.updateMCP(id, fresh: fresh))); await store.loadMCPCopies() }
        catch let failure as CompanionError { problem = failure.message }
        catch { problem = CompanionError.unreachable.message }
    }
}
