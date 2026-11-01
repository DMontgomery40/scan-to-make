import Foundation

public protocol AgentService {
    func register() throws
    func unregister() throws
    var enabled: Bool { get }
}

public enum AgentError: Error, LocalizedError, Equatable {
    case approvalRequired, companionUnavailable, commandFailed, invalidInvitation, rollbackFailed
    public var errorDescription: String? {
        switch self {
        case .approvalRequired: return "Allow Scan to Make in System Settings → General → Login Items, then try again."
        case .companionUnavailable: return "Scan to Make couldn’t start in the background. Please try again."
        case .commandFailed: return "That didn’t work. Your saved projects and pairing are unchanged."
        case .invalidInvitation: return "Could not create a valid pairing code. Try again."
        case .rollbackFailed: return "The previous version of Scan to Make couldn’t be restarted. Its settings and data are kept."
        }
    }
}

/// Registration can require approval. The agent waits for an activation marker,
/// so registration never takes the old service's port before migration is ready.
public final class AgentManager {
    let service: AgentService
    public init(service: AgentService) { self.service = service }
    public func requireReady(probe: () throws -> Void) throws {
        guard service.enabled else { throw AgentError.approvalRequired }
        do { try probe() } catch { throw AgentError.companionUnavailable }
    }
    public func migrate(legacy: URL, preflight: () throws -> Void = {}, stop: () throws -> Void, restore: () throws -> Void,
                        preserveExistingAgent: Bool = false, activate: () throws -> Void = {}, deactivate: () throws -> Void = {}) throws {
        try service.register()
        guard service.enabled else { throw AgentError.approvalRequired }
        var stopped = false
        do {
            try preflight()
            try stop()
            stopped = true
            try activate()
            // Only the launch configuration is retired; auth, TLS, capture and
            // the old release remain in place for rollback and existing phones.
            if FileManager.default.fileExists(atPath: legacy.path) {
                try FileManager.default.moveItem(at: legacy, to: legacy.appendingPathExtension("pre-app"))
            }
        } catch {
            let original = error
            var rollbackFailed = false
            if !preserveExistingAgent {
                do { try deactivate() } catch { rollbackFailed = true }
                do { try service.unregister() } catch { rollbackFailed = true }
            }
            if stopped {
                do { try restore() } catch { rollbackFailed = true }
            }
            if rollbackFailed { throw AgentError.rollbackFailed }
            throw original
        }
    }
}

/// The installer puts its launcher directly under STM_INSTALL_ROOT. Resolve
/// paths from that plist so pairing and migration use the same data directory.
public struct LegacyInstallation {
    public let launcher: URL
    public let state: URL
    public let source: URL
    public var auth: URL { state.appendingPathComponent("auth") }
    public var cli: URL { source.appendingPathComponent("services/companion/dist/remote-auth-cli.js") }
    public var authModule: URL { source.appendingPathComponent("services/companion/dist/remote-auth.js") }
    public var healthcheck: URL { source.appendingPathComponent("deploy/companion/healthcheck.mjs") }
    public init(plist: URL) throws {
        let value = try PropertyListSerialization.propertyList(from:Data(contentsOf:plist),format:nil) as? [String:Any]
        guard let args = value?["ProgramArguments"] as? [String], args.count >= 2,
              args[0].hasPrefix("/"), args[1].hasPrefix("/") else { throw AgentError.commandFailed }
        launcher = URL(fileURLWithPath:args[0])
        state = launcher.deletingLastPathComponent()
        source = URL(fileURLWithPath:args[1]).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    public func pairingArguments() throws -> [String] {
        let value = try JSONSerialization.jsonObject(with:Data(contentsOf:auth.appendingPathComponent("auth.json"))) as? [String:Any]
        guard let config = value?["configuration"] as? [String:Any] else { throw AgentError.commandFailed }
        let logins = config["allowedLogins"] as? [String] ?? []
        return [cli.path,"pair-capture-and-printer-handoff",auth.path]
            + (config["transport"] as? String == "lan" ? [] : Array(logins.prefix(1)))
    }
}

/// Captured after the old server stops and before the new server can open auth.
/// On failed activation, restore a schema upgrade before restarting old code.
public struct AuthStoreSnapshot {
    private let file: URL
    private let bytes: Data
    private let version: Int
    private let hadBackup: Bool
    public init(file: URL) throws {
        self.file = file
        bytes = try Data(contentsOf:file)
        guard let value = try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
              let version = value["version"] as? Int else { throw AgentError.commandFailed }
        self.version = version
        hadBackup = FileManager.default.fileExists(atPath:file.deletingLastPathComponent().appendingPathComponent("auth.v1.json").path)
    }
    public func restoreIfUpgraded() throws {
        let data = (try? Data(contentsOf:file)) ?? Data()
        let current = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any]
        guard current?["version"] as? Int != version else { return }
        try bytes.write(to:file,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
        let backup = file.deletingLastPathComponent().appendingPathComponent("auth.v1.json")
        // A failed migration's backup must not obstruct a later v1→v2 retry.
        if !hadBackup, (try? Data(contentsOf:backup)) == bytes {
            try FileManager.default.removeItem(at:backup)
        }
    }
}

public struct PairingInvitation: Decodable {
    public let qrPayload: String
    public let expiresAt: Double
    public static func decode(_ data: Data, now: Date = Date()) throws -> Self {
        let invitation = try JSONDecoder().decode(Self.self, from: data)
        guard let url = URLComponents(string: invitation.qrPayload), url.scheme == "scantomake",
              url.host == "pair", invitation.expiresAt > now.timeIntervalSince1970 * 1000,
              invitation.qrPayload.utf8.count < 4096 else { throw AgentError.invalidInvitation }
        return invitation
    }
}
