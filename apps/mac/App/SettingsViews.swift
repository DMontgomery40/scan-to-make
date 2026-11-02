import SwiftUI
import AppKit
import ServiceManagement
import UniformTypeIdentifiers
import AgentKit
#if canImport(ControlKit)
import ControlKit
#endif

extension MacStatusModel {
    static let shared: MacStatusModel = {
        #if DEBUG
        if let source = DesignFixtures.macStatus() { return MacStatusModel(source:source) }
        #endif
        let installation = Installation(bundle:.main)
        return MacStatusModel(source:SocketMacStatus(path:ModelAccessModel.socketPath(for:installation),
                                                     settings:installation.state.appendingPathComponent("auth/auth.json")))
    }()
}

enum AppVersion {
    static var version: String { Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "—" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "—" }
}

// Settings (PRD §7.5, screens/mac-settings-*.jpg and mac-devices.jpg): a real Settings scene with toolbar tabs.

enum SettingsTab: String { case general, devices, printers, ai, advanced }

struct SettingsView: View {
    @ObservedObject var mac: MacStatusModel
    @ObservedObject var cleanup: ModelAccessModel
    @ObservedObject var objects: ObjectsModel
    @State private var tab = SettingsTab.initial

    var body: some View {
        TabView(selection:$tab) {
            Tab("General", systemImage:"gearshape", value:.general) { GeneralSettings() }
            Tab("Phones and iPads", systemImage:"iphone", value:.devices) { DevicesSettings(mac:mac) }
            Tab("Printers", systemImage:"printer", value:.printers) { PrintersSettings(objects:objects) }
            Tab("AI", systemImage:"sparkles", value:.ai) { AISettings(model:cleanup) }
            Tab("Advanced", systemImage:"wrench.and.screwdriver", value:.advanced) { AdvancedSettings(mac:mac) }
        }
        .frame(width:620)
        .tint(.filament)
        .task { await mac.refresh() }
    }
}

extension SettingsTab {
    @MainActor static var initial: SettingsTab {
        #if DEBUG
        if DesignFixtures.assets != nil, DesignFixtures.screen.hasPrefix("settings-"),
           let tab = SettingsTab(rawValue:String(DesignFixtures.screen.dropFirst("settings-".count)).replacingOccurrences(of:"-nofusion", with:"")) {
            return tab
        }
        #endif
        return .general
    }
}

// MARK: General

struct GeneralSettings: View {
    @State private var login = SMAppService.mainApp.status == .enabled
    @State private var loginProblem: String?
    @State private var dock = DockIcon.shown
    @State private var switches: [NotificationSwitch: Bool] = Dictionary(uniqueKeysWithValues:NotificationSwitch.allCases.map { ($0, NotificationPrefs().isOn($0)) })
    @State private var progress = NotificationPrefs().progress

    var body: some View {
        Form {
            Section {
                Toggle(isOn:Binding(get:{ login }, set:{ setLogin($0) })) {
                    Text("Open at login")
                    Text(loginProblem ?? "Your phone only gets updates while Counterpart is running.")
                }
                Toggle("Show in Dock", isOn:Binding(get:{ dock }, set:{ dock = $0; UserDefaults.standard.set($0, forKey:DockIcon.key); DockIcon.apply() }))
            }
            Section {
                ForEach(NotificationSwitch.ordered) { item in
                    Toggle(item.title, isOn:Binding(get:{ switches[item] ?? item.defaultOn }, set:{ switches[item] = $0; NotificationPrefs().set(item, $0) }))
                    if item == .firstLayer {
                        Picker("Progress", selection:Binding(get:{ progress }, set:{ progress = $0; NotificationPrefs().progress = $0 })) {
                            ForEach(ProgressNotifications.allCases) { Text($0.title).tag($0) }
                        }
                    }
                }
            } header: { Text("Notifications on this Mac") } footer: {
                Text(NotificationPrefs.delivered ? "Progress is off on the Mac by default. Your iPhone has its own switches in its Settings."
                     : "Mac notifications start with the event relay in the next update. Your iPhone has its own switches in its Settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .disabled(!NotificationPrefs.delivered)
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:620)
    }

    private func setLogin(_ on: Bool) {
        loginProblem = nil
        // Remembered, so the next launch doesn't register it again behind the person's back.
        UserDefaults.standard.set(!on, forKey:"openAtLoginOff")
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            loginProblem = "Allow Counterpart in System Settings → General → Login Items."
        }
        login = SMAppService.mainApp.status == .enabled
    }
}

// MARK: Phones and iPads

struct DevicesSettings: View {
    @ObservedObject var mac: MacStatusModel
    @Environment(\.openWindow) private var openWindow
    @State private var removing: DeviceGroup?
    @State private var removingOlder: DeviceGroup?

