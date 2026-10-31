import Foundation
import Security

public struct PrinterSetupChoice: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case none, bambu, other }
    public var kind: Kind
    public var printer_host: String?
    public var bambu_serial: String?
    public var bambu_model: String?
    public var printer_type: String?
    public var printer_port: String?
    public var keychainRef: UUID?
    public var connection_mode: String?
    public var slicer_path: String?
    public var slicer_type: String?
    public var blender_mcp_command: String?
    public var blender_mcp_args: String?
    public init(kind: Kind, printer_host: String? = nil, bambu_serial: String? = nil, bambu_model: String? = nil,
                printer_type: String? = nil, printer_port: String? = nil, keychainRef: UUID? = nil,
                connection_mode: String? = nil, slicer_path: String? = nil, slicer_type: String? = nil, blender_mcp_command: String? = nil, blender_mcp_args: String? = nil) {
        self.kind = kind; self.printer_host = printer_host; self.bambu_serial = bambu_serial; self.bambu_model = bambu_model
        self.printer_type = printer_type; self.printer_port = printer_port; self.keychainRef = keychainRef
        self.connection_mode = connection_mode; self.slicer_path = slicer_path; self.slicer_type = slicer_type
        self.blender_mcp_command = blender_mcp_command; self.blender_mcp_args = blender_mcp_args
    }
    public func validate() throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        guard try encoder.encode(self).count <= 12288 else { throw ModelAccessError.invalidChoice }
        func matches(_ value: String?, _ pattern: String) -> Bool { value.map { !$0.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) && $0.range(of: pattern, options: .regularExpression) != nil } ?? false }
        if kind == .none {
            guard printer_host == nil, bambu_serial == nil, bambu_model == nil, printer_type == nil,
                  printer_port == nil, keychainRef == nil, connection_mode == nil, slicer_path == nil, slicer_type == nil, blender_mcp_command == nil, blender_mcp_args == nil else { throw ModelAccessError.invalidChoice }
            return
        }
        guard keychainRef != nil, let host = printer_host, host.utf8.count <= 253,
              matches(host, "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$") else { throw ModelAccessError.invalidChoice }
        if kind == .bambu {
            guard matches(bambu_serial, "^[A-Za-z0-9]{1,64}$"),
                  ["p1s","p1p","p2s","x1c","x1e","a1","a1mini","h2d","h2dpro","h2s","h2c","x2d"].contains(bambu_model ?? ""),
                  ["lan_mqtt_ftps","bambu_native","bambu_network","bambu_connect"].contains(connection_mode ?? ""),
                  printer_type == nil, printer_port == nil, slicer_type == nil,
                  connection_mode != "bambu_native" || bambu_model == "x2d",
                  bambu_model != "x2d" || connection_mode != "lan_mqtt_ftps" else { throw ModelAccessError.invalidChoice }
            for path in [slicer_path, blender_mcp_command].compactMap({ $0 }) {
                guard path.utf8.count <= 4096, matches(path, "^/[^\\x00-\\x1f]*$") else { throw ModelAccessError.invalidChoice }
            }
            if let args = blender_mcp_args {
                guard args.utf8.count <= 8192, let data = args.data(using: .utf8),
                      let items = try? JSONDecoder().decode([String].self, from: data), items.count <= 64,
                      items.allSatisfy({ !$0.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) }) else { throw ModelAccessError.invalidChoice }
            }
        } else {
            guard ["octoprint","klipper","duet","repetier","prusa","creality"].contains(printer_type ?? ""),
                  bambu_serial == nil, bambu_model == nil, connection_mode == nil, blender_mcp_command == nil, blender_mcp_args == nil else { throw ModelAccessError.invalidChoice }
            if let type = slicer_type { guard ["prusaslicer","slic3r","cura","orcaslicer","orcaslicer-bambulab","bambustudio"].contains(type) else { throw ModelAccessError.invalidChoice } }
            if let path = slicer_path { guard path.utf8.count <= 4096, matches(path, "^/[^\\x00-\\x1f]*$") else { throw ModelAccessError.invalidChoice } }
            if let port = printer_port {
                guard matches(port, "^[1-9][0-9]{0,4}$"), let number = Int(port), number <= 65535 else { throw ModelAccessError.invalidChoice }
            }
        }
    }
    /// Everything which can choose the recipient or interpretation of a secret.
    /// Copying a credential between choices is allowed only for this destination.
    public var destination: [String: String] {
        var value = ["kind": kind.rawValue]
        for (key, item) in [("printer_host",printer_host),("bambu_serial",bambu_serial),("bambu_model",bambu_model),("printer_type",printer_type),("printer_port",printer_port)] {
            if let item { value[key] = item }
        }
        return value
    }
}

