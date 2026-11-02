import Foundation

/// What the user can do with an object on this Mac. Close-up photos come from the iPhone in v1.
public enum ObjectAction: Sendable, Equatable {
    case print
    /// Print again after an uncertain print, once the user has checked the printer (`checked: true`).
    case printChecked
    case correct
    case bestGuess
    case plateClear
    /// Start the touch-up again after it failed without a model (`objects.start`).
    case retry
}

/// An object in plain words, the same as the phone's `describeObject` (apps/mobile/src/objects/model.ts).
public struct ObjectWords: Sendable, Equatable {
    public enum Tone: Sendable, Equatable { case pending, pass, fail, accent, neutral }
    public let title: String
    /// The whole sentence, for the object page.
    public let status: String
    /// The first sentence, for a card in the list.
    public let headline: String
    public let tone: Tone
    /// Touching up or printing: the page keeps itself up to date.
    public let busy: Bool
    /// "W × D × H mm, ready to print", in whole millimetres.
    public let size: String?
    public let actions: [ObjectAction]

    static let wait = "You can leave this project and return to it while your Mac works."

    public static func formatSize(_ size: [Double]) -> String {
        size.map { String(Int($0.rounded())) }.joined(separator: " × ") + " mm"
    }

    /// The first sentence of the instructions, at most two clauses and 60 characters;
    /// else "Copy of your scan" for a scan, or "Something new".
    public static func title(_ object: StmObject) -> String {
        let text = (object.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let first = text.cut(at: #"(?<=[.!?])\s|\n"#).replacingPattern(#"[.!?]+$"#, with: "")
        let line = first.pieces(at: #",\s*(?=[a-z])"#).prefix(2).joined(separator: ", ")
        if line.isEmpty {
            if object.scan != nil || !(object.capture ?? []).isEmpty { return "Copy of your scan" }
            return object.photos.isEmpty ? "Unfinished project" : "Photo project"
        }
        guard line.count > 60 else { return line }
        return String(line.prefix(57)).replacingPattern(#"\s+$"#, with: "") + "…"
    }

    init(_ object: StmObject) {
        title = Self.title(object)
        size = object.current?.sizeMm.flatMap { $0.count == 3 ? Self.formatSize($0) + ", ready to print" : nil }
        let printing: ObjectAction = object.print?.uncertain == true ? .printChecked : .print
        let made: [ObjectAction] = object.current == nil ? [] : [printing, .correct]
        var headline: String?
        switch object.state {
        case .new:
            // Nothing has arrived from the phone yet, or it is on its way.
            (status, tone, busy, actions) = ("Draft saved. Continue on your iPhone.", .neutral, false, [])
        case .touchingUp:
            let what = object.progress ?? (object.passes.count > 1 && object.current != nil ? "Making your changes."
                : object.scan != nil ? "Touching up your scan." : "Making it.")
            (status, tone, busy, actions) = ("\(what) \(Self.wait)", .pending, true, [])
        case .needsCloseup:
            let part = object.question?.closeup?.trimmingCharacters(in: .whitespacesAndNewlines)
            let closeup = part?.isEmpty == false ? part! : "the part I missed"
            status = "Can you send me a close-up of \(closeup)? I can't see what's happening there."
            headline = "Need a close-up of \(closeup)"
            (tone, busy, actions) = (.accent, false, [.bestGuess])
        case .ready:
            (status, tone, busy, actions) = ("Ready to print", .pass, false, made)
        case .printing:
            if object.printConfirmation != nil {
                (status, tone, actions) = ("Waiting for your print confirmation.", .accent, [])
            } else {
                (status, tone, actions) = (object.progress ?? "Preparing print…", .pending, [])
            }
            busy = true
        case .printed:
            (status, tone, busy, actions) = ("Print request accepted", .pass, false, made)
        case .failed:
            let failure = object.failure?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            (status, tone, busy, actions) = (failure.isEmpty ? "Something went wrong on your Mac." : failure, .fail, false, made.isEmpty ? [.retry, .correct] : made)
        case .unknown:
            (status, tone, busy, actions) = ("Update Counterpart to see this one.", .neutral, false, [])
        }
        self.headline = headline ?? status.cut(at: #"(?<=[.!?])\s"#)
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
