import Foundation

/// What this phone last heard from its Mac about each project, kept on disk so a page opens from it when the Mac stops
/// answering, after a relaunch too (board X100: David's phone reaches his Mac through a tunnel from cellular most of the
/// day, so a dropped link is his everyday case). Nov 10, the screenshot tool under `away`: 18 of 20 project pages were
/// replaced by "Couldn't load project" although the phone had loaded every one of them from the list a moment before.
///
/// One file per Mac (`mac` is the pairing's base URL): another Mac's projects are never shown as this one's.
public struct KnownProjects: Codable, Equatable, Sendable {
    public var mac: String
    public var projects: [Project]
    /// When the Mac last answered with each project.
    public var heard: [String: Date]

    public init(mac: String, projects: [Project] = [], heard: [String: Date] = [:]) {
        self.mac = mac; self.projects = projects; self.heard = heard
    }

    /// The saved copy for this Mac, or nil when there is none, it is unreadable, or it belongs to another Mac.
    public static func load(from url: URL, mac: String) -> KnownProjects? {
        guard let data = try? Data(contentsOf: url), let known = try? JSONDecoder().decode(KnownProjects.self, from: data),
              known.mac == mac else { return nil }
        return known
    }

    public func save(to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The Mac answered with these projects now (`at`); every other saved project keeps its own time.
    public mutating func heard(_ listed: [Project], at time: Date) {
        projects = listed
        for project in listed { heard[project.id] = time }
        heard = heard.filter { id, _ in listed.contains { $0.id == id } }
    }

    /// The Mac answered with one project now.
    public mutating func heard(_ project: Project, at time: Date) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project } else { projects.insert(project, at: 0) }
        heard[project.id] = time
    }

    public mutating func forget(_ id: String) {
        projects.removeAll { $0.id == id }
        heard[id] = nil
    }

    /// The one line a page shows over what the phone already had while the Mac isn't answering: that it isn't, and when
    /// what is shown was true. `heard` nil (never answered on this phone) says only the first half.
    public static func awayLine(heard: Date?, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard let heard else { return "Your Mac isn’t answering, so Print and Send wait. This is what your phone already had." }
        return "Your Mac isn’t answering, so Print and Send wait. This is what your phone had \(when(heard, now: now, calendar: calendar, locale: locale))."
    }

    /// "at 4:12 PM", "yesterday at 4:12 PM", "on Nov 8 at 4:12 PM".
    public static func when(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        var time = Date.FormatStyle(date: .omitted, time: .shortened); time.locale = locale; time.calendar = calendar; time.timeZone = calendar.timeZone
        let clock = date.formatted(time)
        if calendar.isDate(date, inSameDayAs: now) { return "at \(clock)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday at \(clock)" }
        var day = Date.FormatStyle().month(.abbreviated).day(); day.locale = locale; day.calendar = calendar; day.timeZone = calendar.timeZone
        return "on \(date.formatted(day)) at \(clock)"
    }
}
