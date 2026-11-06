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
        /// `settings.changed`: which keys, who changed them (`mac` or a device id), and an action for this Mac to run.
        public let keys: [String]?
        public let by: String?
        public let action: String?
        /// `mcp.update.*` (PRD §8.10): which install, the versions, and the log's tail on failure.
        public let mcpId: String?
        public let fromVersion: String?
        public let toVersion: String?
        public let log: String?
        public init(progress: Double? = nil, remainingSec: Double? = nil, endsAt: String? = nil, layer: Int? = nil, totalLayers: Int? = nil,
                    state: String? = nil, stage: String? = nil, problems: [Problem]? = nil) {
            self.progress = progress; self.remainingSec = remainingSec; self.endsAt = endsAt; self.layer = layer; self.totalLayers = totalLayers
            self.state = state; self.stage = stage; self.problems = problems
            estimateSec = nil; grams = nil; askId = nil; confirmationId = nil; expiresAt = nil
            mcpId = nil; fromVersion = nil; toVersion = nil; log = nil; keys = nil; by = nil; action = nil
        }
    }
    public let seq: Int
    public let id: String
    /// ISO 8601 with an offset.
    public let at: String
    public let type: String
    /// Absent for an event that isn't about one project (`mcp.update.*`, PRD §8.10).
    public let projectId: String?
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

    public init(seq: Int, id: String, at: String, type: String, projectId: String?, printId: String? = nil, destinationId: String? = nil,
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
/// Events are read one by one: one this app can't read is skipped (counted in `skipped`), never the whole page, and
/// `next` still moves past it.
public struct EventsPage: Decodable, Sendable, Equatable {
    public let events: [CounterpartEvent]
    public let next: Int
    public let latest: Int
    public let truncated: Bool?
    public let reset: Bool?
    /// Events on this page that couldn't be read.
    public let skipped: Int
    public init(events: [CounterpartEvent], next: Int, latest: Int, truncated: Bool? = nil, reset: Bool? = nil, skipped: Int = 0) {
        self.events = events; self.next = next; self.latest = latest; self.truncated = truncated; self.reset = reset; self.skipped = skipped
    }

    private struct Lossy: Decodable {
        let event: CounterpartEvent?
        init(from decoder: Decoder) throws { event = try? CounterpartEvent(from: decoder) }
    }
    private enum CodingKeys: String, CodingKey { case events, next, latest, truncated, reset }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let read = try c.decodeIfPresent([Lossy].self, forKey: .events) ?? []
        events = read.compactMap(\.event)
        skipped = read.count - events.count
        next = try c.decode(Int.self, forKey: .next)
        latest = try c.decode(Int.self, forKey: .latest)
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated)
        reset = try c.decodeIfPresent(Bool.self, forKey: .reset)
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

/// The companion's answer to `fusion.setup`.
public struct FusionSetupReply: Decodable, Sendable, Equatable {
    public let setup: JSONValue?
    public let server: String
    public let error: String?
    public init(setup: JSONValue?, server: String, error: String? = nil) { self.setup = setup; self.server = server; self.error = error }
}

public extension ControlClient {
    /// Holds up to `timeoutMs` for events after `after` (`capabilities.events`). Use a client whose own deadline is
    /// longer than `timeoutMs`; the companion keeps this connection open for `timeoutMs` plus 5 s.
    func waitForEvents(after: Int, timeoutMs: Int, limit: Int = 100) async throws -> EventsPage {
        try await call("events.wait", ["after": .number(Double(after)), "timeoutMs": .number(Double(timeoutMs)), "limit": .number(Double(limit))])
    }
    func liveActivityTokens() async throws -> LiveActivityTokens { try await call("liveActivity.tokens") }

    /// The print monitor's milestones (PRD §8.6), shared by every device: "off", "50", "25-50-75" or "every-10".
    func milestones() async throws -> String {
        struct Reply: Decodable { struct Settings: Decodable { let milestones: String }; let settings: Settings }
        let reply: Reply = try await call("settings.get")
        return reply.settings.milestones
    }
    func setMilestones(_ value: String) async throws {
        struct Reply: Decodable {}
        let _: Reply = try await call("settings.set", ["milestones": .string(value)])
    }

    /// Every setting the companion keeps (docs/protocols/settings.md, PRD §5.9): the phone and the Mac read and write
    /// the same values. Sections an older companion doesn't send are nil, and the Mac keeps its own then.
    func companionSettings() async throws -> CompanionSettings {
        struct Reply: Decodable { let settings: CompanionSettings }
        let reply: Reply = try await call("settings.get")
        return reply.settings
    }
    /// Changes only the keys named (deep-merged). Returns every setting after the change.
    @discardableResult func setSettings(_ patch: [String: JSONValue]) async throws -> CompanionSettings {
        struct Reply: Decodable { let settings: CompanionSettings }
        let reply: Reply = try await call("settings.set", patch)
        return reply.settings
    }
    /// Passive Mac observations only; neither call launches Fusion or reads a design.
    func reportFusion(installed: Bool, configured: Bool, running: Bool) async throws {
        struct Reply: Decodable {}
        let _: Reply = try await call("fusion.report", ["installed": .bool(installed), "configured": .bool(configured), "running": .bool(running)])
    }
    /// Claim once, including after reconnect. Replayed settings events never repeat an install.
    func claimFusionSetup(claimantId: String) async throws -> String? {
        struct Reply: Decodable { let requestId: String? }
        let reply: Reply = try await call("fusion.claimSetup", ["claimantId": .string(claimantId)])
        return reply.requestId
    }
    /// `fusion_mcp_setup` on the printer MCP as the companion runs it (with its Update override). `setup` is the MCP's
    /// result as it sent it; nil without `error` when that MCP has no such tool (`server` names it). `install` installs.
    func fusionSetup(install: Bool) async throws -> FusionSetupReply {
        try await call("fusion.setup", ["install": .bool(install)])
    }
    func fusionSetupDone(requestId: String, ok: Bool, message: String?) async throws {
        struct Reply: Decodable {}
        var params: [String: JSONValue] = ["requestId": .string(requestId), "ok": .bool(ok)]
        if let message { params["message"] = .string(message) }
        let _: Reply = try await call("fusion.setupDone", params)
    }

    /// Runs one control method by name with JSON parameters: commands from the phone (PRD §9.3) name existing methods.
    func run(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue { try await call(method, params) }
}

/// `pairing.icloudToken` (PRD §5.10): what this Mac publishes in its `CounterpartMac` record so a phone on the same
/// Apple Account enrols by itself. The token is single-use, valid for 10 minutes, and replaced every 5.
public struct ICloudEnrolment: Decodable, Sendable, Equatable {
    public struct Address: Codable, Sendable, Equatable, Hashable {
        /// `lan`, `mdns` or `tailscale`.
        public let kind: String
        public let host: String
        public let port: Int?
        public init(kind: String, host: String, port: Int? = nil) { self.kind = kind; self.host = host; self.port = port }
    }
    public let token: String
    /// ISO 8601.
    public let expiresAt: String
    public let macId: String
    public let spkiSha256: String
    public let addresses: [Address]
    public init(token: String, expiresAt: String, macId: String, spkiSha256: String, addresses: [Address]) {
        self.token = token; self.expiresAt = expiresAt; self.macId = macId; self.spkiSha256 = spkiSha256; self.addresses = addresses
    }
    public var expiresAtDate: Date? { CounterpartEvent.parse(expiresAt) }
}

public extension ControlClient {
    func icloudEnrolment() async throws -> ICloudEnrolment { try await call("pairing.icloudToken") }
}

/// `settings.get` (docs/protocols/settings.md), read tolerantly: a section an older companion doesn't send is nil.
public struct CompanionSettings: Decodable, Sendable, Equatable {
    public struct General: Codable, Sendable, Equatable {
        public var openAtLogin: Bool?
        public var showInDock: Bool?
        public var keepAwake: Bool?
        public init(openAtLogin: Bool? = nil, showInDock: Bool? = nil, keepAwake: Bool? = nil) {
            self.openAtLogin = openAtLogin; self.showInDock = showInDock; self.keepAwake = keepAwake
        }
    }
    public struct Fusion: Decodable, Sendable, Equatable { public let state: String; public let message: String?; public let version: String? }
    public let milestones: String?
    /// `notifications.mac`: explicit overrides; omitted types retain their platform defaults.
    public let notificationsMac: [String: Bool]?
    public let general: General?
    public let fusion: Fusion?
    /// `ai.check.outcome` of the latest Test; `needs-gui-session` means the sign-in has to finish on this Mac.
    public let aiCheckOutcome: String?

    public init(milestones: String? = nil, notificationsMac: [String: Bool]? = nil, general: General? = nil, fusion: Fusion? = nil,
                aiCheckOutcome: String? = nil) {
        self.milestones = milestones; self.notificationsMac = notificationsMac; self.general = general; self.fusion = fusion
        self.aiCheckOutcome = aiCheckOutcome
    }

    private enum CodingKeys: String, CodingKey { case milestones, notifications, general, fusion, ai }
    private struct Notifications: Decodable { let mac: [String: Bool]? }
    private struct AI: Decodable { struct Check: Decodable { let outcome: String? }; let check: Check? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        milestones = try? c.decodeIfPresent(String.self, forKey: .milestones)
        notificationsMac = (try? c.decodeIfPresent(Notifications.self, forKey: .notifications))?.mac
        general = try? c.decodeIfPresent(General.self, forKey: .general)
        fusion = try? c.decodeIfPresent(Fusion.self, forKey: .fusion)
        aiCheckOutcome = (try? c.decodeIfPresent(AI.self, forKey: .ai))?.check?.outcome
    }
}
