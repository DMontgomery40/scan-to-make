import Foundation

/// Why a pairing invitation can't be used. The codes match `@scan-to-make/contracts/pairing-link`.
public enum PairingLinkError: String, Error, Equatable, Sendable {
    case invalid = "invalid-invitation"
    case expired = "expired-invitation"
    case unsupported = "unsupported-invitation"
}

/// The `scantomake://pair` link a companion shows as a QR code, versions 1 and 2. A rule-for-rule port of
/// `packages/contracts/src/pairing-link.ts`; `packages/contracts/fixtures/pairing-link-vectors.json` holds
/// both implementations to the same answers.
///
/// - v1: `v=1&u=<https base URL>&c=<code>&e=<expiresAt ms>[&f=<certificate SHA-256>]`
/// - v2: `v=2&c=<code>&e=<expiresAt ms>&k=<public key SHA-256>&a=<origin>[&a=<origin>…][&n=<name>]`
///
/// Unknown keys are ignored within a known version; a repeated single key is invalid.
public enum PairingLink: Equatable, Sendable {
    case v1(baseUrl: String, code: String, expiresAt: Int64, certificateSha256: String?)
    case v2(addresses: [String], code: String, expiresAt: Int64, publicKeySha256: String, name: String?)

    public static let maxAddresses = 8
    public static let maxName = 63

