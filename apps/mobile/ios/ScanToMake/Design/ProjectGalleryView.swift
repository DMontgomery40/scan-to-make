import SwiftUI
import CounterpartKit

/// The pictures at the top of a project's page (PRD §5.4 Pictures): every entry of the project's `ProjectGallery`, one
/// at a time, on the dark stage. A row of labels under the stage moves between them: none for one entry, a few labels
/// for the common two or three, a scrolling row for a designer's dozen plates. The labels sit below the stage, never
/// over it, so a drag always turns the model (HIG, Page controls: a scrolling row for an arbitrary number of pages;
/// Segmented controls: short noun labels, no introductory text).
struct ProjectGalleryView: View {
    let store: ProjectsStore
    let project: Project
    let words: ProjectWords
    let height: CGFloat
    let modelURL: URL?
    let arURL: URL?
    /// The scan while it is still only on this phone (before the Mac has it).
    let localScan: URL?
    var working = false
    /// "See it together": asks the Mac where the scanned object sits in a part made before passes said.
    var locate: (() -> Void)? = nil
    @State private var selected: String?
    @State private var scanURL: URL?
    @State private var measured: [String: [Double]] = [:]
    @State private var showingPhotos = false

    private var gallery: ProjectGallery { ProjectGallery(project: project, scanOnThisDevice: localScan != nil) }
    private var entry: ProjectGallery.Entry? {
        let entries = gallery.entries
        return entries.first { $0.id == selected } ?? entries.first
    }

    var body: some View {
        VStack(spacing: 10) {
            stage
                .frame(height: height)
                .clipped()
                .overlay(alignment: .bottom) { controls }
            if gallery.entries.count > 1 { labels }
        }
        .task(id: "\(project.id)#\(project.scan ?? "")#\(Int64(project.mediaVersion))#\(localScan?.path ?? "")") {
            // The Mac's scan when it has one; this phone's own until then.
            if project.scan != nil, let scan = project.scanModels().first, let url = try? await store.mac.download(project, scan) { scanURL = url }
            else { scanURL = localScan }
        }
    }

    // MARK: Stage

    @ViewBuilder private var stage: some View {
        if let entry {
            switch entry.drawing {
            case .model(let path):
                ModelStage(url: path == "model.stl" ? modelURL : scanURL, tint: tint(entry.colour),
                           lightStage: StageContrast.lightStage(for: entry.colour), measured: { measured[entry.id] = $0 })
                    .id(entry.id)
            case .assembly(_, _, let seats):
                ModelStage(url: modelURL, tint: tint(entry.colour), lightStage: StageContrast.lightStage(for: entry.colour),
                           object: scanURL, seats: seats.map(\.matrix), measured: { measured[entry.id] = $0 })
                    .id(entry.id)
            case .picture(let path):
                ZStack {
                    StageBackground()
                    ProjectImage(project: project, path: path.isEmpty ? nil : path, maxPixelSize: 1200, contentMode: .fit)
                }
            }
        } else {
            ZStack {
                StageBackground()
                Image(systemName: words.phase.symbol).font(.system(size: 44)).foregroundStyle(words.phase.color.opacity(0.7))
                    .symbolEffect(.pulse, isActive: words.busy)
            }
        }
    }

    private func tint(_ colour: ProjectGallery.Colour) -> UIColor? {
        guard case .spool(let hex) = colour, let value = Int(hex.dropFirst().prefix(6), radix: 16) else { return nil }
        return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }

    // MARK: Controls on the stage: AR, the scan's photos, Together, and the size of what is shown

    @ViewBuilder private var controls: some View {
        if let entry {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if let ar = arTarget(entry) {
                        Button { ARModel.show(ar) } label: { Label("AR", systemImage: "arkit") }.buttonStyle(.glass)
                            .accessibilityHint("Places it at true size in your room")
                    }
                    if entry.kind == .scan, !entry.photos.isEmpty {
                        Button { showingPhotos = true } label: { Label("\(entry.photos.count) photos", systemImage: "photo.on.rectangle") }
                            .buttonStyle(.glass).accessibilityIdentifier("gallery-photos")
                    }
                    if entry.kind == .part, let locate, project.canLocate {
                        Button(action: locate) { Label("See it together", systemImage: "cube.transparent") }
                            .buttonStyle(.glass).disabled(working).accessibilityIdentifier("gallery-locate")
                            .accessibilityHint("Your Mac works out where the scanned object sits in this part, without changing it")
                    }
                    Spacer(minLength: 0)
                    if let size = entry.sizeText(measured[entry.id]) {
                        Text(size).font(.caption.monospacedDigit().weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            .padding(.horizontal, 12).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                            .accessibilityLabel("\(entry.measures) size \(size)")
                    }
                }
                .labelStyle(.titleAndIcon).font(.caption.weight(.semibold))
            }
            .padding(14)
            .sheet(isPresented: $showingPhotos) { ScanPhotos(project: project, photos: entry.photos) }
        }
    }

    private func arTarget(_ entry: ProjectGallery.Entry) -> URL? {
        switch entry.kind {
        case .part: arURL
        case .scan: scanURL.flatMap { $0.pathExtension.lowercased() == "usdz" ? $0 : nil }
        default: nil
        }
    }

    // MARK: Labels

    private var labels: some View {
        ScrollViewReader { reader in
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(gallery.entries) { item in
                        let chosen = item.id == entry?.id
                        Button { withAnimation(.snappy) { selected = item.id } } label: {
                            Text(item.label).font(.subheadline.weight(.semibold)).lineLimit(1)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .foregroundStyle(chosen ? Color.black : Color.primary)
                                .background(chosen ? Color.white : Color.white.opacity(0.10), in: .capsule)
                        }
                        .buttonStyle(.plain).id(item.id)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                        .accessibilityIdentifier("gallery-\(item.id)")
                    }
                }
                .padding(.horizontal, 20)
            }
            .scrollIndicators(.hidden)
            .onChange(of: selected) { _, id in withAnimation { reader.scrollTo(id, anchor: .center) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pictures")
    }
}

/// The scan's photos, one tap in from "What you scanned": where raw photos belong (David, Nov 10). The first one, large,
/// and how many there are; the whole set is under "What you sent".
private struct ScanPhotos: View {
    let project: Project
    let photos: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                ProjectImage(project: project, path: photos.first, maxPixelSize: 1600, contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 16))
                Text(photos.count == 1 ? "The photo your scan was made from." : "1 of the \(photos.count) photos your scan was made from. All of them are under What you sent.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .navigationTitle("What you scanned").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

extension Project {
    /// A part made to fit a scanned object, made before passes said where the object sits: the Mac can find it.
    var canLocate: Bool {
        kind == "fit" && scan != nil && current != nil && !preservesPublishedFilaments && (current?.seats ?? []).isEmpty
            && state != .printing && state != .touchingUp
    }
}
