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

/// One filament of a multi-part model, with the spool the companion suggests for it (`objects.colourMapping`).
public struct ModelColourFilament: Codable, Sendable, Identifiable, Equatable {
    /// 1-based project filament, as the 3MF numbers them.
    public let index: Int
    public let name: String?
    /// The colour this part belongs in, `#RRGGBB`, when the model or its design pass says one.
    public let colour: String?
    public let material: String?
    /// The suggested spool's absolute slot; nil when nothing is loaded.
    public let slot: Int?
    /// How far the suggested spool's colour is from `colour` (0 exact); nil when the colour is unknown.
    public let distance: Double?
    public let materialMismatch: Bool?
    /// No colour was known: the suggestion is only a starting point.
    public let guessed: Bool?
    public var id: Int { index }
    public init(index: Int, name: String? = nil, colour: String? = nil, material: String? = nil, slot: Int? = nil,
                distance: Double? = nil, materialMismatch: Bool? = nil, guessed: Bool? = nil) {
        self.index = index; self.name = name; self.colour = colour; self.material = material
        self.slot = slot; self.distance = distance; self.materialMismatch = materialMismatch; self.guessed = guessed
    }
}

/// A multi-part model's filaments and the printer's loaded spools: which spool each colour prints from.
public struct ColourMapping: Codable, Sendable, Equatable {
    public let filaments: [ModelColourFilament]
    public let trays: [PrinterFilament]
    /// The model version these rows describe; sent back with Print so a redesign can't inherit old choices.
    public let modelVersion: String?
    public init(filaments: [ModelColourFilament], trays: [PrinterFilament], modelVersion: String? = nil) {
        self.filaments = filaments; self.trays = trays; self.modelVersion = modelVersion
    }
    /// The companion's nearest-colour suggestion per filament index: what the sheet starts with.
    public var suggestedSlots: [Int: Int] {
        Dictionary(uniqueKeysWithValues: filaments.compactMap { filament in filament.slot.map { (filament.index, $0) } })
    }
    /// The chosen spools in filament order, when every colour has one: what Print and Estimate send.
    public func spools(slots: [Int: Int]) -> [PrinterFilament]? {
        guard !filaments.isEmpty else { return nil }
        let choices = filaments.compactMap { filament in trays.first { $0.slot == slots[filament.index] } }
        return choices.count == filaments.count ? choices : nil
    }
    /// AMS trays and the external spool (slot 254+) can't feed one print together; the companion refuses the mix.
    public static func mixesFeedSources(slots: [Int: Int]) -> Bool {
        let external = slots.values.map { $0 >= 254 }
        return external.contains(true) && external.contains(false)
    }
}

