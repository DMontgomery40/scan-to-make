import Foundation

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
    public struct Pass: Decodable, Sendable, Equatable {
        public let startedAtMs: Double
        public let endedAtMs: Double?
        public let note: String?, status: String?, summary: String?
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
    /// Set while a print waits for the user: something is on the plate, or the printer has no camera.
    public struct Plate: Decodable, Sendable, Equatable {
        public let item: String?
        public let noCamera: Bool?
        /// `plate.jpg` is in the object's folder while this is true.
        public let photo: Bool?
    }
    /// The last print. `uncertain`: it may have reached the printer, so it is only sent again with `checked`.
    public struct Print: Decodable, Sendable, Equatable {
        public let bundleId: String?
        public let uncertain: Bool?
    }

    public let id: String
    public let createdAtMs: Double, updatedAtMs: Double
    public let instructions: String?
    public let state: State
    public let scan: String?
    public let photos: [String]
    public let passes: [Pass]
    public let current: Current?
    public let question: Question?
    public let plate: Plate?
    public let failure: String?
    public let print: Print?
    /// The object's folder on this Mac (absolute).
    public let directory: String

    private enum CodingKeys: String, CodingKey {
        case id, createdAtMs, updatedAtMs, instructions, state, scan, photos, passes, current, question, plate, failure, print, directory
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
        passes = try values.decodeIfPresent([Pass].self, forKey: .passes) ?? []
        current = try values.decodeIfPresent(Current.self, forKey: .current)
        question = try values.decodeIfPresent(Question.self, forKey: .question)
        plate = try values.decodeIfPresent(Plate.self, forKey: .plate)
        failure = try values.decodeIfPresent(String.self, forKey: .failure)
        print = try values.decodeIfPresent(Print.self, forKey: .print)
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
    /// The printer camera's photo of the plate, while the print waits on what it shows.
    public var platePhotoURL: URL? { plate?.photo == true ? file("plate.jpg") : nil }
}

public extension ControlClient {
    private struct ObjectList: Decodable { let objects: [StmObject] }
    private struct ObjectReply: Decodable { let object: StmObject }

    /// Every object on this Mac, newest first. Refused with `unavailable` when objects aren't set up here.
    func objects() async throws -> [StmObject] {
        let result: ObjectList = try await call("objects.list"); return result.objects
    }
    func object(_ id: String) async throws -> StmObject {
        let result: ObjectReply = try await call("objects.get", ["id": .string(id)]); return result.object
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
}
