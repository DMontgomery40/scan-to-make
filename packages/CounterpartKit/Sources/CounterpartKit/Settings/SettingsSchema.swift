import Foundation

/// Every setting the Mac has, as both apps show it (PRD §5.9, docs/protocols/settings.md). The companion stores
/// the values and is the one source of truth; this is the list of keys, labels and defaults the phone and the
/// Mac render from, so they say the same thing. Values come and go through `GET`/`PATCH /v1/settings`.
public enum SettingsSchema {
    public struct NotificationType: Identifiable, Equatable, Sendable {
        /// The event type, e.g. `pass.ready`.
        public let id: String
        public let label: String
        /// On by default on a phone, and on the Mac.
        public let phone: Bool
        public let mac: Bool
    }

    /// One switch per type, in this order (PRD §8.8, §9.1).
    public static let notificationTypes: [NotificationType] = [
        .init(id: "pass.ready", label: "Ready to print", phone: true, mac: true),
        .init(id: "pass.ask", label: "Needs a photo or an answer", phone: true, mac: true),
        .init(id: "pass.failed", label: "Couldn't finish the model", phone: true, mac: true),
        .init(id: "print.confirm", label: "Printer needs a yes", phone: true, mac: true),
        .init(id: "print.started", label: "Print started", phone: true, mac: false),
        .init(id: "print.first-layer", label: "First layer down", phone: true, mac: false),
        .init(id: "print.milestone", label: "Progress updates", phone: true, mac: false),
        .init(id: "print.paused", label: "Print paused", phone: true, mac: true),
        .init(id: "print.done", label: "Print done", phone: true, mac: true),
        .init(id: "print.failed", label: "Print failed", phone: true, mac: true),
        .init(id: "print.not-started", label: "Print didn't start", phone: true, mac: true),
        .init(id: "print.cancelled", label: "Print stopped", phone: true, mac: false),
        .init(id: "print.unreachable", label: "Lost contact with the printer", phone: true, mac: false),
        .init(id: "print.sent", label: "Sent to a printer Counterpart can't follow", phone: true, mac: false),
        .init(id: "mcp.update.done", label: "Printer software updated", phone: true, mac: false),
        .init(id: "mcp.update.failed", label: "Printer software update failed", phone: true, mac: true),
    ]

    /// A type a newer Mac knows and this app doesn't: on for the phone, off for the Mac.
    public static func defaultValue(_ type: String, mac: Bool) -> Bool {
        notificationTypes.first { $0.id == type }.map { mac ? $0.mac : $0.phone } ?? !mac
    }

    /// `milestones`: which progress updates the Mac sends.
    public static let milestones: [(value: String, label: String)] = [
        ("off", "Off"), ("50", "Halfway"), ("25-50-75", "Every quarter"), ("every-10", "Every 10%"),
    ]
    public static func milestoneLabel(_ value: String) -> String { milestones.first { $0.value == value }?.label ?? value }

    /// `general.*`: each one changes the Mac.
    public static let general: [(key: String, label: String)] = [
        ("openAtLogin", "Open at login"), ("showInDock", "Show in Dock"), ("keepAwake", "Keep the Mac awake while working"),
    ]

    /// `ai.choice.kind`, and which of them a phone can choose (the others need a key in the Mac's Keychain).
    public static let aiKinds: [(kind: String, label: String, fromPhone: Bool)] = [
        ("none", "Off", true), ("claude-code", "Claude Code (your login)", true), ("codex-cli", "Codex (your login)", true),
        ("api", "API key", false), ("endpoint", "Your own endpoint", false),
    ]
    public static func aiLabel(_ kind: String) -> String { aiKinds.first { $0.kind == kind }?.label ?? kind }
}

