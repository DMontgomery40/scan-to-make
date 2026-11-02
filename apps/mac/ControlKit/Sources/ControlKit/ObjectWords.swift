import Foundation

// The words for a project, PRD §4 ("Project states and the words shown for them"). This is the one
// place the Mac turns the companion's object into words; when `packages/CounterpartKit` lands on main
// it replaces this file and the Mac adopts its status words, so the phone and the Mac say the same thing.

/// What the user can do with a project on this Mac.
public enum ObjectAction: Sendable, Equatable {
    case print
    /// Print again after an uncertain print, once the user has checked the printer (`checked: true`).
    case printChecked
    case correct
    case bestGuess
    case plateClear
    /// Start the pass again after it failed without a model (`objects.start`).
    case retry
}

/// The states in PRD §4's table. The companion's own states map onto these; nothing is left out.
public enum ProjectStage: String, Sendable, Equatable, CaseIterable {
    case sending, working, needsYou, ready, preparing, printing, printed, failed
    /// A state from a newer companion than this app.
    case unknown

    /// The capsule's words: the state alone.
    public var label: String {
        switch self {
        case .sending: return "Sending to your Mac"
        case .working: return "Your Mac is working"
        case .needsYou: return "Needs you"
        case .ready: return "Ready to print"
        case .preparing: return "Getting the print ready"
        case .printing: return "Printing"
        case .printed: return "Printed"
        case .failed: return "Didn't work"
        case .unknown: return "Update Counterpart"
        }
    }
    /// Always paired with the words and a colour (PRD §2.7).
    public var symbol: String {
        switch self {
        case .sending: return "arrow.up.circle"
        case .working: return "wand.and.sparkles"
        case .needsYou: return "hand.raised.fill"
        case .ready: return "checkmark.seal.fill"
        case .preparing: return "gearshape"
        case .printing: return "printer.fill"
        case .printed: return "shippingbox.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .unknown: return "questionmark.circle"
        }
    }
}

/// The sidebar's sections (PRD §7.2), in order. Every stage belongs to exactly one.
public enum ProjectGroup: Int, Sendable, Equatable, CaseIterable, Comparable {
    case now, needsYou, ready, printed
    public var title: String {
        switch self {
        case .now: return "Now"
        case .needsYou: return "Needs you"
        case .ready: return "Ready"
        case .printed: return "Printed"
        }
    }
    public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

/// A project in plain words.
public struct ObjectWords: Sendable, Equatable {
    public let title: String
    public let stage: ProjectStage
    public let group: ProjectGroup
    /// The status line, for the sidebar row and the menu bar: "Ready to print · 48 × 50 × 54 mm".
    public let status: String
    /// The question, when the Mac needs something ("Needs a close-up of the underside").
    public let question: String?
    /// Working or printing: keep reading while it changes.
    public let busy: Bool
    /// "48 × 50 × 54 mm".
    public let size: String?
    /// Printing progress, 0…1, when the printer reports it.
    public let progress: Double?
    public let actions: [ObjectAction]

    public static func formatSize(_ size: [Double]) -> String {
        size.map { String(Int($0.rounded())) }.joined(separator: " × ") + " mm"
    }

    /// "38 min", "1 h 12 min".
    public static func formatMinutes(_ minutes: Double) -> String {
        let whole = max(0, Int(minutes.rounded()))
        return whole >= 60 ? "\(whole / 60) h \(whole % 60) min" : "\(whole) min"
    }

