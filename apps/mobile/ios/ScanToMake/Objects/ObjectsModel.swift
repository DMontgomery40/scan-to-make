import Foundation

/// One thing scanned or asked for, as the Mac keeps it (`/v1/objects`). Unknown fields are ignored and an
/// unknown state from a newer Mac still decodes, so an update on one side never breaks the other.
struct StmObject: Codable, Identifiable, Equatable, Sendable {
    enum State: String, Codable, Sendable {
        case new, touchingUp = "touching-up", needsCloseup = "needs-closeup", ready, printing, printed, failed, unknown
        init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }
    struct Pass: Codable, Equatable, Sendable { var startedAtMs: Double; var endedAtMs: Double?; var note: String?; var status: String?; var summary: String? }
    struct Current: Codable, Equatable, Sendable {
        var model: String; var renders: [String]; var sizeMm: [Double]?; var summary: String?
        /// Dimensions the touch-up used and where each came from.
        var measurements: [Measurement]?
    }
    /// One dimension: `source` is caliper, ruler, scan or description (a newer Mac may send others).
    struct Measurement: Codable, Equatable, Sendable { var what: String; var mm: Double; var source: String }
    struct Question: Codable, Equatable, Sendable { var closeup: String? }
    struct Plate: Codable, Equatable, Sendable { var item: String?; var noCamera: Bool?; var photo: Bool? }
    struct Print: Codable, Equatable, Sendable { var bundleId: String; var uncertain: Bool? }

    var id: String
    var createdAtMs: Double
    var updatedAtMs: Double
    var instructions: String?
    var state: State
    var scan: String?
    var photos: [String]
    var passes: [Pass]
    var current: Current?
    var question: Question?
    var plate: Plate?
    var failure: String?
    var print: Print?
    /// "caliper" for the printable caliper the Mac ships.
    var kind: String?
}

/// What the object page and the list can offer for an object right now.
enum ObjectAction: Equatable, Sendable {
    case finishSending, scan, attachPhotos, makeIt, print, printChecked, correct, openCamera, bestGuess, plateClear, retry
}

/// An object in plain words. The copy matches the Mac app's `ObjectWords` and the spec's voice.
struct ObjectWords: Equatable, Sendable {
    enum Tone: Sendable { case pending, pass, fail, accent, neutral }
    let title: String
    let status: String
    /// Touching up or printing: the page keeps itself up to date.
    let busy: Bool
    let tone: Tone
    /// "W × D × H mm", whole millimetres (LiDAR isn't sub-millimetre).
    let size: String?
    let actions: [ObjectAction]

    static let wait = "This can take a few minutes. We'll let you know when it's ready."

    static func title(_ object: StmObject) -> String {
        let text = (object.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return object.scan == nil ? "Something new" : "Copy of your scan" }
        // The first sentence, without its full stop, cut at a word if it is long.
        var first = text.components(separatedBy: "\n")[0]
        if let end = first.range(of: #"[.!?](\s|$)"#, options: .regularExpression) { first = String(first[..<end.lowerBound]) }
        guard first.count > 44 else { return first }
        let cut = String(first.prefix(43))
        let word = cut.range(of: " ", options: .backwards).map { String(cut[..<$0.lowerBound]) } ?? cut
        return word.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// "62.3 mm across the top, read from the caliper". A ruler reading says it's an estimate.
    static func measurement(_ m: StmObject.Measurement) -> String {
        let value = m.mm.rounded() == m.mm ? String(Int(m.mm)) : String(format: "%.1f", m.mm)
        let what = m.what.trimmingCharacters(in: .whitespacesAndNewlines)
        let size = what.isEmpty ? "\(value) mm" : "\(value) mm \(what)"
        switch m.source {
        case "caliper": return "\(size), read from the caliper"
        case "ruler": return "About \(size), read from a ruler (an estimate)"
        case "scan": return "\(size), from the scan"
        case "description": return "\(size), from what you asked for"
        default: return size
        }
    }

    /// Caliper readings first: they're the most exact.
    static func measurements(_ object: StmObject) -> [String] {
        let rank = ["caliper": 0, "ruler": 1, "description": 2, "scan": 3]
        return (object.current?.measurements ?? []).enumerated()
            .sorted { (rank[$0.element.source] ?? 4, $0.offset) < (rank[$1.element.source] ?? 4, $1.offset) }
            .map { measurement($0.element) }
    }

    static func formatSize(_ size: [Double]) -> String? {
        guard size.count == 3 else { return nil }
        return size.map { String(Int($0.rounded())) }.joined(separator: " × ") + " mm"
    }

    /// What reached the Mac, in a few words.
    static func sent(_ object: StmObject) -> String {
        let photos = object.photos.count
        let photoWords = photos == 1 ? "1 photo" : "\(photos) photos"
        switch (object.scan != nil, photos) {
        case (true, 0): return "A scan"
        case (true, _): return "A scan and \(photoWords)"
        case (false, 0): return "Just the description"
        case (false, _): return photoWords.prefix(1).uppercased() + photoWords.dropFirst()
        }
    }

    init(_ object: StmObject) {
        title = Self.title(object)
        size = object.current?.sizeMm.flatMap(Self.formatSize)
        let made: [ObjectAction] = object.current == nil ? [] : [object.print?.uncertain == true ? .printChecked : .print, .correct]
        switch object.state {
        case .new:
            if object.scan != nil || !object.photos.isEmpty {
                (status, tone, busy, actions) = ("Sending to your Mac…", .pending, true, [.finishSending])
            } else {
                let described = !(object.instructions ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                (status, tone, busy, actions) = ("Waiting for a scan or photos.", .neutral, false,
                                                 described ? [.scan, .attachPhotos, .makeIt] : [.scan, .attachPhotos])
            }
        case .touchingUp:
            let what = object.passes.count > 1 && object.current != nil ? "Making your changes."
                : object.scan != nil ? "Touching up your scan." : "Making it."
            (status, tone, busy, actions) = ("\(what) \(Self.wait)", .pending, true, [])
        case .needsCloseup:
            let part = (object.question?.closeup ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            (status, tone, busy, actions) = ("Can you send me a close-up of \(part.isEmpty ? "the part I missed" : part)? I can't see what's happening there.",
                                             .accent, false, [.openCamera, .attachPhotos, .bestGuess])
        case .ready:
            (status, tone, busy, actions) = ("Ready to print", .pass, false, made)
        case .printing:
            if object.plate?.noCamera == true {
                (status, tone, busy, actions) = ("Check the plate is clear.", .accent, true, [.plateClear])
            } else if let plate = object.plate {
                let item = (plate.item ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                (status, tone, busy, actions) = ("Looks like there's \(item.isEmpty ? "something" : item) on your plate. Can you take it off first?",
                                                 .accent, true, [.plateClear])
            } else {
                (status, tone, busy, actions) = ("Printing", .pending, true, [])
            }
        case .printed:
            (status, tone, busy, actions) = ("Printed", .pass, false, made)
        case .failed:
            let failure = (object.failure ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            (status, tone, busy, actions) = (failure.isEmpty ? "Something went wrong on your Mac." : failure, .fail, false,
                                             made.isEmpty ? [.retry] : made)
        case .unknown:
            (status, tone, busy, actions) = ("Update Counterpart to see this one.", .neutral, false, [])
        }
    }
}
