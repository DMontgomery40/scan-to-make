import Foundation
import CounterpartKit

public struct PrinterFilament: Codable, Sendable, Identifiable, Equatable {
    public let slot: Int
    public let colour: String, material: String, name: String, filamentId: String, destinationId: String
    /// The one tray the companion preselects, matching the profile's material (`printSettings`).
    public let suggested: Bool?
    public var id: Int { slot }
    /// Slots 254 and 255 are the external spool on a Bambu printer.
    public var external: Bool { slot >= 254 }
    public init(slot: Int, colour: String, material: String, name: String, filamentId: String, destinationId: String, suggested: Bool? = nil) {
        self.slot = slot; self.colour = colour; self.material = material; self.name = name
        self.filamentId = filamentId; self.destinationId = destinationId; self.suggested = suggested
    }
    private enum CodingKeys: String, CodingKey { case slot, colour, material, name, filamentId, destinationId }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        slot = try values.decode(Int.self, forKey: .slot)
        colour = try values.decode(String.self, forKey: .colour)
        material = try values.decode(String.self, forKey: .material)
        name = try values.decode(String.self, forKey: .name)
        filamentId = try values.decode(String.self, forKey: .filamentId)
        destinationId = try values.decode(String.self, forKey: .destinationId)
        suggested = try? decoder.container(keyedBy: SuggestedKey.self).decodeIfPresent(Bool.self, forKey: .suggested)
    }
    private enum SuggestedKey: String, CodingKey { case suggested }
}

/// What the print sheet asks for (PRD §5.5, §8.5). Standard quality and strength send nothing, so the MCP's preset decides.
public struct PrintSettings: Sendable, Equatable {
    public enum Quality: String, Sendable, CaseIterable { case draft, standard, fine }
    public enum Strength: String, Sendable, CaseIterable { case standard, strong, max }
    public enum Colour: Sendable, Equatable { case auto, amsSlot(Int), external, material(String) }
    public var quality: Quality
    public var strength: Strength
    public var colour: Colour?
    public init(quality: Quality = .standard, strength: Strength = .standard, colour: Colour? = nil) {
        self.quality = quality; self.strength = strength; self.colour = colour
    }
    /// The `objects.print` fields: standard values are left out.
    public var params: [String: JSONValue] {
        var params: [String: JSONValue] = [:]
        if quality != .standard { params["quality"] = .string(quality.rawValue) }
        if strength != .standard { params["strength"] = .string(strength.rawValue) }
        switch colour {
        case .auto?: params["colour"] = .object(["auto": .bool(true)])
        case .amsSlot(let slot)?: params["colour"] = .object(["amsSlot": .number(Double(slot))])
        case .external?: params["colour"] = .object(["external": .bool(true)])
        case .material(let material)?: params["colour"] = .object(["material": .string(material)])
        case nil: break
        }
        return params
    }
}

/// `objects.estimate`: the slice of the current model with the sheet's settings, through the printer's MCP.
public struct PrintEstimate: Decodable, Sendable, Equatable {
    public let destinationId: String
    public let quality: String
    public let strength: String
    public let seconds: Double?
    public let grams: Double?
    public let layers: Int?
    public let layerHeightMm: Double?
    public let infillPercent: Double?
    public let wallLoops: Int?
}

