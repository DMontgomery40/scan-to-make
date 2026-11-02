import Foundation

/// One user-visible change on the Mac (PRD §8.7, docs/protocols/events.md). `title` and `body` are written once
/// by the companion for every surface. Unknown keys are ignored and an unknown `type` still decodes.
public struct CounterpartEvent: Codable, Sendable, Equatable, Identifiable {
    public struct Problem: Codable, Sendable, Equatable { public let code: String; public let message: String }
    public struct Data: Codable, Sendable, Equatable {
        public let progress: Double?
        public let remainingSec: Double?
        public let endsAt: String?
        public let layer: Int?
        public let totalLayers: Int?
        public let state: String?
        public let stage: String?
        public let problems: [Problem]?
        public let estimateSec: Double?
        public let grams: Double?
        public let askId: String?
        public let confirmationId: String?
        public let expiresAt: String?
        public init(progress: Double? = nil, remainingSec: Double? = nil, endsAt: String? = nil, layer: Int? = nil, totalLayers: Int? = nil,
                    state: String? = nil, stage: String? = nil, problems: [Problem]? = nil) {
            self.progress = progress; self.remainingSec = remainingSec; self.endsAt = endsAt; self.layer = layer; self.totalLayers = totalLayers
            self.state = state; self.stage = stage; self.problems = problems
            estimateSec = nil; grams = nil; askId = nil; confirmationId = nil; expiresAt = nil
        }
    }
    public let seq: Int
    public let id: String
    /// ISO 8601 with an offset.
    public let at: String
    public let type: String
    public let projectId: String
    public let printId: String?
    public let destinationId: String?
    public let printerName: String?
    public let title: String
    public let body: String
    /// `none`, `passive`, `active` or `timeSensitive`.
    public let notify: String
    public let data: Data?
    /// `prints/<printId>/frames/<eventId>.jpg`, relative to the project's folder.
    public let frame: String?

    public init(seq: Int, id: String, at: String, type: String, projectId: String, printId: String? = nil, destinationId: String? = nil,
                printerName: String? = nil, title: String, body: String, notify: String, data: Data? = nil, frame: String? = nil) {
        self.seq = seq; self.id = id; self.at = at; self.type = type; self.projectId = projectId; self.printId = printId
        self.destinationId = destinationId; self.printerName = printerName; self.title = title; self.body = body
        self.notify = notify; self.data = data; self.frame = frame
    }

    /// When it happened; nil if the companion's time can't be read.
    public var date: Date? { Self.parse(at) }

    static let fractional: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    static let whole: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
    public static func parse(_ text: String) -> Date? { fractional.date(from: text) ?? whole.date(from: text) }
}

/// `events.wait`: the events after a cursor, the next cursor, and whether the log was pruned or recreated.
public struct EventsPage: Decodable, Sendable, Equatable {
    public let events: [CounterpartEvent]
    public let next: Int
    public let latest: Int
    public let truncated: Bool?
    public let reset: Bool?
    public init(events: [CounterpartEvent], next: Int, latest: Int, truncated: Bool? = nil, reset: Bool? = nil) {
        self.events = events; self.next = next; self.latest = latest; self.truncated = truncated; self.reset = reset
    }
}

/// The phones' Live Activity push tokens, kept by the companion for the relay (PRD §8.8).
public struct LiveActivityTokens: Codable, Sendable, Equatable {
    public struct PushToStart: Codable, Sendable, Equatable {
        public let deviceId: String; public let token: String; public let updatedAt: String
        public init(deviceId: String, token: String, updatedAt: String) { self.deviceId = deviceId; self.token = token; self.updatedAt = updatedAt }
    }
    public struct Activity: Codable, Sendable, Equatable {
        public let printId: String; public let deviceId: String; public let token: String; public let updatedAt: String
        public init(printId: String, deviceId: String, token: String, updatedAt: String) {
            self.printId = printId; self.deviceId = deviceId; self.token = token; self.updatedAt = updatedAt
        }
    }
    public let pushToStart: [PushToStart]
    public let activities: [Activity]
    public init(pushToStart: [PushToStart] = [], activities: [Activity] = []) { self.pushToStart = pushToStart; self.activities = activities }
}

public extension ControlClient {
    /// Holds up to `timeoutMs` for events after `after` (`capabilities.events`). Use a client whose own deadline is
    /// longer than `timeoutMs`; the companion keeps this connection open for `timeoutMs` plus 5 s.
    func waitForEvents(after: Int, timeoutMs: Int, limit: Int = 100) async throws -> EventsPage {
        try await call("events.wait", ["after": .number(Double(after)), "timeoutMs": .number(Double(timeoutMs)), "limit": .number(Double(limit))])
    }
    func liveActivityTokens() async throws -> LiveActivityTokens { try await call("liveActivity.tokens") }

    /// Runs one control method by name with JSON parameters: commands from the phone (PRD §9.3) name existing methods.
    func run(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue { try await call(method, params) }
}
