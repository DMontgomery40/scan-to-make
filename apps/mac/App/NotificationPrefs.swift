import Foundation
import ServiceManagement
import enum CounterpartKit.SettingsSchema
#if canImport(ControlKit)
import ControlKit
#endif

/// Settings → General → Notifications on this Mac (PRD §9.1's Mac column, screens/mac-settings-general.jpg).
/// Each switch covers one or more event types from the companion's log (docs/protocols/events.md).
enum NotificationSwitch: String, CaseIterable, Identifiable {
    case ready, ask, confirm, firstLayer, paused, done, problem, lost
    var id: String { rawValue }

    var title: String {
        switch self {
        case .ready: return "Ready to print"
        case .ask: return "Your Mac has a question"
        case .confirm: return "A printer needs a yes"
        case .firstLayer: return "First layer's down"
        case .paused: return "Printer paused"
        case .done: return "Print done"
        case .problem: return "Stopped or couldn't finish"
        case .lost: return "Lost contact with a printer"
        }
    }

    /// On by default: what needs the person or ends a job. Progress-like events are off on the Mac by default.
    var defaultOn: Bool { self != .firstLayer && self != .lost }

    var eventTypes: Set<String> {
        switch self {
        case .ready: return ["pass.ready"]
        case .ask: return ["pass.ask"]
        case .confirm: return ["print.confirm"]
        case .firstLayer: return ["print.first-layer"]
        case .paused: return ["print.paused"]
        case .done: return ["print.done"]
        case .problem: return ["print.failed", "print.not-started", "pass.failed", "print.check"]
        case .lost: return ["print.unreachable"]
        }
    }

    /// The order the switches appear in Settings, with Progress after First layer's down.
    static let ordered: [NotificationSwitch] = [.ready, .ask, .confirm, .firstLayer, .paused, .done, .problem, .lost]
}

/// `print.milestone` on the Mac: off by default. Which milestones exist is one setting shared with the iPhone (the
/// print monitor's, PRD §8.6, default halfway); choosing a level here sets it, and Off turns them off on this Mac only.
enum ProgressNotifications: String, CaseIterable, Identifiable {
    case off, halfway, quarters, every10
    var id: String { rawValue }
    /// The print monitor's value (`settings.set {milestones}`); nil for Off, which never turns them off for the phone.
    var milestones: String? {
        switch self {
        case .off: return nil
        case .halfway: return "50"
        case .quarters: return "25-50-75"
        case .every10: return "every-10"
        }
    }
    init?(milestones: String) {
        guard let level = Self.allCases.first(where: { $0.milestones == milestones }) else { return nil }
        self = level
    }
    var title: String {
        switch self {
        case .off: return "Off"
        case .halfway: return "Halfway"
        case .quarters: return "25, 50 and 75%"
        case .every10: return "Every 10%"
        }
    }
}

/// The Mac's switches as the companion keeps them (`notifications.mac.<type>`, docs/protocols/settings.md), one per event
/// type, in this order. Labels come from CounterpartKit's `SettingsSchema` once it has them; these match the doc.
enum MacNotificationTypes {
    static let ordered: [(type: String, label: String)] = [
        ("pass.ready", "Ready to print"), ("pass.ask", "Needs a photo or an answer"), ("pass.failed", "Couldn't finish the model"),
        ("print.confirm", "Printer needs a yes"), ("print.started", "Print started"), ("print.first-layer", "First layer down"),
        ("print.milestone", "Progress updates"), ("print.paused", "Print paused"), ("print.done", "Print done"),
        ("print.failed", "Print failed"), ("print.check", "Nothing coming out of the nozzle"), ("print.not-started", "Print didn't start"), ("print.cancelled", "Print stopped"),
        ("print.unreachable", "Lost contact with the printer"), ("print.sent", "Sent to a printer Counterpart can't follow"),
        ("mcp.update.done", "Printer software updated"), ("mcp.update.failed", "Printer software update failed"),
    ]
}

/// The switches, kept in UserDefaults. Read by Settings and by the event relay before each Mac notification.
struct NotificationPrefs {
    /// Whether this build posts Mac notifications at all (the event relay); until then the switches are shown, not live.
    static let delivered = true
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    static func key(_ item: NotificationSwitch) -> String { "notify.\(item.rawValue)" }
    static let progressKey = "notify.progress"
    /// The companion's per-type switches (`notifications.mac`), mirrored here so the relay reads them without a call.
    static let typesKey = "notify.types"

