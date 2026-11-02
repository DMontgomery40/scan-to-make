import SwiftUI
import CounterpartKit

/// Settings as it was before the PRD's Settings and About (KAN-217 PR 4) replace it.
struct SettingsView: View {
    let store: ProjectsStore
    @State private var checking = false
    @Environment(\.dismiss) private var dismiss
    private var version: String {
        let info = Bundle.main.infoDictionary
        return "Version \(info?["CFBundleShortVersionString"] as? String ?? "–") (\(info?["CFBundleVersion"] as? String ?? "–"))"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Image("Logo").resizable().frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Counterpart").font(.title3.bold())
                            Text("Scan it or describe it. Your Mac makes it. Your printer prints it.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    LabeledContent("Status") {
                        if checking { ProgressView() }
                        else if store.connection?.state == .paired {
                            Label(store.error == nil ? "Connected" : "Can't reach it", systemImage: "circle.fill")
                                .labelStyle(.titleAndIcon).foregroundStyle(store.error == nil ? .green : .orange)
                        } else { Text("Not connected").foregroundStyle(.orange) }
                    }
                    if let address = store.connection?.host { LabeledContent("Address", value: address) }
                    Button("Check Connection") {
                        Task { checking = true; _ = try? await store.pairingClient.check(); await store.load(); checking = false }
                    }
                    Button("Connect to a Different Mac") { dismiss(); store.onPair() }
                } header: { Text("Your Mac") } footer: {
                    Text("Your Mac does the touch-ups and talks to your printer. Keep Counterpart running on it.")
                }
                Section("How It Works") {
                    Label("Describe what you want, add a photo or two, or scan a real object.", systemImage: "text.viewfinder")
                    Label("Your Mac makes the model with your own Claude and Blender, then shows it here.", systemImage: "desktopcomputer")
                    Label("Check the size and pictures, fix anything, then tap Print.", systemImage: "printer")
                }
                Section("Help") {
                    Link(destination: URL(string: "https://counterpart.dtmont.com/")!) {
                        Label("Counterpart Website", systemImage: "safari")
                    }
                    Link(destination: URL(string: "https://counterpart.dtmont.com/#help")!) {
                        Label("Get Help", systemImage: "questionmark.circle")
                    }
                }
                Section("About") {
                    LabeledContent("Counterpart", value: version)
                    LabeledContent("Made With", value: "Open source")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