/// What the print sheet asks for (PRD §5.5, §8.5). Standard quality and strength send nothing, so the MCP's preset decides.
public struct PrintSettings: Sendable, Equatable {
    public enum Quality: String, Sendable, CaseIterable { case draft, standard, fine }
    public enum Strength: String, Sendable, CaseIterable { case standard, strong, max }
    public enum Colour: Sendable, Equatable { case auto, amsSlot(Int), external, material(String) }
    public var quality: Quality
    public var strength: Strength
    public var colour: Colour?
    /// How many on the plate (`capabilities.printCopies`), only when the person picked a number: nil sends nothing,
    /// so the printer profile's own count applies (one named overrides a profile set to three, KAN-214 #230).
    public var copies: Int?
    /// Pause before these 1-based layers, as the slicer preview numbers them: the printer stops there by itself.
    public var pauseBeforeLayers: [Int]
    /// The sheet's estimate (`PrintEstimate.sliceSha256`): Print sends exactly that sliced file, the one its preview showed.
    public var sliceSha256: String?
    public init(quality: Quality = .standard, strength: Strength = .standard, colour: Colour? = nil, copies: Int? = nil, pauseBeforeLayers: [Int] = [], sliceSha256: String? = nil) {
        self.quality = quality; self.strength = strength; self.colour = colour; self.copies = copies; self.pauseBeforeLayers = pauseBeforeLayers
        self.sliceSha256 = sliceSha256
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
        if let copies { params["copies"] = .number(Double(copies)) }
        let pauses = Array(Set(pauseBeforeLayers.filter { $0 >= 2 })).sorted()
        if !pauses.isEmpty { params["pauseBeforeLayers"] = .array(pauses.map { .number(Double($0)) }) }
        if let sliceSha256 { params["sliceSha256"] = .string(sliceSha256) }
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
    /// Bambu Studio's own warning on this slice, word for word (KAN-224), such as a floating cantilever. Print still
    /// goes ahead: the run asks "Print anyway" with the same words.
    public let slicerWarning: String?
    /// The SHA-256 of this estimate's sliced file: Print sends it (`PrintSettings.sliceSha256`) and prints exactly that file.
    public let sliceSha256: String?
    /// The printer MCP's pictures of that file's G-code: what will print. Absent when the MCP can't draw them.
    public let preview: PrintPreview?

    public init(destinationId: String, quality: String, strength: String, seconds: Double? = nil, grams: Double? = nil, layers: Int? = nil,
                layerHeightMm: Double? = nil, infillPercent: Double? = nil, wallLoops: Int? = nil, slicerWarning: String? = nil,
                sliceSha256: String? = nil, preview: PrintPreview? = nil) {
        self.destinationId = destinationId; self.quality = quality; self.strength = strength; self.seconds = seconds; self.grams = grams
        self.layers = layers; self.layerHeightMm = layerHeightMm; self.infillPercent = infillPercent; self.wallLoops = wallLoops
        self.slicerWarning = slicerWarning; self.sliceSha256 = sliceSha256; self.preview = preview
    }
}

/// What will print, drawn by the printer MCP from the exact sliced G-code (never a thumbnail or a design render).
public struct PrintPreview: Decodable, Sendable, Equatable {
    public struct View: Decodable, Sendable, Equatable, Identifiable {
        /// `top` (as it sits on the bed) or `bed_side` (the face on the bed, turned over toward you).
        public let name: String
        public let label: String
        /// PNG, base64.
        public let png: String
        public let width: Int
        public let height: Int
        public var id: String { name }
        public var pngData: Data? { Data(base64Encoded: png) }
    }
    public let sha256: String
    public let views: [View]
}

/// What the print sheet shows under its settings for one estimate (PRD §5.5): the numbers, Studio's warning, or
/// Studio's refusal. A refusal (`slicer-error`) holds Print for that file; every other failure leaves Print on.
public enum EstimateOutcome: Sendable, Equatable {
    case estimate(PrintEstimate)
    /// Bambu Studio refused to slice this model: its words, verbatim.
    case refused(String)
    /// Any other failure: the companion's words, or a plain fallback. Printing slices it again anyway.
    case unavailable(String)

