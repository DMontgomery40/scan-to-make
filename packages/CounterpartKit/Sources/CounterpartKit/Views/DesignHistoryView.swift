#if canImport(SwiftUI)
import SwiftUI

/// Read-only designs in the existing project page; printing or changing an earlier one belongs to slice 2.
public struct DesignHistoryView<Thumbnail: View>: View {
    public var project: Project
    public var select: (String) -> Void
    public var answer: (String, String) -> Void
    @ViewBuilder public var thumbnail: (Project.DesignVersion) -> Thumbnail
    public init(project: Project, select: @escaping (String) -> Void, answer: @escaping (String, String) -> Void,
                @ViewBuilder thumbnail: @escaping (Project.DesignVersion) -> Thumbnail) {
        self.project = project; self.select = select; self.answer = answer; self.thumbnail = thumbnail
    }
    public var body: some View {
        let history = DesignHistory(project)
        if history.showsSections {
            VStack(alignment: .leading, spacing: 14) {
                if !history.have.isEmpty {
                    Text("What you have").font(.headline)
                    ForEach(history.have) { version in
                        VStack(alignment: .leading, spacing: 8) {
                            Button { select(version.id) } label: {
                                HStack(spacing: 12) {
                                    thumbnail(version).frame(width: 72, height: 72).clipped().clipShape(.rect(cornerRadius: 12))
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(history.printedLine(version)).font(.subheadline.weight(.semibold))
                                        Text(version.label).font(.callout).lineLimit(2)
                                        Label(history.outcomeLine(version), systemImage: version.outcome == "works" ? "checkmark.circle" : "shippingbox")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                }.contentShape(.rect)
                            }.buttonStyle(.plain).accessibilityIdentifier("design-\(version.id)")
                            if version.outcome == nil {
                                HStack {
                                    Button("It works") { answer(version.id, "works") }
                                    Button("Needs changes") { answer(version.id, "needs-changes") }
                                }.font(.callout).buttonStyle(.bordered)
                            }
                        }.padding(12).background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 16))
                    }
                }
                if !history.earlier.isEmpty {
                    Text("Earlier designs").font(.headline)
                    ForEach(history.earlier) { version in
                        Button { select(version.id) } label: {
                            HStack {
                                Text(DesignHistory.date(version.sealedAtMs)).foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(version.label).lineLimit(2)
                                    // A design that went to the printer says so, even when how it ended wasn't kept.
                                    if !history.attempts(version).isEmpty {
                                        Text(history.printedLine(version)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                            }.font(.callout).contentShape(.rect)
                        }.buttonStyle(.plain).accessibilityIdentifier("design-\(version.id)")
                    }
                }
                if let restored = project.historyRestored {
                    Text(restored).font(.footnote).foregroundStyle(.secondary)
                }
            }
            // A container, so the identifier names the sections and each design row keeps its own (SwiftUI
            // AccessibilityChildBehavior.contain: "Any child accessibility elements become children of the new element").
            .accessibilityElement(children: .contain).accessibilityIdentifier("design-history")
        }
    }
}
#endif
