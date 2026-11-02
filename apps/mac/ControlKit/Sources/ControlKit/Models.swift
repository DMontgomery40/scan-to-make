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
    public struct Capabilities: Decodable, Sendable, Equatable {
        public let capture: Bool, cleanup: Bool, printerHandoff: Bool
        /// Nearby pairing (MAC-5): poll `nearbyRequests()` while true. False from a companion that predates it.
        public let nearbyPairing: Bool
        /// `objects.create` and `objects.addFile`: projects can start on this Mac.
        public let objectsCreate: Bool
        /// `events.wait`: the event log (PRD §8.7).
        public let events: Bool
        /// Pause, resume and cancel a running print.
        public let printControl: Bool
        /// Quality, strength and colour on `objects.print`, and `objects.estimate`.
        public let printSettings: Bool
        /// Title, kind, Ask, what changed, pass stages and estimates, and the design engine.
        public let structuredPasses: Bool
        /// The printer's confirmation is relayed with every elicitation field type, and answered with typed values.
        public let genericConfirmations: Bool
        /// `printers.updateMcp` and the `mcp.update.*` events (PRD §8.10).
        public let mcpUpdates: Bool
        /// Published models (PRD §8.11): `objects.create {url}`, `file` and `choice` Asks, `kind: "model"` files.
        public let publishedModels: Bool
        /// Project Settings (PRD §5.4): `objects.settings.set {id, status | archived}`, the Done state.
        public let projectSettings: Bool
        public let projectRename: Bool
        /// `copies` on `objects.print` and `objects.estimate`.
        public let printCopies: Bool
        private enum CodingKeys: String, CodingKey { case capture, cleanup, printerHandoff, nearbyPairing, objectsCreate, events, printControl, printSettings, structuredPasses, genericConfirmations, mcpUpdates, publishedModels, projectSettings, projectRename, printCopies }
        public init(capture: Bool = true, cleanup: Bool = true, printerHandoff: Bool = true, nearbyPairing: Bool = false,
                    objectsCreate: Bool = false, events: Bool = false, printControl: Bool = false, printSettings: Bool = false,
                    structuredPasses: Bool = false, genericConfirmations: Bool = false, mcpUpdates: Bool = false, publishedModels: Bool = false,
                    projectSettings: Bool = false, projectRename: Bool = false, printCopies: Bool = false) {
            self.capture = capture; self.cleanup = cleanup; self.printerHandoff = printerHandoff; self.nearbyPairing = nearbyPairing
            self.objectsCreate = objectsCreate; self.events = events; self.printControl = printControl; self.printSettings = printSettings
            self.structuredPasses = structuredPasses; self.genericConfirmations = genericConfirmations; self.mcpUpdates = mcpUpdates
            self.publishedModels = publishedModels; self.projectSettings = projectSettings; self.projectRename = projectRename; self.printCopies = printCopies
        }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            capture = try values.decode(Bool.self, forKey: .capture)
            cleanup = try values.decode(Bool.self, forKey: .cleanup)
            printerHandoff = try values.decode(Bool.self, forKey: .printerHandoff)
            nearbyPairing = try values.decodeIfPresent(Bool.self, forKey: .nearbyPairing) ?? false
            objectsCreate = try values.decodeIfPresent(Bool.self, forKey: .objectsCreate) ?? false
            events = try values.decodeIfPresent(Bool.self, forKey: .events) ?? false
            printControl = try values.decodeIfPresent(Bool.self, forKey: .printControl) ?? false
            printSettings = try values.decodeIfPresent(Bool.self, forKey: .printSettings) ?? false
            structuredPasses = try values.decodeIfPresent(Bool.self, forKey: .structuredPasses) ?? false
            genericConfirmations = try values.decodeIfPresent(Bool.self, forKey: .genericConfirmations) ?? false
            mcpUpdates = try values.decodeIfPresent(Bool.self, forKey: .mcpUpdates) ?? false
            publishedModels = try values.decodeIfPresent(Bool.self, forKey: .publishedModels) ?? false
            projectSettings = try values.decodeIfPresent(Bool.self, forKey: .projectSettings) ?? false
            projectRename = try values.decodeIfPresent(Bool.self, forKey: .projectRename) ?? false
            printCopies = try values.decodeIfPresent(Bool.self, forKey: .printCopies) ?? false
        }
    }
    public let protocolVersion: Int
    public let companionVersion: String, transport: String
    public let pairedDeviceCount: Int
    public let capabilities: Capabilities
    public init(protocolVersion: Int = 1, companionVersion: String, transport: String = "lan", pairedDeviceCount: Int, capabilities: Capabilities) {
        self.protocolVersion = protocolVersion; self.companionVersion = companionVersion; self.transport = transport
        self.pairedDeviceCount = pairedDeviceCount; self.capabilities = capabilities
    }
}
public struct ControlDevice: Decodable, Sendable, Identifiable {
    public struct PairedVia: Decodable, Sendable {
        public let transport: String, login: String
        public init(transport: String, login: String) { self.transport = transport; self.login = login }
    }
    public let deviceId: String, deviceName: String
    public let scopes: [String]
    public let pairedAt: Double, lastRefreshedAt: Double, expiresAt: Double
    public let pairedVia: PairedVia
    /// "iPhone", "iPad" or the hardware name, once the companion records it.
    public let model: String?
    /// The device's last authenticated request (ms), once the companion records it.
    public let lastSeenAt: Double?
    /// A pairing from before devices had a stable identity (KAN-214): never shown as connected, and the companion
    /// removes it after 14 idle days. Absent from a companion that doesn't mark them.
    public let legacy: Bool?
    public var id: String { deviceId }
    public init(deviceId: String, deviceName: String, scopes: [String] = [], pairedAt: Double, lastRefreshedAt: Double,
                expiresAt: Double, pairedVia: PairedVia = .init(transport: "lan", login: "lan"), model: String? = nil, lastSeenAt: Double? = nil,
                legacy: Bool? = nil) {
        self.deviceId = deviceId; self.deviceName = deviceName; self.scopes = scopes; self.pairedAt = pairedAt
        self.lastRefreshedAt = lastRefreshedAt; self.expiresAt = expiresAt; self.pairedVia = pairedVia; self.model = model; self.lastSeenAt = lastSeenAt
        self.legacy = legacy
    }
    /// The best evidence of when it was last heard from.
    public var seenAt: Double { max(lastSeenAt ?? 0, lastRefreshedAt) }
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
    public let id: String, mode: String, message: String
    public let requestedSchema: JSONValue?
    public let url: String?, elicitationId: String?
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
