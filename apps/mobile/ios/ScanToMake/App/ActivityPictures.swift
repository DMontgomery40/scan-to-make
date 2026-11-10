import Foundation
import CounterpartKit

/// Puts each live print's picture (the one Home and the project page show: a photo, else a scan frame, else a render)
/// into the App Group, where the Live Activity's widget reads it (PRD §9.4). The widget can't reach the Mac.
/// The notification service writes the Mac's copy of the same real-object-first picture when a print notification arrives, so an
/// activity the Mac started or updated by push has it too.
@MainActor final class ActivityPictures {
    private var running: Set<String> = []
    private let store: PrintActivityThumbnails?

    init(store: PrintActivityThumbnails? = .shared()) { self.store = store }

    func refresh(_ projects: [Project], mac: MacConnection) async {
        guard let store else { return }
        for project in projects where !running.contains(project.id) {
            guard let path = project.thumbnailPath else { continue }
            // Download again only when the picture itself changed, not on every progress update.
            let source = "\(path)#\(Int64(project.mediaVersion))"
            if store.entry(for: project.id)?.source == source { continue }
            running.insert(project.id)
            // Optional LAN I/O must not consume a background activity update's runtime. Each project
            // refreshes independently; reconcile uses the cached picture (or the mark) immediately.
            Task {
                defer { running.remove(project.id) }
                guard let url = try? await mac.download(project, path) else { return }
                let id = project.id, version = project.updatedAtMs
                await Task.detached(priority: .utility) { store.store(imageAt: url, projectId: id, version: version, source: source) }.value
            }
        }
    }
}
