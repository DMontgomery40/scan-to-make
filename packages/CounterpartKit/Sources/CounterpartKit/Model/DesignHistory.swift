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
        // A "done" the camera check had flagged (#630) is only the printer's word: not a print of this design.
        return attempts(version).filter { $0.monitor?.printedOut == true }.map { attempt in
            attempt.monitor?.endedAt.flatMap(ISO.date)
                .map { $0.timeIntervalSince1970 * 1000 } ?? attempt.startedAtMs
        }.max()
    }
    /// Attempts on this design whose end was never kept (made before attempts were recorded; their frames survive).
    public func unknownEnds(_ version: Project.DesignVersion) -> Int {
        attempts(version).filter { $0.monitor?.endState == nil }.count
    }
    public func printedLine(_ version: Project.DesignVersion) -> String {
        guard let at = printedAt(version) else {
            if version.outcome == "works" { return "Printed" }
            // Never "not printed" for a design that went to the printer: say what is known (#616, the hanger's Nov 4 design).
            let tries = attempts(version).count, unknown = unknownEnds(version)
            if unknown > 0 { return "Sent to the printer \(tries == 1 ? "once" : "\(tries) times") · how \(tries == 1 ? "it" : "they") ended wasn’t kept" }
            // The printer said it finished after the camera saw nothing coming out: keep the MCP's warning (#630).
            if let flagged = attempts(version).last(where: { $0.monitor?.endState == "done" && $0.monitor?.checkSent == true }) {
                return ["The printer says it finished", flagged.monitor?.checkMessage].compactMap { $0 }.joined(separator: " · ")
            }
            if tries > 0 { return "Not printed · \(tries == 1 ? "1 try" : "\(tries) tries") didn’t finish" }
            return "Not printed yet"
        }
        let printer = attempts(version).last(where: { $0.monitor?.printedOut == true })?.destination?.name
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
        view.state = history.printedAt(version) != nil ? (version.outcome == "works" ? .confirmed : .printed)
            : version.outcome == "works" ? .confirmed : history.unknownEnds(version) > 0 ? .sent : .ready
        view.updatedAtMs = version.sealedAtMs
        return view
    }
}
