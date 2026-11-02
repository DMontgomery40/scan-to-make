import SwiftUI
import UserNotifications
import CounterpartKit

/// Settings (PRD §5.9, screens/phone-settings.jpg), opened from the account button on Home as a sheet: your
/// Mac, notifications, help and About. Printers are configured on the Mac and never duplicated here.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    let store: ProjectsStore
    @State private var path: [String] = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var checking = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "macmini.fill").font(.title2).foregroundStyle(.white)
                            .frame(width: 50, height: 50)
                            .glassEffect(.regular.tint((store.reachable == false ? Color.orange : Color.okGreen).opacity(0.28)), in: .rect(cornerRadius: 16))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(store.macName ?? "Your Mac").font(.headline)
                            if checking {
                                Label("Checking…", systemImage: "arrow.triangle.2.circlepath").font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                            } else if store.reachable == false || store.error != nil {
                                Label("Can't reach it right now", systemImage: "exclamationmark.circle.fill").font(.subheadline.weight(.medium)).foregroundStyle(.orange)
                            } else {
                                Label("Connected now", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium)).foregroundStyle(Color.okGreen)
                            }
                            if let host = store.connection?.host { Text("On your network · \(host)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            Button { check() } label: { Text("Check Connection").minimumScaleFactor(0.75).frame(maxWidth: .infinity) }
                                .disabled(checking)
                            Button { dismiss(); store.onPair() } label: { Text("Different Mac…").minimumScaleFactor(0.75).frame(maxWidth: .infinity) }
                                .accessibilityLabel("Connect a Different Mac")
                        }
                        .buttonStyle(.glass).controlSize(.regular).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                } header: { Text("Your Mac") }

                Section {
                    NavigationLink(value: "notifications") {
                        HStack(spacing: 12) {
                            SettingsIcon(symbol: "bell.badge.fill", tint: .red)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Notifications")
                                Text(NotificationChoices.summary).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section {
                    link(CounterpartIdentifiers.docsSite, SettingsLinkRow(symbol: "book.fill", tint: .blue, title: "Guide", detail: nil))
                    link(URL(string: "#how", relativeTo: CounterpartIdentifiers.docsSite)!.absoluteURL,
                         SettingsLinkRow(symbol: "cube.transparent.fill", tint: .indigo, title: "How scanning works", detail: nil))
                    link(URL(string: "#help", relativeTo: CounterpartIdentifiers.docsSite)!.absoluteURL,
                         SettingsLinkRow(symbol: "ruler.fill", tint: .teal, title: "Print the caliper card", detail: "Checks your scans come out the right size"))
                    link(CounterpartIdentifiers.scanRig,
                         SettingsLinkRow(symbol: "rotate.3d.fill", tint: .filament, title: "Print the scan rig", detail: "By Kass 3D on MakerWorld. For casual photos, not professional equipment."))
                } header: { Text("Help") }

                Section {
                    NavigationLink(value: "about") {
                        HStack(spacing: 12) {
                            AppIcon(size: 30)
                            Text("About Counterpart")
                            Spacer()
                            Text(AboutView.version).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(role: .confirm) { dismiss() } } }
            .navigationDestination(for: String.self) { page in
                if page == "about" { AboutView() } else { NotificationSettingsView(store: store) }
            }
        }
        #if DEBUG
        .task {
            if let page = app.debugSettings, page != "settings" { path = [page] }
            app.debugSettings = nil
        }
        #endif
    }

    private func link<Label: View>(_ url: URL, _ label: Label) -> some View {
        Button { openURL(url) } label: { label }.foregroundStyle(.primary)
    }

    private func check() {
        guard !checking else { return }
        checking = true
        Task {
            defer { checking = false }
            _ = try? await store.pairingClient.check()
            await store.load()
        }
    }
}

/// Counterpart's mark, as the mockups draw it: two interlocking parts, the object and its counterpart.
struct AppIcon: View {
    let size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.23, style: .continuous)
                .fill(LinearGradient(colors: [Color.filament, Color(red: 0.85, green: 0.2, blue: 0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.08).fill(.white).frame(width: size * 0.34, height: size * 0.5).offset(x: -size * 0.1)
                RoundedRectangle(cornerRadius: size * 0.08).strokeBorder(.white, lineWidth: size * 0.07).frame(width: size * 0.34, height: size * 0.5)
                    .offset(x: size * 0.1, y: size * 0.06)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
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
            .accessibilityHidden(true)
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
        .accessibilityAddTraits(.isLink)
    }
}

/// Which notifications you want (PRD §9.1). Kept on this phone for the notification service to read (a
/// seam for the notifications milestone); the progress milestones live on the Mac (`/v1/settings`),
/// because the Mac decides when to send them.
enum NotificationChoices {
    struct Kind: Identifiable { let id: String; let symbol: String; let tint: Color; let title: String; var urgent = false }
    static let projects = [Kind(id: "ready", symbol: "checkmark.seal.fill", tint: .filament, title: "Ready to print"),
                           Kind(id: "ask", symbol: "hand.raised.fill", tint: .orange, title: "Your Mac has a question")]
    static let beforePrint = [Kind(id: "confirm", symbol: "checkmark.shield.fill", tint: .blue, title: "A printer needs a yes", urgent: true)]
    static let whilePrinting = [Kind(id: "live", symbol: "livephoto", tint: .okGreen, title: "Live Activity"),
                                Kind(id: "first", symbol: "square.stack.3d.down.forward.fill", tint: .okGreen, title: "First layer's down")]
    static let afterProgress = [Kind(id: "paused", symbol: "pause.circle.fill", tint: .orange, title: "Printer paused", urgent: true),
                                Kind(id: "done", symbol: "shippingbox.fill", tint: .okGreen, title: "Print done")]
    static let problems = [Kind(id: "problem", symbol: "xmark.octagon.fill", tint: .red, title: "Stopped or couldn't finish", urgent: true),
                           Kind(id: "lost", symbol: "wifi.exclamationmark", tint: .gray, title: "Lost contact with a printer")]
    static var all: [Kind] { projects + beforePrint + whilePrinting + afterProgress + problems }

    /// `CounterpartNotify.<kind>`: on unless you turned it off.
    static func isOn(_ kind: String) -> Bool { UserDefaults.standard.object(forKey: "CounterpartNotify." + kind) as? Bool ?? true }
    static func set(_ kind: String, _ on: Bool) { UserDefaults.standard.set(on, forKey: "CounterpartNotify." + kind) }
    /// The Mac's milestone choice, as last read.
    static var milestones: String { UserDefaults.standard.string(forKey: "CounterpartNotify.milestones") ?? "50" }

    static func milestoneWords(_ value: String) -> String {
        switch value { case "off": "no progress"; case "25-50-75": "progress at 25, 50 and 75%"; case "every-10": "progress every 10%"; default: "progress at halfway" }
    }

    /// "All on · progress at halfway"
    static var summary: String {
        let off = all.filter { !isOn($0.id) }.count
        let state = off == 0 ? "All on" : off == all.count ? "All off" : "\(all.count - off) of \(all.count) on"
        return "\(state) · \(milestoneWords(milestones))"
    }
}

/// Settings → Notifications (PRD §9.1, screens/phone-settings-notifications.jpg): one switch per kind, and the
/// progress milestones, which the Mac keeps.
struct NotificationSettingsView: View {
    let store: ProjectsStore
    @State private var on: [String: Bool] = Dictionary(uniqueKeysWithValues: NotificationChoices.all.map { ($0.id, NotificationChoices.isOn($0.id)) })
    @State private var milestones = NotificationChoices.milestones
    @State private var milestonesAvailable = true
    @State private var problem: String?
    /// One milestone change at a time; the first read never overwrites one.
    @State private var savingMilestones = false
    /// Set once you change it here: the first read then never replaces your choice.
    @State private var editedMilestones = false

    var body: some View {
        List {
            NotificationPermissionRow()
            Section { ForEach(NotificationChoices.projects) { row($0) } } header: { Text("Projects") }
            Section { ForEach(NotificationChoices.beforePrint) { row($0) } } header: { Text("Before a print") }
            Section {
                ForEach(NotificationChoices.whilePrinting) { row($0) }
                HStack(spacing: 12) {
                    SettingsIcon(symbol: "percent", tint: .okGreen)
                    Picker("Progress", selection: Binding(get: { milestones }, set: { setMilestones($0) })) {
                        Text("Off").tag("off")
                        Text("Halfway").tag("50")
                        Text("25, 50 and 75%").tag("25-50-75")
                        Text("Every 10%").tag("every-10")
                    }
                    .pickerStyle(.menu)
                    .disabled(!milestonesAvailable || savingMilestones)
                }
                .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                ForEach(NotificationChoices.afterProgress) { row($0) }
            } header: { Text("While printing") } footer: {
                if !milestonesAvailable { Text("Update Counterpart on your Mac to choose progress milestones.") }
                else if let problem { Text(problem).foregroundStyle(.red) }
            }
            Section { ForEach(NotificationChoices.problems) { row($0) } } header: { Text("Problems") } footer: {
                Text("Sent from your Mac through iCloud, so use the same Apple Account on both. Marked ones are time sensitive.")
            }
        }
        .listSectionSpacing(10)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                let value = try await store.mac.client.settings().milestones
                guard !savingMilestones, !editedMilestones else { return }
                milestones = value
                UserDefaults.standard.set(value, forKey: "CounterpartNotify.milestones")
            } catch let failure as CompanionError where failure.isUnsupported { milestonesAvailable = false }
            catch {}
        }
    }

    private func row(_ kind: NotificationChoices.Kind) -> some View {
        Toggle(isOn: Binding(get: { on[kind.id] ?? true }, set: { on[kind.id] = $0; NotificationChoices.set(kind.id, $0) })) {
            HStack(spacing: 12) {
                SettingsIcon(symbol: kind.symbol, tint: kind.tint)
                Text(kind.title).lineLimit(1).minimumScaleFactor(0.85)
                if kind.urgent {
                    Image(systemName: "clock.badge.exclamationmark.fill").font(.caption).foregroundStyle(.secondary)
                        .accessibilityLabel("Time sensitive")
                }
            }
        }
        .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
    }

    private func setMilestones(_ value: String) {
        guard !savingMilestones else { return }
        let previous = milestones
        milestones = value; problem = nil; savingMilestones = true; editedMilestones = true
        Task {
            defer { savingMilestones = false }
            do {
                let saved = try await store.mac.client.setMilestones(value).milestones
                milestones = saved
                UserDefaults.standard.set(saved, forKey: "CounterpartNotify.milestones")
            } catch let failure as CompanionError {
                milestones = previous
                if failure.isUnsupported { milestonesAvailable = false } else { problem = failure.message }
            } catch { milestones = previous; problem = CompanionError.unreachable.message }
        }
    }
}

