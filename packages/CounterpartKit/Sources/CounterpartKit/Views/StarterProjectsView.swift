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
    private let start: (StarterProject) async throws -> Void
    @State private var opened: StarterProject?

    public init(actionTitle: String = "Add to Projects", start: @escaping (StarterProject) async throws -> Void) {
        self.actionTitle = actionTitle; self.start = start
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
                                StarterArtwork(project: project).frame(width: 164, height: 118).clipped()
                                    .background(Color.secondary.opacity(0.08), in: .rect(cornerRadius: 18))
                                Text(project.title).font(.headline).lineLimit(2, reservesSpace: true)
                                Text(project.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                Text("by \(project.designer)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }.frame(width: 164, alignment: .leading).padding(12)
                                .background(Color.secondary.opacity(0.06), in: .rect(cornerRadius: 24))
                                .contentShape(.rect(cornerRadius: 24))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("starter-\(project.id)")
                    }
                }.padding(.vertical, 2)
            }
        }
        .sheet(item: $opened) { project in
            StarterDetail(project: project, actionTitle: actionTitle, start: start)
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private struct StarterDetail: View {
    @Environment(\.dismiss) private var dismiss
    let project: StarterProject
    let actionTitle: String
    let start: (StarterProject) async throws -> Void
    @State private var busy = false
    @State private var problem: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    StarterArtwork(project: project).frame(maxWidth: .infinity).frame(height: 220)
                    Text(project.subtitle).font(.title2.bold())
                    Text(project.summary)
                    Label(project.detail, systemImage: "square.stack.3d.up").font(.subheadline.weight(.medium))
                    Text(project.instructions).font(.callout).foregroundStyle(.secondary)
                    if !project.bundled {
                        Text("Add the designer’s original files from MakerWorld to print this project.").font(.callout)
                    }
                    Link("\(project.designer) · \(project.site)", destination: project.url)
                    Text(project.licence).font(.caption).foregroundStyle(.secondary)
                    if let credit = project.imageCredit { Text(credit).font(.caption2).foregroundStyle(.secondary) }
                    if let problem { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                }.padding(20).frame(maxWidth: 620)
            }
            .navigationTitle(project.title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .safeAreaInset(edge: .bottom) {
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
                }.buttonStyle(.glassProminent).disabled(busy).padding(20)
                    .accessibilityIdentifier("starter-add")
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
