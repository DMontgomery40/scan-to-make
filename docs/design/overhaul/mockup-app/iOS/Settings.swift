import SwiftUI

// MARK: Settings (PRD §5.9). Opened from the account button on Home, as a sheet.

struct PhoneSettingsView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "macmini.fill").font(.title2).foregroundStyle(.white)
                            .frame(width: 50, height: 50)
                            .glassEffect(.regular.tint(Color.okGreen.opacity(0.28)), in: .rect(cornerRadius: 16))
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Mac mini").font(.headline)
                            Label("Connected now", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium)).foregroundStyle(Color.okGreen)
                            Text("Home Wi-Fi · 192.168.1.20").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            Button { } label: { Text("Check Connection").minimumScaleFactor(0.75).frame(maxWidth: .infinity) }
                            Button { } label: { Text("Different Mac…").minimumScaleFactor(0.75).frame(maxWidth: .infinity) }
                        }
                        .buttonStyle(.glass).controlSize(.regular).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                } header: { Text("Your Mac") }

                Section {
                    NavigationLink { NotificationSettingsView() } label: {
                        HStack(spacing: 12) {
                            SettingsIcon(symbol: "bell.badge.fill", tint: .red)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Notifications")
                                Text("All on · progress at halfway").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section {
                    SettingsLinkRow(symbol: "book.fill", tint: .blue, title: "Guide", detail: nil)
                    SettingsLinkRow(symbol: "cube.transparent.fill", tint: .indigo, title: "How scanning works", detail: nil)
                    SettingsLinkRow(symbol: "rotate.3d.fill", tint: .filament, title: "Print the scan rig", detail: "By Kass 3D on MakerWorld. For casual photos, not professional equipment.")
                } header: { Text("Help") }

                Section {
                    NavigationLink { AboutView() } label: {
                        HStack(spacing: 12) {
                            AppIconMock(size: 30)
                            Text("About Counterpart")
                            Spacer()
                            Text("2.0 (1)").foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(role: .confirm) { } }
            }
        }
    }
}

/// An iOS Settings-style row: a coloured symbol tile, a title and a value.
struct SettingsRow: View {
    let symbol: String, tint: Color, title: String
    var value: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: symbol, tint: tint)
            Text(title)
            Spacer()
            if let value { Text(value).foregroundStyle(.secondary) }
        }
    }
}

struct SettingsIcon: View {
    let symbol: String, tint: Color
    var body: some View {
        Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(tint.gradient, in: .rect(cornerRadius: 8))
    }
}

/// A row that opens a web page: the docs site or a MakerWorld model page.
struct SettingsLinkRow: View {
    let symbol: String, tint: Color, title: String, detail: String?
    var body: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: symbol, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(.primary)
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
    }
}

// MARK: Settings → Notifications (PRD §9.1: one switch per row; milestones from §8.6)

struct NotificationSettingsView: View {
    @State private var on: [String: Bool] = [
        "ready": true, "ask": true, "plate": true, "confirm": true, "live": true, "first": true,
        "paused": true, "done": true, "problem": true, "lost": true,
    ]
    @State private var milestones = 1

    var body: some View {
        List {
            Section {
                row("ready", "checkmark.seal.fill", .filament, "Ready to print")
                row("ask", "hand.raised.fill", .orange, "Your Mac has a question")
            } header: { Text("Projects") }

            Section {
                row("plate", "exclamationmark.triangle.fill", .orange, "Something's on the plate", urgent: true)
                row("confirm", "checkmark.shield.fill", .blue, "A printer needs a yes", urgent: true)
            } header: { Text("Before a print") }

            Section {
                row("live", "livephoto", .okGreen, "Live Activity")
                row("first", "square.stack.3d.down.forward.fill", .okGreen, "First layer's down")
                HStack(spacing: 12) {
                    SettingsIcon(symbol: "percent", tint: .okGreen)
                    Picker("Progress", selection: $milestones) {
                        Text("Off").tag(0)
                        Text("Halfway").tag(1)
                        Text("25, 50 and 75%").tag(2)
                        Text("Every 10%").tag(3)
                    }
                    .pickerStyle(.menu)
                }
                .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                row("paused", "pause.circle.fill", .orange, "Printer paused", urgent: true)
                row("done", "shippingbox.fill", .okGreen, "Print done")
            } header: { Text("While printing") }

            Section {
                row("problem", "xmark.octagon.fill", .red, "Stopped or couldn't finish", urgent: true)
                row("lost", "wifi.exclamationmark", .gray, "Lost contact with a printer")
            } header: { Text("Problems") } footer: {
                Text("Sent from your Mac through iCloud, so use the same Apple Account on both. Marked ones are time sensitive.")
            }
        }
        .listSectionSpacing(10)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ key: String, _ symbol: String, _ tint: Color, _ title: String, urgent: Bool = false) -> some View {
        rowToggle(key, symbol, tint, title, urgent: urgent).listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
    }

    private func rowToggle(_ key: String, _ symbol: String, _ tint: Color, _ title: String, urgent: Bool) -> some View {
        Toggle(isOn: Binding(get: { on[key] ?? false }, set: { on[key] = $0 })) {
            HStack(spacing: 12) {
                SettingsIcon(symbol: symbol, tint: tint)
                Text(title).lineLimit(1).minimumScaleFactor(0.85)
                if urgent {
                    Image(systemName: "clock.badge.exclamationmark.fill").font(.caption).foregroundStyle(.secondary)
                        .accessibilityLabel("Time sensitive")
                }
            }
        }
    }
}

// MARK: About (PRD §5.9, credits §15)

struct AboutView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    AppIconMock(size: 112)
                        .shadow(color: Color.filament.opacity(0.45), radius: 24, y: 8)
                        .padding(.top, 8)
                    Text("Counterpart").font(.title.bold())
                    Text("Version 2.0 (1)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                    Text("Makes physical things that fit your life, with your iPhone, your Mac and your 3D printer.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 12)
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)
                .listRowBackground(Color.clear)
            }

            Section {
                SettingsLinkRow(symbol: "globe", tint: .blue, title: "counterpart.dtmont.com", detail: nil)
                NavigationLink { Text("Licence") } label: { SettingsRow(symbol: "doc.text.fill", tint: .gray, title: "Licence") }
                NavigationLink { Text("Notices") } label: { SettingsRow(symbol: "chevron.left.forwardslash.chevron.right", tint: .gray, title: "Open-source notices") }
            }

            Section {
                CreditRow(title: "Scan rig", detail: "“Fully 3D-printed 360° photography turntable” by Kass 3D, on MakerWorld")
                CreditRow(title: "Fusion bridge", detail: "fusion360-mcp-server by Faust Machines and contributors · MIT")
                CreditRow(title: "Printing", detail: "bambu-printer-mcp and mcp-3D-printer-server, on your Mac")
            } header: { Text("Thanks to") }
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct CreditRow: View {
    let title: String, detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(detail).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
