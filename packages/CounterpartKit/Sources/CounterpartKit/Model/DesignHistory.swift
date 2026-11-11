import Foundation

/// The designs a person has, and those they have not printed. Latest is a default, never a stored pointer.
public struct DesignHistory: Equatable, Sendable {
    public var project: Project
    public var latest: Project.DesignVersion? { project.versions?.last }
    public var have: [Project.DesignVersion] { (project.versions ?? []).reversed().filter { printedAt($0) != nil } }
    public var earlier: [Project.DesignVersion] { (project.versions ?? []).reversed().filter { $0.id != latest?.id && printedAt($0) == nil } }
    public var showsSections: Bool { (project.versions?.count ?? 0) > 1 }
    public init(_ project: Project) { self.project = project }
    public func attempts(_ version: Project.DesignVersion) -> [Project.PrintAttempt] { (project.prints ?? []).filter { $0.versionId == version.id } }
    public func printedAt(_ version: Project.DesignVersion) -> Double? {
        if let at = version.printedAtMs { return at }
        return attempts(version).filter { $0.monitor?.endState == "done" }.map { attempt in
            attempt.monitor?.endedAt.flatMap { ISO8601DateFormatter().date(from: $0)?.timeIntervalSince1970 }.map { $0 * 1000 } ?? attempt.startedAtMs
        }.max()
    }
    public func printedLine(_ version: Project.DesignVersion) -> String {
        guard let at = printedAt(version) else { return "Not printed yet" }
        let printer = attempts(version).last(where: { $0.monitor?.endState == "done" })?.destination?.name
        return ["Printed \(Self.date(at))", printer].compactMap { $0 }.joined(separator: " · ")
    }
    public func outcomeLine(_ version: Project.DesignVersion) -> String {
        switch version.outcome { case "works": return "It works"; case "needs-changes": return "Needs changes"; default: return printedAt(version) == nil ? "Ready to print" : "Did it fit?" }
    }
    public var phase: ProjectPhase? {
        guard let latest else { return nil }
        guard ![.new, .touchingUp, .needsCloseup, .printing, .failed, .sent].contains(project.state) else { return nil }
        if printedAt(latest) == nil { return .ready }
        return latest.outcome == "works" ? .confirmed : .printed
    }
    public var line: String? {
        guard let latest, phase != nil else { return nil }
        if printedAt(latest) == nil {
            if let at = have.first.flatMap({ printedAt($0) }) { return "New one ready · printed \(Self.date(at))" }
            return "Ready to print"
        }
        return latest.outcome == "works" ? "Done · it works" : printedLine(latest)
    }
    /// Dates match the companion's row words, including while reading a saved library with the Mac away.
    public static func date(_ at: Double) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
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
