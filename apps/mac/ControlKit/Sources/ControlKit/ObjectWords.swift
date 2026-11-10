import Foundation
import CounterpartKit

// The words for a project (PRD §4) come from CounterpartKit's `ProjectWords`, the one source the phone, the Lock
// Screen and this Mac share; the companion's own `status` wins inside it. This file only adds what is the Mac's
// alone: the sidebar's sections, the capsule, the window subtitle, live print progress and the actions this Mac
// offers.

/// PRD §4's stages, shared with the phone (`needs-you` on the wire and in CloudKit).
public typealias ProjectStage = ProjectPhase

/// What the user can do with a project on this Mac.
public enum ObjectAction: Sendable, Equatable {
    case print
    /// Print again after an uncertain print, once the user has checked the printer (`checked: true`).
    case printChecked
    case correct
    case bestGuess
    /// Start the pass again after it failed without a model (`objects.start`).
    case retry

    /// The shared actions this Mac offers; the phone's own (camera, attach, finish sending) have no Mac button.
    init?(_ action: ProjectAction) {
        switch action {
        case .print: self = .print
        case .printChecked: self = .printChecked
        case .correct: self = .correct
        case .bestGuess: self = .bestGuess
        case .retry: self = .retry
        default: return nil
        }
    }
}

/// The sidebar's sections (PRD §7.2), in order. Every stage belongs to exactly one.
public enum ProjectGroup: Int, Sendable, Equatable, CaseIterable, Comparable {
    /// Done: the person said it works (PRD §5.4). Drafts: started on the phone, nothing sent yet.
    /// Archived: hidden from the others, collapsed, everything kept.
    case now, needsYou, ready, done, printed, drafts, archived
    public var title: String {
        switch self {
        case .now: return "Now"
        case .needsYou: return "Needs you"
        case .ready: return "Ready"
        case .done: return "Done"
        case .printed: return "Printed"
        case .drafts: return "Drafts"
        case .archived: return "Archived"
        }
    }
    public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

/// A project in plain words, for this Mac.
public struct ObjectWords: Sendable, Equatable {
    public let title: String
    public let stage: ProjectStage
    /// The capsule's words: the stage alone.
    public let capsule: String
    public let group: ProjectGroup
    /// The status line, for the sidebar row and the menu bar: "Ready to print · 48 × 50 × 54 mm".
    public let status: String
    /// The question, when the Mac needs something ("Can you send me a close-up of the underside? …").
    public let question: String?
    /// Working or printing: keep reading while it changes.
    public let busy: Bool
    /// "48 × 50 × 54 mm".
    public let size: String?
    /// Printing progress, 0…1, when the printer reports it.
    public let progress: Double?
    public let actions: [ObjectAction]
    /// The person said it works (`confirmed`, PRD §5.4): it shows under Done with the ✓, and can be printed again.
    public let done: Bool
    /// A print the printer has: printing, or dispatched and still getting ready (`preparing`, with `print.dispatchedAt`
    /// and the monitor `starting` or `watching`; a `printId` alone is set at the tap, while it still slices and sends).
    /// Pause and Stop work the same in both; only the words differ.
    public let printRunning: Bool

    /// "38 min", "1 h 12 min".
    public static func formatMinutes(_ minutes: Double) -> String { Format.duration(max(0, minutes) * 60) ?? "0 min" }

