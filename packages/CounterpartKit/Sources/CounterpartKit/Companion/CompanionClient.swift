import Foundation

/// A refusal in one sentence a screen can show as it is.
public struct CompanionError: Error, Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }

    /// The phone has to pair (again) before anything else will work.
    public var needsPairing: Bool { ["pairing-required", "pairing-changed", "certificate-changed", "scope-denied", "pairing"].contains(code) }
    /// The Mac didn't answer: nothing is wrong with the project itself.
    public var isUnreachable: Bool { code == "unreachable" }
    /// An older Mac without this route or field.
    public var isUnsupported: Bool { code == "not-supported" }

    public static let unreachable = CompanionError(code: "unreachable", message: "Your Mac isn't answering. Check it's on and awake, then try again.")
    public static let cancelled = CompanionError(code: "cancelled", message: "Cancelled.")
    public static let unsupported = CompanionError(code: "not-supported", message: "Update Counterpart on your Mac to use this here.")

    static func transport(_ code: String) -> CompanionError {
        switch code {
        case "pairing-required", "scope-denied", "pairing-changed": .init(code: code, message: "Connect to your Mac again.")
        case "certificate-changed": .init(code: code, message: "Your Mac presented a different certificate. Scan a new QR code from it.")
        case "too-large", "payload-too-large": .init(code: "payload-too-large", message: "That file is too large to send.")
        case "invalid-request": .init(code: code, message: "That request isn't allowed.")
        case "cancelled": .cancelled
        case "network", "timeout", "certificate", "unreachable": .unreachable
        default: .init(code: code, message: "Something went wrong talking to your Mac. Try again.")
        }
    }
}

/// The companion's phone API (docs/protocols/objects-api.md), over the paired, pinned connection.
/// Credentials stay in `PairingStore`; every request carries the device token and is pinned like pairing.
public final class CompanionClient: @unchecked Sendable {
    public let pairing: PairingClient
    private let transport: HTTPTransport
    public let cache: URL
    /// `X-Scan-Device-Model`: the hardware identifier ("iPhone18,2"), shown in the Mac's device list.
    public let deviceModel: String?
    /// `X-Scan-Device-Name`: the phone's own name, percent-encoded UTF-8; absent when iOS gives only "iPhone".
    public let deviceName: String?

    public static let jsonLimit = 4 * 1024 * 1024
    public static let scanLimit = 64 * 1024 * 1024
    public static let photoLimit = 25 * 1024 * 1024
    public static let depthLimit = 8 * 1024 * 1024
    static let uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"

