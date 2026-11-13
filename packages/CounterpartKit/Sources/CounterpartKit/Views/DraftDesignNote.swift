#if canImport(SwiftUI)
import SwiftUI

/// #788: a design that isn't finished. The one plain line, then the printer MCP's reasons word for word, the first two
/// shown and the rest behind Show All. Never interpreted: the app shows the words it is given.
@available(iOS 26.0, macOS 26.0, *)
public struct DraftDesignNote: View {
    let draft: Project.DesignDraft
    @State private var expanded = false
    public init(draft: Project.DesignDraft) { self.draft = draft }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(Project.DesignDraft.line, systemImage: "exclamationmark.triangle")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                .accessibilityIdentifier("draft-design-line")
            if !draft.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(draft.shown(expanded: expanded).enumerated()), id: \.offset) { _, reason in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•").foregroundStyle(.secondary)
                            Text(reason).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("draft-design-reason")
                    }
                }
                .font(.footnote).foregroundStyle(.secondary)
                if draft.collapses {
                    Button(expanded ? "Show Fewer" : "Show All \(draft.reasons.count)") { withAnimation { expanded.toggle() } }
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier("draft-design-more")
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("draft-design")
    }
}
#endif
