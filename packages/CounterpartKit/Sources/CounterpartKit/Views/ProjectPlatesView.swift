#if canImport(SwiftUI)
import SwiftUI

/// Both clients use the same plate navigation. Image loading and mutations stay with their existing transports.
@available(iOS 26.0, macOS 26.0, *)
public struct ProjectPlatesView<Thumbnail: View>: View {
    let project: Project
    let busy: Bool
    let thumbnail: (ProjectPlate) -> Thumbnail
    let select: (ProjectPlate) -> Void
    let printPlate: (ProjectPlate) -> Void

    public init(project: Project, busy: Bool, @ViewBuilder thumbnail: @escaping (ProjectPlate) -> Thumbnail,
                select: @escaping (ProjectPlate) -> Void, printPlate: @escaping (ProjectPlate) -> Void) {
        self.project = project; self.busy = busy; self.thumbnail = thumbnail
        self.select = select; self.printPlate = printPlate
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
                        }
                        .frame(width: 144, alignment: .leading).padding(10)
                        .background(plate.selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.08), in: .rect(cornerRadius: 18))
                        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(plate.selected ? Color.accentColor : .clear, lineWidth: 1.5) }
                    }
                }.padding(.vertical, 2)
            }
            .disabled(busy || !project.canSelectPlate)
            if !project.canSelectPlate {
                Text(project.print?.uncertain == true ? "Check the current print on your printer before changing plates." : "Choose another plate when this step finishes.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
#endif
