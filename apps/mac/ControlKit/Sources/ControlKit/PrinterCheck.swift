import Foundation

public struct PrinterCheckSnapshot: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable { case idle, checking, complete }
    public enum Result: String, Decodable, Sendable {
        case connected, failed, notSupported = "not-supported"
    }
    public let state: State
    public let status: Result?
    public let camera: Result?
    public let cameraSha256: String?
    public let cameraBytes: Int?
}
public extension ControlClient {
    /// Start a read-only status/camera diagnostic, or poll its last result.
    /// An in-flight start is coalesced. No printer command or raw image is returned.
    func checkPrinter(start: Bool = false) async throws -> PrinterCheckSnapshot {
        try await call("printer.check", ["start": .bool(start)])
    }
}
