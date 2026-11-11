import Foundation

/// Where a project's scan came from, and what else was made from it (things-and-versions design §3.3), from the projects
/// this app already has: "Make something else from this scan" makes a new project with a copy of the scan, and both
/// pages say so. Ported to Android (`ScanLineage` in Words.kt) and Linux (`scanLineage` in domain.ts) word for word.
public struct ScanLineage: Equatable, Sendable {
    /// The action on every project the Mac has a scan for, in the design's words.
    public static let action = "Make something else from this scan"
    /// New's door to the same thing, for a scan kept on another project.
    public static let useExisting = "Use a scan you already have"
    /// The two answers New asks before anything else when it holds a scan the Mac already has.
    public static let fitChoice = "Make something that fits this"
    public static let copyChoice = "Copy this object"

    public struct Link: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        /// The project is still on the Mac, so the line opens it.
        public var exists: Bool
    }

    /// The project this one's scan was copied from.
    public var from: Link?
    /// Projects made from this one's scan, newest first.
    public var made: [Link]

    public init(_ project: Project, in projects: [Project]) {
        if let source = project.scanFrom {
            let live = projects.first { $0.id == source.id }
            from = Link(id: source.id, title: live.map { ProjectWords.title($0) } ?? source.title, exists: live != nil)
        } else {
            from = nil
        }
        made = projects.filter { $0.scanFrom?.id == project.id && $0.id != project.id }
            .sorted { $0.createdAtMs > $1.createdAtMs }
            .map { Link(id: $0.id, title: ProjectWords.title($0), exists: true) }
    }

    /// Under What you scanned on a project made from another's scan.
    public var fromLine: String? {
        guard let from else { return nil }
        return from.exists ? "Uses the scan from “\(from.title)”" : "Uses the scan from “\(from.title)”, since deleted"
    }

    /// Under What you scanned on a project whose scan made others.
    public var madeLine: String? {
        switch made.count {
        case 0: return nil
        case 1: return "Also made from this scan: “\(made[0].title)”"
        default: return "Also made from this scan: \(made.count) projects"
        }
    }

    /// A scan offered by "Use a scan you already have", under its project's name: when it was scanned ("scanned Nov 4").
    public static func scannedLine(_ project: Project, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale; formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return "scanned \(formatter.string(from: project.createdAt))"
    }

    /// The projects whose scans New offers, newest first: every project the Mac has a scan for.
    public static func scans(in projects: [Project]) -> [Project] {
        projects.filter(\.canMakeFromScan).sorted { $0.createdAtMs > $1.createdAtMs }
    }
}
