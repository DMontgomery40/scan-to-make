import SwiftUI

// MARK: Settings (PRD §7.5), a real `Settings` scene with toolbar tabs.
// Launch with `-screen settings-<tab>`: general, devices, printers, ai, ai-nofusion, advanced.

enum SettingsTab: String { case general, devices, printers, ai, advanced }

struct MacSettingsView: View {
    @State var tab: SettingsTab
    var fusionInstalled = true

    var body: some View {
        TabView(selection: $tab) {
            Tab("General", systemImage: "gearshape", value: .general) { GeneralSettings() }
            Tab("Phones and iPads", systemImage: "iphone", value: .devices) { DevicesSettingsMock() }
            Tab("Printers", systemImage: "printer", value: .printers) { PrintersSettings() }
            Tab("AI", systemImage: "sparkles", value: .ai) { AISettings(fusionInstalled: fusionInstalled) }
            Tab("Advanced", systemImage: "wrench.and.screwdriver", value: .advanced) { AdvancedSettings() }
        }
        .frame(width: 620)
        .tint(.filament)
        .preferredColorScheme(.dark)
    }
}

/// Opens the Settings window at launch and closes the launcher window.
struct SettingsLauncher: View {
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        Color.clear.frame(width: 1, height: 1)
            .onAppear {
                openSettings()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    NSApp.windows.filter { $0.title.isEmpty || $0.title == "Counterpart Mock" }.forEach { $0.orderOut(nil) }
                }
            }
    }
}

struct GeneralSettings: View {
    @State private var login = true
    @State private var dock = true
    @State private var on: [String: Bool] = ["ready": true, "ask": true, "plate": true, "confirm": true, "first": false, "paused": true, "done": true, "problem": true, "lost": false]
    @State private var progress = 0

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $login) {
                    Text("Open at login")
                    Text("Your phone only gets updates while Counterpart is running.")
                }
                Toggle("Show in Dock", isOn: $dock)
            }
            Section {
                toggle("ready", "Ready to print")
                toggle("ask", "Your Mac has a question")
                toggle("plate", "Something's on the plate")
                toggle("confirm", "A printer needs a yes")
                toggle("first", "First layer's down")
                Picker("Progress", selection: $progress) {
                    Text("Off").tag(0); Text("Halfway").tag(1); Text("25, 50 and 75%").tag(2); Text("Every 10%").tag(3)
                }
                toggle("paused", "Printer paused")
                toggle("done", "Print done")
                toggle("problem", "Stopped or couldn't finish")
                toggle("lost", "Lost contact with a printer")
            } header: { Text("Notifications on this Mac") } footer: {
                Text("Progress is off on the Mac by default. Your iPhone has its own switches in its Settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height: 620)
    }

    private func toggle(_ key: String, _ title: String) -> some View {
        Toggle(title, isOn: Binding(get: { on[key] ?? false }, set: { on[key] = $0 }))
    }
}

