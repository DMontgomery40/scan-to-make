import SwiftUI
import CounterpartKit

/// Settings → Keep on this iPhone (on-device-library.md): what the phone keeps of the Mac's projects so it shows them with
/// the Mac away, how much space that takes, and Clear. David, Nov 11: "maybe just let them (and iPhone people all people)
/// just choose? Doesn't seem hard."
struct LibrarySettingsSection: View {
    @Environment(AppModel.self) private var app
    @State private var confirmClear = false

    private var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    var body: some View {
        @Bindable var library = app.library
        Section {
            Picker(selection: $library.keep) {
                ForEach(OnDeviceLibrary.Keep.allCases, id: \.self) { keep in Text(keep.title).tag(keep) }
            } label: {
                HStack(spacing: 12) {
                    SettingsIcon(symbol: "internaldrive.fill", tint: .gray)
                    Text("Keep")
                }
            }
            .accessibilityIdentifier("library-keep")
            HStack {
                Text("Uses \(ByteCountFormatter.string(fromByteCount: library.usage, countStyle: .file))")
                    .foregroundStyle(.secondary).monospacedDigit()
                    .accessibilityIdentifier("library-usage")
                Spacer()
                Button("Clear", role: .destructive) { confirmClear = true }
                    .disabled(library.usage == 0)
                    .accessibilityIdentifier("library-clear")
            }
            .confirmationDialog("Clear what this \(device) keeps?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear", role: .destructive) { app.library.clear() }
            } message: {
                Text("Pictures and models come again from your Mac the next time it answers.")
            }
        } header: {
            Text("Keep on this \(device)")
        } footer: {
            Text("So your projects show even when your Mac isn’t answering. Pictures always come; 3D models wait for Wi‑Fi unless you open one; scans only when you choose Everything. Up to \(ByteCountFormatter.string(fromByteCount: library.keep.ceiling, countStyle: .file)), then the projects you opened longest ago make room.")
        }
        .onAppear { app.library.refreshUsage() }
    }
}
