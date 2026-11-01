import SwiftUI

/// The printable caliper your Mac ships. Held next to something in a photo, it gives the touch-up a size it can trust.
enum Caliper {
    static let name = "Scan to Make caliper"

    /// Asks the Mac to print it. Returns a sentence to show if it couldn't.
    @MainActor static func print(_ store: ObjectsStore) async -> String? {
        do {
            store.replace(try await store.mac.printCaliper())
            return nil
        } catch let failure as MacError {
            // It may have made the caliper even though it couldn't print it yet.
            await store.load()
            return failure.message
        } catch {
            return MacError.unreachable.message
        }
    }
}

/// Settings > Help: print the caliper at any time.
struct CaliperPrintButton: View {
    let store: ObjectsStore
    @State private var working = false
    @State private var result: String?

    var body: some View {
        Button {
            Task { working = true; result = await Caliper.print(store) ?? "Printing. It's in Your Things."; working = false }
        } label: {
            HStack {
                Label("Print the Scan to Make Caliper", systemImage: "ruler")
                Spacer()
                if working { ProgressView() }
            }
        }
        .disabled(working || store.connection?.paired != true)
        if let result { Text(result).font(.footnote).foregroundStyle(.secondary) }
    }
}

/// Once, after pairing: suggests printing the caliper before the first real job.
struct CaliperSetupCard: View {
    @Bindable var store: ObjectsStore
    @AppStorage("caliperCardDone") private var done = false
    @State private var working = false
    @State private var problem: String?

    private var showing: Bool {
        !done && store.loaded && store.error == nil && store.connection?.paired == true
            && !store.objects.contains { $0.kind == "caliper" }
    }

    var body: some View {
        if showing {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "ruler")
                            .font(.title2)
                            .frame(width: 44, height: 44)
                            .glassEffect(.regular.tint(.accentColor.opacity(0.25)), in: .circle)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Print a caliper first").font(.headline)
                            Text("Hold it next to things in your photos. Your Mac reads the size from it, which is more exact than a scan.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    if let problem { Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red) }
                    HStack {
                        Button("Not Now") { done = true }
                            .buttonStyle(.glass)
                        Spacer()
                        Button {
                            Task {
                                working = true
                                problem = await Caliper.print(store)
                                if problem == nil { done = true }
                                working = false
                            }
                        } label: {
                            if working { ProgressView() } else { Label("Print", systemImage: "printer") }
                        }
                        .buttonStyle(.glassProminent)
                        .disabled(working)
                    }
                }
                .padding(.vertical, 6)
            }
        }
    }
}

/// The object page: what the touch-up measured, caliper readings first.
struct MeasurementsSection: View {
    let object: StmObject

    var body: some View {
        let lines = ObjectWords.measurements(object)
        if !lines.isEmpty {
            Section {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.subheadline)
                }
            } header: { Text("Measured") } footer: {
                Text("A caliper reading wins over the scan. A ruler reading is an estimate.")
            }
        }
    }
}
