import SwiftUI
import CounterpartKit

// The print sheet and the printer's own confirmation as they worked before the PRD's print screens (M3,
// KAN-217 PR 3) replace them. Kept so printing keeps working on this milestone.

struct PhonePrintPreparation: View {
    let store: ProjectsStore
    let objectId: String
    @Environment(\.dismiss) private var dismiss
    @State private var printerId = ""
    @State private var choices: [PrinterFilament] = []
    @State private var selected: Int?
    @State private var checked = false
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?

    private var object: StmObject? { store.project(objectId) }
    private var previousPrinter: String { object?.print?.destination?.name ?? "the printer" }
    private func displayName(_ filament: PrinterFilament) -> String {
        var name = filament.name.replacingOccurrences(of: #"\s*#[0-9a-fA-F]{6,8}\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = " " + filament.material
        if name.count > suffix.count, name.uppercased().hasSuffix(suffix.uppercased()) {
            name.removeLast(suffix.count)
        }
        return name.isEmpty ? filament.material : name
    }
    private func swatch(_ hex: String) -> Color {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double((value >> 16) & 255) / 255,
                     green: Double((value >> 8) & 255) / 255,
                     blue: Double(value & 255) / 255)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let object {
                        Text(object.instructions?.isEmpty == false ? object.instructions! : "Your model")
                            .font(.headline).lineLimit(3)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Printer").font(.headline)
                        if let catalog = store.catalog, !catalog.destinations.isEmpty {
                            Picker("Printer", selection: Binding(get: { printerId }, set: { id in Task { await choosePrinter(id) } })) {
                                ForEach(catalog.destinations) { Text($0.name).tag($0.id) }
                            }
                            .pickerStyle(.menu).labelsHidden().disabled(loading || sending)
                        } else {
                            Text(store.printerProblem ?? "Reading your Mac’s printers…").foregroundStyle(.secondary)
                        }
                    }
                    if object?.print?.uncertain == true {
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Check the previous print", systemImage: "exclamationmark.triangle.fill")
                                .font(.headline).foregroundStyle(.orange)
                            Text("The last request may have reached \(previousPrinter). Check it before trying again.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            Toggle("I checked; it isn’t printing this model.", isOn: $checked)
                        }
                        .padding(16).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text("Filament").font(.headline)
                            Spacer()
                            if !loading { Button("Refresh") { Task { await load() } }.disabled(sending) }
                        }
                        if loading {
                            ProgressView("Reading your printer’s filament…").frame(maxWidth: .infinity, alignment: .leading)
                        } else if choices.isEmpty, error == nil {
                            Text("No selectable filament was reported. Check the printer or open the model in your slicer.").foregroundStyle(.secondary)
                        } else {
                            ForEach(choices) { filament in
                                Button { selected = filament.slot } label: {
                                    HStack(spacing: 14) {
                                        Circle().fill(swatch(filament.colour)).frame(width: 38, height: 38)
                                            .overlay(Circle().strokeBorder(.secondary.opacity(0.4)))
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(displayName(filament)).font(.body.weight(.medium)).foregroundStyle(.primary)
                                            Text(filament.slot >= 254 ? "External spool" : "Slot \(filament.slot + 1)")
                                                .font(.subheadline).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: selected == filament.slot ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selected == filament.slot ? Color.accentColor : Color.secondary)
                                    }
                                    .padding(14).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                                }.buttonStyle(.plain).disabled(sending)
                                    .accessibilityLabel("\(displayName(filament)), \(filament.colour), slot \(filament.slot + 1)")
                                    .accessibilityAddTraits(selected == filament.slot ? .isSelected : [])
                            }
                        }
                    }
                    if let error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                    Text("Your printer may ask you to confirm its checks before printing.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Prepare to Print").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(sending) } }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button { Task { await submit() } } label: {
                    HStack { if sending { ProgressView() }; Text("Print").frame(maxWidth: .infinity) }
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                .disabled(loading || sending || selected == nil || (object?.print?.uncertain == true && !checked))
                .padding(.horizontal, 20).padding(.vertical, 10).background(Color(uiColor: .systemBackground))
            }
            .task {
                if store.catalog == nil { await store.loadPrinters() }
                printerId = object?.printerDestinationId ?? store.catalog?.defaultDestinationId ?? ""
                await load()
            }
        }
    }

    private func choosePrinter(_ id: String) async {
        guard id != printerId, !loading, !sending else { return }
        loading = true; selected = nil; choices = []; error = nil
        do {
            let updated = try await store.mac.selectPrinter(objectId, destinationId: id)
            store.replace(updated); printerId = id
            await load()
        } catch let failure as CompanionError { error = failure.message; loading = false }
        catch { self.error = CompanionError.unreachable.message; loading = false }
    }

    private func load() async {
        loading = true; selected = nil; choices = []; error = nil
        if printerId.isEmpty {
            await store.loadPrinters()
            printerId = object?.printerDestinationId ?? store.catalog?.defaultDestinationId ?? ""
        }
        guard !printerId.isEmpty else { loading = false; error = store.printerProblem ?? "No printer is available on your Mac."; return }
        do { choices = try await store.mac.filaments(objectId) }
        catch let failure as CompanionError { error = failure.message }
        catch { self.error = CompanionError.unreachable.message }
        loading = false
    }

    private func submit() async {
        guard let filament = choices.first(where: { $0.slot == selected }), !sending else { return }
        sending = true; error = nil
        defer { sending = false }
        do {
            let updated = try await store.mac.print(objectId, checked: object?.print?.uncertain == true && checked, filament: filament)
            store.replace(updated); dismiss()
        } catch let failure as CompanionError { error = failure.message }
        catch { self.error = CompanionError.unreachable.message }
    }
}


struct PrinterConfirmationView: View {
    let question: StmObject.PrintConfirmation
    let working: Bool
    let answer: (PrintConfirmationResponse.Action, [String: Bool]) -> Void
    @State private var checked: [String: Bool] = [:]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let now = timeline.date.timeIntervalSince1970 * 1000
            let expired = question.expiresAtMs <= now
            VStack(alignment: .leading, spacing: 16) {
                Text("Printer Confirmation").font(.headline)
                Text(verbatim: question.message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if question.supported {
                    ForEach(question.fields, id: \.name) { field in
                        Button { checked[field.name] = !(checked[field.name] ?? false) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: checked[field.name] == true ? "checkmark.square.fill" : "square")
                                    .font(.title2).foregroundStyle(.tint)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: field.title).font(.body.weight(.medium))
                                    if let description = field.description {
                                        Text(verbatim: description).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    if field.required { Text("Required").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(checked[field.name] == true ? "Checked" : "Unchecked")
                        .disabled(working || expired)
                    }
                    Button { answer(.accept, checked) } label: {
                        Label("Confirm and Continue", systemImage: "checkmark.circle").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .disabled(working || !question.canAccept(checked, atMs: now))
                } else {
                    Text("This printer question needs a form this app cannot display. Cancel this print to continue.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if expired {
                    Text("This confirmation has expired. Waiting for your Mac to update.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Button("Cancel Print", role: .destructive) { answer(.cancel, [:]) }
                    .buttonStyle(.glass).controlSize(.large).frame(maxWidth: .infinity)
                    .disabled(working || expired)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

