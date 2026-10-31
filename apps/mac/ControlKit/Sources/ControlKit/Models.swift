import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
    public var string: String? { if case .string(let value) = self { return value }; return nil }
}
public struct ControlStatus: Decodable, Sendable {
    public struct Capabilities: Decodable, Sendable {
        public let capture: Bool, cleanup: Bool, printerHandoff: Bool
        /// Nearby pairing (MAC-5): poll `nearbyRequests()` while true. False from a companion that predates it.
        public let nearbyPairing: Bool
        private enum CodingKeys: String, CodingKey { case capture, cleanup, printerHandoff, nearbyPairing }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            capture = try values.decode(Bool.self, forKey: .capture)
            cleanup = try values.decode(Bool.self, forKey: .cleanup)
            printerHandoff = try values.decode(Bool.self, forKey: .printerHandoff)
            nearbyPairing = try values.decodeIfPresent(Bool.self, forKey: .nearbyPairing) ?? false
        }
    }
    public let protocolVersion: Int
    public let companionVersion: String, transport: String
    public let pairedDeviceCount: Int
    public let capabilities: Capabilities
}
public struct ControlDevice: Decodable, Sendable, Identifiable {
    public struct PairedVia: Decodable, Sendable { public let transport: String, login: String }
    public let deviceId: String, deviceName: String
    public let scopes: [String]
    public let pairedAt: Double, lastRefreshedAt: Double, expiresAt: Double
    public let pairedVia: PairedVia
    public var id: String { deviceId }
}
public struct ControlInvitation: Decodable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let version: Int
    public let baseUrl: String, code: String, qrPayload: String
    public let expiresAt: Double
    public let certificateSha256: String?
    public var description: String { "ControlInvitation(<private>)" }
    public var debugDescription: String { description }
}
/// A nearby phone waiting for Allow (MAC-5). Show `code` with the request: it must match the
/// phone's screen before the user allows it. Each request expires two minutes after it starts.
public struct ControlNearbyRequest: Decodable, Sendable, Identifiable, Equatable {
    public let id: String, deviceName: String, code: String
    public let expiresAt: Double
}
public struct ControlJob: Decodable, Sendable, Identifiable {
    public let kind: String
    public let projectId: String?, projectName: String?
    /// Original ScanProcessingJob or HandoffManifest; no lossy status translation.
    public let job: [String: JSONValue]
    public var id: String { kind + ":" + (job["jobId"]?.string ?? job["id"]?.string ?? "") }
    public var status: String? { job["status"]?.string }
}
public struct ControlJobsPage: Decodable, Sendable {
    public let items: [ControlJob]
    public let nextCursor: String?
}
public struct ControlConfirmation: Decodable, Sendable, Identifiable {
    public struct CameraSnapshot: Decodable, Sendable { public let format: String, base64: String }
    public let id: String, mode: String, message: String
    public let requestedSchema: JSONValue?
    public let url: String?, elicitationId: String?
    public let cameraSnapshot: CameraSnapshot?
    public let createdAtMs: Double, expiresAtMs: Double
}
public enum ConfirmationAnswer: Sendable {
    case accept([String: JSONValue]), decline, cancel
    var json: JSONValue {
        switch self {
        case .accept(let content): return .object(["action": .string("accept"), "content": .object(content)])
        case .decline: return .object(["action": .string("decline")])
        case .cancel: return .object(["action": .string("cancel")])
        }
    }
}
public enum ControlDoor: String, Sendable { case finder, blender, bambuStudio = "bambu-studio", orca }
public enum DoorTarget: Sendable { case project(String), handoff(String) }
public struct PreparedDoor: Decodable, Sendable {
    public let action: String, fileURL: URL
    public let applicationBundleId: String?
    public let projectRevision: Int?
}
public struct ControlRemoteError: Error, Decodable, Sendable, Equatable {
    public let code: String, message: String
}
public enum ControlClientError: Error, Sendable, Equatable {
    case invalidEndpoint, oversizedRequest, unavailable, timedOut, invalidResponse, cancelled
}