    public init(error: Error) {
        let remote = error as? ControlRemoteError
        let trimmed = remote?.message.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let words = trimmed.isEmpty ? nil : trimmed
        if remote?.code == "slicer-error", let words { self = .refused(words) }
        else { self = .unavailable(words ?? "No estimate right now. Your printer MCP slices it when you print.") }
    }
    /// Print stays possible unless Studio refused this exact slice.
    public var holdsPrint: Bool { if case .refused = self { return true } else { return false } }
}

/// One project, as CounterpartKit's shared model (`Project`, the same type the phone reads), with `directory`, its
/// folder on this Mac, which only the control socket sends. These are the files the Mac shows from that folder.
public extension Project {
    /// A file named by the companion, kept inside the project's folder.
    func file(_ relative: String) -> URL? {
        let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard let directory, directory.hasPrefix("/"), !relative.isEmpty, !relative.hasPrefix("/"),
              !parts.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else { return nil }
        return URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(relative)
    }
    /// The project's folder on this Mac.
    var folderURL: URL? { directory.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil } }
    /// The current model: exactly what will print (an STL, or a multi-part model's 3MF).
    var modelURL: URL? { current.flatMap { file($0.model) } }
    /// What Open in Blender sends. Blender imports STL, so a design whose model is a
    /// multi-colour 3MF opens its merged mesh, saved beside the 3MF — never the 3MF itself.
    /// Nil when there is no STL to open (a published 3MF), so the action can say so honestly.
    var blenderModelURL: URL? {
        guard let url = modelURL else { return nil }
        if url.pathExtension.lowercased() == "stl" { return url }
        return file("current/model.stl").flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
    }
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
    /// A multi-part model's filaments, the loaded spools, and the suggested spool for each colour.
    func colourMapping(_ id: String) async throws -> ColourMapping {
        try await call("objects.colourMapping", ["id":.string(id)])
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
    func correctObject(_ id: String, note: String, photos: [String] = [], photoNames: [String]? = nil) async throws -> Project {
        var params: [String: JSONValue] = ["id": .string(id), "note": .string(note)]
        if !photos.isEmpty { params["photos"] = .array(photos.map(JSONValue.string)) }
        if let photoNames { params["photoNames"] = .array(photoNames.map(JSONValue.string)) }
        let client = try ControlClient(socketPath: socketPath, timeout: max(timeout, Self.timeout(for: "objects.correct")))
        let result: ObjectReply = try await client.call("objects.correct", params); return result.object
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
    func addFile(_ id: String, kind: String, path: String, forMessage: Bool = false) async throws -> Project {
        var params: [String: JSONValue] = ["id": .string(id), "kind": .string(kind), "path": .string(path)]
        if forMessage { params["forMessage"] = .bool(true) }
        let result: ObjectReply = try await call("objects.addFile", params)
        return result.object
    }
    /// The companion may sanitize or disambiguate a local filename. Only its receipt identifies this upload.
    func addPhotoFile(_ id: String, path: String, forMessage: Bool = false) async throws -> String {
        struct Receipt: Decodable { let photoName: String? }
        var params: [String: JSONValue] = ["id": .string(id), "kind": .string("photos"), "path": .string(path)]
        if forMessage { params["forMessage"] = .bool(true) }
        let receipt: Receipt = try await call("objects.addFile", params)
        guard let name = receipt.photoName, !name.isEmpty else {
            throw ControlRemoteError(code: "not-supported", message: "Update Counterpart on your Mac to answer with these photos.")
        }
        return name
    }
    func answerCloseup(_ id: String, bestGuess: Bool, photoNames: [String] = []) async throws -> Project {
        let result: ObjectReply = try await call("objects.answerCloseup", ["id": .string(id), "bestGuess": .bool(bestGuess), "photoNames": .array(photoNames.map(JSONValue.string))]); return result.object
    }
    /// Prints the current model. `checked` only after an
    /// uncertain print, once the user has looked at the printer. Like every mutation, a deadline after
    /// sending has an unknown outcome: read the object again, never resend.
    func printObject(_ id: String, checked: Bool = false) async throws -> Project {
        var params: [String: JSONValue] = ["id": .string(id)]
        if checked { params["checked"] = .bool(true) }
        let result: ObjectReply = try await call("objects.print", params); return result.object
    }
    func printObject(_ id: String, checked: Bool, filament: PrinterFilament) async throws -> Project {
        let result: ObjectReply = try await call("objects.print", ["id":.string(id), "checked":.bool(checked), "filament": Self.value(filament)])
        return result.object
    }
    /// Prints a multi-part model with the spool chosen for each of its filaments, in filament order.
    func printObject(_ id: String, checked: Bool, settings: PrintSettings, filaments: [PrinterFilament], modelVersion: String? = nil, expectedPlate: String? = nil) async throws -> Project {
        var params = settings.params
        // As the settings send does: Standard is a choice too, never the saved default in disguise.
        params["quality"] = .string(settings.quality.rawValue); params["strength"] = .string(settings.strength.rawValue)
        params["id"] = .string(id)
        if checked { params["checked"] = .bool(true) }
        params["filaments"] = .array(filaments.map(Self.value))
        if let expectedPlate { params["expectedPlate"] = .string(expectedPlate) }
        if let modelVersion { params["filamentsModelVersion"] = .string(modelVersion) }
        let result: ObjectReply = try await call("objects.print", params)
        return result.object
    }
    private static func value(_ filament: PrinterFilament) -> JSONValue {
        .object(["slot":.number(Double(filament.slot)), "colour":.string(filament.colour),
            "material":.string(filament.material), "name":.string(filament.name), "filamentId":.string(filament.filamentId), "destinationId":.string(filament.destinationId)])
    }
    /// Prints with the sheet's settings (`capabilities.printSettings`). A deadline after sending has an unknown outcome.
    func printObject(_ id: String, checked: Bool, settings: PrintSettings, overrideDefaults: Bool = false, expectedPlate: String? = nil) async throws -> Project {
        var params = settings.params
        if let expectedPlate { params["expectedPlate"] = .string(expectedPlate) }
        if overrideDefaults { params["quality"] = .string(settings.quality.rawValue); params["strength"] = .string(settings.strength.rawValue) }
        params["id"] = .string(id)
        if checked { params["checked"] = .bool(true) }
        let result: ObjectReply = try await call("objects.print", params)
        return result.object
    }
    /// Slices the current model as a Print with these settings would, without printing. Up to 180 s.
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength, copies: Int? = nil,
                  filaments: [PrinterFilament] = [], modelVersion: String? = nil) async throws -> PrintEstimate {
        var params: [String: JSONValue] = ["id": .string(id), "quality": .string(quality.rawValue), "strength": .string(strength.rawValue)]
        if let destinationId { params["destinationId"] = .string(destinationId) }
        if let copies { params["copies"] = .number(Double(copies)) }
        if !filaments.isEmpty { params["filaments"] = .array(filaments.map(Self.value)) }
        if let modelVersion { params["filamentsModelVersion"] = .string(modelVersion) }
        return try await call("objects.estimate", params)
    }
    /// Pause, resume or cancel this project's print (`capabilities.printControl`).
    func controlPrint(_ id: String, _ action: PrintControl) async throws -> Project {
        let result: ObjectReply = try await call(action.method, ["id": .string(id)]); return result.object
    }
    /// Copies the current model and project preferences, leaving the source and its print history alone.
    func duplicateObject(_ id: String) async throws -> Project {
        let result: ObjectReply = try await call("objects.duplicate", ["id": .string(id)])
        return result.object
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

/// `printers.route`: how a destination's printer MCP reaches the printer. The MCP keeps this setting
/// (bambu-printer-mcp `counterpart_print_route`); Counterpart only shows and changes it.
public struct PrintRoute: Decodable, Sendable, Equatable {
    /// One connection as the MCP describes it: its own label, whether it can be chosen and what controls do on it.
    public struct Option: Decodable, Sendable, Equatable {
        public let id: String
        public let label: String
        public let available: Bool
        public let reason: String?
        public let controls: String?
        public init(id: String, label: String, available: Bool, reason: String? = nil, controls: String? = nil) {
            self.id = id; self.label = label; self.available = available; self.reason = reason; self.controls = controls
        }
    }
    /// `lan` (the local network), `cloud` (Bambu Cloud), `developer` (LAN Only + Developer Mode), or a newer id.
    public let route: String
    /// The MCP's connection mode and type, for example `bambu_network` / `lan`.
    public let mode: String
    public let type: String
    public let choices: [String]
    /// Every connection with the MCP's own words; nil from an MCP that only reports `choices`.
    public let options: [Option]?
    /// The config file the MCP saved it to; nil when it has none to update.
    public let savedTo: String?
    public init(route: String, mode: String, type: String, choices: [String], options: [Option]? = nil, savedTo: String? = nil) {
        self.route = route; self.mode = mode; self.type = type; self.choices = choices; self.options = options; self.savedTo = savedTo
    }
}

public extension ControlClient {
    /// Reads, or with `route` changes, the destination MCP's print route. Nil when that MCP has no route choice.
    func printRoute(_ destinationId: String, route: String? = nil) async throws -> PrintRoute? {
        struct Reply: Decodable { let route: PrintRoute? }
        var params: [String: JSONValue] = ["destinationId": .string(destinationId)]
        if let route { params["route"] = .string(route) }
        let reply: Reply = try await call("printers.route", params)
        return reply.route
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
        case "objects.pausePrint", "objects.resumePrint", "objects.cancelPrint": return 740 // 730 s on the companion: the printer's question may stay open 10 min
        case "printers.route": return 35 // 25 s on the companion: it may start the MCP's session first
        case "printers.mcps": return 15 // it looks for copies in the home folder
        case "printers.installMcp", "printers.discover": return 25 // 15 s on the companion (npm lookup 7 s; discovery about 4 s)
        case "printers.check": return 70 // 60 s on the companion: it starts the MCP, then reads status and the camera
        case "printers.add", "printers.remove", "printers.chooseMcp", "printers.completeSettings": return 40 // 30 s on the companion
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
    /// The same printer reached through both MCPs: the profile for each, the one in use first (`printers.chooseMcp`).
    public let mcps: [McpChoice]?
    /// A printer added in Counterpart: the folder its MCP runs in (its `.env` holds the settings).
    public let folder: String?
    /// Its `.env` lacks settings its MCP needs: their names, and what Complete Settings adds (only the model).
    public let incomplete: Incomplete?
    public struct Incomplete: Decodable, Sendable, Equatable {
        public let missing: [String]
        public let fill: [String: String]
        public init(missing: [String], fill: [String: String] = [:]) { self.missing = missing; self.fill = fill }
    }
    public struct McpChoice: Decodable, Sendable, Equatable {
        public let backend: String
        public let destinationId: String
        public init(backend: String, destinationId: String) { self.backend = backend; self.destinationId = destinationId }
    }
    /// The MCP that reaches this printer, as people know it.
    public var mcpName: String {
        switch backend {
        case "bambu", "bambu-printer-mcp": return "bambu-printer-mcp"
        default: return "mcp-3D-printer-server"
        }
    }
    private enum CodingKeys: String, CodingKey { case id, name, backend, model, address, source, state, origin, capabilities, mcpId, mcps, folder, incomplete }
    public init(id: String, name: String, backend: String, model: String? = nil, address: String? = nil, source: String = "mcp-profile",
                state: String? = nil, origin: String? = nil, capabilities: PrinterCapabilities? = nil, mcpId: String? = nil,
                mcps: [McpChoice]? = nil, folder: String? = nil, incomplete: Incomplete? = nil) {
        self.id = id; self.name = name; self.backend = backend; self.model = model; self.address = address; self.source = source
        self.state = state; self.origin = origin; self.capabilities = capabilities; self.mcpId = mcpId; self.mcps = mcps; self.folder = folder
        self.incomplete = incomplete
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
        mcps = try? values.decodeIfPresent([McpChoice].self, forKey: .mcps)
        folder = try? values.decodeIfPresent(String.self, forKey: .folder)
        incomplete = try? values.decodeIfPresent(Incomplete.self, forKey: .incomplete)
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
    /// This printer's MCP can put several on the plate (`slice_stl` `repetitions`, KAN-214 PR 8b).
    public let copies: Bool?
    /// slice_stl takes pause_at_layers: the print sheet offers Pause before a layer.
    public var layerPauses: Bool? = nil
    public let materialChoice: Bool?
    public let missing: [String]?
    public let update: Update?
    public init(server: Server? = nil, progress: Bool = true, layers: Bool? = nil, camera: String = "none", filaments: String = "none",
                pause: Bool = false, resume: Bool = false, cancel: Bool = false, quality: Bool = false, strength: Bool = false,
                multiColour: Bool? = nil, copies: Bool? = nil, materialChoice: Bool? = nil, missing: [String]? = nil, update: Update? = nil) {
        self.server = server; self.progress = progress; self.layers = layers; self.camera = camera; self.filaments = filaments
        self.pause = pause; self.resume = resume; self.cancel = cancel; self.quality = quality; self.strength = strength
        self.multiColour = multiColour; self.copies = copies; self.materialChoice = materialChoice; self.missing = missing; self.update = update
    }
}
public struct PrinterCatalog: Decodable, Sendable, Equatable {
    public let destinations: [PrinterDestination]
    public let defaultDestinationId: String
    public init(destinations: [PrinterDestination], defaultDestinationId: String) {
        self.destinations = destinations; self.defaultDestinationId = defaultDestinationId
    }
}

public extension PrintSettings {
    /// Print Another (PRD §5.4): the settings the last print was sent with, so a reprint is the same print. Standard,
    /// and the suggested colour, for what it didn't record.
    init(last: Project.Print?) {
        self.init(saved: last?.settings)
    }

    init(saved: CounterpartKit.PrintSettings?) {
        var colour: Colour?
        if case .object(let value)? = saved?.colour {
            if case .number(let slot)? = value["amsSlot"] { colour = .amsSlot(Int(slot)) }
            else if value["external"] == .bool(true) { colour = .external }
            else if case .string(let material)? = value["material"] { colour = .material(material) }
            else if value["auto"] == .bool(true) { colour = .auto }
        }
        self.init(quality: saved?.quality.flatMap(Quality.init(rawValue:)) ?? .standard,
                  strength: saved?.strength.flatMap(Strength.init(rawValue:)) ?? .standard, colour: colour, copies: saved?.copies)
    }

    /// The spool the last print used: the same slot when it is the same printer, or a loaded spool of the material it
    /// was sliced for (the suggested one first). Nil for the suggestion again, or when nothing loaded matches.
    static func lastSlot(_ colour: Colour?, lastPrinter: String?, printer: String?, in filaments: [PrinterFilament]) -> Int? {
        let samePrinter = lastPrinter != nil && lastPrinter == printer
        switch colour {
        case .amsSlot(let slot)? where samePrinter: return filaments.first { $0.slot == slot && !$0.external }?.slot
        case .external? where samePrinter: return filaments.first(where: \.external)?.slot
        case .material(let material)?:
            let matching = filaments.filter { $0.material.caseInsensitiveCompare(material) == .orderedSame }
            return (matching.first { $0.suggested == true } ?? matching.first)?.slot
        default: return nil
        }
    }
}

public extension ControlClient {
    func blenderAddon(_ action: BlenderAddonStatus.Action = .status) async throws -> BlenderAddonStatus {
        struct Reply: Decodable { let blender: BlenderAddonStatus }
        let reply: Reply = try await call("blender." + action.rawValue)
        return reply.blender
    }
}

/// `printers.mcps`: one of the two printer MCPs, and whether this Mac has a copy of it (a printer's, the app's own,
/// or a folder of its own). One it hasn't is offered as Download.
public struct PrinterMcpPackage: Decodable, Sendable, Equatable, Identifiable {
    public struct Install: Decodable, Sendable, Equatable {
        /// `npx`, `global`, `app`, `checkout` or `folder`.
        public let kind: String
        public let path: String?
        public let version: String?
        public init(kind: String, path: String? = nil, version: String? = nil) { self.kind = kind; self.path = path; self.version = version }
    }
    /// The npm package: `bambu-printer-mcp` or `mcp-3d-printer-server`.
    public let package: String
    /// As people know it: `mcp-3D-printer-server`.
    public let label: String
    public let description: String
    public let installed: Bool
    public let version: String?
    public let latestVersion: String?
    /// The id Download's `mcp.update.*` events carry.
    public let appMcpId: String
    public let installs: [Install]
    public var id: String { package }
    public init(package: String, label: String, description: String, installed: Bool, version: String? = nil, latestVersion: String? = nil,
                appMcpId: String, installs: [Install] = []) {
        self.package = package; self.label = label; self.description = description; self.installed = installed; self.version = version
        self.latestVersion = latestVersion; self.appMcpId = appMcpId; self.installs = installs
    }
}

/// Download's answer: already on this Mac, or the install it started (its progress comes as `mcp.update.*` events).
public enum McpInstallReply: Sendable {
    case installed
    case started(McpUpdate)
}

public extension ControlClient {
    /// Settings → Printers, Printer MCPs: both packages, always.
    func printerMcps() async throws -> [PrinterMcpPackage] { try await printerSetupState().packages }
    /// `printers.mcps` in full: the packages, and the choices Add printer… and Complete Settings offer.
    func printerSetupState() async throws -> (packages: [PrinterMcpPackage], options: PrinterSetupOptions?) {
        struct Reply: Decodable { let packages: [PrinterMcpPackage]; let options: PrinterSetupOptions? }
        let reply: Reply = try await call("printers.mcps")
        return (reply.packages, reply.options)
    }

    /// Download: installs only `package`, into the app's own copy, when this Mac has no copy of it.
    func installPrinterMcp(_ package: String) async throws -> McpInstallReply {
        struct Reply: Decodable { let installed: Bool?; let update: McpUpdate? }
        let reply: Reply = try await call("printers.installMcp", ["package": .string(package)])
        if let update = reply.update { return .started(update) }
        return .installed
    }
}

/// Add printer…: what the sheet offers, from the printer MCPs (`printers.discover` `options`).
public struct PrinterSetupOptions: Decodable, Sendable, Equatable {
    public struct Secret: Decodable, Sendable, Equatable {
        public let label: String
        public let hint: String
        public let required: Bool
    }
    /// A brand or host software: mcp-3D-printer-server's `PRINTER_TYPE`, and the MCPs that can reach it (the default first).
    public struct PrinterType: Decodable, Sendable, Equatable, Identifiable {
        public let printerType: String
        public let label: String
        public let backends: [String]
        /// It needs a serial number and a model (Bambu Lab).
        public let serial: Bool
        public let secret: Secret?
        public var id: String { printerType }
    }
    public struct Model: Decodable, Sendable, Equatable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { value }
    }
    public let types: [PrinterType]
    /// Each MCP's own model names, by package.
    public let models: [String: [Model]]
    /// A Bambu serial number's first three characters → its model (bambu-printer-mcp's own table).
    public let serialModels: [String: String]?
    /// The model a typed serial number names, when it is one the MCP knows.
    public func model(forSerial serial: String) -> String? {
        let prefix = String(serial.trimmingCharacters(in: .whitespaces).prefix(3)).uppercased()
        return prefix.count == 3 ? serialModels?[prefix] : nil
    }
}

/// A printer Add printer… found: a configured MCP folder on this Mac, or a printer on the network. Never a secret.
public struct PrinterCandidate: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    /// `folder`, `ssdp` or `bonjour`.
    public let source: String
    public let name: String
    public let backend: String
    public let printerType: String
    public let model: String?
    public let host: String?
    public let port: String?
    public let serial: String?
    /// A configured MCP folder: Add runs it where it is, in one click.
    public let folder: String?
    /// Already one of the printers.
    public let added: Bool
    /// A folder whose `.env` lacks settings its MCP needs (names only), and what Add fills (only the model).
    public let missing: [String]?
    public let fill: [String: String]?
    /// Its MCP needs a model Counterpart couldn't tell: the sheet asks.
    public var needsModel: Bool { missing?.contains("BAMBU_MODEL") == true && fill?["BAMBU_MODEL"] == nil }
}

public struct PrinterDiscovery: Decodable, Sendable, Equatable {
    public let found: [PrinterCandidate]
    /// `unavailable` when this Mac couldn't listen for Bambu printers (another app may hold the port).
    public let network: String
    public let options: PrinterSetupOptions
}

/// What Check and Add send: a found folder, or the form's fields. `secret` is the access code or API key.
public struct PrinterForm: Sendable, Equatable {
    public var folder: String?
    public var backend = "bambu-printer-mcp"
    public var printerType = "bambu"
    public var host = ""
    public var port: String?
    public var serial = ""
    public var model: String?
    public var secret = ""
    public var name: String?
    public init(folder: String? = nil) { self.folder = folder }
    public var json: JSONValue {
        if let folder { return .object(["folder": .string(folder)].merging(model.map { ["model": .string($0)] } ?? [:]) { $1 }) }
        var value: [String: JSONValue] = ["backend": .string(backend), "printerType": .string(printerType), "host": .string(host.trimmingCharacters(in: .whitespaces))]
        if let port, !port.isEmpty { value["port"] = .string(port) }
        if printerType == "bambu" {
            value["serial"] = .string(serial.trimmingCharacters(in: .whitespaces))
            if let model { value["model"] = .string(model) }
        }
        if !secret.isEmpty { value["secret"] = .string(secret) }
        if let name, !name.isEmpty { value["name"] = .string(name) }
        return .object(value)
    }
}

/// Check: what get_printer_status (and, for a Bambu printer, camera_snapshot) said. Never the MCP's own words.
public struct PrinterCheckResult: Decodable, Sendable, Equatable {
    public struct Image: Decodable, Sendable, Equatable { public let mimeType: String; public let base64: String }
    public let reached: Bool
    /// `connected`, `failed` or `not-supported`.
    public let camera: String
    public let image: Image?
    public let model: String?
}

public struct PrinterAdded: Decodable, Sendable, Equatable {
    public let id: String
    /// The printer it is listed as; another one when it is the same printer through another MCP.
    public let destinationId: String?
    public let sameAs: String?
}

public extension ControlClient {
    func discoverPrinters() async throws -> PrinterDiscovery { try await call("printers.discover") }
    func checkPrinter(_ form: PrinterForm) async throws -> PrinterCheckResult {
        struct Reply: Decodable { let check: PrinterCheckResult }
        let reply: Reply = try await call("printers.check", ["printer": form.json])
        return reply.check
    }
    func addPrinter(_ form: PrinterForm) async throws -> PrinterAdded { try await call("printers.add", ["printer": form.json]) }
    func removePrinter(_ destinationId: String) async throws {
        struct Reply: Decodable { let removed: Bool }
        let _: Reply = try await call("printers.remove", ["destinationId": .string(destinationId)])
    }
    /// Adds the settings a Counterpart printer's `.env` lacks (only the model; `model` when it can't be told) and restarts its MCP.
    func completePrinterSettings(_ destinationId: String, model: String? = nil) async throws {
        struct Reply: Decodable { let destinationId: String }
        var params: [String: JSONValue] = ["destinationId": .string(destinationId)]
        if let model { params["model"] = .string(model) }
        let _: Reply = try await call("printers.completeSettings", params)
    }
    /// Which MCP a printer reachable through both uses. Returns the printer's id now.
    func choosePrinterMcp(_ destinationId: String, backend: String) async throws -> String {
        struct Reply: Decodable { let destinationId: String }
        let reply: Reply = try await call("printers.chooseMcp", ["destinationId": .string(destinationId), "backend": .string(backend)])
        return reply.destinationId
    }
}
