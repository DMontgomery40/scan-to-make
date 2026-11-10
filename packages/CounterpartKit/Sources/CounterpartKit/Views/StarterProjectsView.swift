#if canImport(SwiftUI)
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@available(iOS 26.0, macOS 26.0, *)
public struct StarterProjectsView: View {
    private let actionTitle: String
    /// Shown beside the action before any tap, e.g. when the store already knows the Mac isn't answering (F6).
    private let unavailableMessage: String?
    private let start: (StarterProject) async throws -> Void
    @State private var opened: StarterProject?

    public init(actionTitle: String = "Add to Projects", unavailableMessage: String? = nil,
                start: @escaping (StarterProject) async throws -> Void) {
        self.actionTitle = actionTitle; self.unavailableMessage = unavailableMessage; self.start = start
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Start with something useful").font(.title3.weight(.bold))
            Text("Tools to print for your next scan.").font(.subheadline).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(StarterProject.all) { project in
                        Button { opened = project } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                StarterArtwork(project: project).frame(maxWidth: .infinity).frame(height: 118).clipped()
                                    .background(Color.secondary.opacity(0.08), in: .rect(cornerRadius: 18))
                                Text(project.title).font(.headline).lineLimit(2, reservesSpace: true)
                                Text(project.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                Text("by \(project.designer)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                .background(Color.secondary.opacity(0.06), in: .rect(cornerRadius: 24))
                                .contentShape(.rect(cornerRadius: 24))
                                .containerRelativeFrame(.horizontal) { width, _ in
                                    Self.cardWidth(available: width, count: StarterProject.all.count)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("starter-\(project.id)")
                    }
                }.padding(.vertical, 2)
            }
        }
        .sheet(item: $opened) { project in
            StarterDetail(project: project, actionTitle: actionTitle, unavailableMessage: unavailableMessage, start: start)
        }
    }

    /// A card's width: its natural 188 pt when every card fits; narrower so they all fit whole when there are only
    /// two; otherwise sized so the next card shows by about a third, a deliberate peek rather than a card cut off at the
    /// margin (first look U14, Nov 10: the iPhone cut the second starter at the screen edge).
    static func cardWidth(available: CGFloat, count: Int, spacing: CGFloat = 12, natural: CGFloat = 188) -> CGFloat {
        guard count > 0, available > 0 else { return natural }
        let n = CGFloat(count)
        if n * natural + (n - 1) * spacing <= available { return natural }
        if count <= 2 { return max(120, (available - (n - 1) * spacing) / n) }
        // Two whole cards and a third of the next, never wider than natural.
        return min(natural, max(120, (available - 2 * spacing) / 2.35))
    }
}

/// One starter as a sidebar row (iPad and Mac): its picture, title and designer. The sidebars list the starters
/// in a "Start with these" section, so they stay one click away while projects exist (PRD §5.11, "Every layout").
@available(iOS 26.0, macOS 26.0, *)
public struct StarterRow: View {
    let project: StarterProject
    public init(_ project: StarterProject) { self.project = project }
    public var body: some View {
        HStack(spacing: 10) {
            StarterArtwork(project: project).frame(width: 36, height: 36).clipped()
                .background(Color.secondary.opacity(0.12), in: .rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(project.title).font(.body.weight(.medium)).lineLimit(1)
                Text("\(project.detail) · by \(project.designer)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A starter's credits, instructions and its one action, as a sheet. `StarterProjectsView` and the sidebars'
/// starter rows open the same sheet.
@available(iOS 26.0, macOS 26.0, *)
public struct StarterDetail: View {
    @Environment(\.dismiss) private var dismiss
    let project: StarterProject
    let actionTitle: String
    let unavailableMessage: String?
    let start: (StarterProject) async throws -> Void
    public init(project: StarterProject, actionTitle: String = "Add to Projects", unavailableMessage: String? = nil,
                start: @escaping (StarterProject) async throws -> Void) {
        self.project = project; self.actionTitle = actionTitle; self.unavailableMessage = unavailableMessage; self.start = start
    }
    @State private var busy = false
    @State private var problem: String?
    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    StarterArtwork(project: project).frame(maxWidth: .infinity).frame(height: 220)
                    Text(project.subtitle).font(.title2.bold())
                    Text(project.summary)
                    Label(project.detail, systemImage: "square.stack.3d.up").font(.subheadline.weight(.medium))
                    Text(project.instructions).font(.callout).foregroundStyle(.secondary)
                    Text("Counterpart gets the designer’s own files from \(project.site) and has them ready to print.").font(.callout)
                    Link("\(project.designer) · \(project.site)", destination: project.url)
                    Text(project.licence).font(.caption).foregroundStyle(.secondary)
                    if let credit = project.imageCredit { Text(credit).font(.caption2).foregroundStyle(.secondary) }
                }.padding(20).frame(maxWidth: 620)
            }
            .navigationTitle(project.title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            // The error sits beside the button that caused it, inside the always-visible bottom bar —
            // never at the end of the scroll, behind this bar (F6). Before any tap, a Mac the caller
            // already knows is unreachable says so here too.
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    if let problem = problem ?? unavailableMessage {
                        Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("starter-problem")
                    }
                    Button {
                        busy = true; problem = nil
                        Task {
                            defer { busy = false }
                            do { try await start(project); dismiss() }
                            catch let error as CompanionError { problem = error.message }
                            catch { problem = error.localizedDescription }
                        }
                    } label: {
                        HStack { if busy { ProgressView() }; Text(actionTitle).fontWeight(.semibold) }.frame(maxWidth: .infinity).padding(.vertical, 8)
                    }.buttonStyle(.glassProminent).disabled(busy)
                        .accessibilityIdentifier("starter-add")
                }.padding(20)
            }
        }
        #if os(macOS)
        .frame(width: 600, height: 700)
        #endif
    }
}

@available(iOS 26.0, macOS 26.0, *)
private struct StarterArtwork: View {
    let project: StarterProject
    var body: some View {
        Group {
            if let url = project.imageFile {
                #if os(macOS)
                if let image = NSImage(contentsOf: url) { Image(nsImage: image).resizable().scaledToFit() } else { placeholder }
                #else
                if let image = UIImage(contentsOfFile: url.path) { Image(uiImage: image).resizable().scaledToFit() } else { placeholder }
                #endif
            } else if let url = project.imageURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFit() } else { placeholder }
                }
            } else { placeholder }
        }.accessibilityHidden(true)
    }
    private var placeholder: some View {
        Image(systemName: project.symbol).font(.system(size: 58, weight: .light))
            .foregroundStyle(.yellow).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
