import Foundation
import Darwin

public enum ModelAPIProvider: String, Codable, Sendable { case anthropic, openai }

/// Persisted metadata. A reference identifies one item in our Keychain service;
/// neither this type nor the control protocol can contain an API key.
public enum ModelAccessChoice: Equatable, Sendable, Codable {
    case none, claudeCode, codexCLI
    case api(provider: ModelAPIProvider, model: String, keychainRef: UUID)
    case endpoint(url: URL, model: String, keychainRef: UUID?)

    private enum Keys: String, CodingKey { case kind, provider, model, keychainRef, url }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "none": self = .none
        case "claude-code": self = .claudeCode
        case "codex-cli": self = .codexCLI
        case "api": self = .api(provider: try c.decode(ModelAPIProvider.self, forKey: .provider), model: try c.decode(String.self, forKey: .model), keychainRef: try c.decode(UUID.self, forKey: .keychainRef))
        case "endpoint": self = .endpoint(url: try Self.endpointURL(c.decode(String.self, forKey: .url)), model: try c.decode(String.self, forKey: .model), keychainRef: try c.decodeIfPresent(UUID.self, forKey: .keychainRef))
        default: throw ModelAccessError.invalidChoice
        }
        try validate()
    }
    public func encode(to encoder: Encoder) throws {
        try validate()
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .none: try c.encode("none", forKey: .kind)
        case .claudeCode: try c.encode("claude-code", forKey: .kind)
        case .codexCLI: try c.encode("codex-cli", forKey: .kind)
        case let .api(provider, model, reference):
            try c.encode("api", forKey: .kind); try c.encode(provider, forKey: .provider)
            try c.encode(model, forKey: .model); try c.encode(reference, forKey: .keychainRef)
        case let .endpoint(url, model, reference):
            try c.encode("endpoint", forKey: .kind); try c.encode(url, forKey: .url)
            try c.encode(model, forKey: .model); try c.encodeIfPresent(reference, forKey: .keychainRef)
        }
    }
    public var keychainReference: UUID? {
        switch self {
        case let .api(_, _, reference), let .endpoint(_, _, reference?): return reference
        default: return nil
        }
    }
    /// Validate the wire string before Foundation can percent-encode it.
    static func endpointURL(_ value: String) throws -> URL {
        guard value.hasPrefix("http://") || value.hasPrefix("https://"),
              value.utf8.count <= 2048,
              !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || "?#\\".unicodeScalars.contains($0) }),
              let parts = URLComponents(string: value), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port.map({ (0...65535).contains($0) }) ?? true,
              let url = parts.url else { throw ModelAccessError.invalidChoice }
        return url
    }
    public func validate() throws {
        let model: String
        switch self {
        case let .api(_, value, _): model = value
        case let .endpoint(url, value, _):
            _ = try Self.endpointURL(url.absoluteString)
            model = value
        default: return
        }
        guard model.range(of: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$", options: .regularExpression) != nil else { throw ModelAccessError.invalidChoice }
    }
}

public enum ModelAccessError: Error, Equatable { case invalidChoice, invalidSecret, credentialMissing, credentialLocked, credentialUnavailable, credentialMismatch, forbiddenOverride }

/// The whole immutable choice is encrypted with the key. No unbound legacy
/// string item is accepted. Avoid accidental diagnostic interpolation of secrets.
public struct ModelCredential: Codable, CustomStringConvertible, CustomDebugStringConvertible {
    let version: Int
    public let choice: ModelAccessChoice
    let secret: String
    public init(choice: ModelAccessChoice, secret: String) { self.version = 1; self.choice = choice; self.secret = secret }
    public var description: String { "ModelCredential(redacted)" }
    public var debugDescription: String { description }
}

public protocol ModelCredentialStore {
    func read(_ reference: UUID) throws -> ModelCredential
    func save(_ secret: String, for choice: ModelAccessChoice) throws
    func remove(_ reference: UUID) throws
}

public enum ModelWorkerEnvironment {
    /// Keyed workers accept no caller environment. These two variables may be
    /// inserted by macOS itself; neither chooses code or a credential destination.
    private static let systemMetadata = Set(["__CF_USER_TEXT_ENCODING", "__CFBundleIdentifier"])
    private static func trustedEnvironment() throws -> [String: String] {
        guard let home = getpwuid(getuid())?.pointee.pw_dir else { throw ModelAccessError.credentialUnavailable }
        return ["HOME": String(cString: home), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/tmp", "LANG": "en_US.UTF-8"]
    }
    /// The caller's choice is only an assertion. Once a reference is present,
    /// destination and model come exclusively from the Keychain's saved choice.
    public static func make(choice: ModelAccessChoice, base: [String: String], credentials: any ModelCredentialStore) throws -> [String: String] {
        try choice.validate()
        var selected = choice
        var secret: String?
        var env: [String: String]
        if let reference = choice.keychainReference {
            guard base.keys.allSatisfy({ systemMetadata.contains($0) }) else { throw ModelAccessError.forbiddenOverride }
            let saved = try credentials.read(reference)
            guard saved.version == 1, saved.choice == choice, saved.choice.keychainReference == reference else { throw ModelAccessError.credentialMismatch }
            try saved.choice.validate()
            try validateSecret(saved.secret)
            selected = saved.choice; secret = saved.secret
            env = try trustedEnvironment()
        } else {
            let allowed = Set(["HOME", "PATH", "TMPDIR", "LANG", "SCAN_TO_MAKE_CLAUDE_PATH", "SCAN_TO_MAKE_CODEX_PATH", "SCAN_TO_MAKE_SCAN_BLENDER", "SCAN_TO_MAKE_CAPTURE_PYTHON"])
            env = base.filter { allowed.contains($0.key) }
            if choice == .claudeCode || choice == .codexCLI {
                for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] { env[key] = base[key] }
            }
        }
        switch selected {
        case .none: env["SCAN_TO_MAKE_AI_ACCESS"] = "none"
        case .claudeCode: env["SCAN_TO_MAKE_AI_ACCESS"] = "claude-code"
        case .codexCLI: env["SCAN_TO_MAKE_AI_ACCESS"] = "codex-cli"
        case let .api(provider, model, _):
            env["SCAN_TO_MAKE_AI_ACCESS"] = "api"; env["SCAN_TO_MAKE_AI_PROVIDER"] = provider.rawValue
            env["SCAN_TO_MAKE_AI_MODEL"] = model
        case let .endpoint(url, model, _):
            env["SCAN_TO_MAKE_AI_ACCESS"] = "endpoint"; env["SCAN_TO_MAKE_AI_ENDPOINT"] = url.absoluteString
            env["SCAN_TO_MAKE_AI_MODEL"] = model
        }
        if let secret {
            env["SCAN_TO_MAKE_AI_KEY_ENV"] = "SCAN_TO_MAKE_MODEL_KEY"
            env["SCAN_TO_MAKE_MODEL_KEY"] = secret
        }
        return env
    }
    static func validateSecret(_ secret: String) throws {
        guard !secret.isEmpty, secret.utf8.count <= 16384,
              !secret.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }) else { throw ModelAccessError.invalidSecret }
    }
}
