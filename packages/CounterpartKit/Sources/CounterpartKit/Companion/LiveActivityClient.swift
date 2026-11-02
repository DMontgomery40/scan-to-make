import Foundation

extension CompanionClient {
    public func registerLiveActivity(pushToStart token: String) async throws {
        guard Self.validActivityToken(token) else { throw CompanionError(code: "invalid-request", message: "The Live Activity token isn't valid.") }
        _ = try await send("POST", "/v1/devices/live-activity-tokens", body: JSONValue.data(["pushToStart": .string(token)]), timeout: 10).checked(path: "/v1/devices/live-activity-tokens")
    }

    /// A nil token forgets an ended activity at the companion.
    public func registerLiveActivity(printId: String, token: String?) async throws {
        guard UUID(uuidString: printId) != nil, token.map(Self.validActivityToken) ?? true else {
            throw CompanionError(code: "invalid-request", message: "The Live Activity token isn't valid.")
        }
        _ = try await send("POST", "/v1/devices/live-activity-tokens",
            body: JSONValue.data(["activity": .object(["printId": .string(printId), "token": token.map(JSONValue.string) ?? .null])]), timeout: 10).checked(path: "/v1/devices/live-activity-tokens")
    }

    private static func validActivityToken(_ value: String) -> Bool { Pattern("[0-9a-fA-F]{32,512}").matches(value) && value.count.isMultiple(of: 2) }
}
