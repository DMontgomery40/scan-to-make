import SwiftUI
import CounterpartKit

/// Printers (PRD §5.8, screens/phone-printers.jpg): one row per printer from the MCP configs on the Mac.
/// Printers are configured in the MCPs; Counterpart picks them up and never duplicates their settings.
struct PrintersView: View {
    let store: ProjectsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                if let catalog = store.catalog {
                    ForEach(catalog.destinations) { printer in PrinterRow(store: store, printer: printer) }
                } else if let problem = store.printerProblem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                } else {
                    ProgressView()
                }
            } footer: {
                Text("These come from bambu-printer-mcp and mcp-3D-printer-server on your Mac. Add or change printers there; Counterpart picks them up.")
            }
        }
        .navigationTitle("Printers")
        .refreshable { await store.loadPrinters() }
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task {
            // The Mac reads each printer's state in the background; asking again shows it as it fills in.
            for _ in 0..<6 where !Task.isCancelled {
                await store.loadPrinters()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

struct PrinterRow: View {
    let store: ProjectsStore
    let printer: PrinterDestination

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: printer.isBambu ? "printer.fill" : "printer").font(.title2).frame(width: 48, height: 48)
                .glassEffect(.regular, in: .rect(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 3) {
                Text(printer.name).font(.headline)
                Text(stateText).font(.subheadline).foregroundStyle(printer.isReady == true ? Color.okGreen : .secondary)
                Text(printer.modelName + " · " + printer.via).font(.caption).foregroundStyle(.secondary)
                if let update = printer.capabilities?.update?.message {
                    Label(update, systemImage: "arrow.down.circle").font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// Ready, busy (with the project printing on it), offline, or not read yet.
    private var stateText: String {
        let job = store.projects.first { ($0.print?.destination?.id ?? $0.printerDestinationId) == printer.id && store.words($0).phase == .printing }
        switch printer.state {
        case "ready": return "Ready"
        case "busy": return job.map { "Printing " + ProjectWords.title($0) } ?? "Busy"
        case "offline": return "Offline"
        default: return printer.state == nil ? "Configured on your Mac" : "Checking…"
        }
    }
}
