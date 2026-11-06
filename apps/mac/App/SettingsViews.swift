import SwiftUI
import AppKit
import ServiceManagement
import UniformTypeIdentifiers
import AgentKit
import CounterpartKit
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
        .onReceive(NotificationCenter.default.publisher(for:SettingsTab.openRequest)) { note in
            if let asked = (note.object as? String).flatMap(SettingsTab.init(rawValue:)) { tab = asked }
        }
        .task {
            #if DEBUG
            // Design QA: the tab asked for wins over the one the system restores from last time.
            if let asked = SettingsTab.designed { tab = asked }
            #endif
            await mac.refresh()
        }
    }
}

extension SettingsTab {
    static let openRequest = Notification.Name("counterpart.settings.open")
    /// Opens Settings on this tab (the AI sign-in a phone's Test needs finishes here).
    @MainActor static func open(_ tab: SettingsTab) {
        NSApp.activate()
        AppRouter.shared.open(.settings)
        DispatchQueue.main.asyncAfter(deadline:.now() + 0.5) { NotificationCenter.default.post(name:openRequest, object:tab.rawValue) }
    }
    @MainActor static var initial: SettingsTab {
        #if DEBUG
        if let designed { return designed }
        #endif
        return .general
    }
    #if DEBUG
    /// `--design-screen settings-<tab>`, with fixtures or against the real companion.
    @MainActor static var designed: SettingsTab? {
        let screen = DesignFixtures.assets != nil ? DesignFixtures.screen : (DesignFixtures.realScreen ?? "")
        guard screen.hasPrefix("settings-") else { return nil }
        return SettingsTab(rawValue:String(screen.dropFirst("settings-".count)).replacingOccurrences(of:"-nofusion", with:""))
    }
    #endif
}

// MARK: General

struct GeneralSettings: View {
    /// PRD §5.9: kept in the companion when it keeps them, so the phone shows and changes the same values.
    @ObservedObject private var companion = CompanionSettingsModel.shared
    @State private var login = SMAppService.mainApp.status == .enabled
    @State private var loginProblem: String?
    @State private var dock = DockIcon.shown
    @State private var switches: [NotificationSwitch: Bool] = Dictionary(uniqueKeysWithValues:NotificationSwitch.allCases.map { ($0, NotificationPrefs().isOn($0)) })
    @State private var progress = NotificationPrefs().progress
    /// The shared milestones as the companion has them, once read; nil while unknown or unreachable.
    @State private var shared: String?
    @State private var progressProblem: String?
    /// One change to the shared milestones at a time, so a slower earlier write never lands after a newer choice.
    @State private var savingMilestones = false

