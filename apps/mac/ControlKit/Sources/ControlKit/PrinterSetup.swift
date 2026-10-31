import Foundation
import AgentKit

public typealias PrinterSetupChoice = AgentKit.PrinterSetupChoice
public typealias PrinterKeychain = AgentKit.PrinterKeychain

public struct PrinterSetupSnapshot: Decodable, Sendable {
    public let revision: UUID
    public let configured: Bool
    public let choice: PrinterSetupChoice
    public let check: PrinterSetupCheck?
    public let routes: [PrinterRoute]
    public var connected: Bool { check?.revision == revision && check?.state == .connected }
}
public struct PrinterRoute: Decodable, Sendable {
    public let connection_mode: String
    public let developerMode: String
}
public struct PrinterSetupCheck: Decodable, Sendable {
    public enum State: String, Decodable, Sendable { case checking, connected, failed, skipped }
    public let id: UUID
    public let revision: UUID
    public let state: State
    public let result: PrinterProbe?
}
public struct PrinterProbe: Decodable, Sendable {
    public let status: String
    public let camera: String
    public let fulu: String
    public let model: String?
    public let firmware: String?
    public let image: PrinterCameraImage?
}
public struct PrinterCameraImage: Decodable, Sendable {
    public let mimeType: String
    public let base64: String
    public var jpeg: Data? { Data(base64Encoded: base64) }
}
public struct PrinterDiscovery: Decodable, Sendable {
    public let state: String
    public let printers: [DiscoveredPrinter]
}
public struct DiscoveredPrinter: Decodable, Sendable {
    public let printer_host: String
    public let bambu_serial: String
    public let bambu_model: String?
    public let name: String
    public let firmware: String?
}
public extension ControlClient {
    func printerSetup() async throws -> PrinterSetupSnapshot { try await call("printerSetup.get") }
    func discoverPrinters() async throws -> PrinterDiscovery { try await call("printerSetup.discover") }
    /// Save the access code with PrinterKeychain before sending its UUID here.
    /// Every changed choice needs a fresh UUID. Use copyCredential only for the same destination. Refresh on unknown mutation outcome
    /// before removing old credentials. `.none` implements Set up a printer later.
    func setPrinterSetup(_ choice: PrinterSetupChoice, expectedRevision: UUID) async throws -> PrinterSetupSnapshot {
        try choice.validate()
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(choice))
        return try await call("printerSetup.set", ["expectedRevision": .string(expectedRevision.uuidString), "choice": value])
    }
    func checkPrinterSetup(revision: UUID) async throws -> PrinterSetupSnapshot {
        try await call("printerSetup.check", ["revision": .string(revision.uuidString)])
    }
}
