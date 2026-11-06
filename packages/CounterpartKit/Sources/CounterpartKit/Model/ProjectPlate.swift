import Foundation

/// The companion's retained plates and printer-confirmed progress, independent of the selected plate.
public struct ProjectPlate: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var fileIndex: Int
    public var plateIndex: Int
    public var name: String
    public var fileName: String
    public var thumbnail: String?
    public var selected: Bool
    public var sliced: Bool
    public var status: String
    public var printId: String?
    public var completedAtMs: Double?
    /// Its last send may have reached the printer: printing it again asks "I checked the printer". A cancelled or
    /// refused send can read "unknown" too, but it was never sent, so it doesn't ask.
    public var uncertain: Bool?

    public var statusText: String {
        switch status {
        case "printed": "Printed"
        case "preparing": "Getting ready"
        case "printing": "Printing"
        case "paused": "Paused"
        case "cancelled": completedAtMs == nil ? "Cancelled" : "Reprint cancelled · printed before"
        case "failed": completedAtMs == nil ? "Print failed" : "Reprint failed · printed before"
        case "sent": "Sent to printer"
        case "unknown": "Check print result"
        default: completedAtMs == nil ? "Not printed" : "Printed"
        }
    }
}

extension Project {
    public var selectedPlate: ProjectPlate? { plates?.first(where: \.selected) }
    public var completedPlateCount: Int { plates?.filter { $0.completedAtMs != nil }.count ?? 0 }
    /// Any plate can be chosen except while a step runs. A send Counterpart couldn't confirm stays on its own plate
    /// ("Check print result") and never locks the others (David, Nov 6: "i can see them but i can't click on them").
    public var canSelectPlate: Bool {
        !(plates ?? []).isEmpty && state != .printing && state != .touchingUp
    }
    /// Print asks "I checked the printer" first: the last send of this project, or of the chosen plate, may have reached
    /// it. The companion refuses that print without the check on the same rule.
    public var printNeedsCheck: Bool {
        print?.uncertain == true || selectedPlate?.uncertain == true
    }
}
