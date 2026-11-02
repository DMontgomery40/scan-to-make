import SwiftUI
import AppKit
#if canImport(ControlKit)
import ControlKit
#endif

// The print sheet. PR 2 of KAN-220 replaces this with PRD §7.3's sheet (printer cards, plate preview,
// colours, quality, strength, plate check); until then it keeps today's filament choice working.

struct PrepareObjectPrint: View {
    /// The project as it was when the sheet opened; `object` reads the current one, so a printer change shows at once.
    let opened: StmObject
    @ObservedObject var model: ObjectsModel
    private var object: StmObject { model.objects.first { $0.id == opened.id } ?? opened }
    @Environment(\.dismiss) private var dismiss
    @State private var choices: [PrinterFilament] = []
    @State private var selected: Int?
    @State private var loading = true
    @State private var failure: String?
    @State private var checked = false

    private func swatch(_ hex: String) -> Color {
        let value = Int(hex.dropFirst(), radix:16) ?? 0
        return Color(red:Double((value >> 16) & 255)/255, green:Double((value >> 8) & 255)/255, blue:Double(value & 255)/255)
    }

    var body: some View {
        VStack(alignment:.leading, spacing:20) {
            HStack {
                VStack(alignment:.leading, spacing:4) {
                    Text("Prepare to Print").font(.title2.weight(.semibold))
                    Text(object.instructions?.isEmpty == false ? object.instructions! : "Your model")
                        .lineLimit(1).font(.callout)
                    if let catalog = model.printerCatalog, catalog.destinations.count > 1, let printer = model.printer(for:object) {
                        Picker(selection:Binding(get:{ printer.id }, set:{ destination in
                            Task { await model.selectPrinter(object.id, destinationId:destination); await load() }
                        })) {
                            ForEach(catalog.destinations) { Text("\($0.name) · \($0.mcpName)").tag($0.id) }
                        } label: { Label("Printer", systemImage:"printer") }
                        .frame(maxWidth:360)
                        .disabled(model.working.contains(object.id))
                    } else if let printer = model.printer(for:object) {
                        Label(printer.name, systemImage:"printer").foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HStack {
                Text("Choose Filament").font(.headline)
                Spacer()
                if !loading && failure == nil { Button("Refresh") { Task { await load() } } }
            }
            if loading {
                ProgressView("Reading filament from your printer…").frame(maxWidth:.infinity, minHeight:100)
            } else if let failure {
                Label(failure, systemImage:"exclamationmark.circle").foregroundStyle(.secondary)
                Button("Try Again") { Task { await load() } }
            } else if choices.isEmpty {
                Text("No selectable filament was reported. Check the printer’s filament or open the model in your slicer.").foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVGrid(columns:[GridItem(.adaptive(minimum:145), spacing:10)], spacing:10) {
                        ForEach(choices) { filament in
                            Button { selected = filament.slot } label: {
                                VStack(alignment:.leading, spacing:8) {
                                    HStack {
                                        Circle().fill(swatch(filament.colour)).frame(width:34, height:34)
                                            .overlay(Circle().strokeBorder(.secondary.opacity(0.4)))
                                        Spacer()
                                        if selected == filament.slot { Image(systemName:"checkmark.circle.fill").foregroundStyle(Color.filament) }
                                    }
                                    Text(filament.material).font(.headline)
                                    Text(filament.slot >= 254 ? "External spool" : "Slot \(filament.slot + 1)").font(.caption).foregroundStyle(.secondary)
                                }.padding(12).frame(maxWidth:.infinity, alignment:.leading)
                                    .background(RoundedRectangle(cornerRadius:12).fill(Color(nsColor:.controlBackgroundColor)))
                                    .overlay(RoundedRectangle(cornerRadius:12).stroke(selected == filament.slot ? Color.filament : Color.secondary.opacity(0.25), lineWidth:selected == filament.slot ? 2 : 1))
                            }.buttonStyle(.plain).accessibilityLabel("\(filament.material), \(filament.colour), slot \(filament.slot + 1)")
                        }
                    }
                }.frame(maxHeight:240)
            }
            if object.print?.uncertain == true {
                Toggle("I checked the printer; it isn’t already printing this model.", isOn:$checked)
            }
            if let problem = model.problem, problem.id == object.id { Text(problem.text).foregroundStyle(.red) }
            Spacer(minLength:0)
            HStack {
                Text("The printer may ask you to confirm its checks next.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Print") {
                    guard let filament = choices.first(where:{ $0.slot == selected }) else { return }
                    Task { if await model.print(object.id, checked:object.print?.uncertain == true && checked, filament:filament) { dismiss() } }
                }.buttonStyle(.glassProminent).controlSize(.large)
                    .disabled(selected == nil || model.working.contains(object.id) || (object.print?.uncertain == true && !checked))
            }
        }
        .padding(24).frame(width:540).frame(minHeight:400)
        .task { await load() }
    }

    private func load() async {
        loading = true; failure = nil; selected = nil
        do { choices = try await model.filaments(object.id) }
        catch { failure = (error as? ControlRemoteError)?.message ?? "Couldn’t read filament from this printer." }
        loading = false
    }
}

