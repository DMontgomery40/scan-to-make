import Foundation

/// Identifiers shared by the app and the extensions a later milestone adds (widgets, the Live Activity,
/// the notification service extension). Internal ids keep the `scantomake` name.
public enum CounterpartIdentifiers {
    /// The App Group the app and its extensions will share (PRD §9.5). The entitlement is added with the
    /// first extension that needs it.
    public static let appGroup = "group.com.scantomake.counterpart"
    /// The private CloudKit container the Mac mirrors projects into (PRD §8.8).
    public static let cloudKitContainer = "iCloud.com.scantomake.counterpart"
    public static let cloudKitZone = "Counterpart"
    public static let docsSite = URL(string: "https://counterpart.dtmont.com/")!
    public static let helpPage = docsSite.appendingPathComponent("help")
    /// Kass 3D's 360° scan rig on MakerWorld (PRD §11.1, §15). Counterpart links to it and never re-hosts it.
    public static let scanRig = URL(string: "https://makerworld.com/en/models/1531561")!
}

/// The CloudKit record types (PRD §8.8, §9.2, §9.3). Space for the records the Mac writes and the phone
/// reads; the CloudKit code itself arrives with the notifications milestone.
public enum CloudKitRecords {
    public static let event = "CounterpartEvent"
    public static let project = "CounterpartProject"
    public static let command = "CounterpartCommand"
    /// `CounterpartProject.state`: the shared phase spelling, exactly `ProjectPhase.rawValue`
    /// (draft, sending, working, needs-you, ready, preparing, printing, printed, sent, failed, unknown).
    public static func projectState(_ phase: ProjectPhase) -> String { phase.rawValue }
    public static let device = "CounterpartDevice"

    /// The phone's fixed subscription ids and their notification categories (PRD §9.2).
    public static let subscriptions: [(id: String, types: [String], category: String)] = [
        ("ev-ready", ["pass.ready"], "READY"),
        ("ev-ask", ["pass.ask"], "ASK"),
        ("ev-confirm", ["print.confirm"], "CONFIRM"),
        ("ev-progress", ["print.first-layer", "print.milestone"], "PROGRESS"),
        ("ev-done", ["print.done"], "DONE"),
        ("ev-problem", ["print.paused", "print.failed", "print.not-started", "pass.failed", "print.unreachable", "print.check"], "PROBLEM"),
    ]
}

/// Where a notification, a widget tap or a Live Activity button takes you. The one entry point for
/// notification routing: the app opens whatever this resolves to.
public enum AppRoute: Equatable, Sendable {
    case home
    case project(String)
    /// The print sheet for a ready project.
    case print(String)
    /// The camera, to answer a project's Ask.
    case camera(String)
    case printing(String)
    case printers
    case newProject
    case pair(String)

    /// From a notification's `userInfo` (`projectId`, `type`) or a CloudKit query notification's record fields.
    public init?(notification userInfo: [AnyHashable: Any], action: String? = nil) {
        let fields = (userInfo["ck"] as? [String: Any])?["qry"].flatMap { ($0 as? [String: Any])?["af"] as? [String: Any] } ?? [:]
        func value(_ key: String) -> String? { userInfo[key] as? String ?? fields[key] as? String }
        guard let project = value("projectId"), !project.isEmpty else { return nil }
        let type = value("type") ?? ""
        let ended = ["print.done", "print.failed", "print.cancelled", "print.not-started", "print.sent"]
        if action == "PRINT" { self = .print(project) }
        else if action == "CAMERA" { self = .camera(project) }
        // Try Again on a print that failed or never started opens Print, where the person presses Print: a
        // notification button never starts a print by itself. On a failed pass it opens the project's Try Again.
        else if action == "TRY_AGAIN" { self = type.hasPrefix("print.") ? .print(project) : .project(project) }
        // Each Open button goes where it says; only a plain tap follows the event type.
        else if action == "OPEN" { self = .project(project) }
        else if action == "OPEN_PRINT" { self = .printing(project) }
        else if type.hasPrefix("print.") && !ended.contains(type) { self = .printing(project) }
        else { self = .project(project) }
    }

    /// The notification's project id and event type, from its `userInfo` or a CloudKit query notification's fields.
    public static func notificationFields(_ userInfo: [AnyHashable: Any]) -> (projectId: String?, type: String?, eventId: String?) {
        let fields = (userInfo["ck"] as? [String: Any])?["qry"].flatMap { ($0 as? [String: Any])?["af"] as? [String: Any] } ?? [:]
        func value(_ key: String) -> String? { (userInfo[key] as? String ?? fields[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        return (value("projectId"), value("type"), value("eventId"))
    }

    /// The project this route shows, if any.
    public var projectId: String? {
        switch self {
        case .project(let id), .print(let id), .camera(let id), .printing(let id): id
        case .home, .printers, .newProject, .pair: nil
        }
    }

    /// From a `counterpart://` or `scantomake://` URL: `scantomake://pair?…` pairs; `counterpart://project/<id>`
    /// and friends open a screen.
    public init?(url: URL) {
        if PairingLink.isPairingLink(url.absoluteString) { self = .pair(url.absoluteString); return }
        guard ["counterpart", "scantomake"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
        switch (parts.first, parts.count > 1 ? parts[1] : nil) {
        case ("new", _): self = .newProject
        case ("printers", _): self = .printers
        case ("project", let id?): self = .project(id)
        case ("print", let id?): self = .print(id)
        case ("printing", let id?): self = .printing(id)
        case ("camera", let id?): self = .camera(id)
        default: self = .home
        }
    }
}