    /// The companion's generated title when it has one; else the first clause of the request (at most 60
    /// characters); else what was sent.
    public static func title(_ object: StmObject) -> String {
        if let title = object.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        let text = (object.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let first = text.cut(at: #"(?<=[.!?])\s|\n"#).replacingPattern(#"[.!?]+$"#, with: "")
        let line = first.pieces(at: #",\s*(?=[a-z])"#).prefix(2).joined(separator: ", ")
        if line.isEmpty {
            if object.scan != nil || !(object.capture ?? []).isEmpty { return "Copy of your scan" }
            return object.photos.isEmpty ? "New project" : "Project from your photos"
        }
        guard line.count > 60 else { return line }
        return String(line.prefix(57)).replacingPattern(#"\s+$"#, with: "") + "…"
    }

    /// The window's subtitle: the state, then what was asked for (PRD §7.2).
    public func subtitle(request: String?) -> String {
        let asked = (request ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .cut(at: #"(?<=[.!?])\s|\n"#).replacingPattern(#"[.!?]+$"#, with: "")
        let head: String
        switch stage {
        case .needsYou: head = question.map { "Needs you · \($0)" } ?? stage.label
        case .working, .printing, .failed: head = status
        default: head = stage.label
        }
        guard !asked.isEmpty, asked != title else { return head }
        let short = asked.count > 80 ? String(asked.prefix(79)) + "…" : asked
        return head + " · " + short.prefix(1).lowercased() + short.dropFirst()
    }

    public init(_ object: StmObject, now: Date = Date(), calendar: Calendar = .current) {
        title = Self.title(object)
        size = object.current?.sizeMm.flatMap { $0.count == 3 ? Self.formatSize($0) : nil }
        let printing: ObjectAction = object.print?.uncertain == true ? .printChecked : .print
        let made: [ObjectAction] = object.current == nil ? [] : [printing, .correct]
        var question: String?
        var progress: Double?
        var line = ""
        let stage: ProjectStage
        switch object.state {
        case .new:
            stage = .sending
            (line, busy, actions) = (stage.label, false, [])
        case .touchingUp:
            stage = .working
            let doing = object.progress?.trimmingCharacters(in: .whitespacesAndNewlines).replacingPattern(#"[.…]+$"#, with: "")
            var estimate: String?
            if let ends = object.passes.last?.estimate?.endsAtMs {
                let left = (ends / 1000 - now.timeIntervalSince1970) / 60
                if left > 0.5 { estimate = "about \(Int(left.rounded(.up))) min" }
            }
            let stageWords = object.passes.last?.stages?.last(where: { $0.endedAtMs == nil })?.words
            let parts = [stageWords ?? (doing?.isEmpty == false ? doing : nil), estimate].compactMap { $0 }
            line = parts.isEmpty ? stage.label : parts.joined(separator: " · ")
            (busy, actions) = (true, [])
        case .needsCloseup:
            stage = .needsYou
            let part = object.question?.closeup?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let ask = object.ask, ask.status == "open", !ask.question.isEmpty { question = ask.question }
            else { question = "Needs a close-up of \(part?.isEmpty == false ? part! : "the part it couldn't see")" }
            (line, busy, actions) = (question!, false, [.bestGuess])
        case .ready:
            stage = .ready
            line = size.map { "Ready to print · \($0)" } ?? stage.label
            (busy, actions) = (false, made)
        case .printing:
            busy = true
            let printer = object.print?.destination?.name
            if object.printConfirmation != nil {
                stage = .needsYou
                question = "\(printer ?? "Your printer") needs a yes before printing"
                (line, actions) = (question!, [])
            } else if object.plate?.noCamera == true {
                stage = .needsYou
                question = "Check the plate is clear"
                (line, actions) = (question!, [.plateClear])
            } else if let plate = object.plate {
                stage = .needsYou
                let item = plate.item?.trimmingCharacters(in: .whitespacesAndNewlines)
                question = "Something's on the plate" + (item?.isEmpty == false ? ": \(item!)" : "")
                (line, actions) = (question!, [.plateClear])
            } else if let live = object.print?.live, ["printing", "paused"].contains(live.state) {
                stage = .printing
                progress = live.job?.progress.map { min(1, max(0, $0 / 100)) }
                line = [live.state == "paused" ? "Paused on \(printer ?? "your printer")" : "Printing on \(printer ?? "your printer")",
                          live.job?.progress.map { "\(Int($0.rounded()))%" },
                          live.job?.remainingSec.map { Self.formatMinutes($0 / 60) + " left" }].compactMap { $0 }.joined(separator: " · ")
                actions = []
            } else if let report = object.print?.printerStatus, let percent = report.percent {
                stage = .printing
                progress = min(1, max(0, percent / 100))
                line = ["Printing on \(printer ?? "your printer")", "\(Int(percent.rounded()))%",
                          report.remainingMinutes.map { Self.formatMinutes($0) + " left" }].compactMap { $0 }.joined(separator: " · ")
                actions = []
            } else {
                stage = .preparing
                (line, actions) = (stage.label, [])
            }
        case .printed:
            let day = Date(timeIntervalSince1970: object.updatedAtMs / 1000)
            let when = calendar.isDate(day, inSameDayAs: now) ? "today"
                : calendar.isDate(day, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) ? "yesterday"
                : day.formatted(.dateTime.month(.abbreviated).day())
            // A companion without the print monitor sets `printed` when the printer accepts the job, not when it
            // finishes, and its printer status isn't tied to this job: say only that it was sent, never "Printed".
            let watched = object.status != nil || object.print?.monitor != nil
            if !watched {
                stage = .printed
                (line, busy, actions) = ("Sent to \(object.print?.destination?.name ?? "your printer") \(when)", false, made)
            } else {
                stage = .printed
                (line, busy, actions) = ("Printed \(when)", false, made)
            }
        case .failed:
            stage = .failed
            let failure = object.failure?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let what = failure.isEmpty ? "Something went wrong on your Mac" : failure.prefix(1).uppercased() + failure.dropFirst()
            line = what.replacingPattern(#"[.]+$"#, with: "") + (made.isEmpty ? " · Try again" : " · Print again or ask for changes")
            (busy, actions) = (false, made.isEmpty ? [.retry, .correct] : made)
        case .unknown:
            stage = .unknown
            (line, busy, actions) = ("Update Counterpart to see this one", false, [])
        }
        // The companion's own words win once it writes them (KAN-214 `status`): one sentence for every surface.
        if let served = object.status, let phase = Self.stage(phase: served.phase), !served.text.isEmpty {
            self.stage = phase
            line = served.text
        } else {
            self.stage = stage
        }
        status = line
        self.question = question
        self.progress = progress
        group = Self.group(self.stage)
    }

    /// The companion's `status.phase`; nil for one this app doesn't know, which keeps the app's own reading.
    public static func stage(phase: String) -> ProjectStage? {
        switch phase {
        case "sending": return .sending
        case "working": return .working
        case "needs-you": return .needsYou
        case "ready": return .ready
        case "preparing": return .preparing
        case "printing": return .printing
        case "printed": return .printed
        case "failed": return .failed
        default: return nil
        }
    }

    /// Which sidebar section a stage belongs to. Failures need the person, so they sit with Needs you.
    public static func group(_ stage: ProjectStage) -> ProjectGroup {
        switch stage {
        case .sending, .working, .preparing, .printing, .unknown: return .now
        case .needsYou, .failed: return .needsYou
        case .ready: return .ready
        case .printed: return .printed
        }
    }
}

public extension StmObject {
    var words: ObjectWords { ObjectWords(self) }
}

private extension String {
    /// Everything before the first match of `pattern`.
    func cut(at pattern: String) -> String {
        let regex = try! NSRegularExpression(pattern: pattern)
        guard let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)),
              let range = Range(match.range, in: self) else { return self }
        return String(self[..<range.lowerBound])
    }
    /// Split at each match of `pattern` (letters match either case).
    func pieces(at pattern: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: pattern, options: .caseInsensitive)
        var pieces: [String] = [], start = startIndex
        for match in regex.matches(in: self, range: NSRange(startIndex..., in: self)) {
            guard let range = Range(match.range, in: self) else { continue }
            pieces.append(String(self[start..<range.lowerBound])); start = range.upperBound
        }
        return pieces + [String(self[start...])]
    }
    func replacingPattern(_ pattern: String, with template: String) -> String {
        let regex = try! NSRegularExpression(pattern: pattern)
        return regex.stringByReplacingMatches(in: self, range: NSRange(startIndex..., in: self), withTemplate: template)
    }
}
