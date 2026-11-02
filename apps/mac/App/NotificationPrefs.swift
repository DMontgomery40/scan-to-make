import Foundation

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
        case .problem: return ["print.failed", "print.not-started", "pass.failed"]
        case .lost: return ["print.unreachable"]
        }
    }

    /// The order the switches appear in Settings, with Progress after First layer's down.
    /// No plate switch: plate-clearance prompts are gone (main `ac44431`); the printer's own confirmation covers it.
    static let ordered: [NotificationSwitch] = [.ready, .ask, .confirm, .firstLayer, .paused, .done, .problem, .lost]
}

/// `print.milestone` on the Mac: off by default. The companion's own milestone setting decides which exist at all.
enum ProgressNotifications: String, CaseIterable, Identifiable {
    case off, halfway, quarters, every10
    var id: String { rawValue }
    var title: String {
        switch self {
        case .off: return "Off"
        case .halfway: return "Halfway"
        case .quarters: return "25, 50 and 75%"
        case .every10: return "Every 10%"
        }
    }
    func includes(percent: Double) -> Bool {
        let whole = Int(percent.rounded())
        switch self {
        case .off: return false
        case .halfway: return whole == 50
        case .quarters: return [25, 50, 75].contains(whole)
        case .every10: return whole % 10 == 0
        }
    }
}

/// The switches, kept in UserDefaults. Read by Settings and by the event relay before each Mac notification.
struct NotificationPrefs {
    /// Whether this build posts Mac notifications at all (the event relay); until then the switches are shown, not live.
    static let delivered = false
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    static func key(_ item: NotificationSwitch) -> String { "notify.\(item.rawValue)" }
    static let progressKey = "notify.progress"

    func isOn(_ item: NotificationSwitch) -> Bool { defaults.object(forKey: Self.key(item)) as? Bool ?? item.defaultOn }
    func set(_ item: NotificationSwitch, _ on: Bool) { defaults.set(on, forKey: Self.key(item)) }
    var progress: ProgressNotifications {
        get { defaults.string(forKey: Self.progressKey).flatMap(ProgressNotifications.init(rawValue:)) ?? .off }
        nonmutating set { defaults.set(newValue.rawValue, forKey: Self.progressKey) }
    }

    /// Whether an event of this type (and, for a milestone, this percent) makes a Mac notification.
    func shouldNotify(type: String, progress percent: Double? = nil) -> Bool {
        if type == "print.milestone" { return percent.map(progress.includes(percent:)) ?? false }
        guard let item = NotificationSwitch.allCases.first(where: { $0.eventTypes.contains(type) }) else { return false }
        return isOn(item)
    }
}
