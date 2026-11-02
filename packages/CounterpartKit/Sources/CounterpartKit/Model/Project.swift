import Foundation

/// One thing you want made (PRD §4), as the Mac keeps it at `/v1/objects` (docs/protocols/objects-api.md).
/// Wire names are the companion's. Unknown fields are ignored and unknown enum values decode as unknown,
/// so an update on one side never breaks the other. Fields the companion doesn't serve yet are optional
/// and the screens show an honest fallback without them (PRD §2.6).
public struct Project: Codable, Identifiable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        /// `sent`: the printer took the job but Counterpart can't follow it (no job id, or Bambu Connect). Terminal.
        case new, touchingUp = "touching-up", needsCloseup = "needs-closeup", ready, printing, printed, sent, failed, unknown
        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    public var id: String
    public var createdAtMs: Double
    public var updatedAtMs: Double
    /// Your request, as you wrote it.
    public var instructions: String?
    public var state: State
    /// The walk-around scan's file name, under scan/.
    public var scan: String?
    /// Photos you added, in upload order.
    public var photos: [String]
    /// An in-hand scan's photos, rebuilt into the scan on the Mac.
    public var capture: [String]?
    /// Depth files that go with `capture`, kept apart from the viewable images.
    public var captureDepth: [String]?
    /// What the Mac is doing right now, in words, while that takes longer than a moment.
    public var progress: String?
    public var passes: [Pass]
    /// The current result.
    public var current: Result?
    /// The older close-up question: which part the Mac couldn't see. Still set beside `ask`.
    public var question: Question?
    public var plate: Plate?
    public var failure: String?
    public var print: Print?
    public var printerDestinationId: String?
    public var printConfirmation: PrintConfirmation?
    /// The PRD §4 state line, written by the companion (KAN-214 PR 3). Show `text` as is.
    public var status: Status?
    /// A short generated title ("Mic mount"), PR 4.
    public var title: String?
    /// `fit` (make something that fits) or `copy`, PR 4.
    public var kind: String?
    /// A structured question from the Mac, PR 4.
    public var ask: Ask?
    /// The project's folder on the Mac. Only the Mac's control socket (`objects.list`) sends it; absent on `/v1/objects`.
    public var directory: String?

    public init(id: String, createdAtMs: Double, updatedAtMs: Double, instructions: String? = nil, state: State, scan: String? = nil,
                photos: [String] = [], capture: [String]? = nil, progress: String? = nil, passes: [Pass] = [], current: Result? = nil,
                question: Question? = nil, plate: Plate? = nil, failure: String? = nil, print: Print? = nil,
                printerDestinationId: String? = nil, printConfirmation: PrintConfirmation? = nil,
                status: Status? = nil, title: String? = nil, kind: String? = nil, ask: Ask? = nil, directory: String? = nil) {
        self.id = id; self.createdAtMs = createdAtMs; self.updatedAtMs = updatedAtMs; self.instructions = instructions
        self.state = state; self.scan = scan; self.photos = photos; self.capture = capture; self.progress = progress
        self.passes = passes; self.current = current; self.question = question; self.plate = plate; self.failure = failure
        self.print = print; self.printerDestinationId = printerDestinationId; self.printConfirmation = printConfirmation
        self.status = status; self.title = title; self.kind = kind; self.ask = ask; self.directory = directory
    }

    public var createdAt: Date { Date(timeIntervalSince1970: createdAtMs / 1000) }
    public var updatedAt: Date { Date(timeIntervalSince1970: updatedAtMs / 1000) }

    /// A scan (walk-around or in hand) reached the Mac.
    public var hasScan: Bool { scan != nil || !(capture ?? []).isEmpty }

    /// Progress updates do not change saved media. A finished pass can replace the model and renders at the
    /// same paths, so their cached copies expire only when a pass finishes.
    public var mediaVersion: Double { passes.last(where: { $0.endedAtMs != nil })?.endedAtMs ?? createdAtMs }

    /// The pass in progress, if the Mac is working.
    public var runningPass: Pass? { state == .touchingUp ? passes.last(where: { $0.endedAtMs == nil }) : nil }

    /// The open question, structured (PR 4) or the older close-up question.
    public var openAsk: Ask? { ask.flatMap { $0.status == "answered" ? nil : $0 } }

    // MARK: Nested types

    /// The companion's state line (`ObjectStatus`).
    public struct Status: Codable, Equatable, Sendable {
        /// sending, working, needs-you, ready, preparing, printing, printed, sent, failed
        public var phase: String
        public var text: String
        public var symbol: String
        /// blue, orange, accent, green, secondary, red
        public var tint: String
        public init(phase: String, text: String, symbol: String, tint: String) { self.phase = phase; self.text = text; self.symbol = symbol; self.tint = tint }
        /// A status missing its symbol or tint still shows its words.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            phase = try c.decode(String.self, forKey: .phase); text = try c.decode(String.self, forKey: .text)
            symbol = try c.decodeIfPresent(String.self, forKey: .symbol) ?? ""; tint = try c.decodeIfPresent(String.self, forKey: .tint) ?? "secondary"
        }
    }

    /// One worker message or tool line from a pass.
    public struct Activity: Codable, Equatable, Sendable {
        public var atMs: Double; public var kind: String; public var text: String
        public init(atMs: Double, kind: String, text: String) { self.atMs = atMs; self.kind = kind; self.text = text }
    }

    /// One stage of a pass, with its times (PRD §4 Pass).
    public struct Stage: Codable, Equatable, Sendable {
        /// building, preparing, working, saving
        public var id: String
        /// "Building the model from your photos", "Getting Blender ready", "Designing it", "Saving the result".
        public var words: String
        public var startedAtMs: Double
        public var endedAtMs: Double?
        /// The median of this stage's recent real durations on this Mac.
        public var typicalSec: Double?
        public init(id: String, words: String, startedAtMs: Double, endedAtMs: Double? = nil, typicalSec: Double? = nil) {
            self.id = id; self.words = words; self.startedAtMs = startedAtMs; self.endedAtMs = endedAtMs; self.typicalSec = typicalSec
        }
    }

    public struct Estimate: Codable, Equatable, Sendable {
        public var remainingSec: Double
        public var endsAtMs: Double
        public init(remainingSec: Double, endsAtMs: Double) { self.remainingSec = remainingSec; self.endsAtMs = endsAtMs }
    }

    /// One item of "what changed".
    public struct Change: Codable, Equatable, Sendable {
        /// added, changed, assumed, estimated
        public var tag: String
        public var text: String
        public var toleranceMm: Double?
        public init(tag: String, text: String, toleranceMm: Double? = nil) { self.tag = tag; self.text = text; self.toleranceMm = toleranceMm }
    }

    /// One round of work on the Mac.
    public struct Pass: Codable, Equatable, Sendable {
        public var startedAtMs: Double
        public var endedAtMs: Double?
        /// Your follow-up that started it, if any.
        public var note: String?
        public var status: String?
        public var summary: String?
        public var activity: [Activity]?
        public var activityCount: Int?
        public var seconds: Double?
        /// new, changes, late-photos, ask-answer (PR 4)
        public var trigger: String?
        public var stages: [Stage]?
        /// While the pass runs (PR 4).
        public var estimate: Estimate?
        public var engine: String?

        public init(startedAtMs: Double, endedAtMs: Double? = nil, note: String? = nil, status: String? = nil, summary: String? = nil,
                    activity: [Activity]? = nil, activityCount: Int? = nil, trigger: String? = nil, stages: [Stage]? = nil, estimate: Estimate? = nil) {
            self.startedAtMs = startedAtMs; self.endedAtMs = endedAtMs; self.note = note; self.status = status; self.summary = summary
            self.activity = activity; self.activityCount = activityCount; self.trigger = trigger; self.stages = stages; self.estimate = estimate
        }

        public var count: Int { activityCount ?? activity?.count ?? 0 }
        public var failed: Bool { ["failed", "interrupted"].contains(status ?? "") }
        /// The stage running now: the last one started and not ended.
        public var currentStage: Stage? { stages?.last { $0.endedAtMs == nil } }
    }

    /// A model version.
    public struct Result: Codable, Equatable, Sendable {
        public var model: String
        public var renders: [String]
        /// Width × depth × height in millimetres.
        public var sizeMm: [Double]?
        /// The Mac's own account, in markdown, from passes before structured "what changed".
        public var summary: String?
        /// What changed (PR 4).
        public var changes: [Change]?
        /// blender or fusion
        public var engine: String?
        public init(model: String, renders: [String], sizeMm: [Double]? = nil, summary: String? = nil, changes: [Change]? = nil) {
            self.model = model; self.renders = renders; self.sizeMm = sizeMm; self.summary = summary; self.changes = changes
        }
    }

    public struct Question: Codable, Equatable, Sendable {
        public var closeup: String?
        public init(closeup: String?) { self.closeup = closeup }
    }

    /// A region of a picture, as fractions of its width and height (origin top-left).
    public struct Region: Codable, Equatable, Sendable {
        public var x: Double; public var y: Double; public var width: Double; public var height: Double
        public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
    }

    /// A structured question from the Mac (PRD §4 Ask).
    public struct Ask: Codable, Equatable, Sendable {
        public var id: String
        public var question: String
        /// `asks/<id>.jpg`, served at `GET /v1/objects/<id>/asks/<askId>.jpg`.
        public var photo: String?
        public var region: Region?
        /// camera, photos, best-guess, text
        public var answers: [String]
        /// open, answered
        public var status: String
        public var askedAtMs: Double?
        public init(id: String, question: String, photo: String? = nil, region: Region? = nil, answers: [String], status: String = "open", askedAtMs: Double? = nil) {
            self.id = id; self.question = question; self.photo = photo; self.region = region; self.answers = answers; self.status = status; self.askedAtMs = askedAtMs
        }
    }

    /// What the printer camera reported on the plate, shown beside the printer's own confirmation. Never a
    /// prompt to clear it (main ac44431).
    public struct Plate: Codable, Equatable, Sendable {
        public var item: String?
        public var noCamera: Bool?
        public var photo: Bool?
        public init(item: String? = nil, noCamera: Bool? = nil, photo: Bool? = nil) {
            self.item = item; self.noCamera = noCamera; self.photo = photo
        }
    }

    public struct PrintDestination: Codable, Equatable, Sendable {
        public var id: String; public var name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }
    /// The older status the companion read while a print page was open; from PR 2 derived from `live`.
    public struct PrinterStatus: Codable, Equatable, Sendable {
        public var state: String; public var job: String?; public var checkedAtMs: Double; public var percent: Double?; public var remainingMinutes: Double?
    }
    public struct PrintEstimate: Codable, Equatable, Sendable {
        public var seconds: Double?; public var grams: Double?
        public init(seconds: Double? = nil, grams: Double? = nil) { self.seconds = seconds; self.grams = grams }
    }
    public struct PrintEvent: Codable, Equatable, Sendable { public var atMs: Double; public var message: String }

    /// The print monitor's record of a print (PRD §8.6).
    public struct PrintMonitor: Codable, Equatable, Sendable {
        /// starting, watching, ended
        public var phase: String
        public var startedAt: String?
        public var lastReportAt: String?
        public var milestonesSent: [Int]?
        public var firstLayerSent: Bool?
        /// Set while the printer can't be reached. Never a failure by itself.
        public var unreachableSince: String?
        /// done, failed, cancelled, not-started, replaced, sent
        public var endState: String?
        public var endedAt: String?
        public init(phase: String, endState: String? = nil, endedAt: String? = nil, unreachableSince: String? = nil) {
            self.phase = phase; self.endState = endState; self.endedAt = endedAt; self.unreachableSince = unreachableSince
        }
    }

    /// The last print.
    public struct Print: Codable, Equatable, Sendable {
        public var bundleId: String
        /// It may have reached the printer and must not be sent again by itself.
        public var uncertain: Bool?
        public var destination: PrintDestination?
        public var printerStatus: PrinterStatus?
        public var sliced: Bool?
        public var estimate: PrintEstimate?
        public var events: [PrintEvent]?
        // PR 2
        public var printId: String?
        public var destinationId: String?
        public var dispatchedAt: String?
        public var jobName: String?
        public var taskId: String?
        public var settings: PrintSettings?
        public var live: PrintLive?
        public var monitor: PrintMonitor?
        /// Set when the dispatch returned no job identity: the name a job is adopted by.
        public var fileBase: String?
        /// "bambu-connect" when the print was handed to Bambu Connect on the Mac.
        public var sentVia: String?

        public init(bundleId: String, uncertain: Bool? = nil, destination: PrintDestination? = nil, sliced: Bool? = nil,
                    estimate: PrintEstimate? = nil, printId: String? = nil, live: PrintLive? = nil, monitor: PrintMonitor? = nil) {
            self.bundleId = bundleId; self.uncertain = uncertain; self.destination = destination; self.sliced = sliced
            self.estimate = estimate; self.printId = printId; self.live = live; self.monitor = monitor
        }
    }

    /// The printer MCP's own question before printing. Only an explicit answer to this id approves it.
    public struct PrintConfirmation: Codable, Equatable, Sendable {
        public struct Field: Codable, Equatable, Sendable {
            public var name: String; public var title: String; public var description: String?; public var required: Bool
            public init(name: String, title: String, description: String? = nil, required: Bool) {
                self.name = name; self.title = title; self.description = description; self.required = required
            }
        }
        public var id: String
        public var message: String
        public var expiresAtMs: Double
        public var fields: [Field]
        public var supported: Bool
        public init(id: String, message: String, expiresAtMs: Double, fields: [Field], supported: Bool) {
            self.id = id; self.message = message; self.expiresAtMs = expiresAtMs; self.fields = fields; self.supported = supported
        }

        public func canAccept(_ content: [String: Bool], atMs: Double) -> Bool {
            supported && expiresAtMs > atMs && fields.allSatisfy { !$0.required || content[$0.name] == true }
        }

        /// An answer belongs to exactly one live question. Checks never carry over to its replacement.
        public func response(confirmationId: String, action: PrintConfirmationResponse.Action, content: [String: Bool], atMs: Double) -> PrintConfirmationResponse? {
            guard confirmationId == id, expiresAtMs > atMs else { return nil }
            if action == .accept && !canAccept(content, atMs: atMs) { return nil }
            var checked: [String: Bool] = [:]
            for field in fields { checked[field.name] = content[field.name] ?? false }
            return .init(confirmationId: id, answer: .init(action: action, content: action == .accept ? checked : nil))
        }
    }
}

