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
        public let startedAtMs: Double
        public let endedAtMs: Double?
        public let note: String?, status: String?, summary: String?
        public let activity: [Activity]?
        public let activityCount: Int?
    }
    public struct Current: Decodable, Sendable, Equatable {
        /// Relative to `directory`, like `renders`.
        public let model: String
        public let renders: [String]
        /// Bounding box in millimetres, from the printer's own STL info.
        public let sizeMm: [Double]?
        public let summary: String?
        private enum CodingKeys: String, CodingKey { case model, renders, sizeMm, summary }
        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            model = try values.decode(String.self, forKey: .model)
            renders = try values.decodeIfPresent([String].self, forKey: .renders) ?? []
            sizeMm = try values.decodeIfPresent([Double].self, forKey: .sizeMm)
            summary = try values.decodeIfPresent(String.self, forKey: .summary)
        }
    }
    public struct Question: Decodable, Sendable, Equatable { public let closeup: String? }
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
        /// `plate.jpg` is in the object's folder while this is true.
        public let photo: Bool?
    }
    /// The last print. `uncertain`: it may have reached the printer, so it is only sent again with `checked`.
    public struct PrintDestination: Decodable, Sendable, Equatable { public let id: String; public let name: String }
    public struct PrinterStatus: Decodable, Sendable, Equatable { public let state: String; public let job: String?; public let checkedAtMs: Double; public let percent: Double?; public let remainingMinutes: Double? }
    public struct PrintEstimate: Decodable, Sendable, Equatable { public let seconds: Double?; public let grams: Double? }
    public struct Print: Decodable, Sendable, Equatable {
        public let printerStatus: PrinterStatus?
        public let sliced: Bool?
        public let estimate: PrintEstimate?
        public let bundleId: String?
        public let uncertain: Bool?
        public let destination: PrintDestination?
    }

    public let id: String
    public let createdAtMs: Double, updatedAtMs: Double
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
        case id, createdAtMs, updatedAtMs, instructions, state, scan, photos, capture, progress, passes, current, question, plate, printConfirmation, failure, print, printerDestinationId, directory
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        createdAtMs = try values.decodeIfPresent(Double.self, forKey: .createdAtMs) ?? 0
        updatedAtMs = try values.decodeIfPresent(Double.self, forKey: .updatedAtMs) ?? createdAtMs
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
    /// Sends a correction back to the touch-up; the object returns to touching up.
    func correctObject(_ id: String, note: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.correct", ["id": .string(id), "note": .string(note)]); return result.object
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
}
public struct PrinterCatalog: Decodable, Sendable, Equatable {
    public let destinations: [PrinterDestination]
    public let defaultDestinationId: String
}
