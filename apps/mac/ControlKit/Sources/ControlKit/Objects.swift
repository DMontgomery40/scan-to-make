import Foundation

public struct PrinterFilament: Codable, Sendable, Identifiable, Equatable {
    public let slot: Int
    public let colour: String, material: String, name: String, filamentId: String, destinationId: String
    public var id: Int { slot }
}

/// One thing the user scanned or asked to have made: the companion's `StmObject`
/// (services/companion/src/objects/store.ts) plus `directory`, its folder on this Mac.
/// Decoding is tolerant: unknown keys are ignored, missing lists read as empty, and a state
/// this app doesn't know reads as `.unknown`, so one object never hides the rest of the list.
public struct StmObject: Decodable, Sendable, Identifiable, Equatable {
    public enum State: String, Decodable, Sendable {
        case new, touchingUp = "touching-up", needsCloseup = "needs-closeup", ready, printing, printed, failed, unknown
        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }
    public struct Activity: Decodable, Sendable, Equatable {
        public let atMs: Double
        public let kind: String
        public let text: String
    }
    public struct Pass: Decodable, Sendable, Equatable {
        /// One named step of a pass (PRD §4): `building`, `preparing`, `working` or `saving`, with its words.
        public struct Stage: Decodable, Sendable, Equatable {
            public let id: String
            public let words: String
            public let startedAtMs: Double
            public let endedAtMs: Double?
            public let typicalSec: Double?
        }
        public struct Estimate: Decodable, Sendable, Equatable { public let remainingSec: Double; public let endsAtMs: Double }
        public let startedAtMs: Double
        public let endedAtMs: Double?
        public let note: String?, status: String?, summary: String?
        public let activity: [Activity]?
        public let activityCount: Int?
        /// `new`, `changes`, `late-photos` or `ask-answer`.
        public let trigger: String?
        public let stages: [Stage]?
        /// While the pass runs: time left, from real timings on this Mac.
        public let estimate: Estimate?
        /// `blender` or `fusion`.
        public let engine: String?
        private enum CodingKeys: String, CodingKey { case startedAtMs, endedAtMs, note, status, summary, activity, activityCount, trigger, stages, estimate, engine }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            startedAtMs = try values.decode(Double.self, forKey: .startedAtMs)
            endedAtMs = try values.decodeIfPresent(Double.self, forKey: .endedAtMs)
            note = try values.decodeIfPresent(String.self, forKey: .note)
            status = try values.decodeIfPresent(String.self, forKey: .status)
            summary = try values.decodeIfPresent(String.self, forKey: .summary)
            activity = try values.decodeIfPresent([Activity].self, forKey: .activity)
            activityCount = try values.decodeIfPresent(Int.self, forKey: .activityCount)
            trigger = try? values.decodeIfPresent(String.self, forKey: .trigger)
            stages = try? values.decodeIfPresent([Stage].self, forKey: .stages)
            estimate = try? values.decodeIfPresent(Estimate.self, forKey: .estimate)
            engine = try? values.decodeIfPresent(String.self, forKey: .engine)
        }
    }
    public struct Current: Decodable, Sendable, Equatable {
        /// One line of "what changed" (PRD §4), tagged `added`, `changed`, `assumed` or `estimated`.
        public struct Change: Decodable, Sendable, Equatable {
            public let tag: String
            public let text: String
            public let toleranceMm: Double?
        }
        /// Relative to `directory`, like `renders`.
        public let model: String
        public let renders: [String]
        /// Bounding box in millimetres, from the printer's own STL info.
        public let sizeMm: [Double]?
        public let summary: String?
        /// Structured "what changed", once the companion serves it; `summary` is the fallback.
        public let changes: [Change]
        /// `blender` or `fusion`.
        public let engine: String?
        private enum CodingKeys: String, CodingKey { case model, renders, sizeMm, summary, changes, engine }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            model = try values.decode(String.self, forKey: .model)
            renders = try values.decodeIfPresent([String].self, forKey: .renders) ?? []
            sizeMm = try values.decodeIfPresent([Double].self, forKey: .sizeMm)
            summary = try values.decodeIfPresent(String.self, forKey: .summary)
            changes = (try? values.decodeIfPresent([Change].self, forKey: .changes)) ?? []
            engine = try? values.decodeIfPresent(String.self, forKey: .engine)
        }
    }
    public struct Question: Decodable, Sendable, Equatable { public let closeup: String? }
    /// A question from the Mac (PRD §4), with the picture and the region it is about.
    public struct Ask: Decodable, Sendable, Equatable {
        public struct Region: Decodable, Sendable, Equatable { public let x, y, width, height: Double }
        public let id: String
        public let question: String
        /// Relative to `directory`.
        public let photo: String?
        public let region: Region?
        /// `camera`, `photos`, `best-guess`, `text`.
        public let answers: [String]
        /// `open` or `answered`.
        public let status: String
    }
    /// The companion's own status line (PRD §4), written once for the phone and the Mac.
    public struct Status: Decodable, Sendable, Equatable {
        /// `sending`, `working`, `needs-you`, `ready`, `preparing`, `printing`, `printed` or `failed`.
        public let phase: String
        public let text: String
        public let symbol: String?
        public let tint: String?
    }
    /// The printer MCP's original human confirmation, tied to one pending request.
    public struct PrintConfirmation: Decodable, Sendable, Equatable, Identifiable {
        public struct Field: Decodable, Sendable, Equatable {
            public let name: String, title: String
            public let description: String?
            public let required: Bool
        }
        public let id: String, message: String
        public let expiresAtMs: Double
        public let fields: [Field]
        public let supported: Bool

        public func canAccept(_ content: [String: Bool], at nowMs: Double) -> Bool {
            supported && expiresAtMs > nowMs && fields.allSatisfy { !$0.required || content[$0.name] == true }
        }
    }
    /// Set while a print waits for the user: something is on the plate, or the printer has no camera.
    public struct Plate: Decodable, Sendable, Equatable {
        public let item: String?
        public let noCamera: Bool?
        /// Look again is retaking and judging a frame.
        public let checking: Bool?
        /// `plate.jpg` is in the object's folder while this is true.
        public let photo: Bool?
    }
    /// The last print. `uncertain`: it may have reached the printer, so it is only sent again with `checked`.
    public struct PrintDestination: Decodable, Sendable, Equatable { public let id: String; public let name: String }
    public struct PrinterStatus: Decodable, Sendable, Equatable { public let state: String; public let job: String?; public let checkedAtMs: Double; public let percent: Double?; public let remainingMinutes: Double? }
    public struct PrintEstimate: Decodable, Sendable, Equatable { public let seconds: Double?; public let grams: Double? }
    public struct PrintEvent: Decodable, Sendable, Equatable { public let atMs: Double; public let message: String }
    /// The latest normalized printer report for this print (PRD §8.6), replacing `printerStatus` once present.
    public struct PrintLive: Decodable, Sendable, Equatable {
        public struct Job: Decodable, Sendable, Equatable {
            public let name: String?
            public let progress: Double?
            public let remainingSec: Double?
            public let layer: Int?
            public let totalLayers: Int?
            public let stage: String?
        }
        public struct Problem: Decodable, Sendable, Equatable { public let code: String; public let severity: String?; public let message: String }
        /// `idle`, `preparing`, `printing`, `paused`, `finished`, `failed`, `cancelled`, `offline`, `busy`.
        public let state: String
        public let observedAt: String?
        public let job: Job?
        public let endsAt: String?
        public let problems: [Problem]?
    }
    /// The companion's print monitor (PRD §8.6): `starting`, `watching` or `ended`, and how it ended.
    public struct PrintMonitor: Decodable, Sendable, Equatable {
        public let phase: String
        public let endState: String?
    }
    public struct Print: Decodable, Sendable, Equatable {
        public let printId: String?
        public let monitor: PrintMonitor?
        public let events: [PrintEvent]?
        public let live: PrintLive?
        public let printerStatus: PrinterStatus?
        public let sliced: Bool?
        public let estimate: PrintEstimate?
        public let bundleId: String?
        public let uncertain: Bool?
        public let destination: PrintDestination?
    }

    public let id: String
    public let createdAtMs: Double, updatedAtMs: Double
    /// The short generated title ("Mic mount"), once the companion serves one.
    public let title: String?
    /// `fit` or `copy`.
    public let kind: String?
    public let status: Status?
    public let ask: Ask?
    public let instructions: String?
    public let state: State
    public let scan: String?
    public let photos: [String]
    public let capture: [String]?
    public let progress: String?
    public let passes: [Pass]
    public let current: Current?
    public let question: Question?
    public let plate: Plate?
    public let printConfirmation: PrintConfirmation?
    public let failure: String?
    public let print: Print?
    public let printerDestinationId: String?
    /// The object's folder on this Mac (absolute).
    public let directory: String

    private enum CodingKeys: String, CodingKey {
        case id, createdAtMs, updatedAtMs, title, kind, status, ask, instructions, state, scan, photos, capture, progress, passes, current, question, plate, printConfirmation, failure, print, printerDestinationId, directory
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        createdAtMs = try values.decodeIfPresent(Double.self, forKey: .createdAtMs) ?? 0
        updatedAtMs = try values.decodeIfPresent(Double.self, forKey: .updatedAtMs) ?? createdAtMs
        title = try? values.decodeIfPresent(String.self, forKey: .title)
        kind = try? values.decodeIfPresent(String.self, forKey: .kind)
        status = try? values.decodeIfPresent(Status.self, forKey: .status)
        ask = try? values.decodeIfPresent(Ask.self, forKey: .ask)
        instructions = try values.decodeIfPresent(String.self, forKey: .instructions)
        state = try values.decodeIfPresent(State.self, forKey: .state) ?? .unknown
        scan = try values.decodeIfPresent(String.self, forKey: .scan)
        photos = try values.decodeIfPresent([String].self, forKey: .photos) ?? []
        capture = try values.decodeIfPresent([String].self, forKey: .capture)
        progress = try values.decodeIfPresent(String.self, forKey: .progress)
        passes = try values.decodeIfPresent([Pass].self, forKey: .passes) ?? []
        current = try values.decodeIfPresent(Current.self, forKey: .current)
        question = try values.decodeIfPresent(Question.self, forKey: .question)
        plate = try values.decodeIfPresent(Plate.self, forKey: .plate)
        printConfirmation = try values.decodeIfPresent(PrintConfirmation.self, forKey: .printConfirmation)
        failure = try values.decodeIfPresent(String.self, forKey: .failure)
        print = try values.decodeIfPresent(Print.self, forKey: .print)
        printerDestinationId = try values.decodeIfPresent(String.self, forKey: .printerDestinationId)
        directory = try values.decode(String.self, forKey: .directory)
    }

    /// A file named by the companion, kept inside the object's folder.
    private func file(_ relative: String) -> URL? {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !relative.isEmpty, !relative.hasPrefix("/"), !parts.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }),
              directory.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(relative)
    }
    /// The current model's STL: exactly what will print.
    public var modelURL: URL? { current.flatMap { file($0.model) } }
    public var renderURLs: [URL] { current?.renders.compactMap(file) ?? [] }
    public var photoURLs: [URL] { photos.compactMap { file("photos/\($0)") } }
    public var captureURLs: [URL] { (capture ?? []).compactMap { file("capture/\($0)") } }
    /// The printer camera's photo of the plate, while the print waits on what it shows.
    public var platePhotoURL: URL? { plate?.photo == true ? file("plate.jpg") : nil }
    /// The Ask's picture, with `ask.region` to highlight on it.
    public var askPhotoURL: URL? { ask?.photo.flatMap(file) }
    /// A file the companion names relative to this project's folder (an event's `frame`).
    public func projectFile(_ relative: String) -> URL? { file(relative) }
    /// The scan as it arrived (a USDZ under scan/), shown until there is a model.
    public var scanURL: URL? { scan.flatMap { file("scan/\($0)") } }
}