    /// The companion's switches, when it keeps them; nil for an older companion (this Mac's own switches then).
    var types: [String: Bool]? {
        get { defaults.dictionary(forKey: Self.typesKey) as? [String: Bool] }
        nonmutating set { defaults.set(newValue, forKey: Self.typesKey) }
    }

    func isOn(_ item: NotificationSwitch) -> Bool { defaults.object(forKey: Self.key(item)) as? Bool ?? item.defaultOn }
    func set(_ item: NotificationSwitch, _ on: Bool) { defaults.set(on, forKey: Self.key(item)) }
    var progress: ProgressNotifications {
        get { defaults.string(forKey: Self.progressKey).flatMap(ProgressNotifications.init(rawValue:)) ?? .off }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Self.progressKey) }
    }

    /// Whether an event of this type makes a Mac notification. A milestone notifies whenever Progress is on here: the
    /// shared setting already decided which milestones exist.
    func shouldNotify(type: String, progress percent: Double? = nil) -> Bool {
        // Explicit stored choices win; omitted known types retain their documented defaults.
        if let types { return types[type] ?? SettingsSchema.defaultValue(type, mac: true) }
        if type == "print.milestone" { return progress != .off }
        guard let item = NotificationSwitch.allCases.first(where: { $0.eventTypes.contains(type) }) else { return false }
        return isOn(item)
    }
}

/// A registered login item can still be awaiting approval; turning it off cancels that registration.
enum LoginRegistrationAction: Equatable {
    case none, register, unregister, approvalRequired, unavailable
    static func resolve(on: Bool, status: SMAppService.Status) -> Self {
        switch status {
        case .enabled: return on ? .none : .unregister
        case .requiresApproval: return on ? .approvalRequired : .unregister
        case .notRegistered: return on ? .register : .none
        default: return .unavailable
        }
    }
}

/// PRD §5.9: the first time the companion keeps settings, this Mac's own choices go up to it.
enum SettingsMigration {
    static func currentGeneral(loginStatus: SMAppService.Status, showInDock: Bool, keepAwake: Bool) -> [String: Bool] {
        var values = ["showInDock": showInDock, "keepAwake": keepAwake]
        switch loginStatus {
        case .enabled, .requiresApproval: values["openAtLogin"] = true
        case .notRegistered: values["openAtLogin"] = false
        default: break // notFound or a future state is unknown, not a new registration request.
        }
        return values
    }

    /// What this Mac had changed from the defaults before the companion kept settings (open at login off, no Dock
    /// icon, a notification switch flipped, Progress on), as the patch that carries it over.
    static func patch(defaults: UserDefaults, companion: CompanionSettings, currentGeneral: [String: Bool] = [:]) -> [String: JSONValue] {
        var patch: [String: JSONValue] = [:]
        if companion.general != nil {
            var general: [String: JSONValue] = [:]
            let owned: [String: Bool?] = ["openAtLogin": companion.general?.openAtLogin, "showInDock": companion.general?.showInDock, "keepAwake": companion.general?.keepAwake]
            for (key, value) in currentGeneral where (owned[key] ?? nil) == nil { general[key] = .bool(value) }
            if let off = defaults.object(forKey: "openAtLoginOff") as? Bool,
               off || companion.general?.openAtLogin != false { general["openAtLogin"] = .bool(!off) }
            if defaults.object(forKey: "showInDock") as? Bool == false { general["showInDock"] = .bool(false) }
            if !general.isEmpty { patch["general"] = .object(general) }
        }
        if companion.notificationsMac != nil {
            let prefs = NotificationPrefs(defaults: defaults)
            var mac: [String: JSONValue] = [:]
            for item in NotificationSwitch.allCases where defaults.object(forKey: NotificationPrefs.key(item)) != nil && prefs.isOn(item) != item.defaultOn {
                for type in item.eventTypes { mac[type] = .bool(prefs.isOn(item)) }
            }
            if prefs.progress != .off { mac["print.milestone"] = .bool(true) }
            // Preserve every saved per-type choice, including unknown types from a newer app.
            for (type, on) in prefs.types ?? [:] { mac[type] = .bool(on) }
            // A saved opt-out wins over a conflicting older local opt-in during migration.
            mac = mac.filter { type, value in value != .bool(true) || companion.notificationsMac?[type] != false }
            if !mac.isEmpty { patch["notifications"] = .object(["mac": .object(mac)]) }
        }
        return patch
    }
}
