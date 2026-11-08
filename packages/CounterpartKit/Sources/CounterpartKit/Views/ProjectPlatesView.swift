#if canImport(SwiftUI)
import SwiftUI
import Observation

@Observable private final class PlateRecordingConfirmation { var plate: ProjectPlate? }

/// Both clients use the same plate navigation. Image loading and mutations stay with their existing transports.
@available(iOS 26.0, macOS 26.0, *)
public struct ProjectPlatesView<Thumbnail: View>: View {
    let project: Project
    let busy: Bool
    let thumbnail: (ProjectPlate) -> Thumbnail
    let select: (ProjectPlate) -> Void
    let printPlate: (ProjectPlate) -> Void
    let markPrinted: (ProjectPlate) -> Void
    let markNotPrinted: (ProjectPlate) -> Void
    @State private var recording = PlateRecordingConfirmation()

    public init(project: Project, busy: Bool, @ViewBuilder thumbnail: @escaping (ProjectPlate) -> Thumbnail,
                select: @escaping (ProjectPlate) -> Void, printPlate: @escaping (ProjectPlate) -> Void, markPrinted: @escaping (ProjectPlate) -> Void, markNotPrinted: @escaping (ProjectPlate) -> Void) {
        self.project = project; self.busy = busy; self.thumbnail = thumbnail
        self.select = select; self.printPlate = printPlate; self.markPrinted = markPrinted; self.markNotPrinted = markNotPrinted
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Plates").font(.headline)
                Spacer()
                Text("\(project.completedPlateCount) of \(project.plates?.count ?? 0) printed").font(.subheadline).foregroundStyle(.secondary)
            }
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(project.plates ?? []) { plate in
                        VStack(alignment: .leading, spacing: 8) {
                            Button { select(plate) } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    thumbnail(plate).frame(width: 144, height: 94).clipped().clipShape(.rect(cornerRadius: 12))
                                    HStack(alignment: .top) {
                                        Text(plate.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                                        Spacer(minLength: 0)
                                        if plate.selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                                    }
                                    if Set((project.plates ?? []).map(\.fileIndex)).count > 1 {
                                        Text(plate.fileName).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                    }
                                    Text(plate.statusText).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                }.contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(plate.name), \(plate.statusText)\(plate.selected ? ", selected" : "")")
                            .accessibilityIdentifier("select-plate-\(plate.fileIndex)-\(plate.plateIndex)")
                            Button(plate.completedAtMs == nil ? "Print…" : "Print Again…") { printPlate(plate) }
                                .buttonStyle(.glass)
                                .accessibilityLabel("\(plate.completedAtMs == nil ? "Print" : "Print again"), \(plate.name)")
                                .accessibilityIdentifier("print-plate-\(plate.fileIndex)-\(plate.plateIndex)")
                            if plate.status != "printed" && plate.completedAtMs == nil {
                                Button("I printed this elsewhere") { recording.plate = plate }
                                    .font(.caption).buttonStyle(.glass)
                                    .accessibilityLabel("I printed this elsewhere, \(plate.name)")
                                    .accessibilityIdentifier("printed-elsewhere-\(plate.fileIndex)-\(plate.plateIndex)")
                                    .confirmationDialog("Mark \(plate.name) as printed elsewhere?", isPresented: Binding(
                                        get: { recording.plate?.id == plate.id },
                                        set: { if !$0 { recording.plate = nil } }), titleVisibility: .visible) {
                                        Button("Mark as printed") { recording.plate = nil; markPrinted(plate) }
                                            .disabled(busy || !project.canSelectPlate)
                                        Button("Cancel", role: .cancel) { recording.plate = nil }
                                    } message: { Text(plate.fileName) }
                            }
                        }
                        .frame(width: 144, alignment: .leading).padding(10)
                        .background(plate.selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08), in: .rect(cornerRadius: 18))
                        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(plate.selected ? Color.accentColor : .clear, lineWidth: 1.5) }
                    }
                }.padding(.vertical, 2)
            }
            .disabled(busy || !project.canSelectPlate)
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach((project.plates ?? []).filter { $0.status == "printed" || $0.completedAtMs != nil }) { plate in
                        Button("Mark \(plate.name) not printed") { markNotPrinted(plate) }
                            .buttonStyle(.glass)
                            .accessibilityIdentifier("mark-not-printed-\(plate.fileIndex)-\(plate.plateIndex)")
                    }
                }
            }
            .disabled(busy || !project.canSelectPlate)
            if !project.canSelectPlate {
                Text("Choose another plate when this step finishes.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// The plate a Print sheet prints, and the way to change it there (David, Nov 6: the sheet opened on plate 1 and he
/// couldn't switch it). Choosing selects that plate in the companion; the estimate, pictures and colours follow it.
@available(iOS 26.0, macOS 26.0, *)
public struct ProjectPlatePicker: View {
    let project: Project
    let busy: Bool
    let select: (ProjectPlate) -> Void

    public init(project: Project, busy: Bool, select: @escaping (ProjectPlate) -> Void) {
        self.project = project; self.busy = busy; self.select = select
    }
    public var body: some View {
        let plates = project.plates ?? []
        let manyFiles = Set(plates.map(\.fileIndex)).count > 1
        Picker(selection: Binding(get: { project.selectedPlate?.id ?? "" }, set: { id in
            if let plate = plates.first(where: { $0.id == id }), !plate.selected { select(plate) }
        })) {
            ForEach(plates) { plate in
                Text(manyFiles ? "\(plate.name) · \(plate.fileName)" : plate.name).tag(plate.id)
            }
        } label: {
            Label("Plate", systemImage: "square.stack.3d.up")
        }
        .pickerStyle(.menu)
        .disabled(busy || !project.canSelectPlate)
        .accessibilityLabel("Plate")
        .accessibilityValue(project.selectedPlate.map { "\($0.name), \($0.statusText)" } ?? "None")
        .accessibilityIdentifier("print-sheet-plate")
    }
}
#endif
