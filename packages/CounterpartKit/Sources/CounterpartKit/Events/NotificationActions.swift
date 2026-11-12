import Foundation
import UserNotifications

/// The buttons on Counterpart's notifications (PRD §9.1, §9.2), shared by the iPhone, its notification service
/// extension and the Mac. One category per kind of moment, chosen from the event's `type`, so a cancelled print
/// never offers It Works and a failure never offers Resume. The CloudKit subscriptions carry one category for
/// several types (`ev-problem`, `ev-stopped`); the service extension sets the right one from `type` (`category(for:)`).
public enum NotificationActions {
    public enum Category: String, CaseIterable, Sendable {
        case ready = "READY", ask = "ASK", confirm = "CONFIRM", progress = "PROGRESS", paused = "PAUSED"
        case done = "DONE", ended = "ENDED", failed = "FAILED", problem = "PROBLEM", software = "SOFTWARE"
    }

    /// Action identifiers. PRINT, CAMERA and OPEN keep the ids notifications already delivered carry.
    public enum Action: String, CaseIterable, Sendable {
        case print = "PRINT", askForChanges = "ASK_FOR_CHANGES", camera = "CAMERA", bestGuess = "BEST_GUESS"
        case openProject = "OPEN", openPrint = "OPEN_PRINT", pause = "PAUSE", resume = "RESUME"
        case itWorks = "IT_WORKS", needsChanges = "NEEDS_CHANGES", tryAgain = "TRY_AGAIN"

        /// Runs without opening the app (PRD §9.2): its answer goes to the Mac and nothing needs the screen.
        public var background: Bool { [.askForChanges, .bestGuess, .pause, .resume, .itWorks, .needsChanges].contains(self) }
        public var title: String {
            switch self {
            case .print: "Print"
            case .askForChanges: "Ask for Changes…"
            case .camera: "Take a Photo"
            case .bestGuess: "Best Guess"
            // Each Open says where it goes (AppRoute): the project page, or the print's Printing screen.
            case .openProject: "Open Project"
            case .openPrint: "Open Print"
            case .pause: "Pause"
            case .resume: "Resume"
            case .itWorks: "It Works"
            case .needsChanges: "Needs Changes…"
            case .tryAgain: "Try Again"
            }
        }
        public var symbol: String {
            switch self {
            case .print: "printer"
            case .askForChanges: "bubble.left"
            case .camera: "camera"
            case .bestGuess: "sparkles"
            case .openProject: "cube"
            case .openPrint: "printer.dotmatrix"
            case .pause: "pause.fill"
            case .resume: "play.fill"
            case .itWorks: "checkmark"
            case .needsChanges: "pencil"
            case .tryAgain: "arrow.clockwise"
            }
        }
    }

    /// The category for an event `type` (events.md), or nil for a type Counterpart never shows.
    public static func category(for type: String) -> Category? {
        switch type {
        case "pass.ready": .ready
        case "pass.ask": .ask
        case "print.confirm": .confirm
        // #630 print.check: the camera shows nothing coming out of the nozzle. Watch it, and Pause if you want: never automatic.
        case "print.started", "print.first-layer", "print.milestone", "print.check": .progress
        case "print.paused": .paused
        case "print.done": .done
        case "print.cancelled", "print.sent": .ended
        case "print.failed", "print.not-started", "pass.failed": .failed
        case "print.unreachable": .problem
        case "mcp.update.done", "mcp.update.failed": .software
        default: nil
        }
    }

    /// The buttons in each category, in the order they show (PRD §9.1).
    public static func actions(in category: Category) -> [Action] {
        switch category {
        case .ready: [.print, .askForChanges]
        case .ask: [.camera, .bestGuess]
        case .confirm: [.openProject]
        case .progress: [.openPrint, .pause]
        case .paused: [.openPrint, .resume]
        case .done: [.itWorks, .needsChanges, .openProject]
        case .ended, .problem: [.openProject]
        case .failed: [.tryAgain, .openProject]
        case .software: []
        }
    }

    /// What `needsChanges` puts before the person's words, as the project page's Needs Changes does (PRD §5.4).
    public static let afterPrinting = "After printing: "

    /// A background action's request to the Mac.
    public enum Command: Equatable, Sendable {
        case status(String, ProjectStatus)
        /// Says it needs changes, then sends the words (if any) as a change.
        case needsChanges(String, note: String?)
        case correct(String, note: String)
        case bestGuess(String)
        case control(String, CompanionClient.PrintControl)

        public var projectId: String {
            switch self {
            case .status(let id, _), .needsChanges(let id, _), .correct(let id, _), .bestGuess(let id), .control(let id, _): id
            }
        }