    static let code = Pattern("[A-Za-z0-9_-]{32}")
    static let sha256 = Pattern("[a-f0-9]{64}")
    static let v1URL = Pattern(#"https://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?/?"#, caseInsensitive: true)
    // iOS accepts a companion's own certificate only on IP addresses, .local names and single-label names.
    static let pinnableURL = Pattern(#"https://(\[[0-9a-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:[0-9]{1,5})?/?"#, caseInsensitive: true)
    static let pinnableOrigin = Pattern(#"https://(\[[0-9a-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:[0-9]{1,5})?"#, caseInsensitive: true)
    // Without a pin, the companion is reached through Tailscale Serve: a *.ts.net name on 443.
    static let tailscaleURL = Pattern(#"https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net/?"#, caseInsensitive: true)
    static let expiresDigits = Pattern("[0-9]{1,16}")
    static let versionDigits = Pattern("[1-9][0-9]{0,8}")
    static let maxSafeInteger: Int64 = 9_007_199_254_740_991

    public static func isPairingLink(_ text: String) -> Bool {
        text.range(of: "^scantomake://pair\\?", options: [.regularExpression, .caseInsensitive]) != nil
    }

    public var code: String {
        switch self { case .v1(_, let c, _, _), .v2(_, let c, _, _, _): c }
    }
    public var expiresAt: Int64 {
        switch self { case .v1(_, _, let e, _), .v2(_, _, let e, _, _): e }
    }

    /// Parses a link. `expired` is reported only when `now` (Unix milliseconds) is given.
    public static func parse(_ text: String, now: Int64? = nil) throws -> PairingLink {
        let params = try read(text)
        guard let version = params["v"], version.count == 1 else { throw PairingLinkError.invalid }
        guard version[0] == "1" || version[0] == "2" else {
            throw versionDigits.matches(version[0]) ? PairingLinkError.unsupported : PairingLinkError.invalid
        }
        let v = version[0] == "1" ? 1 : 2
        let single = v == 1 ? ["v", "u", "c", "e", "f"] : ["v", "c", "e", "k", "n"]
        if single.contains(where: { (params[$0]?.count ?? 0) > 1 }) { throw PairingLinkError.invalid }
        func one(_ key: String) -> String? { params[key]?.first }
        // Unix milliseconds as plain decimal digits only.
        let expiresAt: Int64? = one("e").flatMap { expiresDigits.matches($0) ? Int64($0) : nil }
        let link: PairingLink = v == 1
            ? .v1(baseUrl: one("u") ?? "", code: one("c") ?? "", expiresAt: expiresAt ?? -1, certificateSha256: one("f"))
            : .v2(addresses: params["a"] ?? [], code: one("c") ?? "", expiresAt: expiresAt ?? -1, publicKeySha256: one("k") ?? "", name: one("n"))
        return try check(link, now: now)
    }

    /// Form-decoded parameters in order, keeping every value of a repeated key.
    private static func read(_ text: String) throws -> [String: [String]] {
        guard isPairingLink(text), let mark = text.firstIndex(of: "?") else { throw PairingLinkError.invalid }
        var params: [String: [String]] = [:]
        for pair in text[text.index(after: mark)...].split(separator: "&", omittingEmptySubsequences: false) {
            let key: String, value: String
            if let split = pair.firstIndex(of: "=") {
                key = String(pair[..<split])
                guard let decoded = String(pair[pair.index(after: split)...]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding
                else { throw PairingLinkError.invalid }
                value = decoded
            } else {
                key = String(pair); value = ""
            }
            params[key, default: []].append(value)
        }
        return params
    }

    private static func check(_ link: PairingLink, now: Int64?) throws -> PairingLink {
        guard link.expiresAt > 0, link.expiresAt <= maxSafeInteger else { throw PairingLinkError.invalid }
        switch link {
        case let .v1(baseUrl, code, expiresAt, pin):
            guard v1URL.matches(baseUrl) else { throw PairingLinkError.invalid }
            if let pin, !sha256.matches(pin) { throw PairingLinkError.invalid }
            if let now, expiresAt <= now { throw PairingLinkError.expired }
            guard Self.code.matches(code) else { throw PairingLinkError.invalid }
            guard pin != nil ? pinnableURL.matches(baseUrl) : tailscaleURL.matches(baseUrl) else { throw PairingLinkError.invalid }
        case let .v2(addresses, code, expiresAt, key, name):
            guard Self.code.matches(code), sha256.matches(key),
                  (1...maxAddresses).contains(addresses.count),
                  Set(addresses.map { $0.lowercased() }).count == addresses.count,
                  addresses.allSatisfy({ pinnableOrigin.matches($0) }),
                  name.map(validName) ?? true else { throw PairingLinkError.invalid }
            if let now, expiresAt <= now { throw PairingLinkError.expired }
        }
        return link
    }

    /// 1–63 UTF-16 code units (as JavaScript counts them), no control characters.
    static func validName(_ name: String) -> Bool {
        (1...maxName).contains(name.utf16.count) && !name.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }
}

/// A parsed invitation, from a QR code, a pairing link or the older JSON invitation. v2 (`addresses` and a
/// public-key pin) pairs at each address in order; v1 at `baseUrl`, pinned to its certificate when it has one.
public struct PairingInvitation: Equatable, Sendable {
    public var baseUrl: String
    public var code: String
    public var expiresAt: Int64
    public var certificateSha256: String?
    public var addresses: [String]?
    public var publicKeySha256: String?
    public var name: String?

    /// True when the invitation names a Mac on the local network (pinned), so iOS will ask about the Wi-Fi.
    public var isLocal: Bool { certificateSha256 != nil || publicKeySha256 != nil }

    public init(baseUrl: String, code: String, expiresAt: Int64, certificateSha256: String? = nil,
                addresses: [String]? = nil, publicKeySha256: String? = nil, name: String? = nil) {
        self.baseUrl = baseUrl; self.code = code; self.expiresAt = expiresAt
        self.certificateSha256 = certificateSha256; self.addresses = addresses
        self.publicKeySha256 = publicKeySha256; self.name = name
    }

    public init(_ link: PairingLink) {
        switch link {
        case let .v1(baseUrl, code, expiresAt, pin):
            self.init(baseUrl: baseUrl, code: code, expiresAt: expiresAt, certificateSha256: pin)
        case let .v2(addresses, code, expiresAt, key, name):
            self.init(baseUrl: addresses[0], code: code, expiresAt: expiresAt, addresses: addresses, publicKeySha256: key, name: name)
        }
    }

    /// What the camera or a link gave: a `scantomake://pair` link, or the older JSON invitation
    /// (`{"version":1,"baseUrl","code","expiresAt","certificateSha256"?}`). `now` is Unix milliseconds.
    public static func parse(_ value: String, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws -> PairingInvitation {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("{") { return try legacy(text, now: now) }
        guard PairingLink.isPairingLink(text) else { throw PairingLinkError.invalid }
        return PairingInvitation(try PairingLink.parse(text, now: now))
    }

    private static func legacy(_ text: String, now: Int64) throws -> PairingInvitation {
        guard let object = JSONValue.object(from: Data(text.utf8)),
              object["version"] == .number(1),
              let url = object["baseUrl"]?.string,
              let code = object["code"]?.string,
              let expires = object["expiresAt"]?.number, expires.rounded() == expires, abs(expires) <= Double(PairingLink.maxSafeInteger)
        else { throw PairingLinkError.invalid }
        var pin: String?
        if let value = object["certificateSha256"] {
            guard let text = value.string, PairingLink.sha256.matches(text) else { throw PairingLinkError.invalid }
            pin = text
        }
        if Int64(expires) <= now { throw PairingLinkError.expired }
        guard !url.isEmpty, PairingLink.code.matches(code) else { throw PairingLinkError.invalid }
        if pin != nil, !PairingLink.pinnableURL.matches(url) { throw PairingLinkError.invalid }
        if pin == nil, !PairingLink.tailscaleURL.matches(url) { throw PairingLinkError.invalid }
        return PairingInvitation(baseUrl: url, code: code, expiresAt: Int64(expires), certificateSha256: pin)
    }
}