public struct PrinterCredential: Codable, CustomStringConvertible, CustomDebugStringConvertible {
    let version: Int
    let reference: UUID
    let choice: PrinterSetupChoice
    let secret: String
    public init(choice: PrinterSetupChoice, secret: String) throws {
        try choice.validate()
        guard let reference = choice.keychainRef else { throw ModelAccessError.invalidChoice }
        try ModelWorkerEnvironment.validateSecret(secret)
        version = 1; self.reference = reference; self.choice = choice; self.secret = secret
    }
    public func copied(from old: PrinterSetupChoice, to new: PrinterSetupChoice) throws -> PrinterCredential {
        try old.validate(); try new.validate()
        guard choice == old, reference == old.keychainRef, old.destination == new.destination,
              old.keychainRef != new.keychainRef else { throw ModelAccessError.credentialMismatch }
        return try PrinterCredential(choice: new, secret: secret)
    }
    public var description: String { "PrinterCredential(redacted)" }
    public var debugDescription: String { description }
}
public protocol PrinterCredentialStore {
    func read(_ reference: UUID) throws -> PrinterCredential
}
public struct PrinterKeychain: PrinterCredentialStore {
    public init() {}
    private func query(_ reference: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.scantomake.printer-setup",
         kSecAttrAccount as String: reference.uuidString.lowercased(), kSecAttrSynchronizable as String: false,
         kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecItemNotFound: throw ModelAccessError.credentialMissing
        case errSecInteractionNotAllowed, errSecAuthFailed: throw ModelAccessError.credentialLocked
        default: throw ModelAccessError.credentialUnavailable
        }
    }
    public func save(_ secret: String, for choice: PrinterSetupChoice) throws {
        let credential = try PrinterCredential(choice: choice, secret: secret)
        var item = query(credential.reference)
        item[kSecValueData as String] = try JSONEncoder().encode(credential)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        try check(SecItemAdd(item as CFDictionary, nil))
    }
    public func copyCredential(from old: PrinterSetupChoice, to new: PrinterSetupChoice) throws {
        guard let reference = old.keychainRef else { throw ModelAccessError.invalidChoice }
        let copied = try read(reference).copied(from: old, to: new)
        try save(copied.secret, for: new)
    }
    public func read(_ reference: UUID) throws -> PrinterCredential {
        var item = query(reference); item[kSecReturnData as String] = true; item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        try check(SecItemCopyMatching(item as CFDictionary, &result))
        guard let data = result as? Data, let saved = try? JSONDecoder().decode(PrinterCredential.self, from: data),
              saved.version == 1, saved.reference == reference else { throw ModelAccessError.credentialUnavailable }
        return saved
    }
    public func remove(_ reference: UUID) throws {
        let status = SecItemDelete(query(reference) as CFDictionary); if status != errSecItemNotFound { try check(status) }
    }
}

public enum PrinterWorkerEnvironment {
    public static func make(choice: PrinterSetupChoice, base: [String: String], credentials: any PrinterCredentialStore) throws -> [String: String] {
        try choice.validate()
        guard base.keys.allSatisfy({ ["__CF_USER_TEXT_ENCODING","__CFBundleIdentifier"].contains($0) }) else { throw ModelAccessError.forbiddenOverride }
        guard let reference = choice.keychainRef, let home = getpwuid(getuid())?.pointee.pw_dir else { throw ModelAccessError.invalidChoice }
        let saved = try credentials.read(reference)
        guard saved.version == 1, saved.reference == reference, saved.choice == choice else { throw ModelAccessError.credentialMismatch }
        try ModelWorkerEnvironment.validateSecret(saved.secret)
        var env = ["HOME": String(cString: home), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/tmp", "MCP_TRANSPORT": "stdio",
                   "PRINTER_HOST": saved.choice.destination["printer_host"]!, "PRINTER_TYPE": saved.choice.destination["printer_type"] ?? "bambu"]
        if choice.kind == .bambu {
            env["BAMBU_SERIAL"] = saved.choice.destination["bambu_serial"]; env["BAMBU_MODEL"] = saved.choice.destination["bambu_model"]; env["BAMBU_TOKEN"] = saved.secret
        } else {
            env["API_KEY"] = saved.secret; env["PRINTER_PORT"] = saved.choice.destination["printer_port"]
        }
        env["SLICER_PATH"] = choice.slicer_path
        env["SLICER_TYPE"] = choice.slicer_type
        if choice.kind == .bambu {
            env["BLENDER_MCP_COMMAND"] = choice.blender_mcp_command
            env["BLENDER_MCP_ARGS"] = choice.blender_mcp_args
        }
        return env
    }
}