        /// Runs it over the paired connection, as the app's own buttons do.
        @discardableResult public func run(_ client: CompanionClient) async throws -> Project? {
            switch self {
            case .status(let id, let status): return try await client.setStatus(id, status)
            case .needsChanges(let id, let note):
                let marked = try await client.setStatus(id, .needsChanges)
                guard let note else { return marked }
                return try await client.correct(id, note)
            case .correct(let id, let note): return try await client.correct(id, note)
            case .bestGuess(let id): return try await client.answerAsk(id, bestGuess: true)
            case .control(let id, let action): return try await client.control(id, action)
            }
        }

        /// The `CounterpartCommand` records (PRD §9.3) that do the same through iCloud, in order, when the phone
        /// can't reach the Mac: `type` and its JSON `payload`.
        public var cloudCommands: [(type: String, payload: [String: JSONValue])] {
            switch self {
            case .status(_, let status): [("status", ["status": .string(status.rawValue)])]
            // One record: the Mac runs iCloud commands concurrently, so a separate `correct` could start the change
            // before the status lands. The Mac sets the status, then sends the words as a change (cloudkit.md).
            case .needsChanges(_, let note):
                [("status", ["status": .string(ProjectStatus.needsChanges.rawValue)].merging(note.map { ["note": .string($0)] } ?? [:]) { $1 })]
            case .correct(_, let note): [("correct", ["note": .string(note)])]
            case .bestGuess: [("answerAsk", ["bestGuess": .bool(true)])]
            case .control(_, let action): [(action.rawValue, [:])]
            }
        }

        /// "Paused Cable clip." — the words for a failure notice: what didn't happen.
        public var failedWords: String {
            switch self {
            case .status(_, .works): "Couldn't mark it as working"
            case .status, .needsChanges: "Couldn't send your changes"
            case .correct: "Couldn't send your changes"
            case .bestGuess: "Couldn't send Best Guess"
            case .control(_, .pause): "Couldn't pause the print"
            case .control(_, .resume): "Couldn't resume the print"
            case .control(_, .cancel): "Couldn't stop the print"
            }
        }
    }

    /// The command for a background action on a notification of this event `type`, or nil when the action
    /// doesn't belong to that moment (It Works only on a finished print, Pause only while printing, Resume only
    /// when paused, Best Guess only on a question) or isn't a background action at all.
    public static func command(action identifier: String, type: String, projectId: String, text: String? = nil) -> Command? {
        guard let action = Action(rawValue: identifier), action.background, !projectId.isEmpty else { return nil }
        let words = text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        switch (action, type) {
        case (.itWorks, "print.done"): return .status(projectId, .works)
        case (.needsChanges, "print.done"): return .needsChanges(projectId, note: words.map { afterPrinting + $0 })
        case (.askForChanges, "pass.ready"): return words.map { .correct(projectId, note: $0) }
        case (.bestGuess, "pass.ask"): return .bestGuess(projectId)
        case (.pause, "print.first-layer"), (.pause, "print.milestone"), (.pause, "print.started"), (.pause, "print.check"): return .control(projectId, .pause)
        case (.resume, "print.paused"): return .control(projectId, .resume)
        default: return nil
        }
    }

    /// Every category with its buttons, for `UNUserNotificationCenter.setNotificationCategories`.
    /// Background actions ask for Face ID or the passcode first: the pairing is in the Keychain, readable only
    /// while the phone is unlocked (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).
    public static func categories() -> Set<UNNotificationCategory> {
        Set(Category.allCases.map { category in
            UNNotificationCategory(identifier: category.rawValue, actions: actions(in: category).map(notificationAction), intentIdentifiers: [])
        })
    }

    static func notificationAction(_ action: Action) -> UNNotificationAction {
        let icon = UNNotificationActionIcon(systemImageName: action.symbol)
        switch action {
        case .askForChanges:
            return UNTextInputNotificationAction(identifier: action.rawValue, title: action.title, options: [.authenticationRequired], icon: icon,
                                                 textInputButtonTitle: "Send", textInputPlaceholder: "What should change?")
        case .needsChanges:
            return UNTextInputNotificationAction(identifier: action.rawValue, title: action.title, options: [.authenticationRequired], icon: icon,
                                                 textInputButtonTitle: "Send", textInputPlaceholder: "What didn't fit?")
        default:
            return UNNotificationAction(identifier: action.rawValue, title: action.title,
                                        options: action.background ? [.authenticationRequired] : [.foreground], icon: icon)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