public struct PrintConfirmationResponse: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case accept, decline, cancel }
    public struct Answer: Codable, Equatable, Sendable { public var action: Action; public var content: [String: Bool]? }
    public var confirmationId: String
    public var answer: Answer
}

/// The latest normalized printer report for a print (`PrintLive`, PRD §8.4).
public struct PrintLive: Codable, Equatable, Sendable {
    public struct Job: Codable, Equatable, Sendable {
        public var name: String
        public var id: String?
        public var progress: Double?
        public var elapsedSec: Double?
        public var remainingSec: Double?
        public var layer: Int?
        public var totalLayers: Int?
        public var stage: String?
        public init(name: String, progress: Double? = nil, remainingSec: Double? = nil, layer: Int? = nil, totalLayers: Int? = nil, stage: String? = nil) {
            self.name = name; self.progress = progress; self.remainingSec = remainingSec; self.layer = layer; self.totalLayers = totalLayers; self.stage = stage
        }
    }
    public struct Temperature: Codable, Equatable, Sendable { public var actual: Double; public var target: Double }
    public struct Temps: Codable, Equatable, Sendable { public var nozzle: Temperature?; public var bed: Temperature?; public var chamber: Double? }
    public struct Filament: Codable, Equatable, Sendable { public var slot: String?; public var material: String?; public var color: String? }
    public struct Problem: Codable, Equatable, Sendable {
        public var code: String; public var severity: String; public var message: String; public var url: String?
    }
    /// counterpart, status-fallback
    public var source: String?
    public var observedAt: String?
    /// idle, preparing, printing, paused, finished, failed, cancelled, offline, busy
    public var state: String
    public var job: Job?
    public var endsAt: String?
    public var temps: Temps?
    public var activeFilament: Filament?
    public var problems: [Problem]?