    /// The window's subtitle: the state, then the first sentence of what was asked for (PRD §7.2).
    public func subtitle(request: String?) -> String {
        var asked = (request ?? "").trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")[0]
        if let end = asked.range(of: #"[.!?](\s|$)"#, options: .regularExpression) { asked = String(asked[..<end.lowerBound]) }
        let head: String
        switch stage {
        case .needsYou: head = question.map { "Needs you · \($0)" } ?? stage.label
        case .working, .printing, .failed: head = status
        default: head = capsule
        }
        guard !asked.isEmpty, asked != title else { return head }
        let short = asked.count > 80 ? String(asked.prefix(79)) + "…" : asked
        return head + " · " + short.prefix(1).lowercased() + short.dropFirst()
    }

    /// "Draft from your iPhone · nothing sent yet".
    public static let draftLine = "Draft from your iPhone · nothing sent yet"

    /// A project started on the phone with nothing sent: new, no scan, photos or capture on this Mac, and nothing
    /// arriving. The companion says when the first files are arriving (`progress`, control socket only); it keeps no
    /// other trace of an upload in progress, so this never guesses from how old the project is.
    public static func isDraft(_ object: Project) -> Bool {
        object.state == .new && object.scan == nil && object.photos.isEmpty && (object.capture ?? []).isEmpty
            && (object.captureDepth ?? []).isEmpty
            && (object.progress ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public init(_ object: Project, now: Date = Date()) {
        let project = object
        let printer = object.print?.destination?.name
        // This Mac never sends a project's files itself. A new project is being sent once its files arrive; before
        // that it is the phone's draft, not "Sending to your Mac".
        let draft = Self.isDraft(object)
        let words = ProjectWords(project, sending: object.state == .new && !draft, printerName: printer, now: now)
        title = words.title
        done = object.status?.phase == "confirmed" || object.state.rawValue == "confirmed"
        // The printer asking for a yes needs the person, also from a companion that doesn't write its own phase yet.
        stage = object.printConfirmation != nil && object.status == nil ? .needsYou : done ? .confirmed : words.phase
        let dispatched = object.print?.dispatchedAt != nil && ["starting", "watching"].contains(object.print?.monitor?.phase ?? "")
        printRunning = stage == .printing || (stage == .preparing && dispatched)
        // The companion's own words when it sends them ("Getting ready · Heating", "The printer stopped: …"): never a
        // percent built here from the printer's raw progress, which can read 3% before printing has begun.
        let said = object.status?.text.trimmingCharacters(in: .whitespacesAndNewlines)
        status = draft ? Self.draftLine : said?.isEmpty == false ? said! : done ? "It works" : words.line
        // A new project waits on the phone; the Mac can't tell an upload from an abandoned draft, so it isn't busy
        // (it would keep the Mac awake and polling for good).
        busy = object.state == .new ? false : words.busy || words.phase.isRunning
        size = words.size
        // Done stays printable ("Print Another…") and changeable, as a printed project is.
        // A question of a kind this build doesn't know is shown with the update sentence and no answer at all:
        // any answer offered (a guess, a photo) could consume it wrongly.
        actions = done && object.current != nil ? [object.print?.uncertain == true ? .printChecked : .print, .correct]
            : object.openAsk?.answerable == false ? []
            : words.actions.compactMap(ObjectAction.init)
        capsule = done ? "Done" : stage.label
        group = done ? .done : Self.group(stage)
        if object.printConfirmation != nil {
            question = "\(printer ?? "Your printer") needs a yes before printing"
        } else if stage == .needsYou || object.state == .needsCloseup {
            question = ProjectWords.question(project)
        } else {
            question = nil
        }
        // The bar only while the companion says it is printing (not preparing, not failed).
        if stage == .printing, object.status.map({ $0.phase == "printing" }) ?? true,
           let percent = object.print?.live?.job?.progress ?? object.print?.printerStatus?.percent {
            progress = min(1, max(0, percent / 100))
        } else {
            progress = nil
        }
    }

    /// Which sidebar section a stage belongs to. Failures need the person, so they sit with Needs you.
    public static func group(_ stage: ProjectStage) -> ProjectGroup {
        switch stage {
        case .draft: return .drafts
        case .sending, .working, .preparing, .printing, .unknown: return .now
        case .needsYou, .failed: return .needsYou
        case .ready: return .ready
        case .confirmed: return .done
        case .printed, .sent: return .printed
        }
    }
}

public extension Project {
    var words: ObjectWords { ObjectWords(self) }
}