/// One project, as CounterpartKit's shared model (`Project`, the same type the phone reads), with `directory`, its
/// folder on this Mac, which only the control socket sends. These are the files the Mac shows from that folder.
public extension Project {
    /// A file named by the companion, kept inside the project's folder.
    private func file(_ relative: String) -> URL? {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard let directory, directory.hasPrefix("/"), !relative.isEmpty, !relative.hasPrefix("/"),
              !parts.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else { return nil }
        return URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(relative)
    }
    /// The project's folder on this Mac.
    var folderURL: URL? { directory.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil } }
    /// The current model's STL: exactly what will print.
    var modelURL: URL? { current.flatMap { file($0.model) } }
    var renderURLs: [URL] { current?.renders.compactMap(file) ?? [] }
    var photoURLs: [URL] { photos.compactMap { file("photos/\($0)") } }
    var captureURLs: [URL] { (capture ?? []).compactMap { file("capture/\($0)") } }
    /// The Ask's picture, with `ask.region` to highlight on it.
    var askPhotoURL: URL? { ask?.photo.flatMap(file) }
    /// A file the companion names relative to this project's folder (an event's `frame`).
    func projectFile(_ relative: String) -> URL? { file(relative) }
    /// The scan as it arrived (a USDZ under scan/), shown until there is a model.
    var scanURL: URL? { scan.flatMap { file("scan/\($0)") } }
}

public extension ControlClient {
    /// Read one by one, so an object this app can't read never hides the rest of the list.
    private struct ObjectList: Decodable {
        private struct Lossy: Decodable { let project: Project?; init(from decoder: Decoder) throws { project = try? Project(from: decoder) } }
        private enum CodingKeys: String, CodingKey { case objects }
        let objects: [Project]
        init(from decoder: Decoder) throws {
            objects = try decoder.container(keyedBy: CodingKeys.self).decode([Lossy].self, forKey: .objects).compactMap(\.project)
        }
    }
    private struct ObjectReply: Decodable { let object: Project }
    private struct PassActivityReply: Decodable { let activity: [Project.Activity] }

