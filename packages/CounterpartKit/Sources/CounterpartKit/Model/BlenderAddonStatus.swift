import Foundation

public struct BlenderAddonStatus: Codable, Sendable, Equatable {
    public let state: String
    public let message: String
    public let canUpdate: Bool
    public let `protocol`: Int?
    public let expectedProtocol: Int?
    public var isWorking: Bool { state == "checking" || state == "updating" }
    public enum Action: String, Sendable { case status, check, update }
}
