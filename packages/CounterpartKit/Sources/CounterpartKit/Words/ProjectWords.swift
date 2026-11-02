import Foundation

/// The PRD §4 project states, as the screens show them. Derived from the Mac's own state plus what the
/// phone knows (an upload still running is "sending").
public enum ProjectPhase: String, Equatable, Sendable, CaseIterable {
    /// Nothing sent yet: waiting for a scan, photos or a description to be sent.
    case draft
    case sending, working, needsYou = "needs-you", ready, preparing, printing, printed, failed
    /// A state from a newer Mac.
    case unknown

    public var symbol: String {
        switch self {
        case .draft: "square.and.pencil"
        case .sending: "arrow.up.circle"
        case .working: "wand.and.sparkles"
        case .needsYou: "hand.raised.fill"
        case .ready: "checkmark.seal.fill"
        case .preparing: "gearshape"
        case .printing: "printer.fill"
        case .printed: "shippingbox.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .unknown: "questionmark.circle"
        }
    }

    public var tone: Tone {
        switch self {
        case .sending, .working: .working
        case .needsYou: .needsYou
        case .ready, .preparing: .accent
        case .printing: .printing
        case .printed, .draft, .unknown: .secondary
        case .failed: .failed
        }
    }

    /// The short words on a status capsule.
    public var label: String {
        switch self {
        case .draft: "Not sent yet"
        case .sending: "Sending to your Mac"
        case .working: "Your Mac is working"
        case .needsYou: "Needs you"
        case .ready: "Ready to print"
        case .preparing: "Getting the print ready"
        case .printing: "Printing"
        case .printed: "Printed"
        case .failed: "Didn't finish"
        case .unknown: "Update Counterpart"
        }
    }

    /// Something is running: the page keeps itself up to date.
    public var isRunning: Bool { [.sending, .working, .preparing, .printing].contains(self) }
}

/// Status colours are fixed (PRD §10) and always paired with a symbol and words.
public enum Tone: String, Equatable, Sendable {
    case working, needsYou, accent, printing, secondary, failed
}

/// What a project page or card can offer right now.
public enum ProjectAction: Equatable, Sendable {
    case finishSending, scan, attachPhotos, makeIt, print, printChecked, correct, openCamera, bestGuess, plateClear, retry
}

/// A project in plain words: the one source of status words for the phone, iPad and (later) the Mac,
/// the Lock Screen and the menu bar. Copy follows PRD §4 and journey.md §9.
public struct ProjectWords: Equatable, Sendable {
    public let title: String
    public let phase: ProjectPhase
    /// The whole sentence, for the project page.
    public let status: String
    /// One line for a card: "Ready to print · 48 × 50 × 54 mm", "Printing on P1S · 42% · 38 min left".
    public let line: String
    /// Touching up or printing: the page keeps itself up to date.
    public let busy: Bool
    /// "W × D × H mm", whole millimetres.
    public let size: String?
    public let actions: [ProjectAction]

    public static let wait = "You can leave this project and return to it while your Mac works."
    public static let putDown = "You can put your phone down. We'll let you know when it's ready."

