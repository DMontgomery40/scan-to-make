import Foundation

public enum DependencyID: String, Codable, Sendable, Hashable {
    case bambu = "bambu-printer-mcp"
    case genericPrinter = "mcp-3d-printer-server"
    case blender, slicer, ffmpeg
}

public enum DependencyBackend: String, Codable, Sendable {
    case bambu = "bambu-printer-mcp"
    case genericPrinter = "mcp-3d-printer-server"
}

public struct DependencyItem: Decodable, Sendable, Equatable, Identifiable {
    public enum State: String, Decodable, Sendable {
        case ready = "Ready", downloading = "Downloading", missing = "Missing", failed = "Failed"
    }
    public let id: DependencyID
    public let state: State
    public let required: Bool
    public let version: String?
    public let bytesReceived: Int64?
    public let totalBytes: Int64?
    public let executablePath: String?
    public let failureCode: String?
    public let installURL: URL?
}

public struct DependencySnapshot: Decodable, Sendable, Equatable {
    public let items: [DependencyItem]
    /// Explicit values to bind to printer setup; no credentials or arbitrary commands.
    public let environment: [String: String]
}

public extension ControlClient {
    func dependencies(backend: DependencyBackend? = nil, model: String? = nil) async throws -> DependencySnapshot {
        var params: [String: JSONValue] = [:]
        if let backend { params["backend"] = .string(backend.rawValue) }
        if let model { params["model"] = .string(model) }
        return try await call("dependencies.get", params)
    }

    /// Starts a coalesced install. Poll dependencies() for progress and final readiness.
    func installDependency(id: DependencyID) async throws -> DependencyItem {
        try await changeDependency("dependencies.install", id: id)
    }

    func retryDependency(id: DependencyID) async throws -> DependencyItem {
        try await changeDependency("dependencies.retry", id: id)
    }

    private func changeDependency(_ method: String, id: DependencyID) async throws -> DependencyItem {
        guard id != .slicer && id != .ffmpeg else { throw ControlClientError.invalidResponse }
        struct Result: Decodable { let item: DependencyItem }
        let result: Result = try await call(method, ["id": .string(id.rawValue)])
        return result.item
    }
}