public extension ControlClient {
    private struct ObjectList: Decodable { let objects: [StmObject] }
    private struct ObjectReply: Decodable { let object: StmObject }
    private struct PassActivityReply: Decodable { let activity: [StmObject.Activity] }

    func printers() async throws -> PrinterCatalog { try await call("objects.printers") }
    func filaments(_ id: String) async throws -> [PrinterFilament] {
        struct Result: Decodable { let filaments: [PrinterFilament] }
        let result: Result = try await call("objects.filaments", ["id":.string(id)])
        return result.filaments
    }
    func selectPrinter(_ id: String, destinationId: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.selectPrinter", ["id": .string(id), "destinationId": .string(destinationId)])
        return result.object
    }
    /// Every object on this Mac, newest first. Refused with `unavailable` when objects aren't set up here.
    func objects() async throws -> [StmObject] {
        let result: ObjectList = try await call("objects.list"); return result.objects
    }
    func object(_ id: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.get", ["id": .string(id)]); return result.object
    }
    func passActivity(_ id: String, index: Int) async throws -> [StmObject.Activity] {
        let result: PassActivityReply = try await call("objects.passActivity", ["id": .string(id), "index": .number(Double(index))])
        return result.activity
    }
    /// Starts the touch-up again, after one that failed without a model.
    func startObject(_ id: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.start", ["id": .string(id)]); return result.object
    }
    /// Sends a correction back to the touch-up; the object returns to touching up. `photos` are absolute paths on
    /// this Mac, sent only to a companion with `objectsCreate` (it copies them into the project).
    func correctObject(_ id: String, note: String, photos: [String] = []) async throws -> StmObject {
        var params: [String: JSONValue] = ["id": .string(id), "note": .string(note)]
        if !photos.isEmpty { params["photos"] = .array(photos.map(JSONValue.string)) }
        let result: ObjectReply = try await call("objects.correct", params); return result.object
    }
    /// A new project started on this Mac (`capabilities.objectsCreate`). Files follow with `addFile`, then `startObject`.
    /// `kind` (`fit` or `copy`) only to a companion with `structuredPasses`; an older one refuses the field.
    func createObject(instructions: String?, kind: String? = nil) async throws -> StmObject {
        var params: [String: JSONValue] = [:]
        if let instructions, !instructions.isEmpty { params["instructions"] = .string(instructions) }
        if let kind { params["kind"] = .string(kind) }
        let result: ObjectReply = try await call("objects.create", params); return result.object
    }
    /// Copies a file on this Mac into the project: `photos` (JPEG, HEIC, PNG) or `scan` (STL, 3MF, USDZ).
    func addFile(_ id: String, kind: String, path: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.addFile", ["id": .string(id), "kind": .string(kind), "path": .string(path)])
        return result.object
    }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.answerCloseup", ["id": .string(id), "bestGuess": .bool(bestGuess)]); return result.object
    }
    /// Prints the current model; the plate is checked in the background. `checked` only after an
    /// uncertain print, once the user has looked at the printer. Like every mutation, a deadline after
    /// sending has an unknown outcome: read the object again, never resend.
    func printObject(_ id: String, checked: Bool = false) async throws -> StmObject {
        var params: [String: JSONValue] = ["id": .string(id)]
        if checked { params["checked"] = .bool(true) }
        let result: ObjectReply = try await call("objects.print", params); return result.object
    }
    func printObject(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> StmObject {
        let value: [String: JSONValue] = ["slot":.number(Double(filament.slot)), "colour":.string(filament.colour),
            "material":.string(filament.material), "name":.string(filament.name), "filamentId":.string(filament.filamentId), "destinationId":.string(filament.destinationId)]
        let result: ObjectReply = try await call("objects.print", ["id":.string(id), "checked":.bool(checked), "filament":.object(value)])
        return result.object
    }
    /// Removes the object and its folder from this Mac. Refused (`conflict`) while it is printing.
    func deleteObject(_ id: String) async throws {
        struct Deleted: Decodable { let deleted: Bool }
        let result: Deleted = try await call("objects.delete", ["id": .string(id)])
        guard result.deleted else { throw ControlRemoteError(code: "conflict", message: "") }
    }
    /// The user says the plate is clear: the printer has no camera, or the check saw something that isn't there.
    func answerPlate(_ id: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.answerPlate", ["id": .string(id)]); return result.object
    }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> StmObject {
        var value: [String: JSONValue] = ["action": .string(answer.action.rawValue)]
        if let content = answer.content { value["content"] = .object(content.mapValues(JSONValue.bool)) }
        let result: ObjectReply = try await call("objects.answerPrintConfirmation", [
            "id": .string(id), "confirmationId": .string(confirmationId), "answer": .object(value)
        ])
        return result.object
    }
}