    public init(state: String, job: Job? = nil, observedAt: String? = nil, endsAt: String? = nil) {
        self.state = state; self.job = job; self.observedAt = observedAt; self.endsAt = endsAt
    }

    public var endsAtDate: Date? { endsAt.flatMap(ISO.date) }
    public var observedAtDate: Date? { observedAt.flatMap(ISO.date) }
}

/// The settings a print was sent with, or will be (`PrintSettingsSchema`): the `objects.print` params the
/// phone and the Mac both build. Encodes `quality`, `strength` and `colour` only, each only when set, so
/// standard settings send nothing (the MCP's preset decides).
public struct PrintSettings: Codable, Equatable, Sendable {
    public var quality: String?
    public var strength: String?
    /// `{auto: true}`, `{amsSlot: n}`, `{external: true}` or `{material: "PETG"}`.
    public var colour: JSONValue?

    public init(quality: String? = nil, strength: String? = nil, colour: JSONValue? = nil) {
        self.quality = quality; self.strength = strength; self.colour = colour
    }

    private enum CodingKeys: String, CodingKey { case quality, strength, colour }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(quality, forKey: .quality)
        try c.encodeIfPresent(strength, forKey: .strength)
        try c.encodeIfPresent(colour, forKey: .colour)
    }
}

/// `POST /v1/objects/<id>/estimate`: the slice with exactly the settings Print would use (PR 2).
public struct SliceEstimate: Codable, Equatable, Sendable {
    public var destinationId: String
    public var quality: String
    public var strength: String
    public var seconds: Double?
    public var grams: Double?
    public var layers: Int?
    public var layerHeightMm: Double?
    public var infillPercent: Double?
    public var wallLoops: Int?
    public var slicedAt: String?
}

/// ISO 8601 dates with or without fractional seconds.
public enum ISO {
    public static func date(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }
}