    func printers() async throws -> PrinterCatalog { try await call("objects.printers") }
    func filaments(_ id: String) async throws -> [PrinterFilament] {
        struct Result: Decodable { let filaments: [PrinterFilament] }
        let result: Result = try await call("objects.filaments", ["id":.string(id)])
        return result.filaments
    }
    func selectPrinter(_ id: String, destinationId: String) async throws -> Project {
        let result: ObjectReply = try await call("objects.selectPrinter", ["id": .string(id), "destinationId": .string(destinationId)])
        return result.object
    }
    /// Every object on this Mac, newest first. Refused with `unavailable` when objects aren't set up here.
    func objects() async throws -> [Project] {
        let result: ObjectList = try await call("objects.list"); return result.objects
    }
    func object(_ id: String) async throws -> Project {
        let result: ObjectReply = try await call("objects.get", ["id": .string(id)]); return result.object
    }
    func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] {
        let result: PassActivityReply = try await call("objects.passActivity", ["id": .string(id), "index": .number(Double(index))])
        return result.activity
    }
    /// Starts the touch-up again, after one that failed without a model.
    func startObject(_ id: String) async throws -> Project {
        let result: ObjectReply = try await call("objects.start", ["id": .string(id)]); return result.object
    }
    /// Sends a correction back to the touch-up; the object returns to touching up. `photos` are absolute paths on
    /// this Mac, sent only to a companion with `objectsCreate` (it copies them into the project).
    func correctObject(_ id: String, note: String, photos: [String] = []) async throws -> Project {
        var params: [String: JSONValue] = ["id": .string(id), "note": .string(note)]
        if !photos.isEmpty { params["photos"] = .array(photos.map(JSONValue.string)) }
        let result: ObjectReply = try await call("objects.correct", params); return result.object
    }
    /// A new project started on this Mac (`capabilities.objectsCreate`). Files follow with `addFile`, then `startObject`.
    /// `kind` (`fit` or `copy`) only to a companion with `structuredPasses`; an older one refuses the field.
    func createObject(instructions: String?, kind: String? = nil) async throws -> Project {
        var params: [String: JSONValue] = [:]
        if let instructions, !instructions.isEmpty { params["instructions"] = .string(instructions) }
        if let kind { params["kind"] = .string(kind) }
        let result: ObjectReply = try await call("objects.create", params); return result.object
    }
    /// Copies a file on this Mac into the project: `photos` (JPEG, HEIC, PNG) or `scan` (STL, 3MF, USDZ).
    func addFile(_ id: String, kind: String, path: String) async throws -> Project {
        let result: ObjectReply = try await call("objects.addFile", ["id": .string(id), "kind": .string(kind), "path": .string(path)])
        return result.object
    }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> Project {
        let result: ObjectReply = try await call("objects.answerCloseup", ["id": .string(id), "bestGuess": .bool(bestGuess)]); return result.object
    }
    /// Prints the current model; the plate is checked in the background. `checked` only after an
    /// uncertain print, once the user has looked at the printer. Like every mutation, a deadline after
    /// sending has an unknown outcome: read the object again, never resend.
    func printObject(_ id: String, checked: Bool = false) async throws -> Project {
        var params: [String: JSONValue] = ["id": .string(id)]
        if checked { params["checked"] = .bool(true) }
        let result: ObjectReply = try await call("objects.print", params); return result.object
    }
    func printObject(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> Project {
        let value: [String: JSONValue] = ["slot":.number(Double(filament.slot)), "colour":.string(filament.colour),
            "material":.string(filament.material), "name":.string(filament.name), "filamentId":.string(filament.filamentId), "destinationId":.string(filament.destinationId)]
        let result: ObjectReply = try await call("objects.print", ["id":.string(id), "checked":.bool(checked), "filament":.object(value)])
        return result.object
    }
    /// Prints with the sheet's settings (`capabilities.printSettings`). A deadline after sending has an unknown outcome.
    func printObject(_ id: String, checked: Bool, settings: PrintSettings) async throws -> Project {
        var params = settings.params
        params["id"] = .string(id)
        if checked { params["checked"] = .bool(true) }
        let result: ObjectReply = try await call("objects.print", params)
        return result.object
    }
    /// Slices the current model as a Print with these settings would, without printing. Up to 180 s.
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        var params: [String: JSONValue] = ["id": .string(id), "quality": .string(quality.rawValue), "strength": .string(strength.rawValue)]
        if let destinationId { params["destinationId"] = .string(destinationId) }
        return try await call("objects.estimate", params)
    }
    /// Pause, resume or cancel this project's print (`capabilities.printControl`).
    func controlPrint(_ id: String, _ action: PrintControl) async throws -> Project {
        let result: ObjectReply = try await call(action.method, ["id": .string(id)]); return result.object
    }
    /// Removes the object and its folder from this Mac. Refused (`conflict`) while it is printing.
    func deleteObject(_ id: String) async throws {
        struct Deleted: Decodable { let deleted: Bool }
        let result: Deleted = try await call("objects.delete", ["id": .string(id)])
        guard result.deleted else { throw ControlRemoteError(code: "conflict", message: "") }
    }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> Project {
        var value: [String: JSONValue] = ["action": .string(answer.action.rawValue)]
        if let content = answer.content {
            // CounterpartKit's values, as this client's JSON: a string, number or bool per field.
            value["content"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(content))
        }
        let result: ObjectReply = try await call("objects.answerPrintConfirmation", [
            "id": .string(id), "confirmationId": .string(confirmationId), "answer": .object(value)
        ])
        return result.object
    }
}

/// `printers.updateMcp` (PRD §8.10): the companion updates an MCP install in its own way and reports progress as
/// `mcp.update.*` events.
public struct McpUpdate: Decodable, Sendable, Equatable {
    /// `started`, `waiting` (after the current print), `current` (already the latest) or `unresolved` (it couldn't
    /// tell how this copy is installed; `found` says what it saw, and a fresh copy can be installed instead).
    public let state: String
    public let mcpId: String
    public let fromVersion: String?
    public let toVersion: String?
    public let found: String?
    public init(state: String, mcpId: String, fromVersion: String? = nil, toVersion: String? = nil, found: String? = nil) {
        self.state = state; self.mcpId = mcpId; self.fromVersion = fromVersion; self.toVersion = toVersion; self.found = found
    }
}

