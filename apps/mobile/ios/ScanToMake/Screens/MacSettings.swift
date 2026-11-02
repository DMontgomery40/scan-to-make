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
        for id in ids {
            do { try await store.mac.client.removeDevice(id) }
            catch let failure as CompanionError { refusal = failure.message; break } catch { break }
        }
        devices = try? await store.mac.client.devices()
    }

    func update(_ printer: PrinterDestination, fresh: Bool = false) async {
        guard let mcpId = printer.mcpId, working == nil else { return }
        working = "mcp." + mcpId; refusal = nil
        defer { working = nil }
        do { store.mcpUpdates[mcpId] = MCPUpdateProgress(try await store.mac.client.updateMCP(mcpId, fresh: fresh)) }
        catch let failure as CompanionError { refusal = failure.message } catch {}
        await store.loadPrinters()
    }
}

/// Settings → Notifications: this iPhone's switches and the Mac's, and the progress updates (PRD §9.1).
struct MacNotificationSettings: View {
    @Environment(AppModel.self) private var app
    let model: MacSettingsModel

    var body: some View {
        List {
            // Skipped or denied: Turn On, or the way to iOS Settings.
            NotificationPermissionRow()
            if let settings = model.settings, settings.isFull, let deviceId = model.deviceId {
                Section {
                    ForEach(SettingsSchema.notificationTypes) { type in
                        toggle(type.label, settings.phoneNotifies(type.id, deviceId: deviceId)) { on in
                            SettingsPatch.phoneNotification(type.id, on, deviceId: deviceId)
                        }.disabled(true)
                    }
                } header: { Text("Saved iPhone preferences") } footer: {
                    Text(app.cloud.alertsMessage + " Your saved choices are kept. Use iOS Settings to control all alerts.")
                }
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
        .task { await model.load() }
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

    // MARK: Printers

    private var printers: some View {
        Section {
            ForEach(model.store.catalog?.destinations ?? []) { printer in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(printer.name).font(.headline)
                        Spacer()
                        Text(PrinterWords.state(printer, store: model.store)).font(.caption).foregroundStyle(printer.isReady == true ? Color.okGreen : .secondary)
                    }
                    Text([printer.via, printer.capabilities?.server?.version].compactMap { $0 }.joined(separator: " ")).font(.caption).foregroundStyle(.secondary)
                    if let missing = printer.capabilities?.update?.message { Text(missing).font(.caption).foregroundStyle(.secondary) }
                    if let progress = printer.mcpId.flatMap({ model.store.mcpUpdates[$0] }) {
                        HStack(spacing: 6) {
                            if progress.isRunning { ProgressView().controlSize(.small) }
                            Text(progress.words).font(.caption).foregroundStyle(progress.state == "failed" ? .red : .secondary)
                        }
                        if progress.state == "unresolved" {
                            Button("Install a Fresh Copy") { Task { await model.update(printer, fresh: true) } }.font(.caption.weight(.semibold))
                        }
                    }
                    if model.store.macCapabilities.contains("mcpUpdates"), let words = printer.updateWords,
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
            Picker("AI", selection: Binding(get: { ai.choice?.kind ?? "none" }, set: { kind in Task { await model.chooseAI(kind) } })) {
                ForEach(SettingsSchema.aiKinds.filter { $0.fromPhone || $0.kind == ai.choice?.kind }, id: \.kind) { Text($0.label).tag($0.kind) }
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
        } header: { Text("AI") } footer: {
            Text("An API key or your own endpoint is chosen on \(model.macName), where its key is kept.")
        }
    }

    private func checkWords(_ check: CompanionSettings.AI.Check) -> String {
        if check.outcome == "needs-gui-session" { return "Finish signing in on \(model.macName)" }
        switch check.state {
        case "connected": return "Connected"
        case "checking": return "Testing…"
        case "skipped": return "Off"
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
                if fusion.state == "not-set-up" {
                    Button("Set Up") { Task { await model.setUpFusion() } }.disabled(model.working != nil)
                }
            }
        } header: { Text("Design with Fusion") }
    }

    // MARK: Phones and iPads

    @ViewBuilder private var devicesSection: some View {
        let current = (model.devices ?? []).filter { $0.legacy != true }
        let older = (model.devices ?? []).filter { $0.legacy == true }
        Section {
            ForEach(current) { device in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.deviceName ?? device.model ?? "A phone").font(.body)
                        Text(device.current == true ? "This iPhone" : (device.lastSeenAt.flatMap(ISO.date).map { "Seen " + Format.whenInSentence($0) } ?? "Paired"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if device.current != true {
                        Button("Remove", role: .destructive) { Task { await model.remove([device.deviceId]) } }.disabled(model.working != nil)
                    }
                }
            }
        } header: { Text("Phones and iPads") }
        if !older.isEmpty {
            Section {
                ForEach(older) { device in Text(device.deviceName ?? "An older pairing").foregroundStyle(.secondary) }
                Button("Remove All", role: .destructive) { confirmRemoveAll = true }.disabled(model.working != nil)
            } header: { Text("Older pairings") } footer: { Text("Pairings from before this version. They can't connect any more.") }
            .confirmationDialog("Remove \(older.count) older pairings?", isPresented: $confirmRemoveAll, titleVisibility: .visible) {
                Button("Remove All", role: .destructive) { Task { await model.remove(older.map(\.deviceId)) } }
            }
        }
    }

    // MARK: General

    private func generalSection(_ general: CompanionSettings.General?) -> some View {
        Section {
            ForEach(SettingsSchema.general, id: \.key) { item in
                Toggle(item.label, isOn: Binding(get: { general?[item.key] ?? true },
                                                 set: { on in Task { await model.change(item.key, SettingsPatch.general(item.key, on)) } }))
            }
        } header: { Text("General") } footer: { Text("Each one changes \(model.macName).") }
        .disabled(model.working != nil)
    }
}
