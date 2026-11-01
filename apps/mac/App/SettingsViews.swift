import SwiftUI
import AppKit
#if canImport(ControlKit)
import ControlKit
#endif

extension MacStatusModel {
    static let shared: MacStatusModel = {
        let installation = Installation(bundle:.main)
        return MacStatusModel(source:SocketMacStatus(path:ModelAccessModel.socketPath(for:installation),
                                                     settings:installation.state.appendingPathComponent("auth/auth.json")))
    }()
}

enum AppVersion {
    static var version: String { Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "—" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "—" }
}

/// Settings: General (this Mac and its iPhones, help, about) and AI Cleanup. A fixed size, so
/// switching tabs never resizes the window under the pointer.
struct SettingsView: View {
    @ObservedObject var mac: MacStatusModel
    @ObservedObject var cleanup: ModelAccessModel
    var body: some View {
        TabView {
            GeneralSettings(mac:mac)
                .tabItem { Label("General", systemImage:"gearshape") }
            ModelAccessPane(model:cleanup, context:.settings)
                .padding(24)
                .frame(maxWidth:.infinity, maxHeight:.infinity, alignment:.topLeading)
                .tabItem { Label("AI Cleanup", systemImage:"sparkles") }
        }
        .frame(width:560, height:680)
    }
}

/// A grouped Form, the system's own Settings look.
struct GeneralSettings: View {
    @ObservedObject var mac: MacStatusModel
    @State private var pairing = false
    @State private var removing: ControlDevice?

    var body: some View {
        Form {
            Section {
                HStack(spacing:14) {
                    AppMark(size:52)
                    VStack(alignment:.leading, spacing:2) {
                        Text("Scan to Make").font(.title2.weight(.semibold))
                        Text("Version \(AppVersion.version)").foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Your iPhone") {
                if mac.devices.isEmpty {
                    Text(mac.connection == .notRunning ? "Your iPhones show here while Scan to Make is running." : "No iPhone is paired yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(mac.devices) { device in
                    LabeledContent {
                        Button("Remove…") { removing = device }
                    } label: {
                        Label {
                            Text(device.deviceName)
                            Text("Paired \(Date(timeIntervalSince1970:device.pairedAt / 1000).formatted(date:.abbreviated, time:.omitted))")
                        } icon: {
                            Image(systemName:"iphone")
                        }
                    }
                }
                if let problem = mac.problem { Text(problem).foregroundStyle(Color(nsColor:.systemRed)) }
            }
            Section("Scan to Make on This Mac") {
                LabeledContent("Status") { ConnectionLabel(connection:mac.connection) }
                if let address = mac.address {
                    LabeledContent("Address") { Text(address).textSelection(.enabled) }
                }
                Button("Pair Another iPhone…") { pairing = true }
            }
            Section("Help") {
                Link(destination:URL(string:"https://github.com/DMontgomery40/scan-to-make")!) {
                    Label("Scan to Make on GitHub", systemImage:"questionmark.circle")
                }
            }
            Section("About") {
                LabeledContent("Version", value:AppVersion.version)
                LabeledContent("Build", value:AppVersion.build)
            }
        }
        .formStyle(.grouped)
        .task { await mac.refresh() }
        .sheet(isPresented:$pairing) { PairAnotherIPhone() }
        .confirmationDialog(removing.map { "Remove “\($0.deviceName)”?" } ?? "Remove?", isPresented:Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility:.visible, presenting:removing) { device in
            Button("Remove", role:.destructive) { Task { await mac.remove(device.deviceId) } }
            Button("Cancel", role:.cancel) {}
        } message: { _ in
            Text("It won’t be able to send scans to this Mac until you pair it again.")
        }
    }
}

/// Running or not, as a dot and a word.
struct ConnectionLabel: View {
    let connection: MacStatusModel.Connection
    var body: some View {
        HStack(spacing:6) {
            Circle().fill(color).frame(width:8, height:8).accessibilityHidden(true)
            Text(text)
        }
    }
    var text: String {
        switch connection {
        case .checking: return "Checking…"
        case .running: return "Running"
        case .notRunning: return "Not running"
        }
    }
    private var color: Color {
        switch connection {
        case .checking: return Color(nsColor:.tertiaryLabelColor)
        case .running: return Color(nsColor:.systemGreen)
        case .notRunning: return Color(nsColor:.systemRed)
        }
    }
}

/// The pairing code in a sheet, for one more iPhone.
private struct PairAnotherIPhone: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing:16) {
            Text("Pair Another iPhone").font(.headline)
            Text("Scan this code with your iPhone.").foregroundStyle(.secondary)
            QRTile { PairingView(model:CompanionModel.shared, side:240) }
            Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
        }
        .padding(24)
        .frame(width:340)
    }
}

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

/// The menu-bar popover: the app's name and whether it's running, a phone waiting to pair, the pairing
/// code, then Open, Settings and Quit. The system draws its background; its width is fixed and every
/// part has a fixed height, so it never resizes under the pointer.
struct MenuBarPopover<Code: View>: View {
    @ObservedObject var nearby: NearbyModel
    @ObservedObject var mac: MacStatusModel
    @ViewBuilder let code: Code

    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:10) {
                AppMark(size:30)
                VStack(alignment:.leading, spacing:1) {
                    Text("Scan to Make").font(.headline)
                    ConnectionLabel(connection:mac.connection).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength:0)
            }
            .padding(EdgeInsets(top:14, leading:14, bottom:12, trailing:14))
            // A phone waiting to pair stays at the top until it is answered or expires.
            if !nearby.requests.isEmpty {
                VStack(spacing:8) {
                    ForEach(nearby.requests) { NearbyRequestCard(request:$0, model:nearby) }
                }
                .padding(EdgeInsets(top:0, leading:10, bottom:12, trailing:10))
            }
            QRTile { code }
                .padding(.bottom, 14)
            Divider().padding(.horizontal, 12)
            VStack(spacing:0) {
                PopoverRow(title:"Open Scan to Make", symbol:"macwindow", key:"O") { ObjectsWindow.shared.show() }
                PopoverRow(title:"Settings…", symbol:"gearshape", key:",") { SettingsWindow.shared.show() }
                Divider().padding(.horizontal, 6).padding(.vertical, 4)
                PopoverRow(title:"Quit Scan to Make", symbol:"power", key:"Q") { NSApp.terminate(nil) }
            }
            .padding(6)
        }
        .frame(width:300)
        .fixedSize(horizontal:false, vertical:true)
        .task { await mac.refresh() }
    }
}

/// One menu-like row: an icon, a title and its ⌘ shortcut. Hover only tints the row's background,
/// which never changes its size.
private struct PopoverRow: View {
    let title: String
    let symbol: String
    let key: Character
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action:action) {
            HStack(spacing:8) {
                Image(systemName:symbol).frame(width:18).foregroundStyle(.secondary)
                Text(title)
                Spacer(minLength:8)
                Text("⌘\(String(key))").foregroundStyle(.secondary).monospacedDigit()
            }
            .padding(.horizontal, 8)
            .frame(height:26)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius:6, style:.continuous).fill(hovering ? Color.primary.opacity(0.08) : Color.clear))
        }
        .buttonStyle(.plain)
        .keyboardShortcut(KeyEquivalent(Character(key.lowercased())), modifiers:.command)
        .onHover { hovering = $0 }
    }
}
