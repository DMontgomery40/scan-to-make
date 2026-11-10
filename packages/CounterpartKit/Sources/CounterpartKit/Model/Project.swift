import Foundation

/// One thing you want made (PRD §4), as the Mac keeps it at `/v1/objects` (docs/protocols/objects-api.md).
/// Wire names are the companion's. Unknown fields are ignored and unknown enum values decode as unknown,
/// so an update on one side never breaks the other. Fields the companion doesn't serve yet are optional
/// and the screens show an honest fallback without them (PRD §2.6).
public struct Project: Codable, Identifiable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        /// `sent`: the printer took the job but Counterpart can't follow it (no job id, or Bambu Connect). Terminal.
        /// `confirmed`: you said the print works ("Did it fit?" → It works). Done.
        case new, touchingUp = "touching-up", needsCloseup = "needs-closeup", ready, printing, printed, sent, confirmed, failed, unknown
        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    /// The companion decides the job (`passKind`) and sends it as `kind`; the apps don't re-derive it.
    public var usesCopyWorkflow: Bool { kind == "copy" }

    /// A 3MF model carries its parts' filament assignments (a published file, or a design in several
    /// colours), so the sheets don't offer one spool for the whole model. An STL uses the normal material controls.
    public var preservesPublishedFilaments: Bool {
        current?.model.lowercased().hasSuffix(".3mf") == true
    }

    /// The model prints with the settings its file carries (a designer's 3MF), as its printer's MCP says.
    public var printsWithOwnSettings: Bool { current?.ownSettings == true }

    /// The print sheet's line under Quality and Strength for a designer's file (Nov 5); nil for any other file.
    /// `quality`/`strength` are the wire values (`standard` sends nothing, so the file's own settings print).
    public func designerSettingsWords(quality: String, strength: String) -> String? {
        guard printsWithOwnSettings else { return nil }
        return quality == "standard" && strength == "standard"
            ? "Prints with the designer’s settings saved in this file."
            : "Changes the designer’s settings saved in this file."
    }

    /// Why a print sheet waits for "I checked the printer": the last print of this project may have reached it.
    public var uncertainPrintWords: String {
        if print?.uncertain != true, let plate = selectedPlate {
            return "Counterpart couldn’t tell whether \(plate.name) reached the printer when it was last sent. Check the printer before printing it again."
        }
        let printer = print?.destination?.name ?? "the printer"
        if let job = print?.printerStatus?.job, !job.isEmpty {
            return "Counterpart couldn’t tell whether the last print reached \(printer). It last reported “\(job)”. Check the printer before printing this again."
        }
        return "Counterpart couldn’t tell whether the last print reached \(printer). Check the printer before printing this again."
    }

    /// Saved defaults replace print history as a whole: an absent colour means use the printer profile.
    /// Legacy quality/strength/copies can follow the model, but a historical tray belongs to one printer.
    public func resolvedPrintDefaults(destinationId: String?) -> PrintSettings {
        if let saved = settings?.printDefaults { return saved }
        var previous = print?.settings ?? PrintSettings()
        let previousPrinter = print?.destinationId ?? print?.destination?.id
        if destinationId == nil || previousPrinter != destinationId { previous.colour = nil }
        return previous
    }

    /// Where a print sheet starts: the resolved defaults, except that a file that prints with its own settings starts
    /// at Standard quality and strength, which send nothing, so its layer height, walls and infill print as the
    /// designer set them, never as the last print's or saved choice (Nov 5). Project Settings keeps showing and saving
    /// the saved defaults themselves (`resolvedPrintDefaults`).
    public func printSheetStart(destinationId: String?) -> PrintSettings {
        var start = resolvedPrintDefaults(destinationId: destinationId)
        if printsWithOwnSettings { start.quality = nil; start.strength = nil }
        return start
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
    public var failure: String?
    /// The companion exposes this decision because terminal pass activity is omitted from project responses.
    public var canRetryCleanup: Bool?
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
    /// Project Settings (PRD §5.4), stored by the companion: so far, the status you set.
    public var settings: Settings?
    /// "Did it fit?" as the companion keeps it (`works`, `needs-changes`), beside `settings.status`.
    public var outcome: String?
    /// Hidden from Home (Archive). Kept beside `settings.status`.
    public var archived: Bool?
    /// The project's picture (PRD §5.1): the object alone on the stage, drawn once by the Mac (`pictures/…png`).
    public var picture: String?
    /// Each gallery picture the Mac drew, for layouts that show pictures: `part`, `scan`, `together`, `photo`.
    public var pictures: [String: String]?
    /// The scan files the Mac offers, with their sizes (`scanFiles`): the scan, and the phone's own model kept beside a
    /// Mac rebuild (`phone-preview.usdz`). `scanModel(together:limit:)` picks what a stage fetches.
    public var scanFiles: [ScanFile]?
    public struct ScanFile: Codable, Equatable, Sendable {
        public var name: String
        public var bytes: Double
        public init(name: String, bytes: Double) { self.name = name; self.bytes = bytes }
    }
    /// Published model attribution and files from the companion, retained for shared search.
    public var credit: JSONValue?
    public var files: JSONValue?
    public var plates: [ProjectPlate]?
    public var publishedSelection: PublishedSelection?
    public struct PublishedSelection: Codable, Equatable, Sendable { public var fileIndex: Int; public var plateIndex: Int; public var sliced: Bool }
    public var completion: Completion?
    public var pendingFollowup: String?
    public var pendingMessageId: String?
    public var messages: [Message]?
    public var requestPhotos: [String]?
    public var pendingPhotos: [String]?

    public init(id: String, createdAtMs: Double, updatedAtMs: Double, instructions: String? = nil, state: State, scan: String? = nil,
                photos: [String] = [], capture: [String]? = nil, progress: String? = nil, passes: [Pass] = [], current: Result? = nil,
                question: Question? = nil, failure: String? = nil, print: Print? = nil,
                printerDestinationId: String? = nil, printConfirmation: PrintConfirmation? = nil,
                status: Status? = nil, title: String? = nil, kind: String? = nil, ask: Ask? = nil, directory: String? = nil,
                settings: Settings? = nil, outcome: String? = nil, archived: Bool? = nil) {
        self.id = id; self.createdAtMs = createdAtMs; self.updatedAtMs = updatedAtMs; self.instructions = instructions
        self.state = state; self.scan = scan; self.photos = photos; self.capture = capture; self.progress = progress
        self.passes = passes; self.current = current; self.question = question; self.failure = failure
        self.print = print; self.printerDestinationId = printerDestinationId; self.printConfirmation = printConfirmation
        self.status = status; self.title = title; self.kind = kind; self.ask = ask; self.directory = directory
        self.settings = settings; self.outcome = outcome; self.archived = archived
    }

    private enum CodingKeys: String, CodingKey {
        case id, createdAtMs, updatedAtMs, instructions, state, scan, photos, capture, captureDepth, progress, passes, current, question
        case failure, canRetryCleanup, print, printerDestinationId, printConfirmation, status, title, kind, ask, directory, settings, outcome, archived, picture, pictures, scanFiles, credit, files, plates, publishedSelection, completion, pendingFollowup, pendingMessageId, messages, requestPhotos, pendingPhotos
    }

    /// One odd object never drops out of the list: missing lists are empty, and an optional that doesn't
    /// decode is left out. Only a missing id, time or state makes it unreadable.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func optional<T: Decodable>(_ type: T.Type, _ key: CodingKeys) -> T? { (try? c.decodeIfPresent(T.self, forKey: key)) ?? nil }
        // Identity, times and state are what every object has; without them it isn't one.
        id = try c.decode(String.self, forKey: .id)
        createdAtMs = try c.decode(Double.self, forKey: .createdAtMs)
        updatedAtMs = try c.decode(Double.self, forKey: .updatedAtMs)
        state = try c.decode(State.self, forKey: .state)
        pendingFollowup = optional(String.self, .pendingFollowup)
        pendingMessageId = optional(String.self, .pendingMessageId)
        messages = optional([Message].self, .messages)
        requestPhotos = optional([String].self, .requestPhotos)
        pendingPhotos = optional([String].self, .pendingPhotos)
        completion = optional(Completion.self, .completion)
        credit = optional(JSONValue.self, .credit)
        scanFiles = optional([ScanFile].self, .scanFiles)
        files = optional(JSONValue.self, .files)
        plates = optional([ProjectPlate].self, .plates)
        publishedSelection = optional(PublishedSelection.self, .publishedSelection)
        instructions = optional(String.self, .instructions)
        scan = optional(String.self, .scan)
        photos = optional([String].self, .photos) ?? []
        capture = optional([String].self, .capture)
        captureDepth = optional([String].self, .captureDepth)
        progress = optional(String.self, .progress)
        passes = optional([Pass].self, .passes) ?? []
        current = optional(Result.self, .current)
        question = optional(Question.self, .question)
        failure = optional(String.self, .failure)
        canRetryCleanup = optional(Bool.self, .canRetryCleanup)
        print = optional(Print.self, .print)
        printerDestinationId = optional(String.self, .printerDestinationId)
        printConfirmation = optional(PrintConfirmation.self, .printConfirmation)
        status = optional(Status.self, .status)
        title = optional(String.self, .title)
        kind = optional(String.self, .kind)
        ask = optional(Ask.self, .ask)
        directory = optional(String.self, .directory)
        settings = optional(Settings.self, .settings)
        outcome = optional(String.self, .outcome)
        archived = optional(Bool.self, .archived)
        picture = optional(String.self, .picture)
        pictures = optional([String: String].self, .pictures)
    }

    public var createdAt: Date { Date(timeIntervalSince1970: createdAtMs / 1000) }
    /// Earliest recorded work, including failed passes; an unsent draft has no work start.
    public var workStartedAt: Date? {
        passes.map(\.startedAtMs).filter { $0.isFinite && $0 >= 0 }.min().map { Date(timeIntervalSince1970: $0 / 1000) }
    }
    public var updatedAt: Date { Date(timeIntervalSince1970: updatedAtMs / 1000) }

    /// A scan (walk-around or in hand) reached the Mac.
    public var hasScan: Bool { scan != nil || !(capture ?? []).isEmpty }

    /// Progress updates do not change saved media. A finished pass can replace the model and renders at the
    /// same paths, so their cached copies expire only when a pass finishes.
    /// A locate pass changes no file (docs/protocols/seats.md), so it never rolls the version over.
    public var mediaVersion: Double { passes.last(where: { $0.endedAtMs != nil && $0.trigger != "locate" })?.endedAtMs ?? createdAtMs }

    /// The pass in progress, if the Mac is working.
    public var runningPass: Pass? { state == .touchingUp ? passes.last(where: { $0.endedAtMs == nil }) : nil }

    /// The status you set (Project Settings), or the older `outcome`. Nil when unset or from a newer Mac.
    public var projectStatus: ProjectStatus? {
        (settings?.status).flatMap(ProjectStatus.init(rawValue:)) ?? outcome.flatMap(ProjectStatus.init(rawValue:))
    }
    /// Hidden from Home. Archiving is apart from the status: a Done project can be archived and stays Done.
    public var isArchived: Bool { settings?.archived ?? (archived == true || projectStatus == .archived) }
    /// The status under an archived project: the status itself where the Mac keeps archive apart, else from the
    /// state (what Unarchive puts back on a Mac without the `archived` setting).
    public var statusUnderneath: ProjectStatus {
        if let status = projectStatus, status != .archived { return status }
        if state == .confirmed { return .works }
        if outcome == "needs-changes" { return .needsChanges }
        if state == .printed || state == .sent { return .printed }
        return .notPrinted
    }

    /// The open question, structured (PR 4) or the older close-up question.
    public var openAsk: Ask? { ask.flatMap { $0.status == "answered" ? nil : $0 } }

    public var completionUndoStatus: ProjectStatus? {
        guard state == .confirmed, let completion, completion.undone != true,
              let previous = ProjectStatus(rawValue: completion.previousStatus), previous != .works else { return nil }
        return previous
    }

    public struct Message: Codable, Equatable, Identifiable, Sendable {
        public var id: String
        public var text: String
        public var atMs: Double
        public var photos: [String]
        public init(id: String, text: String, atMs: Double, photos: [String] = []) {
            self.id = id; self.text = text; self.atMs = atMs; self.photos = photos
        }
    }

    public struct Completion: Codable, Equatable, Sendable {
        public var messageId: String?
        public var note: String
        public var atMs: Double
        public var previousStatus: String
        public var undone: Bool?
    }

    // MARK: Nested types

    /// Project Settings (PRD §5.4). Every part is optional, so a newer Mac's other settings never break decoding.
    public struct Settings: Codable, Equatable, Sendable {
        /// not-printed, printed, works, needs-changes, archived, or a newer value kept as its string.
        public var status: String?
        /// Present on a Mac that archives apart from the status (`PATCH …/settings {archived}`).
        public var archived: Bool?
        public var printerDestinationId: String?
        public var printDefaults: PrintSettings?
        public var designEngine: String?
        public var notifications: String?
        public init(status: String? = nil, archived: Bool? = nil) { self.status = status; self.archived = archived }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil
            archived = (try? c.decodeIfPresent(Bool.self, forKey: .archived)) ?? nil
            printerDestinationId = try? c.decodeIfPresent(String.self, forKey: .printerDestinationId)
            printDefaults = try? c.decodeIfPresent(PrintSettings.self, forKey: .printDefaults)
            designEngine = try? c.decodeIfPresent(String.self, forKey: .designEngine)
            notifications = try? c.decodeIfPresent(String.self, forKey: .notifications)
        }
    }

    /// The companion's state line (`ObjectStatus`).
    public struct Status: Codable, Equatable, Sendable {
        /// sending, working, needs-you, ready, preparing, printing, printed, sent, failed
        public var phase: String
        public var text: String
        /// What a list row shows under the title when the row sits under its phase's heading: only what differs
        /// there (the question, the size, the stage), never the heading again. Nil from an older Mac, or when the
        /// whole line is already that.
        public var detail: String?
        public var symbol: String
        /// blue, orange, accent, green, secondary, red
        public var tint: String
        public init(phase: String, text: String, symbol: String, tint: String) { self.phase = phase; self.text = text; self.symbol = symbol; self.tint = tint }
        /// A status missing its symbol or tint still shows its words.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            phase = try c.decode(String.self, forKey: .phase); text = try c.decode(String.self, forKey: .text)
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
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
        public var messageId: String?
        public var photos: [String]?
        public var startedAtMs: Double
        public var endedAtMs: Double?
        /// Your follow-up that started it, if any.
        public var note: String?
        public var status: String?
        /// How it ended, in the Mac's words ("Asked you a question"); nil while it runs or from an older Mac.
        public var words: String?
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
        /// How an ended pass reads in the project's history: the Mac's own words. An older Mac sends only the status,
        /// which is worded here as that Mac's window worded it. Nil while the pass runs.
        public var endingWords: String? {
            guard endedAtMs != nil else { return nil }
            if let words, !words.isEmpty { return words }
            switch status {
            case "needs_closeup": return "Asked you a question"
            case "interrupted": return "Stopped when Counterpart restarted"
            case "done", nil: return "Finished"
            case let other?: return other.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
        /// How an ended pass left things, for the mark beside it: it finished, it stopped to ask the person, or it
        /// stopped short. Nil while it runs. A pass that asked or stopped must never read as all green ticks.
        public enum Ending: Equatable, Sendable { case finished, asked, stopped }
        public var ending: Ending? {
            guard endedAtMs != nil else { return nil }
            switch status {
            case "needs_closeup", "needs_file": return .asked
            case "capped", "failed", "interrupted": return .stopped
            default: return .finished
            }
        }
        /// The words that started this pass, when it was a change the person asked for ("Your change: …"): a note,
        /// with photos (`late-photos`) or without (`changes`), or from a Mac older than triggers. Never the first
        /// request, and never an answer to a question, whose note the Mac composes.
        public var requestedChange: String? {
            guard let note = note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty, Self.changeTriggers.contains(trigger) else { return nil }
            return note
        }
        static let changeTriggers: Set<String?> = [nil, "changes", "late-photos"]
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
        /// This 3MF prints with the settings it carries (a designer's project), as its printer's MCP says. Nil until asked,
        /// or when the MCP doesn't say.
        public var ownSettings: Bool?
        /// A multi-colour design's parts in filament order, with the colour each was asked for (`#RRGGBB`), as the pass declared them.
        public var filaments: [DeclaredFilament]?
        /// A fit's places for the scanned object, as the pass that made it said (docs/protocols/seats.md).
        public var seats: [Seat]?
        public init(model: String, renders: [String], sizeMm: [Double]? = nil, summary: String? = nil, changes: [Change]? = nil, ownSettings: Bool? = nil,
                    filaments: [DeclaredFilament]? = nil, seats: [Seat]? = nil) {
            self.model = model; self.renders = renders; self.sizeMm = sizeMm; self.summary = summary; self.changes = changes; self.ownSettings = ownSettings
            self.filaments = filaments; self.seats = seats
        }
        private enum CodingKeys: String, CodingKey { case model, renders, sizeMm, summary, changes, engine, ownSettings, filaments, seats }
        /// A malformed optional (say, `changes`) is left out; the model and renders still show.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            model = try c.decode(String.self, forKey: .model)
            renders = (try? c.decodeIfPresent([String].self, forKey: .renders)) ?? []
            sizeMm = (try? c.decodeIfPresent([Double].self, forKey: .sizeMm)) ?? nil
            summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? nil
            changes = (try? c.decodeIfPresent([Change].self, forKey: .changes)) ?? nil
            engine = (try? c.decodeIfPresent(String.self, forKey: .engine)) ?? nil
            ownSettings = (try? c.decodeIfPresent(Bool.self, forKey: .ownSettings)) ?? nil
            filaments = (try? c.decodeIfPresent([DeclaredFilament].self, forKey: .filaments)) ?? nil
            seats = (try? c.decodeIfPresent([Seat].self, forKey: .seats)) ?? nil
        }
    }

    /// One part of a multi-colour design, as its pass declared it.
    public struct DeclaredFilament: Codable, Equatable, Sendable {
        public var name: String?
        public var colour: String?
        public var material: String?
        public init(name: String? = nil, colour: String? = nil, material: String? = nil) { self.name = name; self.colour = colour; self.material = material }
    }

    /// Where the scanned object sits in the part (docs/protocols/seats.md): the scan, in millimetres and Z up, turned
    /// about the fixed X, then Y, then Z axes (`rotationDeg`), then moved (`translationMm`), into the part's frame.
    public struct Seat: Codable, Equatable, Sendable {
        public var name: String?
        public var translationMm: [Double]
        public var rotationDeg: [Double]
        public var check: Check?
        public struct Check: Codable, Equatable, Sendable { public var minimumGapMm: Double?; public var interferenceMm3: Double?; public var clear: Bool? }
        public init(name: String? = nil, translationMm: [Double], rotationDeg: [Double]) { self.name = name; self.translationMm = translationMm; self.rotationDeg = rotationDeg }
        /// Row-major 4×4: Rz·Ry·Rx, then the translation (the printer MCP's `cad_check_fit`).
        public var matrix: [Double] {
            guard translationMm.count == 3, rotationDeg.count == 3 else { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
            let a = rotationDeg.map { $0 * .pi / 180 }
            let (cx, sx, cy, sy, cz, sz) = (cos(a[0]), sin(a[0]), cos(a[1]), sin(a[1]), cos(a[2]), sin(a[2]))
            let t = translationMm
            return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, t[0],
                    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, t[1],
                    -sy, cy * sx, cy * cx, t[2],
                    0, 0, 0, 1]
        }
    }

    /// A spool a print used, as the printer MCP reported it when the print was sent.
    public struct Spool: Codable, Equatable, Sendable {
        /// The model's 1-based filament, for a multi-part model; nil for a one-spool print.
        public var index: Int?
        /// `#RRGGBB`.
        public var colour: String
        public var material: String?
        public var name: String?
        public init(index: Int? = nil, colour: String, material: String? = nil, name: String? = nil) { self.index = index; self.colour = colour; self.material = material; self.name = name }
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
        /// The kinds of question this build knows how to answer (contracts `AskSchema.kind`).
        public static let knownKinds: Set<String> = ["closeup", "file", "choice", "region", "scale", "sizes"]
        /// False for a kind this build doesn't know: the card shows the question and says to update, and offers no
        /// answer at all, because any answer it offered could consume the question wrongly. A question with no
        /// kind is from a Mac older than kinds and is answered the old way.
        public var answerable: Bool { kind.map(Self.knownKinds.contains) ?? true }
        public var id: String
        public var question: String
        public var type: String?
        public var url: String?
        public var options: [Option]?
        public struct Option: Codable, Equatable, Sendable, Identifiable { public var id: String; public var label: String; public var detail: String?; public var thumbnail: String? }
        /// `asks/<id>.jpg`, served at `GET /v1/objects/<id>/asks/<askId>.jpg`.
        public var photo: String?
        public var region: Region?
        /// camera, photos, best-guess, text
        public var answers: [String]
        /// open, answered
        public var status: String
        public var askedAtMs: Double?
        /// What the project is waiting on the person for: closeup, file, choice, region, scale, sizes. The Mac sends
        /// it for every question; nil only from an older Mac.
        public var kind: String?
        /// `file`: why, when it isn't simply "send it" (`downloads-access`).
        public var reason: String?
        /// `sizes`: the sizes to confirm or correct, prefilled.
        public var sizes: [Size]?
        /// One size in millimetres. `id` is opaque; `label` says what to measure; `from` is where the Mac's number
        /// came from (`scan` or `published`).
        public struct Size: Codable, Equatable, Sendable, Identifiable {
            public var id: String; public var label: String; public var mm: Double; public var from: String
            public init(id: String, label: String, mm: Double, from: String) { self.id = id; self.label = label; self.mm = mm; self.from = from }
        }
        public init(id: String, question: String, photo: String? = nil, region: Region? = nil, answers: [String], status: String = "open", askedAtMs: Double? = nil,
                    kind: String? = nil, sizes: [Size]? = nil) {
            self.id = id; self.question = question; self.photo = photo; self.region = region; self.answers = answers; self.status = status; self.askedAtMs = askedAtMs
            self.kind = kind; self.sizes = sizes
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
        /// The spools this print uses (PRD §5.4): the result is drawn in them.
        public var spools: [Spool]?

        public init(bundleId: String, uncertain: Bool? = nil, destination: PrintDestination? = nil, sliced: Bool? = nil,
                    estimate: PrintEstimate? = nil, printId: String? = nil, live: PrintLive? = nil, monitor: PrintMonitor? = nil) {
            self.bundleId = bundleId; self.uncertain = uncertain; self.destination = destination; self.sliced = sliced
            self.estimate = estimate; self.printId = printId; self.live = live; self.monitor = monitor
        }
    }

    /// The printer MCP's own question before printing. Only an explicit answer to this id approves it.
    /// The printer MCP's own question (MCP elicitation), answered on the phone or the Mac. Only an explicit
    /// answer to this id approves it. Fields are the elicitation schema's primitive properties; anything a
    /// field doesn't describe is checked by the companion again.
    public struct PrintConfirmation: Codable, Equatable, Sendable {
        public struct Field: Codable, Equatable, Sendable {
            /// The JSON Schema primitive. Absent means boolean; a type from a newer MCP is `unknown` and can't be answered here.
            public enum Kind: String, Codable, Equatable, Sendable {
                case boolean, string, number, integer, unknown
                public init(from decoder: Decoder) throws {
                    self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
            public var name: String
            public var title: String
            public var description: String?
            public var required: Bool
            public var type: Kind
            /// Allowed values of a string field, and their display names in the same order.
            public var enumValues: [String]?
            public var enumNames: [String]?
            public var defaultValue: JSONValue?
            public var minimum: Double?
            public var maximum: Double?
            public var minLength: Int?
            public var maxLength: Int?
            /// email, uri, date or date-time.
            public var format: String?

            public init(name: String, title: String, description: String? = nil, required: Bool, type: Kind = .boolean,
                        enumValues: [String]? = nil, enumNames: [String]? = nil, defaultValue: JSONValue? = nil,
                        minimum: Double? = nil, maximum: Double? = nil, minLength: Int? = nil, maxLength: Int? = nil, format: String? = nil) {
                self.name = name; self.title = title; self.description = description; self.required = required; self.type = type
                self.enumValues = enumValues; self.enumNames = enumNames; self.defaultValue = defaultValue
                self.minimum = minimum; self.maximum = maximum; self.minLength = minLength; self.maxLength = maxLength; self.format = format
            }

            private enum CodingKeys: String, CodingKey {
                case name, title, description, required, type, enumValues = "enum", enumNames, defaultValue = "default"
                case minimum, maximum, minLength, maxLength, format
            }
            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                name = try c.decode(String.self, forKey: .name)
                title = try c.decodeIfPresent(String.self, forKey: .title) ?? name
                description = try c.decodeIfPresent(String.self, forKey: .description)
                required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
                type = try c.decodeIfPresent(Kind.self, forKey: .type) ?? .boolean
                enumValues = try? c.decodeIfPresent([String].self, forKey: .enumValues)
                enumNames = try? c.decodeIfPresent([String].self, forKey: .enumNames)
                defaultValue = try c.decodeIfPresent(JSONValue.self, forKey: .defaultValue)
                minimum = try? c.decodeIfPresent(Double.self, forKey: .minimum)
                maximum = try? c.decodeIfPresent(Double.self, forKey: .maximum)
                minLength = try? c.decodeIfPresent(Int.self, forKey: .minLength)
                maxLength = try? c.decodeIfPresent(Int.self, forKey: .maxLength)
                format = try c.decodeIfPresent(String.self, forKey: .format)
            }

            /// The value this field starts with. A switch always starts off, whatever the MCP's default says: a
            /// person ticks every printer check themselves. Other fields start at a valid default.
            public var initialValue: JSONValue? {
                if type == .boolean { return .bool(false) }
                if let defaultValue, accepts(defaultValue) { return defaultValue }
                return nil
            }

            /// The answer to use: what the person gave; when they gave nothing, the default (never for a switch).
            /// A field they edited stays edited: `.null` means they cleared it, and its default doesn't come back.
            func fallback(_ given: JSONValue?) -> JSONValue? {
                if given == .null { return nil }
                return given ?? (type == .boolean ? nil : defaultValue)
            }

            /// "Low (0.2 mm)" for an enum value, else the value itself.
            public func displayName(of value: String) -> String {
                guard let values = enumValues, let index = values.firstIndex(of: value), let names = enumNames, index < names.count else { return value }
                return names[index]
            }

            /// True when `value` is the right type and within this field's limits.
            public func accepts(_ value: JSONValue) -> Bool {
                switch (type, value) {
                case (.boolean, .bool): return true
                case (.string, .string(let text)):
                    if let values = enumValues, !values.contains(text) { return false }
                    // JSON Schema counts code points, not what reads as one character.
                    let length = text.unicodeScalars.count
                    if let minLength, length < minLength { return false }
                    if let maxLength, length > maxLength { return false }
                    return Self.matches(format, text)
                case (.number, .number(let number)), (.integer, .number(let number)):
                    guard number.isFinite, type == .number || number.rounded() == number else { return false }
                    if let minimum, number < minimum { return false }
                    if let maximum, number > maximum { return false }
                    return true
                default: return false
                }
            }

            /// A real calendar day: 2026-02-30 doesn't round-trip.
            private static let day: DateFormatter = {
                let f = DateFormatter(); f.calendar = Calendar(identifier: .iso8601); f.locale = Locale(identifier: "en_US_POSIX")
                f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false; return f
            }()

            private static func matches(_ format: String?, _ text: String) -> Bool {
                switch format {
                case "email": return text.wholeMatch(of: #/[^@\s]+@[^@\s]+\.[^@\s]+/#) != nil
                case "uri": return URL(string: text)?.scheme != nil
                case "date": return text.wholeMatch(of: #/\d{4}-\d{2}-\d{2}/#) != nil && Self.day.date(from: text).map(Self.day.string) == text
                case "date-time": return ISO.date(text) != nil
                default: return true
                }
            }
        }
        public var id: String
        public var message: String
        public var expiresAtMs: Double
        public var fields: [Field]
        /// The companion can take an answer to this schema.
        public var supported: Bool
        public init(id: String, message: String, expiresAtMs: Double, fields: [Field], supported: Bool) {
            self.id = id; self.message = message; self.expiresAtMs = expiresAtMs; self.fields = fields; self.supported = supported
        }

        /// The app can show every field natively. Otherwise the question goes to the Mac (or Don't Print).
        public var isRenderable: Bool { supported && fields.allSatisfy { $0.type != .unknown } }

        /// Every required field has a valid value (an untouched default counts), and every value given is valid.
        /// Content holds what the person did: a value, `.null` for a field they cleared, or nothing (untouched).
        /// Text that isn't a number yet is passed as a string, so it's invalid until it is.
        public func canAccept(_ content: [String: JSONValue], atMs: Double) -> Bool {
            guard isRenderable, expiresAtMs > atMs else { return false }
            return fields.allSatisfy { field in
                guard let value = field.fallback(content[field.name]) else { return !field.required }
                if field.type == .boolean && field.required { return value == .bool(true) }
                return field.accepts(value)
            }
        }

        /// An answer belongs to exactly one live question. Values never carry over to its replacement.
        public func response(confirmationId: String, action: PrintConfirmationResponse.Action, content: [String: JSONValue], atMs: Double) -> PrintConfirmationResponse? {
            guard confirmationId == id, expiresAtMs > atMs else { return nil }
            if action == .accept && !canAccept(content, atMs: atMs) { return nil }
            var answer: [String: JSONValue] = [:]
            for field in fields {
                if let value = field.fallback(content[field.name]), field.accepts(value) { answer[field.name] = value }
                else if field.type == .boolean { answer[field.name] = .bool(false) }
            }
            return .init(confirmationId: id, answer: .init(action: action, content: action == .accept ? answer : nil))
        }

        /// Switches only, as the first confirmations were.
        @_disfavoredOverload
        public func canAccept(_ content: [String: Bool], atMs: Double) -> Bool { canAccept(content.mapValues(JSONValue.bool), atMs: atMs) }
        @_disfavoredOverload
        public func response(confirmationId: String, action: PrintConfirmationResponse.Action, content: [String: Bool], atMs: Double) -> PrintConfirmationResponse? {
            response(confirmationId: confirmationId, action: action, content: content.mapValues(JSONValue.bool), atMs: atMs)
        }
    }
}

public struct PrintConfirmationResponse: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case accept, decline, cancel }
    public struct Answer: Codable, Equatable, Sendable {
        public var action: Action
        /// A string, number or bool per field.
        public var content: [String: JSONValue]?
        public init(action: Action, content: [String: JSONValue]? = nil) { self.action = action; self.content = content }
    }
    public var confirmationId: String
    public var answer: Answer
    public init(confirmationId: String, answer: Answer) { self.confirmationId = confirmationId; self.answer = answer }
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
    public var copies: Int?
    /// The last print's "Pause before layer" numbers (`print.settings`), so Print Another keeps the magnet pauses.
    /// Read only: Print sends its own (`pauseBeforeLayers`), and saved defaults never carry them.
    public var pauseBeforeLayers: [Int]?

    public init(quality: String? = nil, strength: String? = nil, colour: JSONValue? = nil, copies: Int? = nil, pauseBeforeLayers: [Int]? = nil) {
        self.quality = quality; self.strength = strength; self.colour = colour; self.copies = copies; self.pauseBeforeLayers = pauseBeforeLayers
    }

    private enum CodingKeys: String, CodingKey { case quality, strength, colour, copies, pauseBeforeLayers }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(quality, forKey: .quality)
        try c.encodeIfPresent(strength, forKey: .strength)
        try c.encodeIfPresent(colour, forKey: .colour)
        try c.encodeIfPresent(copies, forKey: .copies)
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
    /// The SHA-256 of this estimate's sliced file: Print sends it (`PrintChoice.sliceSha256`) and the Mac prints exactly that file.
    public var sliceSha256: String?
    /// The printer MCP's pictures of that file's G-code: what will print. Absent when the MCP can't draw them.
    public var preview: PrintPreviewImages?
    /// The installed printer MCP can't say whether this 3MF prints with its own settings: the companion's words to update it.
    public var ownSettingsUpdate: String?
}

/// What will print, drawn by the printer MCP from the exact sliced G-code (never a thumbnail or a design render).
public struct PrintPreviewImages: Codable, Equatable, Sendable {
    public struct Picture: Codable, Equatable, Sendable, Identifiable {
        /// `top` (as it sits on the bed) or `bed_side` (the face on the bed, turned over toward you).
        public var name: String
        public var label: String
        /// PNG, base64.
        public var png: String
        public var width: Int
        public var height: Int
        public var id: String { name }
        public var pngData: Data? { Data(base64Encoded: png) }
    }
    public var sha256: String
    public var views: [Picture]
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

/// The status a person sets on a project (PRD §5.4 Project Settings): `PATCH /v1/objects/<id>/settings {status}`.
public enum ProjectStatus: String, CaseIterable, Sendable {
    case notPrinted = "not-printed", printed, works, needsChanges = "needs-changes", archived

    /// The Status choices, in order. Archive is its own action ("Hide from Home"), never a status you pick.
    public static let choices: [ProjectStatus] = [.notPrinted, .printed, .works, .needsChanges]

    public var label: String {
        switch self {
        case .notPrinted: "Not printed"
        case .printed: "Printed"
        case .works: "Done"
        case .needsChanges: "Needs changes"
        case .archived: "Archived"
        }
    }
    public var symbol: String {
        switch self {
        case .notPrinted: "circle.dashed"
        case .printed: "shippingbox"
        case .works: "checkmark.circle"
        case .needsChanges: "pencil.and.ruler"
        case .archived: "archivebox"
        }
    }
}
