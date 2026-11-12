import Foundation

/// The designs a person has, and those they have not printed (#616). Latest is a default, never a stored pointer.
public struct DesignHistory: Equatable, Sendable {
    public var project: Project
    public var latest: Project.DesignVersion? { project.versions?.last }
    /// Every design that was printed or answered It works, newest first (the latest included: it is printed too).
    public var have: [Project.DesignVersion] { (project.versions ?? []).reversed().filter { printedAt($0) != nil || $0.outcome == "works" } }
    /// Sealed designs never printed, newest first, without the latest (the page's hero).
    public var earlier: [Project.DesignVersion] { (project.versions ?? []).reversed().filter { $0.id != latest?.id && printedAt($0) == nil && $0.outcome != "works" } }
    /// A project with one design reads exactly as before: no sections.
    public var showsSections: Bool { (project.versions?.count ?? 0) > 1 }
    public init(_ project: Project) { self.project = project }
    public func attempts(_ version: Project.DesignVersion) -> [Project.PrintAttempt] { (project.prints ?? []).filter { $0.versionId == version.id } }
    public func printedAt(_ version: Project.DesignVersion) -> Double? {
        if let at = version.printedAtMs { return at }
        return attempts(version).filter { $0.monitor?.endState == "done" }.map { attempt in
            attempt.monitor?.endedAt.flatMap(ISO.date)
                .map { $0.timeIntervalSince1970 * 1000 } ?? attempt.startedAtMs
        }.max()
    }
    public func printedLine(_ version: Project.DesignVersion) -> String {
        guard let at = printedAt(version) else { return version.outcome == "works" ? "Printed" : "Not printed yet" }
        let printer = attempts(version).last(where: { $0.monitor?.endState == "done" })?.destination?.name
        return ["Printed \(Self.date(at))", printer].compactMap { $0 }.joined(separator: " · ")
    }
    public func outcomeLine(_ version: Project.DesignVersion) -> String {
        switch version.outcome { case "works": return "It works"; case "needs-changes": return "Needs changes"; default: return printedAt(version) == nil ? "Ready to print" : "Did it fit?" }
    }
    /// The one case the list line changes (DESIGN.md §3.1): the newest design is unprinted and unanswered while an
    /// earlier one was printed. Every other project keeps today's phase and words; Done stays Done.
    var twoTruths: Double? {
        guard let latest, (project.versions?.count ?? 0) > 1, latest.outcome == nil, printedAt(latest) == nil,
              ![.new, .touchingUp, .needsCloseup, .printing, .failed, .sent, .confirmed, .printed].contains(project.state) else { return nil }
        return (project.versions ?? []).dropLast().compactMap { printedAt($0) }.max()
    }
    public var phase: ProjectPhase? { twoTruths == nil ? nil : .ready }
    public var line: String? { twoTruths.map { "New one ready · printed \(Self.date($0))" } }
    /// Activity's mark on the pass that sealed a design: "This became the Nov 4 design".
    public func sealedLine(passStartedAtMs: Double) -> String? {
        guard showsSections, let version = project.versions?.first(where: { $0.passStartedAtMs == passStartedAtMs }) else { return nil }
        return "This became the \(Self.date(version.sealedAtMs)) design"
    }
    /// "Nov 4", in this device's time zone, as the Mac's words write it.
    public static func date(_ at: Double) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US"); formatter.timeZone = .current
        formatter.dateFormat = "MMM d"
        return formatter.string(from: Date(timeIntervalSince1970: at / 1000))
    }
}

extension Project {
    /// A view of one sealed design in the existing stage. This value never goes back to the store.
    public func showingDesign(_ id: String?) -> Project {
        guard let id, let version = versions?.first(where: { $0.id == id }) else { return self }
        var view = self
        let history = DesignHistory(self)
        view.current = version.result; view.picture = version.picture; view.pictures = version.pictures; view.pictureStates = version.pictureStates
        view.outcome = version.outcome; view.status = nil; view.versions = [version]
        view.prints = history.attempts(version)
        view.print = nil
        if let attempt = history.attempts(version).last {
            view.print = Print(bundleId: attempt.bundleId, destination: attempt.destination)
            view.print?.monitor = attempt.monitor; view.print?.spools = attempt.spools
        }
        view.state = history.printedAt(version) == nil ? .ready : version.outcome == "works" ? .confirmed : .printed
        view.updatedAtMs = version.sealedAtMs
        return view
    }
}
