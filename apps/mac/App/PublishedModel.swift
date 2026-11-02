import Foundation
import UserNotifications
#if canImport(ControlKit)
import ControlKit
#endif

/// PRD §8.11, the `~/Downloads` pickup: while a published model's project waits for the designer's file (`file` Ask),
/// this Mac watches `~/Downloads` and offers each new `.3mf`/`.stl` that arrived after the question: "Use *name*?".
/// It reads names, sizes and dates only; the file goes to the companion only when the person taps Use.
@MainActor final class DownloadsWatcher: ObservableObject {
    static let shared = DownloadsWatcher()

    /// A file that may be the one, by project.
    @Published private(set) var candidates: [String: [URL]] = [:]
    private var asks: [String: PublishedExtras.Ask] = [:]
    private var dismissed: Set<String> = []
    private var notified: Set<String> = []
    private var source: DispatchSourceFileSystemObject?
    private var folder: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true) }

    /// The projects waiting for a file now. Watching starts with the first and stops with the last.
    func follow(_ extras: [String: PublishedExtras], titles: [String: String]) {
        asks = extras.compactMapValues(\.fileAsk)
        if asks.isEmpty { stop(); candidates = [:]; return }
        start()
        scan(titles: titles)
    }

    /// "Not This": that file is never offered again for that project.
    func dismiss(_ file: URL, for projectId: String) {
        dismissed.insert(projectId + "|" + file.path)
        candidates[projectId]?.removeAll { $0 == file }
    }

    private func start() {
        guard source == nil else { return }
        let descriptor = open(folder.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let watch = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .rename], queue: .main)
        // A download that just finished was written a moment ago: scan now, and again once it has settled.
        watch.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.scan(titles: [:]) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in MainActor.assumeIsolated { self?.scan(titles: [:]) } }
        }
        watch.setCancelHandler { close(descriptor) }
        watch.resume()
        source = watch
    }

    private func stop() {
        source?.cancel()
        source = nil
    }

    private var titles: [String: String] = [:]

    private func scan(titles fresh: [String: String]) {
        if !fresh.isEmpty { titles = fresh }
        let keys: [URLResourceKey] = [.creationDateKey, .contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
        let seen = files.compactMap { url -> DownloadedFile? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return nil }
            return DownloadedFile(url: url, created: values.creationDate ?? .distantPast, modified: values.contentModificationDate ?? .distantPast,
                                  size: values.fileSize ?? 0)
        }
        var found: [String: [URL]] = [:]
        for (projectId, ask) in asks {
            let matches = Self.matches(seen, ask: ask, now: Date()).filter { !dismissed.contains(projectId + "|" + $0.path) }
            if !matches.isEmpty { found[projectId] = matches }
            for file in matches where !notified.contains(projectId + "|" + file.path) {
                notified.insert(projectId + "|" + file.path)
                notify(file, projectId: projectId, title: titles[projectId])
            }
        }
        candidates = found
    }

    struct DownloadedFile: Equatable { let url: URL; let created: Date; let modified: Date; let size: Int }

    /// The files that may be the one: a model type the Ask accepts, arrived after the question (a minute of slack for
    /// a download that started just before), finished (not written in the last 2 s), and not empty. Newest first;
    /// the companion's own candidate leads when it named one.
    nonisolated static func matches(_ files: [DownloadedFile], ask: PublishedExtras.Ask, now: Date) -> [URL] {
        let accepts = Set((ask.accepts ?? ["3mf", "stl"]).map { $0.lowercased() })
        let since = ask.askedAtMs.map { Date(timeIntervalSince1970: $0 / 1000 - 60) } ?? .distantPast
        var found = files.filter {
            accepts.contains($0.url.pathExtension.lowercased()) && $0.created >= since && $0.size > 0 && now.timeIntervalSince($0.modified) >= 2
        }
        .sorted { $0.created > $1.created }
        .map(\.url)
        if let candidate = ask.candidate.map({ URL(fileURLWithPath: $0.path) }), FileManager.default.fileExists(atPath: candidate.path) {
            found.removeAll { $0.standardizedFileURL == candidate.standardizedFileURL }
            found.insert(candidate, at: 0)
        }
        return found
    }

    private func notify(_ file: URL, projectId: String, title: String?) {
        // A question for the person, under the same switch as the Mac's other questions.
        guard NotificationPrefs().shouldNotify(type: "pass.ask") else { return }
        let content = UNMutableNotificationContent()
        content.title = "Use \(file.lastPathComponent)?"
        content.body = title.map { "It may be the file \($0) is waiting for." } ?? "A model just arrived in Downloads."
        content.threadIdentifier = projectId
        content.userInfo = ["projectId": projectId]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "download-" + projectId + "-" + file.lastPathComponent,
                                                                     content: content, trigger: nil))
    }
}

/// A model page's link in what was typed or pasted (PRD §8.11).
enum ModelLink {
    /// Sites where designers publish printable models. A link elsewhere (a product page, a datasheet) is a reference for
    /// a fitted part, and keeps the Fit or Copy flow.
    static let modelSites = ["makerworld.com", "printables.com", "thingiverse.com", "thangs.com", "cults3d.com",
                             "myminifactory.com", "grabcad.com", "makershop.co", "crealitycloud.com", "printables.cz"]

    /// The first link to a published model: on a model site, or straight to a 3MF or STL.
    static func find(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: range).compactMap(\.url).first(where: isModel)
    }

    static func isModel(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased() else { return false }
        if ["3mf", "stl"].contains(url.pathExtension.lowercased()) { return true }
        return modelSites.contains { host == $0 || host.hasSuffix("." + $0) }
    }
    /// The person's own words, with the link taken out.
    static func words(in text: String, without url: URL) -> String {
        text.replacingOccurrences(of: url.absoluteString, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