    /// The generated title when the Mac gives one; else the first sentence of the request, cut at a word.
    public static func title(_ project: Project) -> String {
        if let title = project.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        let text = (project.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            if project.hasScan { return "Copy of your scan" }
            return project.photos.isEmpty ? "Unfinished project" : "Photo project"
        }
        var first = text.components(separatedBy: "\n")[0]
        if let end = first.range(of: #"[.!?](\s|$)"#, options: .regularExpression) { first = String(first[..<end.lowerBound]) }
        guard first.count > 44 else { return first }
        let cut = String(first.prefix(43))
        let word = cut.range(of: " ", options: .backwards).map { String(cut[..<$0.lowerBound]) } ?? cut
        return word.trimmingCharacters(in: .whitespaces) + "…"
    }

    public static func formatSize(_ size: [Double]) -> String? { Format.size(size) }

    /// What reached the Mac, in a few words.
    public static func sent(_ project: Project) -> String {
        let photos = project.photos.count
        let photoWords = photos == 1 ? "1 photo" : "\(photos) photos"
        switch (project.hasScan, photos) {
        case (true, 0): return "A scan"
        case (true, _): return "A scan and \(photoWords)"
        case (false, 0): return "Just the description"
        case (false, _): return photoWords.prefix(1).uppercased() + photoWords.dropFirst()
        }
    }

    /// The phase, from the Mac's state plus whether this phone is still sending files.
    public static func phase(_ project: Project, sending: Bool = false) -> ProjectPhase {
        // The Mac's own phase wins when it gives one (KAN-214 PR 3).
        if let phase = project.status?.phase, let known = ProjectPhase(rawValue: phase), !(project.state == .new && !sending) { return known }
        switch project.state {
        case .new:
            // Only while this phone is actually uploading; a send cut short is a draft to finish.
            return sending ? .sending : .draft
        case .touchingUp: return .working
        case .needsCloseup: return .needsYou
        case .ready: return .ready
        case .printing:
            // Printing only once the printer reports our job; until then the print is being prepared.
            if project.print?.monitor?.phase == "watching" || (project.print?.printId != nil && ["printing", "paused"].contains(project.print?.live?.state ?? "")) { return .printing }
            return .preparing
        case .printed: return .printed
        case .failed: return .failed
        case .unknown: return .unknown
        }
    }

    /// The Mac's question, in its own words when it asked one.
    public static func question(_ project: Project) -> String {
        if let ask = project.openAsk?.question.trimmingCharacters(in: .whitespacesAndNewlines), !ask.isEmpty { return ask }
        let part = (project.question?.closeup ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return "Can you send me a close-up of \(part.isEmpty ? "the part I missed" : part)? I can't see what's happening there."
    }

    public init(_ project: Project, sending: Bool = false, printerName: String? = nil, now: Date = Date()) {
        title = Self.title(project)
        size = project.current?.sizeMm.flatMap(Format.size)
        phase = Self.phase(project, sending: sending)
        let made: [ProjectAction] = project.current == nil ? [] : [project.print?.uncertain == true ? .printChecked : .print, .correct]
        var line: String
        switch project.state {
        case .new:
            if sending {
                (status, busy, actions) = ("Sending to your Mac. Keep the app open until it finishes.", true, [])
            } else if project.hasScan || !project.photos.isEmpty {
                (status, busy, actions) = ("Draft saved. Finish sending to begin.", false, [.finishSending])
            } else {
                let described = !(project.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                (status, busy, actions) = ("Waiting for a scan or photos.", false, described ? [.scan, .attachPhotos, .makeIt] : [.scan, .attachPhotos])
            }
            line = phase.label
        case .touchingUp where !(project.progress ?? "").trimmingCharacters(in: .whitespaces).isEmpty:
            (status, busy, actions) = ("\(project.progress!) \(Self.wait)", true, [])
            line = Self.workingLine(project, fallback: project.progress!)
        case .touchingUp:
            let what = project.passes.count > 1 && project.current != nil ? "Making your changes."
                : project.scan != nil ? "Touching up your scan." : "Making it."
            (status, busy, actions) = ("\(what) \(Self.wait)", true, [])
            line = Self.workingLine(project, fallback: String(what.dropLast()))
        case .needsCloseup:
            (status, busy, actions) = (Self.question(project), false, [.openCamera, .attachPhotos, .bestGuess])
            line = "Needs you · " + (project.openAsk?.question ?? project.question?.closeup.map { "a close-up of \($0)" } ?? "a close-up")
        case .ready:
            (status, busy, actions) = ("Ready to print", false, made)
            line = ["Ready to print", size].compactMap { $0 }.joined(separator: " · ")
        case .printing:
            if project.printConfirmation != nil {
                (status, busy, actions) = ("Your printer needs your confirmation.", true, [])
                line = "Your printer needs a yes"
            } else if phase == .printing {
                let printer = printerName ?? project.print?.destination?.name ?? "your printer"
                let live = project.print?.live
                let parts = ["Printing on \(printer)", Format.percent(live?.job?.progress), Format.duration(live?.job?.remainingSec).map { "\($0) left" }]
                line = parts.compactMap { $0 }.joined(separator: " · ")
                if live?.state == "paused" { line = "Paused on \(printer)" }
                if project.print?.monitor?.unreachableSince != nil { line = "Lost contact with \(printer). Still trying." }
                (status, busy, actions) = (line, true, [])
            } else {
                (status, busy, actions) = (project.progress ?? "Preparing print…", true, [])
                line = project.progress ?? "Getting the print ready"
            }
        case .printed:
            // A print request accepted isn't a print finished; only the print monitor says it finished.
            let finished = project.print?.monitor?.endState == "done"
            let endedAt = project.print?.monitor?.endedAt.flatMap(ISO.date) ?? project.updatedAt
            (status, busy, actions) = (finished ? "Printed" : "Print request accepted", false, made)
            line = finished ? "Printed " + Format.when(endedAt, now: now).replacingOccurrences(of: "Now", with: "just now")
                : "Sent to " + (project.print?.destination?.name ?? "your printer")
        case .failed:
            let failure = (project.failure ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            (status, busy, actions) = (failure.isEmpty ? "Something went wrong on your Mac." : failure, false, made.isEmpty ? [.retry, .correct] : made)
            line = failure.isEmpty ? "Didn't finish · try again" : (failure.components(separatedBy: ". ").first ?? failure)
        case .unknown:
            (status, busy, actions) = ("Update Counterpart to see this one.", false, [])
            line = "Update Counterpart to see this one"
        }
        // The Mac's own words win when it writes them (KAN-214 PR 3), except while this phone is still sending.
        if let text = project.status?.text, !text.isEmpty, !(project.state == .new) { self.line = text } else { self.line = line }
    }

    /// "Designing it · about 4 min", from the running stage and its estimate when the Mac gives them.
    static func workingLine(_ project: Project, fallback: String, now: Date = Date()) -> String {
        guard let pass = project.runningPass else { return fallback }
        let stage = pass.currentStage?.words ?? fallback
        guard let estimate = pass.estimate else { return stage }
        let left = estimate.endsAtMs / 1000 - now.timeIntervalSince1970
        return [stage, Format.about(max(60, left))].compactMap { $0 }.joined(separator: " · ")
    }
}

/// How far a running pass is, when the Mac reports stages. Nil fields mean the Mac doesn't say yet.
public struct WorkProgress: Equatable, Sendable {
    public var stage: String?
    /// 1-based index of the running stage, and how many there are.
    public var step: Int?
    public var steps: Int?
    public var fraction: Double?
    public var remainingSec: Double?

    public init(_ project: Project, now: Date = Date()) {
        guard let pass = project.runningPass else { return }
        if let stages = pass.stages, !stages.isEmpty {
            let running = stages.lastIndex { $0.endedAtMs == nil }
            let index = running ?? stages.count - 1
            stage = stages[index].words; step = index + 1
            // The Mac's stages are building (in-hand scans only), preparing, working and saving; they arrive as they start.
            let expected = stages.contains { $0.id == "building" } || !(project.capture ?? []).isEmpty ? 4 : 3
            steps = max(expected, stages.count)
            // Stages arrive as they start; the typical durations say how much of the work they cover.
            let total = stages.reduce(0) { $0 + ($1.typicalSec ?? 0) }
            if total > 0 {
                let done = stages.reduce(0.0) { sum, s in
                    let ended = s.endedAtMs.map { ($0 - s.startedAtMs) / 1000 } ?? min(s.typicalSec ?? 0, (now.timeIntervalSince1970 * 1000 - s.startedAtMs) / 1000)
                    return sum + min(ended, s.typicalSec ?? ended)
                }
                fraction = min(0.98, done / total)
            }
        }
        if let estimate = pass.estimate {
            remainingSec = max(0, estimate.endsAtMs / 1000 - now.timeIntervalSince1970)
            let elapsed = now.timeIntervalSince1970 - pass.startedAtMs / 1000
            if elapsed + (remainingSec ?? 0) > 0 { fraction = min(0.98, max(fraction ?? 0, elapsed / (elapsed + (remainingSec ?? 0)))) }
        }
    }
}
