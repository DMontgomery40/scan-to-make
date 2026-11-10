import Foundation

/// The address rules every request follows. A port of the rules the iPhone app has kept natively since
/// pairing shipped (`CompanionPairing.mm`), so a record saved by an earlier app is read the same way.
public enum CompanionAddress {
    static let tailscaleHost = Pattern(#"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net"#)
    static let ipv4 = Pattern(#"[0-9]{1,3}(\.[0-9]{1,3}){3}"#)
    static let pin = Pattern("[a-f0-9]{64}")

    public static func validPin(_ value: String?) -> Bool { pin.matches(value) }

    /// The simulator's local test companions (http 9078, https 9079 on 127.0.0.1). Never on a device.
    public static func isFixture(_ url: URL?) -> Bool {
        #if targetEnvironment(simulator)
        return isFixture(url, simulator: true)
        #else
        return false
        #endif
    }

    /// The rule behind `isFixture`: only the simulator, only 127.0.0.1, exactly http 9078 and https 9079. A Debug build
    /// also accepts http on `debugFixturePorts`; that branch and the range are compiled only into Debug, so a Release
    /// build can't express the wider rule (scripts/tests/test_fixture_address_rule.py checks the source stays so).
    static func isFixture(_ url: URL?, simulator: Bool) -> Bool {
        guard simulator, let url, url.host == "127.0.0.1", let port = url.port else { return false }
        if url.scheme == "https" { return port == 9079 }
        guard url.scheme == "http" else { return false }
        if port == 9078 { return true }
        #if DEBUG
        return debugFixturePorts.contains(port)
        #else
        return false
        #endif
    }

    #if DEBUG
    /// Ports `scripts/ux_screens.py` gives its capture companions, so several prepared runs can wait at once (9079 stays
    /// the https fixture). Debug builds only.
    static let debugFixturePorts: ClosedRange<Int> = 9080...9097
    #endif

    private static func components(_ value: String?) -> URLComponents? {
        guard let value, value.count <= 300, let c = URLComponents(string: value),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/" else { return nil }
        return c
    }

    /// An unpinned companion: Tailscale Serve, a `*.ts.net` name on 443 (or a simulator fixture).
    public static func companionBaseURL(_ value: String?) -> URL? {
        guard var c = components(value) else { return nil }
        let remote = c.scheme == "https" && c.port == nil && tailscaleHost.matches(c.host)
        guard remote || isFixture(c.url) else { return nil }
        c.path = ""
        return c.url
    }

    /// A companion pinned by its certificate or public key: any HTTPS host and port where iOS's
    /// local-networking exemption applies (IP addresses, `.local` names, single-label names).
    public static func pinnedBaseURL(_ value: String?, pin: String?) -> URL? {
        guard validPin(pin), var c = components(value), c.scheme == "https", let host = c.host?.lowercased(), !host.isEmpty else { return nil }
        let address = ipv4.matches(host) || host.contains(":")
        if !address, !host.hasSuffix(".local"), host.contains(".") { return nil }
        c.path = ""
        return c.url
    }

    /// Pairing link v2 addresses: 1–8 distinct pinnable origins (no path or trailing slash), in order.
    public static func pinnedAddresses(_ value: [String]?, pin: String?) -> [String]? {
        guard let value, (1...8).contains(value.count) else { return nil }
        var seen = Set<String>()
        for address in value {
            guard pinnedBaseURL(address, pin: pin) != nil, !address.hasSuffix("/"), seen.insert(address.lowercased()).inserted else { return nil }
        }
        return value
    }

    /// Failures that say nothing about the companion move on to its next address.
    public static func tryNext(after failure: String) -> Bool {
        ["network", "timeout", "certificate", "certificate-changed"].contains(failure)
    }
}

/// This phone's pairing with one Mac, as the Keychain keeps it. The JSON object is kept whole, so an
/// earlier app's record (and any field this version doesn't use) survives being read and written back.
public struct PairingRecord: Equatable, Sendable {
    public var fields: [String: JSONValue]
    public init(fields: [String: JSONValue]) { self.fields = fields }

    public static let protocolVersion = "0.1.0"
    static let token = Pattern("[A-Za-z0-9_-]{43}")
    static let scopes: Set<String> = ["generation:health", "generation:create", "projects:read", "projects:write", "captures:read",
                                      "captures:import", "prepared-jobs:read", "prepared-jobs:prepare", "prints:approve", "printer-handoff:use"]

    public var baseUrl: String? { fields["baseUrl"]?.string }
    public var activeUrl: String? { fields["activeUrl"]?.string }
    public var deviceId: String? { fields["deviceId"]?.string }
    public var token: String? { fields["token"]?.string }
    public var expiresAtMs: Double { fields["expiresAt"]?.number ?? 0 }
    public var scopes: [String] { fields["scopes"]?.array?.compactMap(\.string) ?? [] }
    public var certificateSha256: String? { fields["certificateSha256"]?.string }
    public var publicKeySha256: String? { fields["publicKeySha256"]?.string }
    public var addresses: [String]? { fields["addresses"]?.array?.compactMap(\.string) }
    /// The pin in force: the public key (v2) or the certificate (v1), or nil for Tailscale Serve.
    public var pin: String? { publicKeySha256 ?? certificateSha256 }

    public func isExpired(now: Date = Date()) -> Bool { expiresAtMs <= now.timeIntervalSince1970 * 1000 }
    public func has(scope: String) -> Bool { scopes.contains(scope) }

    /// Where requests go: the last address that answered (`activeUrl`) or `baseUrl`, pinned or not.
    public var requestBaseURL: URL? {
        if let key = publicKeySha256 { return CompanionAddress.pinnedBaseURL(activeUrl ?? baseUrl, pin: key) }
        if let cert = certificateSha256 { return CompanionAddress.pinnedBaseURL(baseUrl, pin: cert) }
        return CompanionAddress.companionBaseURL(baseUrl)
    }

    /// The addresses to try: the last one that answered, then the rest in order.
    public var attemptOrder: [String] {
        guard let first = activeUrl ?? baseUrl else { return [] }
        return [first] + (addresses ?? []).filter { $0 != first }
    }

    /// The same pairing: same Mac, device, token, protocol and pin. Which listed address answered last
    /// (`activeUrl`), a renewed expiry or scope list do not make it a different pairing.
    public func isSamePairing(as other: PairingRecord?) -> Bool {
        guard let other else { return false }
        return ["baseUrl", "deviceId", "token", "protocolVersion", "certificateSha256", "publicKeySha256", "addresses"]
            .allSatisfy { fields[$0] == other.fields[$0] }
    }

    /// Whether the record can be used at all (shape, pins, addresses, token, scopes), not whether it is current.
    public var isValid: Bool {
        if let cert = fields["certificateSha256"], !CompanionAddress.validPin(cert.string) { return false }
        guard validAddresses, requestBaseURL != nil,
              fields["protocolVersion"]?.string == Self.protocolVersion,
              let device = deviceId, UUID(uuidString: device) != nil,
              Self.token.matches(token),
              let expires = fields["expiresAt"]?.number, expires > 0,
              validScopes else { return false }
        return true
    }

    private var validAddresses: Bool {
        guard let key = fields["publicKeySha256"] else { return fields["addresses"] == nil && fields["activeUrl"] == nil }
        guard let list = CompanionAddress.pinnedAddresses(fields["addresses"]?.array?.map { $0.string ?? "\u{0}" }, pin: key.string) else { return false }
        return fields["certificateSha256"] == nil && CompanionAddress.validPin(key.string)
            && baseUrl.map(list.contains) == true && (fields["activeUrl"] == nil || activeUrl.map(list.contains) == true)
    }

    private var validScopes: Bool {
        guard let raw = fields["scopes"]?.array, (2...10).contains(raw.count) else { return false }
        var seen = Set<String>()
        for item in raw {
            guard let scope = item.string, Self.scopes.contains(scope), seen.insert(scope).inserted else { return false }
        }
        return seen.contains("generation:health")
    }

    /// True when this record's companion is a simulator test fixture.
    public var isFixture: Bool { CompanionAddress.isFixture(requestBaseURL) }
}

/// What the app may know about the pairing. Never holds the token.
public struct PairingStatus: Equatable, Sendable {
    public enum State: String, Sendable { case disconnected, paired, expired }
    public var state: State
    public var baseUrl: String?
    public var activeUrl: String?
    public var deviceId: String?
    public var expiresAtMs: Double?
    public var fixture: Bool

    public static let disconnected = PairingStatus(state: .disconnected, baseUrl: nil, activeUrl: nil, deviceId: nil, expiresAtMs: nil, fixture: false)

    public init(state: State, baseUrl: String?, activeUrl: String?, deviceId: String?, expiresAtMs: Double?, fixture: Bool) {
        self.state = state; self.baseUrl = baseUrl; self.activeUrl = activeUrl
        self.deviceId = deviceId; self.expiresAtMs = expiresAtMs; self.fixture = fixture
    }

    public init(_ record: PairingRecord?, now: Date = Date()) {
        guard let record else { self = .disconnected; return }
        self.init(state: record.isExpired(now: now) ? .expired : .paired, baseUrl: record.baseUrl, activeUrl: record.activeUrl,
                  deviceId: record.deviceId, expiresAtMs: record.expiresAtMs, fixture: record.isFixture)
    }

    /// The host the phone talks to now, for "Address in use".
    public var host: String? { (activeUrl ?? baseUrl).flatMap(URL.init(string:))?.host }
}
