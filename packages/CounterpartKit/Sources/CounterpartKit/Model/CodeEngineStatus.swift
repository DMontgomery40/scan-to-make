import Foundation

/// The printer MCP's code design engine (PRD §8.9), as the companion reads it from the MCP's `cad_status` and shows it
/// on every layout. The words are the companion's; `result` is the last Set Up's outcome in the MCP's own words.
public struct CodeEngineStatus: Codable, Sendable, Equatable {
    /// The last Set Up's outcome in the MCP's own words. A refusal's structured result (its code included) is carried by
    /// the companion; the apps show its sentence and suggestion and never choose by the code.
    public struct Result: Codable, Sendable, Equatable {
        public let ok: Bool
        public let message: String
        public let suggestion: String?
        public init(ok: Bool, message: String, suggestion: String? = nil) { self.ok = ok; self.message = message; self.suggestion = suggestion }
    }
    /// checking, unavailable, not-set-up, setting-up or ready.
    public let state: String
    public let message: String
    /// The printer MCP whose engine it is.
    public let server: String?
    /// While setting up: seconds since Set Up started.
    public let seconds: Int?
    /// What it takes on disk, from the MCP's own figures: before Set Up the download and installed size, after it what it uses.
    public let size: String?
    public let result: Result?
    /// Set Up is offered.
    public let canSetUp: Bool
    public var isWorking: Bool { state == "checking" || state == "setting-up" }
    public enum Action: String, Sendable { case status, setup }
    public init(state: String, message: String, server: String? = nil, seconds: Int? = nil, size: String? = nil, result: Result? = nil, canSetUp: Bool) {
        self.state = state; self.message = message; self.server = server; self.seconds = seconds; self.size = size; self.result = result; self.canSetUp = canSetUp
    }
}
