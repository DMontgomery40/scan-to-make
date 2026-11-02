import SwiftUI
import CounterpartKit

/// A native message row. The caller keeps image loading and full-size presentation on its platform.
struct ConversationBubble<Photos: View>: View {
    let entry: ProjectConversation.Entry
    @ViewBuilder var photos: () -> Photos
    @State private var expanded = false

    private var person: Bool { entry.role == .person }
    private var text: String { !person && !expanded ? entry.firstParagraph : entry.text }
    private var formatted: AttributedString {
        // SwiftUI renders inline Markdown; preserve list indentation and draw its standard bullet marker.
        let display = text.replacingOccurrences(of: #"(?m)^(\s*)[-+*] "#, with: "$1• ", options: .regularExpression)
        return (try? AttributedString(markdown: display, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    var body: some View {
        VStack(spacing: 12) {
            if entry.showsTime, let at = entry.atMs {
                Text(Date(timeIntervalSince1970: at / 1000).formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            }
            HStack(alignment: .top, spacing: 0) {
                if person { Spacer(minLength: 28) }
                VStack(alignment: .leading, spacing: 10) {
                    if !entry.text.isEmpty { Text(formatted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    photos()
                    if !person && entry.canExpand {
                        Button(expanded ? "Less" : "More") { expanded.toggle() }.font(.callout).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                    }
                    if let status = entry.status { Text(status).font(.caption).foregroundStyle(.secondary) }
                }
                .padding(14)
                .background(person ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.10), in: .rect(cornerRadius: 18))
                .accessibilityIdentifier(entry.id)
                if !person { Spacer(minLength: 28) }
            }
        }
    }
}
