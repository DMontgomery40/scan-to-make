import Foundation

/// A Mac discovered in this user's private CloudKit database. Its short-lived token is never logged.
public struct CloudMac: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let addresses: [String]
    public let publicKeySha256: String
    public let enrolmentToken: String
    public let expiresAt: Date

    public init?(id: String, name: String, addressesJSON: String, publicKeySha256: String,
                 enrolmentToken: String, expiresAt: Date) {
        struct Address: Decodable { let kind: String; let host: String; let port: Int? }
        guard UUID(uuidString: id) != nil, isPlainText(name, max: 128),
              CompanionAddress.validPin(publicKeySha256), Pattern("[A-Za-z0-9_-]{43}").matches(enrolmentToken),
              addressesJSON.utf8.count <= 8192,
              let entries = try? JSONDecoder().decode([Address].self, from: Data(addressesJSON.utf8)),
              (1...8).contains(entries.count) else { return nil }
        var origins: [String] = []
        for address in entries {
            guard ["lan", "mdns", "tailscale"].contains(address.kind),
                  !address.host.isEmpty, !address.host.contains(where: { "/@?#%".contains($0) }),
                  (1...65535).contains(address.port ?? 9077) else { return nil }
            let host = address.host.contains(":") && !address.host.hasPrefix("[") ? "[\(address.host)]" : address.host
            origins.append("https://\(host):\(address.port ?? 9077)")
        }
        guard let checked = CompanionAddress.pinnedAddresses(origins, pin: publicKeySha256) else { return nil }
        self.id = id; self.name = name; self.addresses = checked; self.publicKeySha256 = publicKeySha256
        self.enrolmentToken = enrolmentToken; self.expiresAt = expiresAt
    }

    public func isCurrent(now: Date = Date()) -> Bool { expiresAt > now }
}
