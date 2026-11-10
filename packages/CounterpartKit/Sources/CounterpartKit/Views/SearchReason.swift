#if canImport(SwiftUI)
import SwiftUI

/// Why a search found a project whose title doesn't say (first look U10, Nov 10): the matching words in a short line
/// under the row or card, marked. Shared by iPhone Home, the iPad sidebar and the Mac sidebar.
@available(iOS 26.0, macOS 26.0, *)
public struct SearchReason: ViewModifier {
    let snippet: SearchSnippet?
    let indent: CGFloat

    public func body(content: Content) -> some View {
        if let snippet {
            VStack(alignment: .leading, spacing: 4) {
                content
                Text(snippet.attributed)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, indent)
                    // VoiceOver hears which words matched, as the bold shows them (review F7).
                    .accessibilityLabel("Found \(snippet.matchedWords.map { "“\($0)”" }.joined(separator: ", ")) in: \(snippet.text)")
                    .accessibilityIdentifier("search-reason")
            }
        } else {
            content
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
extension View {
    /// Shows `snippet` under this row or card; nothing when there's none.
    public func searchReason(_ snippet: SearchSnippet?, indent: CGFloat = 0) -> some View {
        modifier(SearchReason(snippet: snippet, indent: indent))
    }
}
#endif
