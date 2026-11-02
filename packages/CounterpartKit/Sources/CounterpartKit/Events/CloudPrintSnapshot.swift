import Foundation
import CloudKit

extension PrintActivitySnapshot {
    /// Shared by the Mac publisher and phone reader so stale printer reports cannot keep an activity alive.
    public static func mirror(_ project: Project, into record: CKRecord) {
        guard let print = project.print else { return }
        let snapshot = Self(project)
        record["printId"] = print.printId
        record["printerName"] = print.destination?.name
        record["projectState"] = project.state.rawValue
        record["printOutcome"] = print.monitor?.endState
        record["printState"] = snapshot?.content.state ?? normalizedState(projectState: project.state.rawValue,
            outcome: print.monitor?.endState, reported: print.live?.state ?? print.printerStatus?.state)
        record["progress"] = snapshot?.content.progress ?? print.live?.job?.progress ?? print.printerStatus?.percent
        record["remainingSec"] = print.live?.job?.remainingSec ?? print.printerStatus?.remainingMinutes.map { $0 * 60 }
        record["endsAt"] = snapshot?.content.endsAt ?? print.live?.endsAtDate
    }

    public init?(cloudRecord record: CKRecord) {
        guard let project = record["projectId"] as? String, let print = record["printId"] as? String else { return nil }
        let state = Self.normalizedState(projectState: record["projectState"] as? String ?? record["state"] as? String,
            outcome: record["printOutcome"] as? String, reported: record["printState"] as? String)
        guard ["preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"].contains(state) else { return nil }
        let updated = record["updatedAt"] as? Date ?? Date()
        self.init(attributes: .init(projectId: project, printId: print, title: record["title"] as? String ?? "Your print",
                                    printerName: record["printerName"] as? String ?? "Your printer"),
            content: .init(state: state, progress: state == "finished" ? 100 : (record["progress"] as? NSNumber)?.doubleValue ?? 0,
                endsAt: record["endsAt"] as? Date ?? updated.addingTimeInterval((record["remainingSec"] as? NSNumber)?.doubleValue ?? 0)),
            observedAt: updated)
    }
}