/// About (PRD §5.9, credits §15, screens/phone-about.jpg).
struct AboutView: View {
    @Environment(\.openURL) private var openURL

    static var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "–") (\(info?["CFBundleVersion"] as? String ?? "–"))"
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    AppIcon(size: 112)
                        .shadow(color: Color.filament.opacity(0.45), radius: 24, y: 8)
                        .padding(.top, 8)
                    Text("Counterpart").font(.title.bold())
                    Text("Version \(Self.version)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                    Text("Makes physical things that fit your life, with your iPhone, your Mac and your 3D printer.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 12)
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)
                .listRowBackground(Color.clear)
            }

            Section {
                Button { openURL(CounterpartIdentifiers.docsSite) } label: {
                    SettingsLinkRow(symbol: "globe", tint: .blue, title: CounterpartIdentifiers.docsSite.host() ?? "Website", detail: nil)
                }
                .foregroundStyle(.primary)
                NavigationLink { NoticesView() } label: { SettingsRow(symbol: "chevron.left.forwardslash.chevron.right", tint: .gray, title: "Open-source notices") }
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
        .accessibilityElement(children: .combine)
    }
}

/// The app's third-party notices (apps/mobile/THIRD_PARTY_NOTICES.md, generated by tools/licence-audit).
struct NoticesView: View {
    private var text: String {
        Bundle.main.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
            ?? "The notices aren't in this build."
    }
    var body: some View {
        ScrollView {
            Text(text).font(.footnote.monospaced()).textSelection(.enabled).padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Open-source notices")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Notifications need the system's permission. Undecided: ask here (after "Not Now" on first run). Denied: the
/// Settings app is the only place to change it.
struct NotificationPermissionRow: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var status: UNAuthorizationStatus?

    var body: some View {
        Group {
            switch status {
            case .notDetermined?:
                Section {
                    Button("Turn On Notifications") {
                        Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]); await read() }
                    }
                } footer: { Text("So you know when it's ready and when the print is done.") }
            case .denied?:
                Section {
                    Button("Open Settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
                } footer: { Text("Notifications are off for Counterpart. Turn them on in Settings.") }
            default: EmptyView()
            }
        }
        .task { await read() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await read() } } }
    }

    private func read() async { status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
}