public struct PrintConfirmationAnswer: Sendable, Equatable {
    public enum Action: String, Sendable { case accept, decline, cancel }
    public let action: Action
    public let content: [String: Bool]?
    public init(action: Action, content: [String: Bool]? = nil) { self.action = action; self.content = content }
}

/// Local checkbox state belongs to one question; camera analysis never populates it.
public struct PrintConfirmationDraft: Sendable, Equatable {
    public let confirmationId: String
    public var values: [String: Bool] = [:]
    public init(_ question: StmObject.PrintConfirmation) { confirmationId = question.id }
    public func answer(for question: StmObject.PrintConfirmation, at nowMs: Double) -> PrintConfirmationAnswer? {
        guard question.id == confirmationId, question.canAccept(values, at:nowMs) else { return nil }
        return PrintConfirmationAnswer(action:.accept, content:question.fields.reduce(into:[:]) { $0[$1.name] = values[$1.name] ?? false })
    }
}

public struct PrinterDestination: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let backend: String
    public let model: String?
    public let address: String?
    public let source: String
    /// `ready`, `busy`, `offline` or `unknown`, once the companion's printer sessions report it.
    public let state: String?
    /// Which client config it came from: `printer-handoff`, `claude-code`, `claude-desktop`, `cursor`, `codemode`, `codex`.
    public let origin: String?
    public let capabilities: PrinterCapabilities?
    /// The MCP that reaches this printer, as people know it.
    public var mcpName: String {
        switch backend {
        case "bambu", "bambu-printer-mcp": return "bambu-printer-mcp"
        default: return "mcp-3D-printer-server"
        }
    }
    private enum CodingKeys: String, CodingKey { case id, name, backend, model, address, source, state, origin, capabilities }
    public init(id: String, name: String, backend: String, model: String? = nil, address: String? = nil, source: String = "mcp-profile",
                state: String? = nil, origin: String? = nil, capabilities: PrinterCapabilities? = nil) {
        self.id = id; self.name = name; self.backend = backend; self.model = model; self.address = address; self.source = source
        self.state = state; self.origin = origin; self.capabilities = capabilities
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        backend = try values.decode(String.self, forKey: .backend)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        address = try values.decodeIfPresent(String.self, forKey: .address)
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "mcp-profile"
        state = try? values.decodeIfPresent(String.self, forKey: .state)
        origin = try? values.decodeIfPresent(String.self, forKey: .origin)
        capabilities = try? values.decodeIfPresent(PrinterCapabilities.self, forKey: .capabilities)
    }
}

/// What a printer's installed MCP can do (PRD §8.2), read by the companion from its tool list.
public struct PrinterCapabilities: Decodable, Sendable, Equatable {
    public struct Update: Decodable, Sendable, Equatable {
        public let message: String
        public let package: String
        public let command: [String]?
    }
    public let progress: Bool
    public let layers: Bool?
    /// `bambu-tcp`, `rtsp`, `http-snapshot` or `none`.
    public let camera: String
    /// `ams`, `single` or `none`.
    public let filaments: String
    public let pause: Bool, resume: Bool, cancel: Bool
    public let quality: Bool, strength: Bool
    public let multiColour: Bool?
    public let missing: [String]?
    public let update: Update?
}
public struct PrinterCatalog: Decodable, Sendable, Equatable {
    public let destinations: [PrinterDestination]
    public let defaultDestinationId: String
    public init(destinations: [PrinterDestination], defaultDestinationId: String) {
        self.destinations = destinations; self.defaultDestinationId = defaultDestinationId
    }
}
