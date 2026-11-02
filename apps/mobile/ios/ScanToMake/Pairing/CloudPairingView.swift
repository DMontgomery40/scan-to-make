import SwiftUI
import CounterpartKit

/// Same-account discovery is first. The camera is opened only when the person chooses the code fallback.
struct CloudPairingView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var fallback = false
    @State private var connecting: String?
    @State private var connected: String?
    @State private var problem: String?
    @State private var pairingTask: Task<Void, Never>?

    var body: some View {
        if fallback { FindYourMacView(mode: .firstRun) }
        else {
            NavigationStack {
                VStack(spacing: 20) {
                    Spacer()
                    Image(systemName: connected == nil ? "laptopcomputer.and.iphone" : "checkmark.circle.fill")
                        .font(.system(size: 64)).foregroundStyle(Color.filament)
                    if let connected {
                        Text("Connected to \(connected)").font(.title.bold()).multilineTextAlignment(.center)
                        Text("Your iPhone and Mac use the same Apple Account, so they found each other.")
                            .foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Continue") { app.holdPairingScreen = false; app.paired() }.buttonStyle(.glassProminent)
                    } else if let connecting {
                        ProgressView("Connecting to \(connecting)…")
                    } else if app.cloud.reading {
                        ProgressView("Finding your Mac in iCloud…")
                    } else {
                        Text("Connect to your Mac").font(.title.bold())
                        ForEach(app.cloud.macs) { mac in
                            Button(mac.name) { connect(mac) }.buttonStyle(.glassProminent)
                        }
                        if let message = problem ?? app.cloud.message {
                            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        Button("Look Again") { Task { await discover() } }.buttonStyle(.glass)
                    }
                    Spacer()
                    if connected == nil {
                        Button("Use Your Mac's Code") {
                            pairingTask?.cancel(); pairingTask = nil
                            app.holdPairingScreen = false; fallback = true
                        }.buttonStyle(.glass)
                    }
                }.padding(28).frame(maxWidth: .infinity)
            }
            .task { if app.pendingLink != nil { useCode() } else { await discover() } }
            .onChange(of: app.pendingLink) { _, link in if link != nil { useCode() } }
            .onChange(of: scenePhase) { _, phase in if phase == .active && connected == nil { Task { await discover() } } }
            .onDisappear { pairingTask?.cancel(); pairingTask = nil }
        }
    }

    private func useCode() {
        pairingTask?.cancel(); pairingTask = nil
        app.holdPairingScreen = false; fallback = true
    }

    private func discover() async {
        guard connecting == nil, connected == nil, !fallback else { return }
        problem = nil
        await app.cloud.refresh()
        guard !Task.isCancelled, !fallback else { return }
        if app.cloud.macs.count == 1, let mac = app.cloud.macs.first { connect(mac) }
    }

    private func connect(_ mac: CloudMac) {
        guard connecting == nil else { return }
        connecting = mac.name; problem = nil; app.holdPairingScreen = true
        pairingTask = Task {
            defer { connecting = nil }
            do {
                _ = try await app.pairing.enrol(mac, deviceName: app.pairing.store.deviceName())
                guard !Task.isCancelled else { return }
                UserDefaults.standard.set(mac.name, forKey: ProjectsStore.macNameKey)
                connected = mac.name
            } catch {
                guard !Task.isCancelled else { return }
                app.holdPairingScreen = false
                problem = "Couldn't connect to \(mac.name). Keep Counterpart open on your Mac and connect to the same Wi-Fi, or use its code."
            }
        }
    }
}
