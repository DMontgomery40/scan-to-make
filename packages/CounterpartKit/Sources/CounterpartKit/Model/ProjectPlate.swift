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
    public var canSelectPlate: Bool {
        !(plates ?? []).isEmpty && state != .printing && state != .touchingUp && print?.uncertain != true
    }
}