    var body: some View {
        Form {
            Section {
                if mac.groups.isEmpty {
                    Text(mac.connection == .notRunning ? "Your phones show here while Counterpart is running." : "No phone is paired yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(mac.groups) { group in
                    DeviceRow(group:group) { removing = group }
                    if group.older > 0 {
                        HStack {
                            Text("\(group.older) older pairing\(group.older == 1 ? "" : "s") with this name, last used \(Date(timeIntervalSince1970:group.olderSeenAt / 1000).formatted(.dateTime.month(.abbreviated).day()))")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("Remove Older…") { removingOlder = group }
                        }
                        .padding(.leading, 42)
                    }
                }
                if let problem = mac.problem { Text(problem).foregroundStyle(.red) }
                Button("Add a Phone…") { NSApp.activate(); openWindow(id:"pairing") }
            } header: { Text("Phones and iPads") } footer: {
                Text("Pairing a phone again replaces its row. It never adds a second one.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:300)
        // A phone paired in the Add a Phone window shows here as soon as Settings is in front again.
        .onReceive(NotificationCenter.default.publisher(for:NSWindow.didBecomeKeyNotification)) { _ in Task { await mac.refresh() } }
        .onChange(of:PairingFlow.shared.finished) { _, done in if done { Task { await mac.refresh() } } }
        .confirmationDialog(removing.map { "Remove “\($0.primary.deviceName)”?" } ?? "Remove?",
                            isPresented:Binding(get:{ removing != nil }, set:{ if !$0 { removing = nil } }),
                            titleVisibility:.visible, presenting:removing) { group in
            Button("Remove", role:.destructive) { Task { await mac.remove([group.primary.deviceId]) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("It can’t reach this Mac until you pair it again.")
        }
        .confirmationDialog(removingOlder.map { "Remove \($0.older) older pairing\($0.older == 1 ? "" : "s") of “\($0.primary.deviceName)”?" } ?? "Remove?",
                            isPresented:Binding(get:{ removingOlder != nil }, set:{ if !$0 { removingOlder = nil } }),
                            titleVisibility:.visible, presenting:removingOlder) { group in
            Button("Remove Older Pairings", role:.destructive) { Task { await mac.remove(Array(group.ids.dropFirst())) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("They haven’t been used since this phone paired again. A phone that still uses one will need pairing again.")
        }
    }
}

private struct DeviceRow: View {
    let group: DeviceGroup
    let remove: () -> Void
    var body: some View {
        TimelineView(.periodic(from:.now, by:30)) { context in
            HStack(spacing:12) {
                Image(systemName:group.kind == "iPad" ? "ipad" : "iphone").font(.title2).frame(width:30)
                VStack(alignment:.leading, spacing:2) {
                    Text(group.primary.deviceName).font(.body.weight(.medium))
                    Text(group.detail(at:context.date)).font(.caption)
                        .foregroundStyle(group.connectedNow(at:context.date) ? Color.okGreen : .secondary)
                }
                Spacer()
                Button("Remove…", action:remove)
            }
        }
    }
}

// MARK: Printers (read-only: they come from the user's MCP configs)

struct PrintersSettings: View {
    @ObservedObject var objects: ObjectsModel
    @State private var updating: Set<String> = []
    @State private var updateResult: [String: String] = [:]

    private var printers: [PrinterDestination] { objects.printerCatalog?.destinations ?? [] }

    var body: some View {
        Form {
            Section {
                if printers.isEmpty {
                    Text("No printer found. Counterpart uses the printers in your bambu-printer-mcp or mcp-3D-printer-server settings.")
                        .foregroundStyle(.secondary)
                }
                ForEach(printers) { printer in
                    HStack(spacing:12) {
                        Image(systemName:printer.mcpName == "bambu-printer-mcp" ? "printer.fill" : "printer").font(.title3).frame(width:26)
                        VStack(alignment:.leading, spacing:2) {
                            Text([printer.name, printer.model].compactMap { $0 }.joined(separator:" · ")).font(.body.weight(.medium))
                            Text([printer.mcpName, printer.address].compactMap { $0 }.joined(separator:" · ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        ReadyDot(state:printer.state)
                        Text(Self.readiness(printer.state)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: { Text("Printers") } footer: {
                Text("Counterpart reads these from your MCP configs and never changes them. Add or edit printers there.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Printer MCPs") {
                ForEach(PrinterMCP.list(printers)) { mcp in
                    MCPRow(mcp:mcp, updating:updating.contains(mcp.id), result:updateResult[mcp.id]) { update(mcp) }
                }
                if PrinterMCP.list(printers).isEmpty { Text("None found yet.").foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:590)
        .task { await objects.refresh() }
    }

    static func readiness(_ state: String?) -> String {
        switch state { case "ready": return "Ready"; case "busy": return "Busy"; case "offline": return "Offline"; default: return "Not checked yet" }
    }

    /// Runs the MCP's own package-manager update, as the companion describes it. Never anything else.
    private func update(_ mcp: PrinterMCP) {
        guard let command = mcp.update?.command, !command.isEmpty else { return }
        updating.insert(mcp.id)
        updateResult[mcp.id] = nil
        Task {
            let ok = await PrinterMCP.run(command)
            updating.remove(mcp.id)
            updateResult[mcp.id] = ok ? "Updated. Counterpart uses it from the next print." : "The update didn’t finish. Try \(command.joined(separator:" ")) in Terminal."
            await objects.refresh()
        }
    }
}

/// One printer MCP install, from the destinations that use it.
struct PrinterMCP: Identifiable, Equatable {
    let name: String
    let version: String?
    let origin: String?
    let printers: [String]
    let update: PrinterCapabilities.Update?
    let missing: [String]
    var id: String { "\(name)|\(origin ?? "")|\(version ?? "")" }

    static func == (a: PrinterMCP, b: PrinterMCP) -> Bool { a.id == b.id && a.printers == b.printers }

    static func list(_ printers: [PrinterDestination]) -> [PrinterMCP] {
        let grouped = Dictionary(grouping:printers) { "\($0.mcpName)|\($0.origin ?? "")|\($0.capabilities?.server?.version ?? "")" }
        return grouped.values.map { members in
            let first = members[0]
            return PrinterMCP(name:first.mcpName, version:first.capabilities?.server?.version, origin:first.origin, printers:members.map(\.name),
                              update:members.compactMap { $0.capabilities?.update }.first, missing:first.capabilities?.missing ?? [])
        }
        .sorted { $0.name == $1.name ? ($0.origin ?? "") < ($1.origin ?? "") : $0.name < $1.name }
    }

    /// Where its config lives, as people know it.
    var source: String {
        switch origin {
        case "printer-handoff": return "Counterpart · printer-handoff.json"
        case "claude-code": return "Claude Code · ~/.claude.json"
        case "claude-desktop": return "Claude Desktop · claude_desktop_config.json"
        case "cursor": return "Cursor · ~/.cursor/mcp.json"
        case "codemode": return "Codemode"
        case "codex": return "Codex · ~/.codex/config.toml"
        default: return "Your MCP settings"
        }
    }

    @MainActor var configURL: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        switch origin {
        case "printer-handoff": return Installation(bundle:.main).state.appendingPathComponent("printer-handoff.json")
        case "claude-code": return home.appendingPathComponent(".claude.json")
        case "claude-desktop": return home.appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json")
        case "cursor": return home.appendingPathComponent(".cursor/mcp.json")
        case "codex": return home.appendingPathComponent(".codex/config.toml")
        default: return nil
        }
    }

    /// The package manager's own command, through a login shell so it finds the user's npm or uv.
    static func run(_ command: [String]) async -> Bool {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath:"/bin/zsh")
            process.arguments = ["-lc", command.map { "'" + $0.replacingOccurrences(of:"'", with:"'\\''") + "'" }.joined(separator:" ")]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return false }
            process.waitUntilExit()
            return process.terminationStatus == 0
        }.value
    }
}

private struct MCPRow: View {
    let mcp: PrinterMCP
    let updating: Bool
    let result: String?
    let update: () -> Void
    var body: some View {
        HStack(spacing:10) {
            VStack(alignment:.leading, spacing:2) {
                HStack(spacing:6) {
                    Text(mcp.name).font(.body.weight(.medium))
                    if let version = mcp.version { Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                Text(mcp.source + (mcp.printers.count == 1 ? " · used by \(mcp.printers[0])" : "")).font(.caption).foregroundStyle(.secondary)
                if let message = mcp.update?.message { Text(message).font(.caption.weight(.medium)).foregroundStyle(Color.filament) }
                if let result { Text(result).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if updating { ProgressView().controlSize(.small) }
            if mcp.update?.command?.isEmpty == false { Button("Update", action:update).buttonStyle(.glassProminent).disabled(updating) }
            if let url = mcp.configURL {
                Button("Show Config") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            }
        }
    }
}

// MARK: AI

struct AISettings: View {
    @ObservedObject var model: ModelAccessModel
    @State private var other = false
    @State private var fusion = FusionState.checking
    @State private var fusionProblem: String?
    @AppStorage("ai.lastTestAt") private var lastTestAt: Double = 0
    @AppStorage("ai.lastTestSeconds") private var lastTestSeconds: Double = 0
    @State private var testStarted: Date?

    enum FusionState: Equatable { case checking, notInstalled, found, settingUp, setUp }

    private var choice: ModelAccessChoice { model.snapshot?.choice ?? .none }

    var body: some View {
        Form {
            Section("Touch-ups and designs") {
                Picker("Provider", selection:Binding(get:{ provider }, set:{ pick($0) })) {
                    Text("Claude · your subscription").tag("claude")
                    Text("Codex · your subscription").tag("codex")
                    if choice.isAPIKey || choice.isEndpoint { Text(choice.displayName + " · your key").tag("other") }
                    Text("Other…").tag("pick-other")
                    Divider()
                    Text("No AI").tag("none")
                }
                .disabled(model.saving || model.unavailable)
                LabeledContent("Status") { status }
                LabeledContent("Last test") {
                    HStack(spacing:10) {
                        Text(lastTest).foregroundStyle(.secondary)
                        Button("Test") { testStarted = Date(); Task { await model.checkAgain() } }
                            .disabled(choice == .none || model.status == .checking)
                    }
                }
                if let problem = model.problem { Text(problem).font(.caption).foregroundStyle(.red) }
            }
            Section {
                HStack(alignment:.center, spacing:12) {
                    Image(systemName:"cube.transparent.fill").font(.title2).foregroundStyle(fusion == .notInstalled ? .secondary : Color.filament)
                        .frame(width:40, height:40).glassEffect(.regular, in:.rect(cornerRadius:10))
                    VStack(alignment:.leading, spacing:2) {
                        Text("Design with Fusion").font(.body.weight(.semibold))
                        switch fusion {
                        case .checking: Text("Looking for Fusion…").font(.caption).foregroundStyle(.secondary)
                        case .notInstalled: Label("Fusion isn't installed", systemImage:"minus.circle").font(.caption).foregroundStyle(.secondary)
                        case .found, .settingUp: Label("Fusion found", systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                        case .setUp: Label("Fusion is set up", systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                        }
                    }
                    Spacer()
                    if fusion == .settingUp { ProgressView().controlSize(.small) }
                    Button(fusion == .setUp ? "Set Up Again…" : "Set Up…") { setUpFusion() }
                        .buttonStyle(.glassProminent).disabled(fusion != .found && fusion != .setUp)
                }
                Text(fusion == .notInstalled
                     ? "New designs use Blender. Install Autodesk Fusion (its personal-use licence is free) and Set Up turns on."
                     : "Set Up adds the Fusion360MCP add-in to Fusion, and five FUSION_MCP settings next to Blender's in your printer MCP's env file. New designs then use Fusion when it's running.")
                    .font(.caption).foregroundStyle(.secondary)
                if let fusionProblem { Text(fusionProblem).font(.caption).foregroundStyle(.red) }
                LabeledContent("Make something that fits") {
                    Text(fusion == .notInstalled ? "Blender" : "Fusion, or Blender if Fusion can't start").foregroundStyle(.secondary)
                }
                LabeledContent("Copy something") { Text("Blender, always").foregroundStyle(.secondary) }
            } header: { Text("Design engine") } footer: {
                Text("Fusion and its licence are yours. Counterpart never ships or requires it. The bridge is fusion360-mcp-server by Faust Machines (MIT).")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:500)
        .task { await model.refresh(); checkFusion() }
        .onChange(of:model.status) { _, status in
            guard status == .connected, let started = testStarted else { return }
            lastTestAt = Date().timeIntervalSince1970
            lastTestSeconds = Date().timeIntervalSince(started)
            testStarted = nil
        }
        .sheet(isPresented:$other) {
            VStack(alignment:.leading) {
                ModelAccessPane(model:model, context:.settings)
                HStack { Spacer(); Button("Done") { other = false }.keyboardShortcut(.defaultAction) }
            }
            .padding(24).frame(width:520, height:560)
        }
    }

    private var provider: String {
        switch choice {
        case .claudeCode: return "claude"
        case .codexCLI: return "codex"
        case .none: return "none"
        default: return "other"
        }
    }

    private func pick(_ tag: String) {
        switch tag {
        case "claude": testStarted = Date(); Task { await model.choose(.claudeCode) }
        case "codex": testStarted = Date(); Task { await model.choose(.codexCLI) }
        case "none": Task { await model.choose(.none) }
        case "pick-other": other = true
        default: break
        }
    }

    @ViewBuilder private var status: some View {
        switch model.status {
        case .connected: Label("Connected", systemImage:"checkmark.circle.fill").foregroundStyle(Color.okGreen)
        case .checking: HStack(spacing:6) { ProgressView().controlSize(.small); Text("Checking…").foregroundStyle(.secondary) }
        case .failed(let text): Label(text, systemImage:"exclamationmark.circle.fill").foregroundStyle(.red)
        case .idle: Text(choice == .none ? "Off" : model.unavailable ? "Counterpart isn’t running" : "Not tested yet").foregroundStyle(.secondary)
        }
    }

    private var lastTest: String {
        guard lastTestAt > 0 else { return "Not tested yet" }
        let when = Date(timeIntervalSince1970:lastTestAt)
        let day = Calendar.current.isDateInToday(when) ? "Today" : when.formatted(.dateTime.month(.abbreviated).day())
        return "\(day) at \(when.formatted(date:.omitted, time:.shortened)) · \(String(format:"%.1f", lastTestSeconds)) s"
    }

    private func checkFusion() {
        #if DEBUG
        if DesignFixtures.assets != nil { fusion = DesignFixtures.screen == "settings-ai-nofusion" ? .notInstalled : .found; return }
        #endif
        let state = Installation(bundle:.main).state
        if FusionSetup.installedFusion() == nil { fusion = .notInstalled }
        else { fusion = FusionSetup.isSetUp(state:state) ? .setUp : .found }
    }

    private func setUpFusion() {
        fusion = .settingUp
        fusionProblem = nil
        let state = Installation(bundle:.main).state
        Task {
            do {
                let changed = try await FusionSetup.install(state:state)
                fusion = .setUp
                fusionProblem = nil
                _ = changed
            } catch {
                fusion = .found
                fusionProblem = error.localizedDescription
            }
        }
    }
}

// MARK: Advanced

struct AdvancedSettings: View {
    @ObservedObject var mac: MacStatusModel
    @State private var exporting = false
    @State private var exportProblem: String?
    private let addresses = NetworkAddresses.current()

    private var state: URL { Installation(bundle:.main).state }

    var body: some View {
        Form {
            Section {
                ForEach(rows, id:\.address) { row in
                    HStack {
                        VStack(alignment:.leading, spacing:2) {
                            Text(row.address).font(.body.monospacedDigit())
                            Text(row.detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if row.inUse {
                            HStack(spacing:5) { Circle().fill(Color.okGreen).frame(width:7); Text("In use now").font(.caption).foregroundStyle(Color.okGreen) }
                        }
                    }
                }
            } header: { Text("Addresses your phone uses") } footer: {
                Text("Your phone tries these in order and remembers the one that worked. They change by themselves; there's nothing to set.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Logs") {
                LabeledContent("Companion") {
                    HStack { Text("companion.log").foregroundStyle(.secondary); Button("Show in Finder") { reveal(state.appendingPathComponent("logs/companion.log")) } }
                }
                LabeledContent("Events") {
                    HStack { Text("events.ndjson · 7 days").foregroundStyle(.secondary); Button("Show in Finder") { reveal(state.appendingPathComponent("events.ndjson")) } }
                }
            }
            Section {
                LabeledContent {
                    HStack {
                        if exporting { ProgressView().controlSize(.small) }
                        Button("Export Diagnostics…") { export() }.disabled(exporting)
                    }
                } label: {
                    Text("Diagnostics")
                    Text(exportProblem ?? "A zip of logs and settings with tokens and keys removed. Nothing is sent anywhere.")
                }
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:560)
    }

    private struct Row { let address: String; let detail: String; let inUse: Bool }
    private var rows: [Row] {
        let host = mac.address.map { $0.split(separator:":").first.map(String.init) ?? $0 }
        var rows: [Row] = []
        func same(_ a: String) -> Bool { host?.caseInsensitiveCompare(a) == .orderedSame }
        if let local = addresses.localHostname { rows.append(Row(address:local, detail:"Bonjour on this Wi-Fi", inUse:same(local))) }
        rows += addresses.lan.map { Row(address:$0, detail:"Home network", inUse:same($0)) }
        rows += addresses.tailscale.map { Row(address:$0, detail:"Tailscale", inUse:same($0)) }
        if let host, !rows.contains(where:{ same($0.address) }) { rows.insert(Row(address:host, detail:"Paired phones use this", inUse:true), at:0) }
        return rows
    }

    private func reveal(_ url: URL) {
        let target = FileManager.default.fileExists(atPath:url.path) ? url : url.deletingLastPathComponent()
        NSWorkspace.shared.activateFileViewerSelecting([target])
    }

    private func export() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Counterpart Diagnostics \(Date().formatted(.iso8601.year().month().day())).zip"
        panel.allowedContentTypes = [.zip]
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        exporting = true
        exportProblem = nil
        let state = state
        Task {
            let ok = await Diagnostics.export(state:state, to:destination)
            exporting = false
            if ok { NSWorkspace.shared.activateFileViewerSelecting([destination]) }
            else { exportProblem = "The diagnostics couldn’t be saved there." }
        }
    }
}

// MARK: - Shared pieces

/// A pairing code needs a white surround to scan, in light and dark alike: only the code gets one.
struct QRTile<Code: View>: View {
    @ViewBuilder let code: Code
    var body: some View {
        code
            .padding(12)
            .background(RoundedRectangle(cornerRadius:14, style:.continuous).fill(Color.white))
    }
}

// MARK: - The menu-bar popover

/// The menu bar popover (PRD §7.4, screens/mac-popover.jpg): the state of things at a glance, what's running,
/// what needs you, the printers, and the way into the app, Add a Phone and Settings.
struct MenuBarPopover: View {
    @ObservedObject var nearby: NearbyModel
    @ObservedObject var mac: MacStatusModel
    @ObservedObject var objects: ObjectsModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    private var running: [StmObject] { objects.objects.filter { [.working, .printing, .preparing, .sending].contains($0.words.stage) } }
    private var asking: [StmObject] { objects.objects.filter { $0.words.group == .needsYou } }

    var body: some View {
        VStack(alignment:.leading, spacing:12) {
            HStack {
                AppMark(size:22)
                Text("Counterpart").font(.headline)
                Spacer()
                Circle().fill(health.color).frame(width:7).accessibilityHidden(true)
                Text(health.text).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(nearby.requests) { NearbyRequestCard(request:$0, model:nearby) }
            if !running.isEmpty {
                VStack(alignment:.leading, spacing:8) {
                    ForEach(running.prefix(3)) { object in RunningLine(object:object) }
                }
                .padding(12).frame(maxWidth:.infinity, alignment:.leading)
                .glassEffect(.regular, in:.rect(cornerRadius:14))
            }
            ForEach(asking.prefix(2)) { object in
                Button { objects.selection = object.id; open(.main) } label: {
                    HStack(alignment:.top) {
                        Image(systemName:object.words.stage == .failed ? "exclamationmark.triangle.fill" : "hand.raised.fill")
                            .foregroundStyle(object.words.stage == .failed ? .red : .orange)
                        VStack(alignment:.leading, spacing:2) {
                            Text(Self.ask(object)).font(.subheadline.weight(.semibold)).lineLimit(2)
                            Text(object.words.stage == .failed ? "Open Counterpart to try again" : "Asked on your iPhone too").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength:0)
                    }
                    .padding(12).frame(maxWidth:.infinity, alignment:.leading)
                    .contentShape(.rect(cornerRadius:14))
                    .glassEffect(.regular.tint((object.words.stage == .failed ? Color.red : .orange).opacity(0.15)), in:.rect(cornerRadius:14))
                }
                .buttonStyle(.plain)
            }
            if let printers = objects.printerCatalog?.destinations, !printers.isEmpty {
                HStack(spacing:12) {
                    ForEach(printers) { printer in
                        HStack(spacing:5) { ReadyDot(state:printer.state, size:6); Text(printer.name).font(.caption).lineLimit(1) }
                    }
                }
            }
            Divider()
            HStack {
                Button("Open Counterpart") { open(.main) }.buttonStyle(.glassProminent)
                Spacer()
                Button { open(.pairing) } label: { Image(systemName:"qrcode") }.buttonStyle(.glass)
                    .help("Add a Phone").accessibilityLabel("Add a Phone")
                Button { open(.settings) } label: { Image(systemName:"gearshape") }.buttonStyle(.glass)
                    .keyboardShortcut(",")
                    .help("Settings. Right-click to quit.").accessibilityLabel("Settings")
                    // With the Dock icon hidden there is no app menu, so quitting lives here too (and ⌘Q in the popover).
                    .contextMenu { quit }
                    .background { quit.keyboardShortcut("q").hidden() }
            }
        }
        .padding(16)
        .frame(width:360)
        .tint(.filament)
        .task { await mac.refresh() }
        .onAppear { objects.setWatching(true, by:"popover") }
        .onDisappear { objects.setWatching(false, by:"popover") }
    }

    /// Delivery to the phone runs in this app (PRD §8.8), so quitting says what stops.
    private var quit: some View {
        Button("Quit Counterpart (your phone stops getting updates)") { NSApp.terminate(nil) }
    }

    private enum Destination { case main, pairing, settings }
    private func open(_ destination: Destination) {
        NSApp.activate()
        switch destination {
        case .main: openWindow(id:"main")
        case .pairing: openWindow(id:"pairing")
        case .settings: openSettings()
        }
    }

    /// Ready, Working or Problem, for the header.
    private var health: (text: String, color: Color) {
        if mac.connection == .notRunning || objects.availability == .notRunning { return ("Not running", .red) }
        if objects.objects.contains(where: { $0.words.stage == .failed }) { return ("Problem", .red) }
        if !running.isEmpty { return ("Working", .blue) }
        return ("Ready", Color.okGreen)
    }

    /// "Plush needs a close-up", "P1S needs a yes before printing".
    static func ask(_ object: StmObject) -> String {
        let words = object.words
        if words.stage == .failed { return "\(words.title) didn’t finish" }
        if object.state == .needsCloseup { return "\(words.title) needs a close-up" }
        return words.question.map { "\(words.title): \($0.prefix(1).lowercased() + $0.dropFirst())" } ?? words.title
    }
}

/// One running project in the popover: its title and, for a print, the bar; for a pass, the time left and stage.
private struct RunningLine: View {
    let object: StmObject
    var body: some View {
        let words = object.words
        VStack(alignment:.leading, spacing:4) {
            HStack {
                Text(words.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(trailing).font(.caption.monospacedDigit()).foregroundStyle(words.stage.tint)
            }
            if let progress = words.progress { ProgressView(value:progress).tint(.okGreen) }
            else if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
    }
    /// "42% · 38m" for a print, "~4 min" for a pass.
    private var trailing: String {
        let words = object.words
        if let live = object.print?.live, let progress = live.job?.progress {
            return ["\(Int(progress.rounded()))%", live.job?.remainingSec.map { "\(Int(($0 / 60).rounded()))m" }].compactMap { $0 }.joined(separator:" · ")
        }
        if let report = object.print?.printerStatus, let percent = report.percent, words.stage == .printing {
            return ["\(Int(percent.rounded()))%", report.remainingMinutes.map { "\(Int($0.rounded()))m" }].compactMap { $0 }.joined(separator:" · ")
        }
        if let ends = object.passes.last?.estimate?.endsAtMs {
            let minutes = Int(((ends / 1000 - Date().timeIntervalSince1970) / 60).rounded(.up))
            if minutes > 0 { return "~\(minutes) min" }
        }
        return words.stage.label
    }
    private var detail: String {
        let words = object.words
        guard words.stage != .printing else { return "" }
        return words.status.components(separatedBy:" · ").first ?? ""
    }
}