    var body: some View {
        Form {
            Section {
                Toggle(isOn:Binding(get:{ companion.settings?.general?.openAtLogin ?? login }, set:{ setLogin($0) })) {
                    Text("Open at login")
                    Text(loginProblem ?? companion.problem ?? "Your phone only gets updates while Counterpart is running.")
                }
                Toggle("Show in Dock", isOn:Binding(get:{ companion.settings?.general?.showInDock ?? dock }, set:{ setDock($0) }))
                if let keepAwake = companion.settings?.general?.keepAwake {
                    Toggle("Keep the Mac awake while working", isOn:Binding(get:{ keepAwake }, set:{ on in Task { await companion.setGeneral("keepAwake", on) } }))
                }
            } footer: {
                if companion.keepsGeneral {
                    Text("The same on your iPhone: changing one changes it everywhere.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .disabled(companion.saving)
            if let types = companion.settings?.notificationsMac {
                companionNotifications(types)
            } else {
                localNotifications
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:620)
        .task { await readMilestones(); await companion.refresh(force:true) }
    }

    /// The companion's switches: one per event type, the same list your iPhone shows for this Mac (settings.md).
    private func companionNotifications(_ types: [String: Bool]) -> some View {
        Section {
            ForEach(MacNotificationTypes.ordered, id:\.type) { item in
                Toggle(item.label, isOn:Binding(get:{ types[item.type] ?? CounterpartKit.SettingsSchema.defaultValue(item.type, mac: true) }, set:{ on in Task { await companion.setNotification(item.type, on) } }))
                if item.type == "print.milestone" {
                    Picker(selection:Binding(get:{ ProgressNotifications(milestones:companion.settings?.milestones ?? shared ?? "50") ?? .off },
                                             set:{ level in if let value = level.milestones { Task { await companion.set(["milestones":.string(value)]) } } })) {
                        ForEach(ProgressNotifications.allCases.filter { $0 != .off }) { Text($0.title).tag($0) }
                    } label: {
                        Text("Milestones")
                        Text("Shared with your iPhone.")
                    }
                }
            }
        } header: { Text("Notifications on this Mac") } footer: {
            Text("Your iPhone can change these Mac settings. iPhone alerts also follow its system notification permission.").font(.caption).foregroundStyle(.secondary)
        }
        .disabled(companion.saving)
    }

    private var localNotifications: some View {
            Section {
                ForEach(NotificationSwitch.ordered) { item in
                    Toggle(item.title, isOn:Binding(get:{ switches[item] ?? item.defaultOn }, set:{ switches[item] = $0; NotificationPrefs().set(item, $0) }))
                    if item == .firstLayer {
                        Picker(selection:Binding(get:{ progress }, set:{ choose($0) })) {
                            ForEach(ProgressNotifications.allCases) { Text($0.title).tag($0) }
                        } label: {
                            Text("Progress")
                            Text(progressProblem ?? (shared == "off" ? "Off on your iPhone too. Choosing a level turns them on for both."
                                                     : "The milestones are shared with your iPhone."))
                        }
                        .disabled(savingMilestones)
                    }
                }
            } header: { Text("Notifications on this Mac") } footer: {
                Text(NotificationPrefs.delivered ? "Progress is off on the Mac by default. iPhone alerts follow its system notification permission."
                     : "Mac notifications are unavailable from this companion. iPhone alerts follow its system notification permission.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .disabled(!NotificationPrefs.delivered)
    }

    /// Shows the shared level while this Mac's Progress is on, so both devices say the same.
    private func readMilestones() async {
        #if DEBUG
        if DesignFixtures.assets != nil { return }
        #endif
        guard let value = try? await Self.client().milestones() else { return }
        shared = value
        if progress != .off, let level = ProgressNotifications(milestones:value), level != progress {
            progress = level
            NotificationPrefs().progress = level
        }
    }

    /// A level turns Progress on here and sets the shared milestones; Off turns it off on this Mac only.
    private func choose(_ level: ProgressNotifications) {
        let previous = progress
        progress = level
        NotificationPrefs().progress = level
        progressProblem = nil
        guard let milestones = level.milestones, milestones != shared else { return }
        savingMilestones = true
        Task {
            defer { savingMilestones = false }
            do { try await Self.client().setMilestones(milestones); shared = milestones }
            catch {
                progress = previous
                NotificationPrefs().progress = previous
                progressProblem = "Counterpart couldn't change the milestones. Try again."
            }
        }
    }

    private static func client() throws -> ControlClient {
        try ControlClient(socketPath:ModelAccessModel.socketPath(for:Installation(bundle:.main)))
    }

    private func setDock(_ on: Bool) {
        if companion.keepsGeneral { Task { await companion.setGeneral("showInDock", on) }; return }
        dock = on; UserDefaults.standard.set(on, forKey:DockIcon.key); DockIcon.apply()
    }

    private func setLogin(_ on: Bool) {
        loginProblem = nil
        // Kept in the companion: it changes everywhere, and this Mac applies it from the answer.
        if companion.keepsGeneral { Task { await companion.setGeneral("openAtLogin", on) }; return }
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
    @State private var removingLegacy: ControlDevice?
    @State private var removingAllLegacy = false

    var body: some View {
        Form {
            Section {
                if mac.groups.isEmpty {
                    Text(mac.connection == .notRunning ? "Your phones show here while Counterpart is running." : "No phone is connected yet.")
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
                Text("A phone on your Apple Account finds this Mac by itself. Add a Phone shows a code for any other phone. Connecting a phone again replaces its row; it never adds a second one.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !mac.legacy.isEmpty {
                Section {
                    ForEach(mac.legacy) { device in
                        HStack(spacing:12) {
                            Image(systemName:"iphone.slash").font(.title2).foregroundStyle(.secondary).frame(width:30)
                            VStack(alignment:.leading, spacing:2) {
                                Text(device.deviceName).font(.body.weight(.medium))
                                Text("Last used \(Self.day(device.seenAt)) · paired \(Self.day(device.pairedAt))").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Remove…") { removingLegacy = device }
                        }
                    }
                    HStack {
                        Spacer()
                        Button("Remove All Older Connections…") { removingAllLegacy = true }
                    }
                } header: { Text("Older pairings") } footer: {
                    Text("Connections from before this version. Counterpart removes them after 14 days without use.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:mac.legacy.isEmpty ? 300 : 620)
        // A phone paired in the Add a Phone window shows here as soon as Settings is in front again.
        .onReceive(NotificationCenter.default.publisher(for:NSWindow.didBecomeKeyNotification)) { _ in Task { await mac.refresh() } }
        .onChange(of:PairingFlow.shared.finished) { _, done in if done { Task { await mac.refresh() } } }
        .confirmationDialog(removing.map { "Remove “\($0.primary.deviceName)”?" } ?? "Remove?",
                            isPresented:Binding(get:{ removing != nil }, set:{ if !$0 { removing = nil } }),
                            titleVisibility:.visible, presenting:removing) { group in
            Button("Remove", role:.destructive) { Task { await mac.remove([group.primary.deviceId]) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("It can’t reach this Mac until you connect it again.")
        }
        .confirmationDialog(removingLegacy.map { "Remove “\($0.deviceName)”?" } ?? "Remove?",
                            isPresented:Binding(get:{ removingLegacy != nil }, set:{ if !$0 { removingLegacy = nil } }),
                            titleVisibility:.visible, presenting:removingLegacy) { device in
            Button("Remove", role:.destructive) { Task { await mac.remove([device.deviceId]) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("A phone that still uses this pairing will need pairing again.")
        }
        .confirmationDialog("Remove \(mac.legacy.count) older pairing\(mac.legacy.count == 1 ? "" : "s")?", isPresented:$removingAllLegacy,
                            titleVisibility:.visible) {
            Button("Remove All", role:.destructive) { Task { await mac.remove(mac.legacy.map(\.deviceId)) } }
            Button("Cancel", role:.cancel) {}
        } message: {
            Text("They’re from before this version. A phone that still uses one will need pairing again.")
        }
        .confirmationDialog(removingOlder.map { "Remove \($0.older) older pairing\($0.older == 1 ? "" : "s") of “\($0.primary.deviceName)”?" } ?? "Remove?",
                            isPresented:Binding(get:{ removingOlder != nil }, set:{ if !$0 { removingOlder = nil } }),
                            titleVisibility:.visible, presenting:removingOlder) { group in
            Button("Remove Older Connections", role:.destructive) { Task { await mac.remove(Array(group.ids.dropFirst())) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("They haven’t been used since this phone paired again. A phone that still uses one will need pairing again.")
        }
    }
}

extension DevicesSettings {
    static func day(_ ms: Double) -> String { Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day()) }
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

// MARK: Printers (they come from the user's MCP configs; the connection is the MCP's own setting)

struct PrintersSettings: View {
    @ObservedObject var objects: ObjectsModel
    @ObservedObject private var updates = PrinterUpdates.shared
    @ObservedObject private var setup = PrinterSetupModel.shared
    @State private var adding = false

    private var printers: [PrinterDestination] { objects.printerCatalog?.destinations ?? [] }

    var body: some View {
        Form {
            Section {
                if printers.isEmpty {
                    Text(objects.missingPrinterText)
                        .foregroundStyle(.secondary)
                }
                ForEach(printers) { printer in
                    VStack(alignment:.leading, spacing:10) {
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
                        // Any MCP with counterpart_print_route; the picker shows nothing for one without it.
                        PrintRoutePicker(destinationId:printer.id).padding(.leading, 38)
                        PrinterMcpPicker(printer:printer) { Task { await objects.refresh() } }.padding(.leading, 38)
                        if printer.origin == "counterpart" {
                            AddedPrinterActions(printer:printer, models:setup.models(printer.backend)) { Task { await objects.refresh() } }.padding(.leading, 38)
                        }
                    }
                }
                if setup.available {
                    Button("Add Printer…") { adding = true }
                }
            } header: { Text("Printers") } footer: {
                Text("Counterpart finds printers in your MCP configs, and the ones you add here. The connection is the printer MCP’s own setting: changing it here changes it in that MCP.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                ForEach(setup.packages.contains(where: { $0.uses != nil }) ? [] : PrinterMCP.list(printers)) { mcp in
                    MCPRow(mcp:mcp, companionUpdates:objects.capabilities?.mcpUpdates == true,
                           status:mcp.mcpId.flatMap { updates.status[$0] },
                           update:{ update(mcp, fresh:false) }, installFresh:{ update(mcp, fresh:true) })
                }
                // Both MCPs, always: one no printer uses yet shows where it is, or Download.
                ForEach(setup.packages) { package in
                    McpPackageRow(package:package, status:updates.status[package.appMcpId], download:{ setup.download(package) },
                                  update:objects.capabilities?.mcpUpdates == true ? { updateAppCopy(package) } : nil,
                                  move: objects.capabilities?.mcpUpdates == true ? { id in
                                      Task { await updates.update(id, fresh:true, socket:ModelAccessModel.socketPath(for:Installation(bundle:.main))); await setup.refresh() }
                                  } : nil)
                }
                if let problem = setup.problem {
                    HStack {
                        Text(problem).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Try Again") { Task { await setup.refresh() } }
                    }
                }
                if PrinterMCP.list(printers).isEmpty && unusedPackages.isEmpty { Text("None found yet.").foregroundStyle(.secondary) }
            } header: { Text("Printer MCPs") } footer: {
                if setup.available {
                    Text("Download installs that MCP for Counterpart only. You need just the one your printer uses.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height:590)
        .task { await objects.refresh(); await setup.refresh() }
        .sheet(isPresented:$adding) {
            AddPrinterSheet(setup:setup) { Task { await objects.refresh(); await setup.refresh() } }
        }
        .onChange(of:updates.status) { _, status in
            // A download that finished: read the packages (and printers) again.
            if status.values.contains(where: { if case .updated = $0 { return true }; return false }) {
                Task { await setup.refresh(); await objects.refresh() }
            }
        }
    }

    /// The packages with no printer row above: neither MCP is ever missing from the list.
    private var unusedPackages: [PrinterMcpPackage] {
        let used = Set(PrinterMCP.list(printers).map { $0.name.lowercased() })
        return setup.packages.filter { !used.contains($0.package) }
    }

    static func readiness(_ state: String?) -> String {
        switch state { case "ready": return "Ready"; case "busy": return "Busy"; case "offline": return "Offline"; default: return "Not checked yet" }
    }

    /// The companion updates it its own way (PRD §8.10) and the events carry the progress. Only offered by a
    /// companion with `printers.updateMcp` (`capabilities.mcpUpdates`): no button that can only fail.
    /// Update for a package no printer uses: the companion installs the latest into Counterpart's own copy.
    private func updateAppCopy(_ package: PrinterMcpPackage) {
        Task { await updates.update(package.appMcpId, fresh:false, socket:ModelAccessModel.socketPath(for:Installation(bundle:.main))) }
    }

    private func update(_ mcp: PrinterMCP, fresh: Bool) {
        guard objects.capabilities?.mcpUpdates == true, let mcpId = mcp.mcpId else { return }
        Task { await updates.update(mcpId, fresh:fresh, socket:ModelAccessModel.socketPath(for:Installation(bundle:.main))) }
    }
}

/// How the printer MCP reaches the printer, for prints and for Stop, Pause and Resume. The MCP keeps the setting
/// (`printers.route` → `counterpart_print_route`, both MCPs) and words each connection; this only shows and
/// changes it. Hidden for an MCP without the choice.
private struct PrintRoutePicker: View {
    let destinationId: String
    @State private var route: PrintRoute?
    @State private var problem: String?
    @State private var saving = false
    /// Until the first answer: a view with no content never runs `.task`, so something must be shown.
    @State private var loaded = false

    private static func label(_ choice: String, in route: PrintRoute) -> String {
        if let option = route.options?.first(where: { $0.id == choice }) { return option.label }
        switch choice { case "lan": return "Local network"; case "cloud": return "Bambu Cloud"; case "developer": return "Local network, Developer Mode"; default: return choice }
    }
    private func client() throws -> ControlClient {
        try ControlClient(socketPath:ModelAccessModel.socketPath(for:Installation(bundle:.main)), timeout:ControlClient.timeout(for:"printers.route"))
    }

    var body: some View {
        Group {
            if let route {
                VStack(alignment:.leading, spacing:6) {
                    Picker("Connection", selection:Binding(get: { route.route }, set: { choose($0) })) {
                        ForEach(route.choices, id:\.self) { Text(Self.label($0, in:route)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(saving)
                    // What Stop, Pause and Resume do on this connection, in the MCP's own words.
                    Text(problem ?? route.options?.first(where: { $0.id == route.route })?.controls ?? "Prints, Stop, Pause and Resume go this way.")
                        .font(.caption).foregroundStyle(problem == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
                        .fixedSize(horizontal:false, vertical:true)
                }
            } else if !loaded {
                ProgressView().controlSize(.small)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { route = try await client().printRoute(destinationId); problem = nil }
        catch { route = nil }
        loaded = true
    }

    private func choose(_ choice: String) {
        guard choice != route?.route, !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                route = try await client().printRoute(destinationId, route:choice)
                problem = nil
            } catch let error as ControlRemoteError where !error.message.isEmpty {
                problem = error.message
            } catch {
                problem = "Counterpart couldn’t change the connection. Try again."
            }
        }
    }
}

extension PrinterMCP {
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
}

private struct MCPRow: View {
    let mcp: PrinterMCP
    /// The companion updates MCPs itself (`printers.updateMcp`).
    let companionUpdates: Bool
    let status: McpUpdateStatus?
    let update: () -> Void
    let installFresh: () -> Void
    @State private var showLog = false

    /// Only a companion that updates MCPs itself offers Update; an older one just says a newer version exists.
    private var canUpdate: Bool { companionUpdates && mcp.mcpId != nil && mcp.updateAvailable }
    private var busy: Bool { status?.busy == true }

    var body: some View {
        HStack(alignment:.top, spacing:10) {
            VStack(alignment:.leading, spacing:3) {
                HStack(spacing:6) {
                    Text(mcp.name).font(.body.weight(.medium))
                    if let version = mcp.version { Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                    if let latest = mcp.update?.latestVersion, McpUpdateStatus.newer(installed:mcp.version, latest:latest) {
                        Text("→ \(latest)").font(.caption.monospacedDigit()).foregroundStyle(Color.filament)
                    }
                }
                Text(mcp.source + (mcp.printers.count == 1 ? " · used by \(mcp.printers[0])" : "")).font(.caption).foregroundStyle(.secondary)
                if let message = mcp.update?.message, status == nil { Text(message).font(.caption.weight(.medium)).foregroundStyle(Color.filament) }
                if let status { statusLine(status) }
                if let url = mcp.configURL {
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                        .buttonStyle(.link).font(.caption).help(url.path)
                }
            }
            Spacer()
            if status?.spinning == true { ProgressView().controlSize(.small) }
            if case .unresolved = status {
                Button("Install a Fresh Copy", action:installFresh).buttonStyle(.glassProminent)
            } else if canUpdate {
                Button(status.map { if case .failed = $0 { return "Try Again" } else { return "Update" } } ?? "Update", action:update)
                    .buttonStyle(.glassProminent).disabled(busy)
            }
        }
    }

    @ViewBuilder private func statusLine(_ status: McpUpdateStatus) -> some View {
        switch status {
        case .failed(let log?) where !log.isEmpty:
            VStack(alignment:.leading, spacing:4) {
                Text(status.words).font(.caption).foregroundStyle(.red)
                DisclosureGroup("What it said", isExpanded:$showLog) {
                    ScrollView {
                        Text(verbatim:log).font(.caption2.monospaced()).textSelection(.enabled).frame(maxWidth:.infinity, alignment:.leading)
                    }
                    .frame(maxHeight:120)
                }
                .font(.caption)
            }
        case .failed, .problem: Text(status.words).font(.caption).foregroundStyle(.red)
        case .unresolved: Text(status.words + " Install a fresh copy to update it from here.").font(.caption).foregroundStyle(.secondary)
        case .updated: Text(status.words).font(.caption).foregroundStyle(Color.okGreen)
        default: Text(status.words).font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: AI

struct AISettings: View {
    @ObservedObject var model: ModelAccessModel
    @State private var other = false
    @State private var fusion = FusionState.checking
    @State private var fusionProblem: String?
    /// What Fusion said after Set Up (`fusion_mcp_status`), in plain words.
    @State private var fusionStatus: FusionSetup.Status?
    @AppStorage("ai.lastTestAt") private var lastTestAt: Double = 0
    @AppStorage("ai.lastTestSeconds") private var lastTestSeconds: Double = 0
    @State private var testStarted: Date?

    enum FusionState: Equatable { case checking, notInstalled, found, settingUp, setUp, unchecked }

    private var choice: ModelAccessChoice { model.snapshot?.choice ?? .none }

    var body: some View {
        Form {
            Section("AI model jobs") {
                Picker("AI provider", selection:Binding(get:{ provider }, set:{ pick($0) })) {
                    Text("Claude · your subscription").tag("claude")
                    Text("Codex · your subscription").tag("codex")
                    if choice.isAPIKey || choice.isEndpoint { Text(choice.displayName + " · your key").tag("other") }
                    Text("Other…").tag("pick-other")
                    Divider()
                    Text("Off").tag("none")
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
                Text("Choose the AI for your model jobs. New scan cleanup, designs and corrections use this choice. Jobs already running keep their provider.").font(.caption).foregroundStyle(.secondary)
            }
            BlenderAddonSettingsSection { action in
                let socket = ModelAccessModel.socketPath(for: Installation(bundle: .main))
                return try await ControlClient(socketPath: socket).blenderAddon(action)
            }
            Section {
                HStack(alignment:.center, spacing:12) {
                    Image(systemName:"cube.transparent.fill").font(.title2).foregroundStyle(fusion == .notInstalled ? .secondary : Color.filament)
                        .frame(width:40, height:40).glassEffect(.regular, in:.rect(cornerRadius:10))
                    VStack(alignment:.leading, spacing:2) {
                        Text("Design with Fusion · Optional").font(.body.weight(.semibold))
                        switch fusion {
                        case .checking: Text("Looking for Fusion…").font(.caption).foregroundStyle(.secondary)
                        case .notInstalled:
                            HStack(spacing:6) {
                                Label("Fusion isn't installed", systemImage:"minus.circle").font(.caption).foregroundStyle(.secondary)
                                Link("Get Fusion", destination:FusionSetup.download).font(.caption)
                            }
                        case .found, .settingUp: Label("Fusion found", systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                        case .setUp: Label("Fusion is set up", systemImage:"checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                        case .unchecked: Label("Couldn't check Fusion", systemImage:"questionmark.circle").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if fusion == .settingUp {
                        ProgressView().controlSize(.small)
                        Text("Setting up and starting Fusion…").font(.caption).foregroundStyle(.secondary)
                    }
                    Button(fusion == .setUp ? "Set Up Again…" : "Set Up…") { setUpFusion() }
                        .buttonStyle(.glassProminent).disabled(fusion != .found && fusion != .setUp && fusion != .unchecked)
                }
                Text(fusion == .notInstalled
                     ? "Install Autodesk Fusion if you want to use it for new designs. You can also design with Blender."
                     : "Set Up connects Fusion to Counterpart for new designs and later changes to them.")
                    .font(.caption).foregroundStyle(.secondary)
                if let fusionProblem { Text(fusionProblem).font(.caption).foregroundStyle(.red) }
                if let fusionStatus, fusion == .setUp {
                    Label(fusionStatus.words, systemImage:fusionStatus.ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(fusionStatus.ok ? Color.okGreen : Color.orange)
                }
                LabeledContent("Make something that fits") {
                    Text(fusion == .notInstalled ? "Blender" : "Fusion, or Blender if Fusion can't start").foregroundStyle(.secondary)
                }
                LabeledContent("Clean up a scan") { Text("Blender").foregroundStyle(.secondary) }
            } header: { Text("Design engine") } footer: {
                Text("Blender and Fusion are optional. Printing existing models and reprinting needs neither. Fusion and its licence are yours; its bridge is fusion360-mcp-server by Faust Machines (MIT).")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(minHeight:500)
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
        case .idle: Text(choice == .none ? "AI off" : model.unavailable ? "Counterpart isn’t running" : "Not tested yet").foregroundStyle(.secondary)
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
        // The printer MCP finds Fusion and says whether its bridge is set up (fusion_mcp_setup).
        Task {
            do {
                let setup = try await FusionSetup.check(state:state, socket:ModelAccessModel.socketPath(for: Installation(bundle: .main)), force:true)
                fusion = !setup.fusionInstalled ? .notInstalled : setup.ready ? .setUp : .found
            } catch {
                fusion = .unchecked
                fusionProblem = error.localizedDescription
            }
        }
    }

    private func setUpFusion() {
        let before = fusion
        fusion = .settingUp
        fusionProblem = nil
        let state = Installation(bundle:.main).state
        Task {
            do {
                let report = try await FusionSetup.install(state:state, socket:ModelAccessModel.socketPath(for: Installation(bundle: .main)))
                fusion = .setUp
                fusionProblem = nil
                fusionStatus = report.status
            } catch {
                fusion = before
                fusionProblem = error.localizedDescription
            }
        }
    }
}

// MARK: Advanced

struct AdvancedSettings: View {
    @ObservedObject var mac: MacStatusModel
    @AppStorage(LiveActivityRelay.enabledKey) private var relayOn = false
    @State private var relayURL = UserDefaults.standard.string(forKey:LiveActivityRelay.urlKey) ?? ""
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
            Section {
                LabeledContent("iCloud") { Text(cloudStatus).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
                LabeledContent("Phones find this Mac") {
                    Text(macPublication).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                }
                Toggle(isOn:$relayOn) {
                    Text("Live Activity relay")
                    Text("Updates your phone's Lock Screen while it prints, through counterpart.dtmont.com. It stores nothing.")
                }
                if relayOn {
                    TextField("Relay address", text:$relayURL, prompt:Text(verbatim:LiveActivityRelay.defaultURL))
                        .onSubmit { UserDefaults.standard.set(relayURL.isEmpty ? nil : relayURL, forKey:LiveActivityRelay.urlKey) }
                    LabeledContent("Last update") { Text(EventRelay.shared.relay.lastResult).foregroundStyle(.secondary) }
                }
            } header: { Text("Your phone away from home") } footer: {
                Text("Without the relay, your phone starts and updates its Live Activity itself.").font(.caption).foregroundStyle(.secondary)
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
        .frame(height:640)
    }

    /// PRD §5.10: a phone on the same Apple Account finds this Mac in iCloud and enrols by itself.
    private var macPublication: String {
        if case .off(let why) = EventRelay.shared.cloud.status { return why + " Phones connect with the code in Add a Phone." }
        return EventRelay.shared.cloud.macPublication
    }

    private var cloudStatus: String {
        switch EventRelay.shared.cloud.status {
        case .on: return "On: projects, events and commands sync through your iCloud"
        case .starting: return "Starting…"
        case .off(let why), .failed(let why): return why
        }
    }

    private struct Row { let address: String; let detail: String; let inUse: Bool }
    private var rows: [Row] {
        let host = mac.address.map { $0.split(separator:":").first.map(String.init) ?? $0 }
        var rows: [Row] = []
        func same(_ a: String) -> Bool { host?.caseInsensitiveCompare(a) == .orderedSame }
        if let local = addresses.localHostname { rows.append(Row(address:local, detail:"Bonjour on this Wi-Fi", inUse:same(local))) }
        rows += addresses.lan.map { Row(address:$0, detail:"Home network", inUse:same($0)) }
        rows += addresses.tailscale.map { Row(address:$0, detail:"Tailscale", inUse:same($0)) }
        if let host, !rows.contains(where:{ same($0.address) }) { rows.insert(Row(address:host, detail:"Connected phones use this", inUse:true), at:0) }
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

    private var running: [Project] { objects.objects.filter { [.working, .printing, .preparing, .sending].contains($0.words.stage) } }
    private var asking: [Project] { objects.objects.filter { $0.words.group == .needsYou } }

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
                    // Each opens its project, where Pause and Stop are (a dispatched print getting ready included).
                    ForEach(running.prefix(3)) { object in
                        Button {
                            objects.selection = object.id
                            NSApp.activate()
                            openWindow(id:"main")
                        } label: { RunningLine(object:object).contentShape(Rectangle()) }
                        .buttonStyle(.plain).help("Open \(object.words.title)")
                    }
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
    static func ask(_ object: Project) -> String {
        let words = object.words
        if words.stage == .failed { return "\(words.title) didn’t finish" }
        if object.state == .needsCloseup { return "\(words.title) needs a close-up" }
        return words.question.map { "\(words.title): \($0.prefix(1).lowercased() + $0.dropFirst())" } ?? words.title
    }
}

/// One running project in the popover: its title and, for a print, the bar; for a pass, the time left and stage.
private struct RunningLine: View {
    let object: Project
    var body: some View {
        let words = object.words
        VStack(alignment:.leading, spacing:4) {
            HStack {
                Text(words.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(trailing).font(.caption.monospacedDigit()).foregroundStyle(words.stage.tint)
            }
            if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            if let progress = words.progress { ProgressView(value:progress).tint(.okGreen) }
        }
    }
    /// "~4 min" for a pass; a print's words come from the companion, in the line under it.
    private var trailing: String {
        let words = object.words
        if words.stage == .printing || words.stage == .preparing { return words.stage.label }
        if let ends = object.passes.last?.estimate?.endsAtMs {
            let minutes = Int(((ends / 1000 - Date().timeIntervalSince1970) / 60).rounded(.up))
            if minutes > 0 { return "~\(minutes) min" }
        }
        return words.stage.label
    }
    /// The companion's words: a print's whole line ("Getting ready · Heating"), a pass's first part.
    private var detail: String {
        let words = object.words
        if words.stage == .printing || words.stage == .preparing { return words.status }
        return words.status.components(separatedBy:" · ").first ?? ""
    }
}
