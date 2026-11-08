import Foundation
#if os(iOS)
import ActivityKit
#endif

/// Exact wire names and Date coding used by services/relay's PrintAttributes contract.
public struct PrintAttributes: Codable, Hashable, Sendable {
    public var projectId: String
    public var printId: String
    public var title: String
    public var printerName: String
    public init(projectId: String, printId: String, title: String, printerName: String) {
        self.projectId = projectId; self.printId = printId
        self.title = String(title.prefix(80)); self.printerName = String(printerName.prefix(80))
    }
    public struct ContentState: Codable, Hashable, Sendable {
        public var state: String
        public var progress: Double
        public var layer: Int
        public var totalLayers: Int
        public var endsAt: Date
        public var stage: String
        public var problem: String?
        public init(state: String, progress: Double, layer: Int = 0, totalLayers: Int = 0, endsAt: Date, stage: String = "", problem: String? = nil) {
            self.state = state
            self.progress = progress.isFinite ? min(100, max(0, progress)) : 0
            self.layer = max(0, layer); self.totalLayers = max(0, totalLayers)
            self.endsAt = endsAt; self.stage = String(stage.prefix(80)); self.problem = problem.map { String($0.prefix(200)) }
        }
        public var terminal: Bool { ["finished", "failed", "cancelled"].contains(state) }
        public var canStart: Bool { ["preparing", "printing", "paused"].contains(state) }
        public var status: String {
            switch state {
            case "preparing": "Getting ready"
            case "paused": "Paused"
            case "finished": "Print finished"
            case "failed": "Print failed"
            case "cancelled": "Print stopped"
            case "offline": "Waiting for your printer"
            default: "Printing"
            }
        }
    }
}
#if os(iOS)
extension PrintAttributes: ActivityAttributes {}
#endif

public struct PrintActivitySnapshot: Equatable, Sendable {
    public var attributes: PrintAttributes
    public var content: PrintAttributes.ContentState
    public var observedAt: Date
    public init(attributes: PrintAttributes, content: PrintAttributes.ContentState, observedAt: Date = Date()) {
        self.attributes = attributes; self.content = content; self.observedAt = observedAt
    }

    public init?(_ project: Project, now: Date = Date()) {
        guard let print = project.print, let id = print.printId else { return nil }
        let live = print.live
        observedAt = live?.observedAtDate ?? Date(timeIntervalSince1970: project.updatedAtMs / 1000)
        let state = Self.normalizedState(projectState: project.state.rawValue, outcome: print.monitor?.endState,
            reported: live?.state ?? print.printerStatus?.state)
        if ["finished", "failed", "cancelled"].contains(state) {
            observedAt = max(observedAt, Date(timeIntervalSince1970: project.updatedAtMs / 1000))
        }
        guard ["preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"].contains(state) else { return nil }
        attributes = .init(projectId: project.id, printId: id, title: project.title ?? "Your print", printerName: print.destination?.name ?? "Your printer")
        content = .init(state: state, progress: state == "finished" ? 100 : live?.job?.progress ?? print.printerStatus?.percent ?? 0,
            layer: live?.job?.layer ?? 0, totalLayers: live?.job?.totalLayers ?? 0,
            endsAt: live?.endsAtDate ?? now.addingTimeInterval(live?.job?.remainingSec ?? print.printerStatus?.remainingMinutes.map { $0 * 60 } ?? 0),
            stage: live?.job?.stage ?? "", problem: live?.problems?.first?.message)
    }

    /// A monitor outcome belongs to this print; the printer's last report may already describe another job.
    public static func normalizedState(projectState: String?, outcome: String?, reported: String?) -> String {
        switch outcome {
        case "done": return "finished"
        case "failed", "not-started": return "failed"
        case "cancelled", "replaced": return "cancelled"
        default:
            if ["printed", "confirmed"].contains(projectState) { return "finished" }
            if projectState == "failed" { return "failed" }
            return reported ?? (projectState == "printing" ? "printing" : "")
        }
    }

    public func shouldStart(foreground: Bool, dismissed: Set<String>) -> Bool {
        foreground && content.canStart && !dismissed.contains(attributes.printId)
    }

    /// The current project snapshot replaces its old print identity on retry. Other projects keep their activities.
    public func supersedes(_ earlier: PrintAttributes) -> Bool {
        attributes.projectId == earlier.projectId && attributes.printId != earlier.printId
    }
}

/// The Live Activity's words, in the print notifications' voice (services/companion/src/events/words.ts):
/// the milestone notification's body is "38 min left · layer 84 of 212 · P1S", and the activity's detail
/// line is that body without the time, which the activity counts down itself.
public enum PrintActivityWords {
    public static func detail(_ state: PrintAttributes.ContentState, printer: String) -> String {
        let layers = state.layer > 0 && state.totalLayers > 0 ? "layer \(state.layer) of \(state.totalLayers)" : nil
        return [layers, printer.isEmpty ? nil : printer].compactMap { $0 }.joined(separator: " · ")
    }
}