public extension ControlClient {
    /// Asks the companion to update one MCP install; `fresh` installs the app's own copy instead.
    func updateMcp(_ mcpId: String, fresh: Bool = false) async throws -> McpUpdate {
        struct Reply: Decodable { let update: McpUpdate }
        var params: [String: JSONValue] = ["mcpId": .string(mcpId)]
        if fresh { params["fresh"] = .bool(true) }
        let reply: Reply = try await call("printers.updateMcp", params)
        return reply.update
    }
}

public enum PrintControl: String, Sendable { case pause, resume, cancel
    public var method: String { "objects.\(rawValue)Print" }
}

public extension ControlClient {
    /// How long to wait for a method's reply: the companion's own deadline for it (local-control.md "Deadlines") plus
    /// time for the reply to arrive. `events.wait` sets its own from `timeoutMs`.
    static func timeout(for method: String) -> TimeInterval {
        switch method {
        case "objects.estimate": return 190 // it slices: 180 s on the companion
        case "objects.pausePrint", "objects.resumePrint", "objects.cancelPrint": return 140 // 130 s on the companion
        default: return 30
        }
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
    /// The MCP install this printer uses, shared by its printers (`printers.updateMcp`, PRD §8.10).
    public let mcpId: String?
    /// The MCP that reaches this printer, as people know it.
    public var mcpName: String {
        switch backend {
        case "bambu", "bambu-printer-mcp": return "bambu-printer-mcp"
        default: return "mcp-3D-printer-server"
        }
    }
    private enum CodingKeys: String, CodingKey { case id, name, backend, model, address, source, state, origin, capabilities, mcpId }
    public init(id: String, name: String, backend: String, model: String? = nil, address: String? = nil, source: String = "mcp-profile",
                state: String? = nil, origin: String? = nil, capabilities: PrinterCapabilities? = nil, mcpId: String? = nil) {
        self.id = id; self.name = name; self.backend = backend; self.model = model; self.address = address; self.source = source
        self.state = state; self.origin = origin; self.capabilities = capabilities; self.mcpId = mcpId
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
        mcpId = try? values.decodeIfPresent(String.self, forKey: .mcpId)
    }
}

/// What a printer's installed MCP can do (PRD §8.2), read by the companion from its tool list.
public struct PrinterCapabilities: Decodable, Sendable, Equatable {
    public struct Update: Decodable, Sendable, Equatable {
        public let message: String
        public let package: String
        public let command: [String]?
        /// The newest published version (`npm view`, daily and when Settings opens), once the companion checks it.
        public let latestVersion: String?
        public init(message: String, package: String, command: [String]?, latestVersion: String? = nil) {
            self.message = message; self.package = package; self.command = command; self.latestVersion = latestVersion
        }
    }
    /// The installed MCP's own name and version, from its `initialize` reply.
    public struct Server: Decodable, Sendable, Equatable {
        public let name: String; public let version: String
        public init(name: String, version: String) { self.name = name; self.version = version }
    }
    public let server: Server?
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
    public init(server: Server? = nil, progress: Bool = true, layers: Bool? = nil, camera: String = "none", filaments: String = "none",
                pause: Bool = false, resume: Bool = false, cancel: Bool = false, quality: Bool = false, strength: Bool = false,
                multiColour: Bool? = nil, missing: [String]? = nil, update: Update? = nil) {
        self.server = server; self.progress = progress; self.layers = layers; self.camera = camera; self.filaments = filaments
        self.pause = pause; self.resume = resume; self.cancel = cancel; self.quality = quality; self.strength = strength
        self.multiColour = multiColour; self.missing = missing; self.update = update
    }
}
public struct PrinterCatalog: Decodable, Sendable, Equatable {
    public let destinations: [PrinterDestination]
    public let defaultDestinationId: String
    public init(destinations: [PrinterDestination], defaultDestinationId: String) {
        self.destinations = destinations; self.defaultDestinationId = defaultDestinationId
    }
}