    public init(pairing: PairingClient, transport: HTTPTransport = PinnedTransport(), deviceModel: String? = DeviceModel.identifier, deviceName: String? = nil,
                cache: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "Objects", directoryHint: .isDirectory)) {
        self.pairing = pairing; self.transport = transport; self.cache = cache
        self.deviceModel = deviceModel.flatMap { Pattern("[A-Za-z0-9,._ -]{1,64}").matches($0) ? $0 : nil }
        // Percent-encoded as JavaScript's encodeURIComponent does, so "David’s iPhone" survives the header.
        self.deviceName = deviceName.flatMap { $0.count <= 80 ? Self.encodeURIComponent($0) : nil }
    }

    /// `encodeURIComponent`: everything but ASCII letters, digits and `-_.!~*'()` is percent-encoded (UTF-8).
    static func encodeURIComponent(_ text: String) -> String? {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return text.addingPercentEncoding(withAllowedCharacters: allowed)
    }

    // MARK: Routes and scopes

    /// The scope a route needs (its path without the query), or nil when the phone never calls it.
    static func scope(_ method: String, _ path: String) -> String? {
        let one = "/v1/objects/\(uuid)"
        func is_(_ pattern: String) -> Bool { Pattern(pattern).matches(path) }
        switch method {
        case "GET":
            if path == "/v1/printers/mcps" { return "projects:read" }
            if path == "/v1/blender" { return "projects:read" }
            if is_("/v1/objects(?:/printers)?") || is_(one) || is_(one + "/passes/(0|[1-9][0-9]{0,15})/activity") { return "projects:read" }
            if is_("/healthz") { return "generation:health" }
            if is_("/v1/events") || is_("/v1/settings") || is_("/v1/settings/cad") || is_("/v1/devices") { return "projects:read" }
            if is_(one + "/(model\\.stl|renders/[^/]+|photos/[^/]+|capture/[^/]+|scan/[^/]+|original/[0-9]+|asks/[^/]+|prints/[^/]+/frames/[^/]+)") { return "projects:read" }
            if is_(one + "/(filaments|colour-mapping|camera\\.jpg)") || is_("/v1/objects/printers/[^/]+/camera\\.jpg") { return "printer-handoff:use" }
            if is_("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/route") { return "printer-handoff:use" }
        case "PATCH":
            if is_(one) { return "captures:import" }
            if is_(one + "/settings") { return "captures:import" }
            if is_("/v1/settings") { return "projects:write" }
        case "DELETE":
            if is_(one) { return "captures:import" }
            if is_("/v1/devices/[^/]+") { return "projects:write" }
        case "PUT":
            if is_(one + "/scan") { return "captures:import" }
            // The Mac also checks printing (`printer-handoff:use`); every phone pairing has both.
            if is_("/v1/objects/printers/[A-Za-z0-9_-]+/(route|mcp)") { return "projects:write" }
        case "POST":
            if is_("/v1/blender/(check|update)") { return "projects:write" }
            if is_("/v1/objects") || is_(one + "/(start|duplicate|corrections|closeup|model|ask|plate-selection|photos|capture|capture-manifest|capture-depth)") { return "captures:import" }
            if is_(one + "/(print|printer|print-confirmation|estimate|print/pause|print/resume|print/cancel)") { return "printer-handoff:use" }
            if is_("/v1/devices/live-activity-tokens") { return "projects:write" }
            if is_("/v1/settings/(ai/test|fusion/setup|cad/setup)") { return "projects:write" }
            if is_("/v1/printers/mcp/[^/]+/update") { return "projects:write" }
            if is_("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/route") { return "printer-handoff:use" }
            if is_("/v1/objects/printers/[A-Za-z0-9_-]{1,256}/mcp") { return "projects:write" }
            // Add printer… (the Mac also checks printing, `printer-handoff:use`; every phone pairing has both).
            if is_("/v1/printers/setup/(discover|check|obtain|add)") { return "projects:write" }
        default: break
        }
        return nil
    }

    /// The current record, if it is unexpired and holds `scope`.
    private func record(_ scope: String) throws -> PairingRecord {
        let record: PairingRecord?
        do { record = try pairing.store.read() } catch { throw CompanionError.transport("pairing-required") }
        guard let record, record.requestBaseURL != nil, !record.isExpired() else { throw CompanionError.transport("pairing-required") }
        guard record.has(scope: scope) else { throw CompanionError.transport("scope-denied") }
        return record
    }

    /// One request: pinned, size-limited, and refused afterwards if the pairing changed while it ran.
    public func send(_ method: String, _ path: String, body: Data? = nil, contentType: String = "application/json",
                     limit: Int = CompanionClient.jsonLimit, timeout: TimeInterval = 90, ifNoneMatch: String? = nil) async throws -> HTTPReply {
        guard let scope = Self.scope(method, path.components(separatedBy: "?")[0]) else { throw CompanionError.transport("invalid-request") }
        var attempt = try record(scope)
        // A GET that can't reach the Mac checks its other addresses once, moving to whichever answers.
        for retry in 0...1 {
            guard let base = attempt.requestBaseURL, let token = attempt.token, let device = attempt.deviceId,
                  let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw CompanionError.transport("invalid-request") }
            var request = URLRequest(url: url, timeoutInterval: timeout)
            request.httpMethod = method
            request.httpBody = body
            if let ifNoneMatch { request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
            if let deviceModel { request.setValue(deviceModel, forHTTPHeaderField: "X-Scan-Device-Model") }
            if let deviceName { request.setValue(deviceName, forHTTPHeaderField: "X-Scan-Device-Name") }
            if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            do {
                // Metadata deadlines bound the whole reply, including a peer trickling bytes. Commands and
                // file transfers keep their budgets; event long polls pass their own 40-second timeout.
                let metadata = method == "GET" && limit <= Self.jsonLimit
                let resourceTimeout = metadata ? timeout + 5 : (body?.count ?? 0) > Self.photoLimit ? 600 : max(180, timeout + 10)
                let reply = try await transport.send(request, trust: .record(attempt), limit: limit,
                                                     resourceTimeout: resourceTimeout)
                let latest = try? pairing.store.read()
                guard attempt.isSamePairing(as: latest ?? nil) else { throw CompanionError.transport("pairing-changed") }
                return reply
            } catch let error as TransportError {
                // A long poll that ends early says nothing about the address: only an ordinary request moves it.
                if retry == 0, method == "GET", !path.hasPrefix("/v1/events"), ["network", "timeout"].contains(error.code), (attempt.addresses?.count ?? 0) > 1,
                   let checked = try? await pairing.check(), checked.activeUrl != attempt.activeUrl,
                   let moved = try? self.record(scope) {
                    attempt = moved
                    continue
                }
                throw CompanionError.transport(error.code)
            }
        }
        throw CompanionError.unreachable
    }

    /// A JSON request and its decoded reply, with the Mac's refusals in plain words.
    public func request<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil, as type: T.Type,
                                      timeout: TimeInterval = 90) async throws -> T {
        var body: Data?
        if let json {
            guard JSONSerialization.isValidJSONObject(json), let data = try? JSONSerialization.data(withJSONObject: json) else {
                throw CompanionError.transport("invalid-request")
            }
            let start = method == "POST" && path.hasSuffix("/start")
            guard data.count <= (start ? 128 * 1024 : 16 * 1024) else { throw CompanionError.transport("invalid-request") }
            body = data
        }
        let reply = try await send(method, path, body: body, timeout: timeout)
        return try Self.decode(reply, path: path, as: type)
    }

    static func decode<T: Decodable>(_ reply: HTTPReply, path: String, as type: T.Type) throws -> T {
        if (200..<300).contains(reply.status) {
            do { return try JSONDecoder().decode(T.self, from: reply.body) }
            catch { throw CompanionError(code: "invalid-response", message: "Your Mac sent something this app doesn't understand. Update both apps.") }
        }
        throw refusal(reply, path: path)
    }

    /// The Mac's refusal in plain words. A 409's message is written for the person, so it's shown as is.
    static func refusal(_ reply: HTTPReply, path: String) -> CompanionError {
        let error = JSONValue.object(from: reply.body)?["error"]?.object
        let message = error?["message"]?.string, code = error?["code"]?.string
        let newer = path.hasPrefix("/v1/events") || path.hasPrefix("/v1/settings") || path.hasSuffix("/camera.jpg") || path.contains("/print/")
            || path.hasSuffix("/estimate") || path.contains("/asks/") || path.hasPrefix("/v1/devices") || path.hasSuffix("/settings")
            || path.hasPrefix("/v1/printers/") || (path.hasPrefix("/v1/objects/printers/") && (path.hasSuffix("/route") || path.hasSuffix("/mcp")))
        switch reply.status {
        case 401, 403: return CompanionError(code: "pairing", message: "Connect to your Mac again.")
        case 404 where path == "/v1/objects": return CompanionError(code: "not-set-up", message: "Your Mac isn't ready to make things yet. Open Counterpart on your Mac.")
        case 404 where path.hasSuffix("/filaments"): return CompanionError(code: "not-set-up", message: "Update Counterpart on your Mac to choose a filament here.")
        case 404 where path.hasSuffix("/colour-mapping"): return CompanionError(code: "not-set-up", message: "Update Counterpart on your Mac to choose a spool for each colour here.")
        case 404 where path.hasSuffix("/camera.jpg") && code == "not-found" && message?.contains("camera") == true:
            return CompanionError(code: "no-camera", message: "This printer has no camera Counterpart can use.")
        case 404 where newer || code == "method-not-allowed": return .unsupported
        case 405: return .unsupported
        // The Mac's own sentence, whatever the status, when it says the message is written for the person (Nov 6).
        case _ where !(error?["sentence"]?.string ?? "").isEmpty: return CompanionError(code: code ?? "refused", message: error!["sentence"]!.string!)
        case 404: return CompanionError(code: "not-found", message: "This is no longer on your Mac.")
        case 409: return CompanionError(code: "conflict", message: message ?? "Wait until the current step finishes.")
        case 503: return CompanionError(code: "unavailable", message: path.hasSuffix("/camera.jpg") ? "The printer's camera isn't answering right now."
                                        : "The printer isn't answering right now. Try again in a moment.")
        case 400 where code == "invalid-request": return CompanionError(code: "invalid-request", message: "Your Mac didn't accept that. Update Counterpart on your Mac, then try again.")
        default: return CompanionError(code: "failed", message: "Something went wrong on your Mac. Try again.")
        }
    }

    // MARK: Projects

    private struct One: Decodable { var object: Project }
    private struct Many: Decodable { var objects: [Project] }
    private struct Deleted: Decodable { var deleted: Bool }
    private struct Filaments: Decodable { var filaments: [PrinterFilament] }
    private struct ActivityReply: Decodable { var activity: [Project.Activity] }

    public func list() async throws -> [Project] { try await request("GET", "/v1/objects", as: Many.self, timeout: 10).objects }
    public func get(_ id: String) async throws -> Project { try await request("GET", "/v1/objects/\(id)", as: One.self, timeout: 10).object }
    /// Creates a project. `kind` is `fit` (make something that fits) or `copy` (copy what you scanned); the
    /// Mac uses Blender for a copy and may use Fusion for a fit. Without it the Mac infers it (a scan means copy).
    public func addStarter(_ starter: StarterProject) async throws -> Project {
        try await request("POST", "/v1/objects", json: ["starterId": starter.id], as: One.self).object
    }
    public func create(_ instructions: String, kind: String? = nil, url: URL? = nil, fit: ProjectFit? = nil) async throws -> Project {
        try await request("POST", "/v1/objects", json: Self.createBody(instructions, kind: kind, url: url, fit: fit), as: One.self).object
    }
    /// `instructions` is what the person typed; how a fit's size is settled goes beside it as `fit`, never inside it.
    static func createBody(_ instructions: String, kind: String?, url: URL?, fit: ProjectFit?) -> [String: Any] {
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        var json: [String: Any] = text.isEmpty ? [:] : ["instructions": text]
        if let kind, ["fit", "copy", "published"].contains(kind) { json["kind"] = kind }
        if let url { json["url"] = url.absoluteString }
        if let fit, kind == "fit", !text.isEmpty { json["fit"] = fit.json }
        return json
    }
    /// A draft's fit choice is sent every time: the fields, or null when the draft is no longer a fit.
    public func updateDraft(_ id: String, instructions: String, kind: String? = nil, fit: ProjectFit? = nil) async throws -> Project {
        try await request("PATCH", "/v1/objects/\(id)", json: Self.draftBody(instructions, kind: kind, fit: fit), as: One.self).object
    }
    static func draftBody(_ instructions: String, kind: String?, fit: ProjectFit?) -> [String: Any] {
        var json: [String: Any] = ["instructions": instructions]
        if let kind, ["fit", "copy"].contains(kind) { json["kind"] = kind }
        json["fit"] = kind == "fit" ? fit?.json ?? NSNull() : NSNull()
        return json
    }
    public func start(_ id: String, captureManifest: [String: Any]? = nil) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/start", json: captureManifest.map { ["captureManifest": $0] } ?? [:], as: One.self).object
    }
    /// A walk-around's every image, named before any is sent (`source: "object-capture"`): the Mac then refuses to
    /// start on part of it, from any client, and takes no frame outside the list. Needs `objectCaptureImages`.
    public func declareCapture(_ id: String, manifest: [String: Any]) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/capture-manifest", json: manifest, as: One.self).object
    }
    /// Ask for changes: a new pass with your text. Upload new photos first.
    /// `messageId` is this note's own id (`NoteAttempts`, `CorrectionQueue.Message.id`): the Mac records it once.
    public func correct(_ id: String, _ note: String, photoNames: [String]? = nil, messageId: String? = nil) async throws -> Project {
        var json: [String: Any] = ["note": note]
        if let photoNames { json["photoNames"] = photoNames }
        if let messageId { json["messageId"] = messageId }
        return try await request("POST", "/v1/objects/\(id)/corrections", json: json, as: One.self).object
    }
    /// Answers the open Ask with explicitly named uploaded photos, a best guess, or words.
    /// `sizes`: a sizes question's numbers (`AskSizesForm.answer`), which may go with words and photos.
    public func answerAsk(_ id: String, bestGuess: Bool = false, text: String? = nil, photoNames: [String] = [], sizes: [AskSizesForm.Answer] = []) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/closeup", json: Self.answerBody(bestGuess: bestGuess, text: text, photoNames: photoNames, sizes: sizes), as: One.self).object
    }
    static func answerBody(bestGuess: Bool, text: String?, photoNames: [String], sizes: [AskSizesForm.Answer]) -> [String: Any] {
        var json: [String: Any] = [:]
        if bestGuess { json["bestGuess"] = true }
        if let text { json["text"] = text }
        json["photoNames"] = photoNames
        if !sizes.isEmpty { json["sizes"] = sizes.map { ["id": $0.id, "mm": $0.mm] as [String: Any] } }
        return json
    }
    public func selectPlate(_ id: String, fileIndex: Int, plateIndex: Int) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/plate-selection", json: ["fileIndex": fileIndex, "plateIndex": plateIndex], as: One.self).object
    }
    public func choosePublishedPlate(_ id: String, askId: String, choice: String) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/ask", json: ["askId": askId, "choices": [choice]], as: One.self).object
    }
    public func addModelFile(_ id: String, file: URL) async throws -> Project {
        let access = file.startAccessingSecurityScopedResource()
        defer { if access { file.stopAccessingSecurityScopedResource() } }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 64 * 1024 * 1024, ["3mf", "stl"].contains(file.pathExtension.lowercased()) else {
            throw CompanionError(code: "invalid-model", message: "Choose a 3MF or STL file at most 64 MB.")
        }
        let data = try Data(contentsOf: file)
        guard data.count <= 64 * 1024 * 1024 else { throw CompanionError(code: "invalid-model", message: "Choose a model file at most 64 MB.") }
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "name", value: file.lastPathComponent)]
        let path = "/v1/objects/\(id)/model?\(query.percentEncodedQuery!)"
        let response = try await send("POST", path, body: data, contentType: "application/octet-stream").checked(path: path)
        return try JSONDecoder().decode(One.self, from: response.body).object
    }
    private struct MaybeOne: Decodable { var object: Project? }
    /// Sets the project's status (PRD §5.4): It works, Needs changes, Archived… Returns the project when the
    /// Mac sends it back; otherwise read it again. An older Mac answers `not-supported`.
    public func setStatus(_ id: String, _ status: ProjectStatus) async throws -> Project? {
        try await changeProjectSettings(id, ["status": status.rawValue])
    }
    /// Hides it from Home or shows it again, keeping its status (a Mac whose settings carry `archived`).
    public func setArchived(_ id: String, _ archived: Bool) async throws -> Project? {
        try await changeProjectSettings(id, ["archived": archived])
    }
    public func rename(_ id: String, title: String) async throws -> Project? {
        try await changeProjectSettings(id, ["title": title])
    }
    private func changeProjectSettings(_ id: String, _ patch: [String: Any]) async throws -> Project? {
        let reply = try await send("PATCH", "/v1/objects/\(id)/settings", body: try JSONSerialization.data(withJSONObject: patch))
            .checked(path: "/v1/objects/\(id)/settings")
        return (try? JSONDecoder().decode(MaybeOne.self, from: reply.body))?.object
    }
    /// Project preferences are available when the companion advertises `projectPreferences`.
    public func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project {
        let reply = try await send("PATCH", "/v1/objects/\(id)/settings", body: try JSONEncoder().encode(patch)).checked(path: "/v1/objects/\(id)/settings")
        return try JSONDecoder().decode(One.self, from: reply.body).object
    }
    public func duplicate(_ id: String) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/duplicate", json: [:], as: One.self).object
    }
    public func delete(_ id: String) async throws { _ = try await request("DELETE", "/v1/objects/\(id)", as: Deleted.self) }
    public func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] {
        try await request("GET", "/v1/objects/\(id)/passes/\(index)/activity", as: ActivityReply.self).activity
    }

    // MARK: Printing

    /// What the running companion can do, as the names of its true capability flags (`genericConfirmations`, …),
    /// from `GET /healthz`. Empty from a Mac that doesn't list them.
    /// A quick "are you there?": `/healthz` with a short timeout, for when a long poll ends early.
    public func answers() async -> Bool {
        (try? await send("GET", "/healthz", timeout: 6).checked(path: "/healthz")) != nil
    }

    public func capabilities() async throws -> Set<String> { try await health().capabilities }

    /// `/healthz`: the capability flags that are on, and the Mac's own name when it gives one.
    public func health() async throws -> (capabilities: Set<String>, name: String?) {
        struct Health: Decodable { var capabilities: [String: JSONValue]?; var name: String?; var macName: String? }
        let health = try await request("GET", "/healthz", as: Health.self)
        let name = (health.name ?? health.macName)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (Set((health.capabilities ?? [:]).compactMap { $0.value == .bool(true) ? $0.key : nil }), name?.isEmpty == false ? name : nil)
    }

    public func printers() async throws -> PrinterCatalog { try await request("GET", "/v1/objects/printers", as: PrinterCatalog.self) }
    private struct RouteReply: Decodable { var route: PrinterConnection? }
    static func printerPath(_ destinationId: String, _ leaf: String) throws -> String {
        guard Pattern("[A-Za-z0-9_-]{1,256}").matches(destinationId) else { throw CompanionError.transport("invalid-request") }
        return "/v1/objects/printers/\(destinationId)/\(leaf)"
    }
    /// How the printer's MCP reaches it, in the MCP's words; nil when that MCP has no choice (needs `printerChoices`).
    public func printerConnection(_ destinationId: String) async throws -> PrinterConnection? {
        try await request("GET", Self.printerPath(destinationId, "route"), as: RouteReply.self, timeout: 40).route
    }
    /// Changes the connection in the MCP's own settings. Refused (409) while the printer prints.
    public func setPrinterConnection(_ destinationId: String, route: String) async throws -> PrinterConnection {
        guard let saved = try await request("PUT", Self.printerPath(destinationId, "route"), json: ["route": route], as: RouteReply.self, timeout: 40).route
        else { throw CompanionError(code: "invalid-response", message: "Your Mac sent something this app doesn't understand. Update both apps.") }
        return saved
    }
    private struct McpReply: Decodable { var destinationId: String }
    /// Which MCP a printer reached through both uses. Returns the printer's id now, which may change.
    public func choosePrinterMcp(_ destinationId: String, backend: String) async throws -> String {
        try await request("PUT", Self.printerPath(destinationId, "mcp"), json: ["backend": backend], as: McpReply.self, timeout: 40).destinationId
    }
    public func filaments(_ id: String) async throws -> [PrinterFilament] {
        try await request("GET", "/v1/objects/\(id)/filaments", as: Filaments.self).filaments
    }
    /// A multi-part model's filaments, the loaded spools, and the suggested spool for each colour.
    public func colourMapping(_ id: String) async throws -> ColourMapping {
        try await request("GET", "/v1/objects/\(id)/colour-mapping", as: ColourMapping.self)
    }
    public func selectPrinter(_ id: String, destinationId: String) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/printer", json: ["destinationId": destinationId], as: One.self).object
    }
    /// The slice estimate for these settings (PR 2): time, grams and layers. Can take up to 150 s.
    /// It takes every choice Print takes (the spool and layer pauses too): its sliced file is the one Print sends.
    public func estimate(_ id: String, destinationId: String?, quality: PrintQuality, strength: PrintStrength, copies: Int? = nil, overrideDefaults: Bool = false,
                         filaments: [PrinterFilament] = [], filamentsModelVersion: String? = nil,
                         colour: PrintColour? = nil, pauseBeforeLayers: [Int] = []) async throws -> SliceEstimate {
        // The spool and pauses exactly as Print's body sends them.
        var json = PrintChoice(colour: filaments.isEmpty ? colour : nil, pauseBeforeLayers: pauseBeforeLayers).body
        json["checked"] = nil
        if let destinationId { json["destinationId"] = destinationId }
        if overrideDefaults || quality != .standard { json["quality"] = quality.rawValue }
        if overrideDefaults || strength != .standard { json["strength"] = strength.rawValue }
        if let copies { json["copies"] = max(1, copies) }
        if !filaments.isEmpty { json["filaments"] = filaments.map(\.jsonObject) }
        if let filamentsModelVersion { json["filamentsModelVersion"] = filamentsModelVersion }
        // The companion may slice for 600 s (630 s with what it reads first): wait a little longer than that.
        return try await request("POST", "/v1/objects/\(id)/estimate", json: json, as: SliceEstimate.self, timeout: 640)
    }
    /// Starts preparing the print. The printer MCP still asks its own confirmation.
    public func print(_ id: String, choice: PrintChoice, overrideDefaults: Bool = false, expectedPlate: String? = nil) async throws -> Project {
        var body = choice.body
        if let expectedPlate { body["expectedPlate"] = expectedPlate }
        // Standard is an explicit choice when replacing a saved Fine/Strong project default.
        if overrideDefaults { body["quality"] = choice.quality.rawValue; body["strength"] = choice.strength.rawValue }
        return try await request("POST", "/v1/objects/\(id)/print", json: body, as: One.self).object
    }
    public func answerPrintConfirmation(_ id: String, response: PrintConfirmationResponse) async throws -> Project {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        return try await request("POST", "/v1/objects/\(id)/print-confirmation", json: json, as: One.self).object
    }
    public enum PrintControl: String, Sendable { case pause, resume, cancel }
    /// Pause, resume or stop a running print (PR 2). The MCP's own confirmation, if it asks, arrives as
    /// `printConfirmation`. Older Macs answer `not-supported`.
    public func control(_ id: String, _ action: PrintControl) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/print/\(action.rawValue)", json: [:], as: One.self).object
    }

    /// A watched camera frame. New companions use shared MCP streams and conditional responses;
    /// older companions keep their snapshot behavior.
    public struct CameraFrame: Sendable {
        public var jpeg: Data
        public var capturedAt: Date?
        public var etag: String?
        public var streaming: Bool
        public init(jpeg: Data, capturedAt: Date? = nil, etag: String? = nil, streaming: Bool = false) {
            self.jpeg = jpeg; self.capturedAt = capturedAt; self.etag = etag; self.streaming = streaming
        }
    }
    public func camera(project id: String, fullScreen: Bool = false, previous: CameraFrame? = nil) async throws -> CameraFrame {
        try await camera(path: "/v1/objects/\(id)/camera.jpg", fullScreen: fullScreen, previous: previous)
    }
    public func camera(printer destinationId: String, fullScreen: Bool = false, previous: CameraFrame? = nil) async throws -> CameraFrame {
        let id = destinationId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? destinationId
        return try await camera(path: "/v1/objects/printers/\(id)/camera.jpg", fullScreen: fullScreen, previous: previous)
    }
    public func cameraFrames(project id: String, fullScreen: Bool = false) -> AsyncThrowingStream<CameraFrame, Error> {
        cameraFrames(path: "/v1/objects/\(id)/camera.jpg", fullScreen: fullScreen)
    }
    public func cameraFrames(printer destinationId: String, fullScreen: Bool = false) -> AsyncThrowingStream<CameraFrame, Error> {
        let id = destinationId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? destinationId
        return cameraFrames(path: "/v1/objects/printers/\(id)/camera.jpg", fullScreen: fullScreen)
    }
    private func cameraFrames(path: String, fullScreen: Bool) -> AsyncThrowingStream<CameraFrame, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    guard let scope = Self.scope("GET", path) else { throw CompanionError.transport("invalid-request") }
                    let paired = try record(scope)
                    guard let base = paired.requestBaseURL, let token = paired.token, let device = paired.deviceId,
                          let url = URL(string: path + "?stream=1" + (fullScreen ? "&size=full" : ""), relativeTo: base)?.absoluteURL
                    else { throw CompanionError.transport("invalid-request") }
                    var request = URLRequest(url: url, timeoutInterval: 35)
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
                    request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
                    if let deviceModel { request.setValue(deviceModel, forHTTPHeaderField: "X-Scan-Device-Model") }
                    if let deviceName { request.setValue(deviceName, forHTTPHeaderField: "X-Scan-Device-Name") }
                    func checkPairing() throws {
                        try Task.checkCancellation()
                        guard paired.isSamePairing(as: try? pairing.store.read()) else { throw CompanionError.transport("pairing-changed") }
                        _ = try record(scope)
                    }
                    var decoder = CameraFrameDecoder(fullScreen: fullScreen)
                    try await transport.lines(request, trust: .record(paired), lineLimit: 65_536, response: { reply in
                        try checkPairing()
                        let type = reply.header("Content-Type")?.components(separatedBy: ";").first?.lowercased()
                        if reply.status == 200, type == "image/jpeg" { throw CompanionError.unsupported }
                        if reply.status == 404, JSONValue.object(from: reply.body)?["error"]?.object?["code"]?.string == "not-supported" {
                            throw CompanionError.unsupported
                        }
                        guard reply.status == 200 else {
                            let error = Self.refusal(reply, path: path)
                            throw error.isUnsupported ? CompanionError(code: "unavailable", message: error.message) : error
                        }
                        guard type == "application/x-ndjson", reply.header("X-Camera-Protocol") == "1" else {
                            throw CompanionError(code: "invalid-response", message: "Your Mac sent an unsupported camera stream. Update both apps.")
                        }
                    }, line: { data in
                        try checkPairing()
                        if let frame = try decoder.decode(data) { continuation.yield(frame) }
                    })
                    throw CompanionError(code: "unavailable", message: "The printer's camera connection ended. Reconnecting…")
                } catch let error as TransportError {
                    // Preserve the snapshot client's address recovery when the phone changes networks.
                    if !Task.isCancelled, ["network", "timeout"].contains(error.code),
                       let known = try? record("printer-handoff:use"), (known.addresses?.count ?? 0) > 1 {
                        _ = try? await pairing.check()
                    }
                    continuation.finish(throwing: CompanionError.transport(error.code))
                }
                catch is CancellationError { continuation.finish(throwing: CompanionError.cancelled) }
                catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func camera(path: String, fullScreen: Bool, previous: CameraFrame?) async throws -> CameraFrame {
        let reply = try await send("GET", path + (fullScreen ? "?size=full" : ""), limit: Self.photoLimit, timeout: 20, ifNoneMatch: previous?.etag)
        if reply.status == 304, let previous {
            return CameraFrame(jpeg: previous.jpeg, capturedAt: previous.capturedAt, etag: previous.etag, streaming: reply.header("X-Camera-Stream") == "1")
        }
        guard reply.status == 200 else { throw Self.refusal(reply, path: path) }
        guard !reply.body.isEmpty else { throw CompanionError(code: "unavailable", message: "The printer's camera isn't answering right now.") }
        return CameraFrame(jpeg: reply.body, capturedAt: reply.header("X-Captured-At").flatMap(ISO.date), etag: reply.header("ETag"), streaming: reply.header("X-Camera-Stream") == "1")
    }

    // MARK: Settings and events

    private struct SettingsReply: Codable { var settings: CompanionSettings }
    /// Every setting the Mac has (docs/protocols/settings.md); an older Mac returns only `milestones`.
    public func settings() async throws -> CompanionSettings { try await request("GET", "/v1/settings", as: SettingsReply.self).settings }
    /// Changes only the keys `patch` names (`SettingsPatch`). Something only the Mac can do is refused with
    /// the sentence to show.
    public func changeSettings(_ patch: [String: Any]) async throws -> CompanionSettings {
        try await request("PATCH", "/v1/settings", json: patch, as: SettingsReply.self).settings
    }
    public func setMilestones(_ value: String) async throws -> CompanionSettings { try await changeSettings(SettingsPatch.milestones(value)) }
    /// Tests the AI choice at `revision`; its progress shows in `settings.ai.check`.
    public func testAI(revision: String) async throws { _ = try await send("POST", "/v1/settings/ai/test", body: try JSONSerialization.data(withJSONObject: ["revision": revision])).checked(path: "/v1/settings/ai/test") }
    /// Asks the Mac to set up Fusion (it installs an add-in there).
    public func setUpFusion() async throws { _ = try await send("POST", "/v1/settings/fusion/setup", body: Data("{}".utf8)).checked(path: "/v1/settings/fusion/setup") }
    /// The code design engine's row (PRD §8.9): its own fresh read (the plain settings read never starts the printer
    /// MCP), or Set Up, which the computer starts and returns from at once. Nil when the companion predates the engine.
    public func codeEngine(_ action: CodeEngineStatus.Action = .status) async throws -> CodeEngineStatus? {
        if action == .status {
            struct Reply: Decodable { let cad: CodeEngineStatus? }
            let response = try await send("GET", "/v1/settings/cad")
            if response.status == 404 { return nil }
            return try JSONDecoder().decode(Reply.self, from: response.checked(path: "/v1/settings/cad").body).cad
        }
        return try await request("POST", "/v1/settings/cad/setup", json: [:], as: SettingsReply.self).settings.cad
    }

    private struct DevicesReply: Decodable { var devices: [CompanionDevice] }
    public func devices() async throws -> [CompanionDevice] { try await request("GET", "/v1/devices", as: DevicesReply.self).devices }
    public func removeDevice(_ deviceId: String) async throws {
        let id = deviceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-"))) ?? deviceId
        _ = try await send("DELETE", "/v1/devices/\(id)").checked(path: "/v1/devices/\(id)")
    }

    public func mcpCopies() async throws -> [MCPPackageCopies] {
        struct Reply: Decodable { let packages: [MCPPackageCopies] }
        return try await request("GET", "/v1/printers/mcps", as: Reply.self).packages
    }

    private struct UpdateReply: Decodable { var update: MCPUpdate }
    /// Updates a printer MCP on the Mac (PRD §8.10). `fresh` installs a fresh copy when the install couldn't be told.
    public func blenderAddon(_ action: BlenderAddonStatus.Action = .status) async throws -> BlenderAddonStatus {
        struct Reply: Decodable { let blender: BlenderAddonStatus }
        let path = action == .status ? "/v1/blender" : "/v1/blender/" + action.rawValue
        let response = try await send(action == .status ? "GET" : "POST", path, body: action == .status ? nil : Data("{}".utf8)).checked(path: path)
        return try JSONDecoder().decode(Reply.self, from: response.body).blender
    }

    public func updateMCP(_ mcpId: String, fresh: Bool = false) async throws -> MCPUpdate {
        let id = mcpId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? mcpId
        return try await request("POST", "/v1/printers/mcp/\(id)/update", json: fresh ? ["fresh": true] : [:], as: UpdateReply.self).update
    }

    // MARK: Files

    /// Downloads one project file into the cache, once per project version, and returns where it is.
    public func download(_ project: Project, _ name: String) async throws -> URL {
        let allowed = Pattern(#"original/[0-9]+|model\.stl|renders/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png|asks/[a-f0-9-]{36}\.(jpg|png)|prints/[a-f0-9-]{36}/frames/[a-f0-9-]{36}\.jpg|(?:photos|capture|scan)/[A-Za-z0-9][A-Za-z0-9._ -]{0,127}"#)
        guard Pattern(Self.uuid).matches(project.id), allowed.matches(name), !name.contains("..") else { throw CompanionError.transport("invalid-request") }
        let version = String(Int64(project.mediaVersion))
        let folder = cache.appending(path: project.id, directoryHint: .isDirectory).appending(path: version, directoryHint: .isDirectory)
        var filename = name.replacingOccurrences(of: "/", with: "_")
        var resource = name
        // The historical route serves the current model, including a 3MF (published or designed multi-colour).
        if name == "model.stl", let model = project.current?.model,
           project.kind == "published" || model.lowercased().hasSuffix(".3mf") {
            let original = Hex.sha256(Data(model.utf8))
            filename = "model-\(original).\(project.preservesPublishedFilaments ? "3mf" : "stl")"
            // Bind this request to the selected original even if another choice
            // reaches the Mac before this download is served.
            if case .array(let originals)? = project.files?.object?["original"],
               let index = originals.firstIndex(where: { $0.string == model }) { resource = "original/\(index)" }
        }
        if name.hasPrefix("original/"), let index = Int(name.dropFirst(9)),
           case .array(let originals)? = project.files?.object?["original"], originals.indices.contains(index), let path = originals[index].string {
            filename += "_" + URL(fileURLWithPath: path).lastPathComponent
        }
        let target = folder.appending(path: filename)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let encoded = resource.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? resource
        // The Ask's picture is served by its id; the field gives `asks/<id>.<ext>`.
        let path = "/v1/objects/\(project.id)/\(encoded)"
        let reply = try await send("GET", path, limit: Self.scanLimit)
        guard reply.status == 200, !reply.body.isEmpty else {
            throw reply.status == 404 ? CompanionError(code: "not-found", message: "This is no longer on your Mac.")
                : CompanionError(code: "download-failed", message: "That file couldn't be saved on this phone.")
        }
        // Older versions of this project are no longer shown. The current version's folder stays: its other
        // files may be downloading at the same time.
        let projectFolder = folder.deletingLastPathComponent()
        for other in (try? FileManager.default.contentsOfDirectory(at: projectFolder, includingPropertiesForKeys: nil)) ?? [] where other.lastPathComponent != version {
            try? FileManager.default.removeItem(at: other)
        }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do { try reply.body.write(to: target, options: .atomic) }
        catch { throw CompanionError(code: "download-failed", message: "That file couldn't be saved on this phone.") }
        return target
    }
}

