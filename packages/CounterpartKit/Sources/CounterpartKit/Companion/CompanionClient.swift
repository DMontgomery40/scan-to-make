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
            if is_("/v1/objects(?:/printers)?") || is_(one) || is_(one + "/passes/(0|[1-9][0-9]{0,15})/activity") { return "projects:read" }
            if is_("/healthz") { return "generation:health" }
            if is_("/v1/events") || is_("/v1/settings") || is_("/v1/devices") { return "projects:read" }
            if is_(one + "/(model\\.stl|renders/[^/]+|photos/[^/]+|capture/[^/]+|asks/[^/]+|prints/[^/]+/frames/[^/]+)") { return "projects:read" }
            if is_(one + "/(filaments|camera\\.jpg)") || is_("/v1/objects/printers/[^/]+/camera\\.jpg") { return "printer-handoff:use" }
        case "PATCH":
            if is_(one) { return "captures:import" }
            if is_("/v1/settings") { return "projects:write" }
        case "DELETE":
            if is_(one) { return "captures:import" }
            if is_("/v1/devices/[^/]+") { return "projects:write" }
        case "PUT":
            if is_(one + "/scan") { return "captures:import" }
        case "POST":
            if is_("/v1/objects") || is_(one + "/(start|corrections|closeup|photos|capture|capture-depth)") { return "captures:import" }
            if is_(one + "/(print|printer|print-confirmation|estimate|print/pause|print/resume|print/cancel)") { return "printer-handoff:use" }
            if is_("/v1/devices/live-activity-tokens") { return "projects:write" }
            if is_("/v1/settings/(ai/test|fusion/setup)") { return "projects:write" }
            if is_("/v1/printers/mcp/[^/]+/update") { return "printer-handoff:use" }
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
                     limit: Int = CompanionClient.jsonLimit, timeout: TimeInterval = 90) async throws -> HTTPReply {
        guard let scope = Self.scope(method, path.components(separatedBy: "?")[0]) else { throw CompanionError.transport("invalid-request") }
        var attempt = try record(scope)
        // A GET that can't reach the Mac checks its other addresses once, moving to whichever answers.
        for retry in 0...1 {
            guard let base = attempt.requestBaseURL, let token = attempt.token, let device = attempt.deviceId,
                  let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw CompanionError.transport("invalid-request") }
            var request = URLRequest(url: url, timeoutInterval: timeout)
            request.httpMethod = method
            request.httpBody = body
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
            if let deviceModel { request.setValue(deviceModel, forHTTPHeaderField: "X-Scan-Device-Model") }
            if let deviceName { request.setValue(deviceName, forHTTPHeaderField: "X-Scan-Device-Name") }
            if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            do {
                let reply = try await transport.send(request, trust: .record(attempt), limit: limit,
                                                     resourceTimeout: (body?.count ?? 0) > Self.photoLimit ? 600 : max(180, timeout + 10))
                let latest = try? pairing.store.read()
                guard attempt.isSamePairing(as: latest ?? nil) else { throw CompanionError.transport("pairing-changed") }
                return reply
            } catch let error as TransportError {
                if retry == 0, method == "GET", ["network", "timeout"].contains(error.code), (attempt.addresses?.count ?? 0) > 1,
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
            || path.hasSuffix("/estimate") || path.contains("/asks/") || path.hasPrefix("/v1/devices")
        switch reply.status {
        case 401, 403: return CompanionError(code: "pairing", message: "Connect to your Mac again.")
        case 404 where path == "/v1/objects": return CompanionError(code: "not-set-up", message: "Your Mac isn't ready to make things yet. Open Counterpart on your Mac.")
        case 404 where path.hasSuffix("/filaments"): return CompanionError(code: "not-set-up", message: "Update Counterpart on your Mac to choose a filament here.")
        case 404 where path.hasSuffix("/camera.jpg") && code == "not-found" && message?.contains("camera") == true:
            return CompanionError(code: "no-camera", message: "This printer has no camera Counterpart can use.")
        case 404 where newer || code == "method-not-allowed": return .unsupported
        case 405: return .unsupported
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

    public func list() async throws -> [Project] { try await request("GET", "/v1/objects", as: Many.self).objects }
    public func get(_ id: String) async throws -> Project { try await request("GET", "/v1/objects/\(id)", as: One.self).object }
    /// Creates a project. `kind` is `fit` (make something that fits) or `copy` (copy what you scanned); the
    /// Mac uses Blender for a copy and may use Fusion for a fit. Without it the Mac infers it (a scan means copy).
    public func create(_ instructions: String, kind: String? = nil) async throws -> Project {
        let text = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        var json: [String: Any] = text.isEmpty ? [:] : ["instructions": text]
        if let kind, ["fit", "copy"].contains(kind) { json["kind"] = kind }
        return try await request("POST", "/v1/objects", json: json, as: One.self).object
    }
    public func updateDraft(_ id: String, instructions: String) async throws -> Project {
        try await request("PATCH", "/v1/objects/\(id)", json: ["instructions": instructions], as: One.self).object
    }
    public func start(_ id: String, captureManifest: [String: Any]? = nil) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/start", json: captureManifest.map { ["captureManifest": $0] } ?? [:], as: One.self).object
    }
    /// Ask for changes: a new pass with your text. Upload new photos first.
    public func correct(_ id: String, _ note: String) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/corrections", json: ["note": note], as: One.self).object
    }
    /// Answers the open Ask: after uploading a photo (`{}`), as a best guess, or in words (PR 4).
    public func answerAsk(_ id: String, bestGuess: Bool = false, text: String? = nil) async throws -> Project {
        var json: [String: Any] = [:]
        if bestGuess { json["bestGuess"] = true }
        if let text { json["text"] = text }
        return try await request("POST", "/v1/objects/\(id)/closeup", json: json, as: One.self).object
    }
    public func delete(_ id: String) async throws { _ = try await request("DELETE", "/v1/objects/\(id)", as: Deleted.self) }
    public func passActivity(_ id: String, index: Int) async throws -> [Project.Activity] {
        try await request("GET", "/v1/objects/\(id)/passes/\(index)/activity", as: ActivityReply.self).activity
    }

    // MARK: Printing

    /// What the running companion can do, as the names of its true capability flags (`genericConfirmations`, …),
    /// from `GET /healthz`. Empty from a Mac that doesn't list them.
    public func capabilities() async throws -> Set<String> {
        struct Health: Decodable { var capabilities: [String: JSONValue]? }
        let health = try await request("GET", "/healthz", as: Health.self)
        return Set((health.capabilities ?? [:]).compactMap { $0.value == .bool(true) ? $0.key : nil })
    }

    public func printers() async throws -> PrinterCatalog { try await request("GET", "/v1/objects/printers", as: PrinterCatalog.self) }
    public func filaments(_ id: String) async throws -> [PrinterFilament] {
        try await request("GET", "/v1/objects/\(id)/filaments", as: Filaments.self).filaments
    }
    public func selectPrinter(_ id: String, destinationId: String) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/printer", json: ["destinationId": destinationId], as: One.self).object
    }
    /// The slice estimate for these settings (PR 2): time, grams and layers. Can take up to 150 s.
    public func estimate(_ id: String, destinationId: String?, quality: PrintQuality, strength: PrintStrength) async throws -> SliceEstimate {
        var json: [String: Any] = [:]
        if let destinationId { json["destinationId"] = destinationId }
        if quality != .standard { json["quality"] = quality.rawValue }
        if strength != .standard { json["strength"] = strength.rawValue }
        return try await request("POST", "/v1/objects/\(id)/estimate", json: json, as: SliceEstimate.self, timeout: 170)
    }
    /// Starts preparing the print. The printer MCP still asks its own confirmation.
    public func print(_ id: String, choice: PrintChoice) async throws -> Project {
        try await request("POST", "/v1/objects/\(id)/print", json: choice.body, as: One.self).object
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

    /// A still from the camera, and when it was taken (PR 2): the printer this project is printing on, or
    /// a printer by id. Shared 3 s cache on the Mac.
    public struct CameraFrame: Sendable { public var jpeg: Data; public var capturedAt: Date? }
    public func camera(project id: String) async throws -> CameraFrame { try await camera(path: "/v1/objects/\(id)/camera.jpg") }
    public func camera(printer destinationId: String) async throws -> CameraFrame {
        let id = destinationId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? destinationId
        return try await camera(path: "/v1/objects/printers/\(id)/camera.jpg")
    }
    private func camera(path: String) async throws -> CameraFrame {
        let reply = try await send("GET", path, limit: Self.photoLimit, timeout: 20)
        guard reply.status == 200 else { throw Self.refusal(reply, path: path) }
        guard !reply.body.isEmpty else { throw CompanionError(code: "unavailable", message: "The printer's camera isn't answering right now.") }
        return CameraFrame(jpeg: reply.body, capturedAt: reply.header("X-Captured-At").flatMap(ISO.date))
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

    private struct DevicesReply: Decodable { var devices: [CompanionDevice] }
    public func devices() async throws -> [CompanionDevice] { try await request("GET", "/v1/devices", as: DevicesReply.self).devices }
    public func removeDevice(_ deviceId: String) async throws {
        let id = deviceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-"))) ?? deviceId
        _ = try await send("DELETE", "/v1/devices/\(id)").checked(path: "/v1/devices/\(id)")
    }

    private struct UpdateReply: Decodable { var update: MCPUpdate }
    /// Updates a printer MCP on the Mac (PRD §8.10). `fresh` installs a fresh copy when the install couldn't be told.
    public func updateMCP(_ mcpId: String, fresh: Bool = false) async throws -> MCPUpdate {
        let id = mcpId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_."))) ?? mcpId
        return try await request("POST", "/v1/printers/mcp/\(id)/update", json: fresh ? ["fresh": true] : [:], as: UpdateReply.self).update
    }

    // MARK: Files

    /// Downloads one project file into the cache, once per project version, and returns where it is.
    public func download(_ project: Project, _ name: String) async throws -> URL {
        let allowed = Pattern(#"model\.stl|renders/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png|asks/[a-f0-9-]{36}\.(jpg|png)|prints/[a-f0-9-]{36}/frames/[a-f0-9-]{36}\.jpg|(?:photos|capture)/[A-Za-z0-9][A-Za-z0-9._ -]{0,127}"#)
        guard Pattern(Self.uuid).matches(project.id), allowed.matches(name), !name.contains("..") else { throw CompanionError.transport("invalid-request") }
        let version = String(Int64(project.mediaVersion))
        let folder = cache.appending(path: project.id, directoryHint: .isDirectory).appending(path: version, directoryHint: .isDirectory)
        let target = folder.appending(path: name.replacingOccurrences(of: "/", with: "_"))
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
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