/// The settings as the companion returns them (`Settings`). Every part is optional, so an older Mac (only
/// `milestones`) and a newer one (keys this app doesn't know) both decode.
public struct CompanionSettings: Codable, Equatable, Sendable {
    public struct Notifications: Codable, Equatable, Sendable {
        public var mac: [String: Bool]
        public var devices: [String: [String: Bool]]
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            mac = (try? c.decodeIfPresent([String: Bool].self, forKey: .mac)) ?? [:]
            devices = (try? c.decodeIfPresent([String: [String: Bool]].self, forKey: .devices)) ?? [:]
        }
        public init(mac: [String: Bool] = [:], devices: [String: [String: Bool]] = [:]) { self.mac = mac; self.devices = devices }
    }
    public struct General: Codable, Equatable, Sendable {
        public var openAtLogin: Bool?
        public var showInDock: Bool?
        public var keepAwake: Bool?
        public subscript(key: String) -> Bool? {
            switch key { case "openAtLogin": openAtLogin; case "showInDock": showInDock; case "keepAwake": keepAwake; default: nil }
        }
    }
    public struct AI: Codable, Equatable, Sendable {
        public struct Choice: Codable, Equatable, Sendable {
            public var kind: String
            public var provider: String?
            public var model: String?
            public var url: String?
        }
        public struct Check: Codable, Equatable, Sendable {
            public var id: String?
            public var revision: String?
            /// checking, connected, failed, skipped
            public var state: String
            /// Why it isn't connected; `needs-gui-session` means the sign-in finishes on the Mac.
            public var outcome: String?
            public var message: String?
        }
        public var revision: String?
        public var choice: Choice?
        public var check: Check?
    }
    public struct Fusion: Codable, Equatable, Sendable {
        /// not-set-up, not-running, connected, setting-up, unavailable
        public var state: String
        public var message: String
        public var version: String?
    }

    public var milestones: String
    public var notifications: Notifications?
    public var general: General?
    public var ai: AI?
    public var fusion: Fusion?

    public init(milestones: String = "50", notifications: Notifications? = nil, general: General? = nil, ai: AI? = nil, fusion: Fusion? = nil) {
        self.milestones = milestones; self.notifications = notifications; self.general = general; self.ai = ai; self.fusion = fusion
    }

    private enum CodingKeys: String, CodingKey { case milestones, notifications, general, ai, fusion }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        milestones = (try? c.decodeIfPresent(String.self, forKey: .milestones)) ?? "50"
        notifications = (try? c.decodeIfPresent(Notifications.self, forKey: .notifications)) ?? nil
        general = (try? c.decodeIfPresent(General.self, forKey: .general)) ?? nil
        ai = (try? c.decodeIfPresent(AI.self, forKey: .ai)) ?? nil
        fusion = (try? c.decodeIfPresent(Fusion.self, forKey: .fusion)) ?? nil
    }

    /// The Mac serves every setting (KAN-214 PR 6b); an older Mac serves only `milestones`.
    public var isFull: Bool { notifications != nil || general != nil || ai != nil || fusion != nil }

    /// This phone's switch for a notification type: its stored value, else the phone default.
    public func phoneNotifies(_ type: String, deviceId: String?) -> Bool {
        deviceId.flatMap { notifications?.devices[$0]?[type] } ?? SettingsSchema.defaultValue(type, mac: false)
    }
    public func macNotifies(_ type: String) -> Bool { notifications?.mac[type] ?? SettingsSchema.defaultValue(type, mac: true) }
}

/// A `PATCH /v1/settings` body: only the keys it names change (deep merge).
public enum SettingsPatch {
    public static func milestones(_ value: String) -> [String: Any] { ["milestones": value] }
    public static func phoneNotification(_ type: String, _ on: Bool, deviceId: String) -> [String: Any] {
        ["notifications": ["devices": [deviceId: [type: on]]]]
    }
    public static func macNotification(_ type: String, _ on: Bool) -> [String: Any] { ["notifications": ["mac": [type: on]]] }
    public static func general(_ key: String, _ on: Bool) -> [String: Any] { ["general": [key: on]] }
    /// Only none, claude-code and codex-cli from a phone; the Mac refuses the others with a sentence.
    public static func ai(kind: String, expectedRevision: String?) -> [String: Any] {
        var ai: [String: Any] = ["choice": ["kind": kind]]
        if let expectedRevision { ai["expectedRevision"] = expectedRevision }
        return ["ai": ai]
    }
}

/// A paired phone or iPad (`GET /v1/devices`).
public struct CompanionDevice: Codable, Identifiable, Equatable, Sendable {
    public var deviceId: String
    public var deviceName: String?
    public var pairedAt: String?
    public var lastRefreshedAt: String?
    public var expiresAt: String?
    public var pairedVia: String?
    public var model: String?
    public var lastSeenAt: String?
    /// A pairing from before stable install identity: the "Older pairings" section.
    public var legacy: Bool?
    /// The phone asking.
    public var current: Bool?
    public var id: String { deviceId }
}

/// `POST /v1/printers/mcp/<mcpId>/update` (PRD §8.10).
public struct MCPUpdate: Codable, Equatable, Sendable {
    public var mcpId: String
    /// started, waiting (a print is running: it updates after), current (already the latest), unresolved
    /// (the install couldn't be told; `found` says what was found).
    public var state: String
    public var fromVersion: String?
    public var toVersion: String?
    public var found: String?
}