/// This device's hardware identifier ("iPhone18,2"), for the Mac's device list.
public enum DeviceModel {
    public static let identifier: String? = {
        #if targetEnvironment(simulator)
        if let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return model }
        #endif
        var info = utsname()
        uname(&info)
        let text = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        return text.isEmpty ? nil : text
    }()
}

extension HTTPReply {
    /// The reply when the Mac accepted the request; its refusal otherwise.
    func checked(path: String) throws -> HTTPReply {
        guard (200..<300).contains(status) else { throw CompanionClient.refusal(self, path: path) }
        return self
    }
}


/// A single HTTP stream has ordered frames; heartbeats carry no image and never refresh its timestamp.
struct CameraFrameDecoder {
    let fullScreen: Bool
    private var lastSequence: Int64 = -1
    init(fullScreen: Bool) { self.fullScreen = fullScreen }
    private struct Wire: Decodable { let v: Int; let seq: Int64; let capturedAt: String; let base64: String }
    mutating func decode(_ line: Data) throws -> CompanionClient.CameraFrame? {
        if line.isEmpty || line == Data([13]) { return nil }
        guard line.count < 65_536, let wire = try? JSONDecoder().decode(Wire.self, from: line),
              wire.v == 1, wire.seq >= 0, wire.seq > lastSequence, let capturedAt = ISO.date(wire.capturedAt),
              let jpeg = Data(base64Encoded: wire.base64), jpeg.count <= (fullScreen ? 42_000 : 20_000),
              jpeg.starts(with: [0xff, 0xd8, 0xff]) else {
            throw CompanionError(code: "invalid-response", message: "Your Mac sent an invalid camera frame. Update both apps.")
        }
        lastSequence = wire.seq
        return .init(jpeg: jpeg, capturedAt: capturedAt, streaming: true)
    }
}
