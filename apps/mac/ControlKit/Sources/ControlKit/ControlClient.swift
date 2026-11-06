import Foundation
import AppKit

public struct ControlClient: Sendable {
    public let socketPath: String
    public let timeout: TimeInterval
    public init(socketPath: String, timeout: TimeInterval = 10) throws {
        guard socketPath.hasPrefix("/"), !socketPath.contains("\0"), socketPath.utf8.count <= 103,
              timeout.isFinite, timeout > 0, timeout <= 900 else { throw ControlClientError.invalidEndpoint }
        self.socketPath = socketPath; self.timeout = timeout
    }
    private struct Request: Encodable { let v = 1; let id: String, method: String; let params: JSONValue }
    private struct Response<T: Decodable>: Decodable { let v: Int; let id: String?; let result: T?; let error: ControlRemoteError? }
    func call<T: Decodable>(_ method: String, _ params: [String: JSONValue] = [:]) async throws -> T {
        let id = UUID().uuidString
        var data: Data
        do { data = try JSONEncoder().encode(Request(id: id, method: method, params: .object(params))) }
        catch { throw ControlClientError.oversizedRequest }
        data.append(10)
        guard data.count <= 64 * 1024 else { throw ControlClientError.oversizedRequest }
        let operation = UnixExchange(path: socketPath, payload: data, timeout: timeout)
        let bytes = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { operation.start($0) }
        } onCancel: { operation.cancel() }
        let reply: Response<T>
        do { reply = try JSONDecoder().decode(Response<T>.self, from: bytes) }
        catch { throw ControlClientError.invalidResponse }
        // An answer before the request was read (`id: null`, the companion's `busy`) can only be a refusal (Nov 6).
        let unread = reply.id == nil && reply.error != nil && reply.result == nil
        guard reply.v == 1, reply.id == id || unread, (reply.result == nil) != (reply.error == nil) else { throw ControlClientError.invalidResponse }
        if let error = reply.error { throw error }
        return reply.result!
    }
    public func status() async throws -> ControlStatus { try await call("status.get") }
    public func jobs(projectId: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> ControlJobsPage {
        var params: [String: JSONValue] = ["limit": .number(Double(limit))]
        if let projectId { params["projectId"] = .string(projectId) }
        if let cursor { params["cursor"] = .string(cursor) }
        return try await call("jobs.list", params)
    }
    public func devices() async throws -> [ControlDevice] {
        struct Result: Decodable { let devices: [ControlDevice] }
        let result: Result = try await call("devices.list"); return result.devices
    }
    public func removeDevice(_ deviceId: String) async throws {
        struct Result: Decodable { let removed: Bool }
        let result: Result = try await call("devices.remove", ["deviceId": .string(deviceId)])
        guard result.removed else { throw ControlClientError.invalidResponse }
    }
    public func createPairing(login: String? = nil) async throws -> ControlInvitation {
        try await call("pairing.create", login.map { ["login": .string($0)] } ?? [:])
    }
    public func pairingIsActive(code: String) async throws -> Bool {
        struct Result: Decodable { let active: Bool }
        let result: Result = try await call("pairing.isActive", ["code": .string(code)]); return result.active
    }
    public func nearbyRequests() async throws -> [ControlNearbyRequest] {
        struct Result: Decodable { let items: [ControlNearbyRequest] }
        let result: Result = try await call("nearby.list"); return result.items
    }
    /// Allow or deny one nearby request; Allow pairs only that phone. A request that is gone throws
    /// `not-found`. Like every mutation, a deadline after sending has an unknown outcome: list again, never resend.
    public func answerNearby(_ id: String, allow: Bool) async throws {
        struct Result: Decodable { let answered: Bool }
        let result: Result = try await call("nearby.answer", ["id": .string(id), "allow": .bool(allow)])
        guard result.answered else { throw ControlClientError.invalidResponse }
    }
    public func pendingConfirmations() async throws -> [ControlConfirmation] {
        struct Result: Decodable { let items: [ControlConfirmation] }
        let result: Result = try await call("confirmations.list"); return result.items
    }
    public func answerConfirmation(_ id: String, answer: ConfirmationAnswer) async throws {
        struct Result: Decodable { let answered: Bool }
        let result: Result = try await call("confirmations.answer", ["id": .string(id), "answer": answer.json])
        guard result.answered else { throw ControlClientError.invalidResponse }
    }
    public func prepareDoor(_ door: ControlDoor, target: DoorTarget) async throws -> PreparedDoor {
        var params: [String: JSONValue] = ["door": .string(door.rawValue)]
        switch target {
        case .project(let id): params["projectId"] = .string(id)
        case .handoff(let id): params["handoffId"] = .string(id)
        }
        return try await call("doors.prepare", params)
    }
    /// Native app launch only; editor import/save tracking is a separate layer.
    @MainActor public func openDoor(_ door: ControlDoor, target: DoorTarget) async throws {
        let prepared = try await prepareDoor(door, target: target)
        guard prepared.fileURL.isFileURL, prepared.fileURL.host == nil || prepared.fileURL.host == "" || prepared.fileURL.host == "localhost",
              FileManager.default.fileExists(atPath: prepared.fileURL.path) else { throw ControlClientError.unavailable }
        if door == .finder {
            guard prepared.action == "reveal", prepared.applicationBundleId == nil else { throw ControlClientError.invalidResponse }
            NSWorkspace.shared.activateFileViewerSelecting([prepared.fileURL]); return
        }
        let identifiers: [ControlDoor: String] = [.blender: "org.blenderfoundation.blender", .bambuStudio: "com.bambulab.bambu-studio", .orca: "com.softfever3d.orca-slicer"]
        guard prepared.action == "open", let expected = identifiers[door], prepared.applicationBundleId == expected,
              let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: expected) else { throw ControlClientError.unavailable }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.open([prepared.fileURL], withApplicationAt: application, configuration: .init()) { _, error in
                if error != nil { continuation.resume(throwing: ControlClientError.unavailable) }
                else { continuation.resume() }
            }
        }
    }
}