struct PrintersSettings: View {
    var body: some View {
        Form {
            Section {
                ForEach(Mock.printers) { p in
                    HStack(spacing: 12) {
                        Image(systemName: p.symbol).font(.title3).frame(width: 26)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(p.name) · \(p.model)").font(.body.weight(.medium))
                            Text("\(p.via) · \(p.firmware)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Circle().fill(p.ready ? Color.okGreen : .gray).frame(width: 7)
                        Text(p.ready ? "Ready" : "Offline").font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: { Text("Printers") } footer: {
                Text("Counterpart reads these from your MCP configs and never changes them. Add or edit printers there.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Printer MCPs") {
                MCPRow(name: "bambu-printer-mcp", version: "1.1.46", source: "Claude Code · ~/.claude.json", update: false)
                MCPRow(name: "mcp-3D-printer-server", version: "1.2.17", source: "Claude Desktop · claude_desktop_config.json", update: false)
                MCPRow(name: "mcp-3D-printer-server", version: "1.2.9", source: "Codex · ~/.codex/config.toml · used by Ender", update: true)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height: 590)
    }
}

struct MCPRow: View {
    let name: String, version: String, source: String, update: Bool
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name).font(.body.weight(.medium))
                    Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Text(source).font(.caption).foregroundStyle(.secondary)
                if update { Text("Update to see progress and camera").font(.caption.weight(.medium)).foregroundStyle(Color.filament) }
            }
            Spacer()
            if update { Button("Update") { }.buttonStyle(.glassProminent) }
            Button("Show Config") { }
        }
    }
}

struct AISettings: View {
    var fusionInstalled: Bool
    @State private var provider = 0
    var body: some View {
        Form {
            Section("Touch-ups and designs") {
                Picker("Provider", selection: $provider) { Text("Claude · your subscription").tag(0) }
                LabeledContent("Status") {
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(Color.okGreen)
                }
                LabeledContent("Last test") {
                    HStack(spacing: 10) {
                        Text("Today at 9:12 AM · 2.1 s").foregroundStyle(.secondary)
                        Button("Test") { }
                    }
                }
            }
            Section {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "cube.transparent.fill").font(.title2).foregroundStyle(fusionInstalled ? Color.filament : .secondary)
                        .frame(width: 40, height: 40).glassEffect(.regular, in: .rect(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Design with Fusion").font(.body.weight(.semibold))
                        if fusionInstalled {
                            Label("Fusion found", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(Color.okGreen)
                        } else {
                            Label("Fusion isn't installed", systemImage: "minus.circle").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Set Up…") { }.buttonStyle(.glassProminent).disabled(!fusionInstalled)
                }
                Text(fusionInstalled
                     ? "Set Up adds the Fusion360MCP add-in to Fusion, and four FUSION_MCP settings next to Blender's in your printer MCP's env file. New designs then use Fusion when it's running."
                     : "New designs use Blender. Install Autodesk Fusion (its personal-use licence is free) and Set Up turns on.")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledContent("Make something that fits") { Text(fusionInstalled ? "Fusion, or Blender if Fusion can't start" : "Blender").foregroundStyle(.secondary) }
                LabeledContent("Copy something") { Text("Blender, always").foregroundStyle(.secondary) }
            } header: { Text("Design engine") } footer: {
                Text("Fusion and its licence are yours. Counterpart never ships or requires it. The bridge is fusion360-mcp-server by Faust Machines (MIT).")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height: 500)
    }
}

struct AdvancedSettings: View {
    var body: some View {
        Form {
            Section {
                AddressRow(address: "mac-mini.local", detail: "Bonjour on this Wi-Fi", inUse: true)
                AddressRow(address: "192.168.1.20", detail: "Home network", inUse: false)
                AddressRow(address: "100.88.4.12", detail: "Tailscale · mac-mini.tail9c2e.ts.net", inUse: false)
            } header: { Text("Addresses your phone uses") } footer: {
                Text("Your phone tries these in order and remembers the one that worked. They change by themselves; there's nothing to set.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Logs") {
                LabeledContent("Companion") { HStack { Text("companion.log").foregroundStyle(.secondary); Button("Show in Finder") { } } }
                LabeledContent("Events") { HStack { Text("events.ndjson · 7 days").foregroundStyle(.secondary); Button("Show in Finder") { } } }
            }
            Section {
                LabeledContent {
                    Button("Export Diagnostics…") { }
                } label: {
                    Text("Diagnostics")
                    Text("A zip of logs and settings with tokens and keys removed. Nothing is sent anywhere.")
                }
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height: 560)
    }
}

struct AddressRow: View {
    let address: String, detail: String, inUse: Bool
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(address).font(.body.monospacedDigit())
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if inUse {
                HStack(spacing: 5) { Circle().fill(Color.okGreen).frame(width: 7); Text("In use now").font(.caption).foregroundStyle(Color.okGreen) }
            }
        }
    }
}
