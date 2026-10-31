import AppKit
import Foundation
import ServiceManagement
import CoreImage.CIFilterBuiltins
import Network
import AgentKit

@MainActor final class CompanionModel: PairingSession {
    static let shared = CompanionModel()
    let install = Installation(bundle:.main)
    var error: String? {
        guard let failure else { return nil }
        if (failure as? AgentError) == .approvalRequired { return "Allow Scan to Make in Login Items, then retry." }
        if (failure as? AgentError) == .companionUnavailable { return failure.localizedDescription }
        return "Your pairing code couldn’t be created. Please try again."
    }
    var qr: NSImage? {
        guard let invitation else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(invitation.qrPayload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cg = CIContext().createCGImage(output.transformed(by:CGAffineTransform(scaleX:6,y:6)),from:output.extent.applying(CGAffineTransform(scaleX:6,y:6))) else { return nil }
        return NSImage(cgImage:cg,size:NSSize(width:cg.width,height:cg.height))
    }
    private var addresses = NetworkAddresses.current()
    private let monitor = NWPathMonitor()
    private var isConfigured: Bool { FileManager.default.fileExists(atPath: install.state.appendingPathComponent("auth/auth.json").path) }
    init() {
        super.init()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in self?.addresses = NetworkAddresses.current() }
        }
        monitor.start(queue:DispatchQueue(label:"com.scantomake.addresses"))
    }
    private func existingCompanion() throws -> LegacyInstallation? {
        if Bundle.main.object(forInfoDictionaryKey:"STMUseLegacyCompanion") as? String == "NO" { return nil }
        let plist = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/org.scantomake.companion.plist")
        guard FileManager.default.fileExists(atPath:plist.path) else { return nil }
        return try LegacyInstallation(plist:plist)
    }
    override func ensureCompanionReady() async throws {
        if let legacy = try existingCompanion() {
            // Probe with the live release's code/env; never replace or restart it.
            do {
                _ = try await Task.detached {
                    try command(legacy.launcher,[legacy.healthcheck.path])
                }.value
            } catch { throw AgentError.companionUnavailable }
            return
        }
        if !isConfigured {
            addresses = NetworkAddresses.current()
            guard let address = addresses.setupAddress else { throw AgentError.commandFailed }
            let installation = install
            _ = try await Task.detached {
                try command(installation.node,installation.arguments("configure",extra:[address]),environment:installation.environment)
            }.value
        }
        if !FileManager.default.fileExists(atPath:install.marker.path) { try await installAgent() }
        let installation = install
        try await Task.detached {
            try AgentManager(service:RegisteredAgent(service:installation.service)).requireReady {
                _ = try command(installation.node,installation.arguments("health"),environment:installation.environment)
            }
        }.value
    }
    override func isInvitationActive(_ invitation: PairingInvitation) async throws -> Bool {
        let legacy = try existingCompanion()
        let installation = install
        let executable = legacy?.launcher ?? installation.node
        let module = legacy?.authModule
            ?? installation.resources.appendingPathComponent("Payload/source/services/companion/dist/remote-auth.js")
        let auth = legacy?.auth ?? installation.state.appendingPathComponent("auth")
        let environment = legacy == nil ? installation.environment : nil
        let args = [installation.resources.appendingPathComponent("pairing-active.mjs").path,module.path,auth.path]
        let input = Data(invitation.qrPayload.utf8)
        let data = try await Task.detached { try command(executable,args,environment:environment,input:input) }.value
        return try JSONDecoder().decode(Bool.self,from:data)
    }
    override func mintInvitation() async throws -> PairingInvitation {
        let data: Data
        if let legacy = try existingCompanion() {
            data = try await Task.detached { try command(legacy.launcher,legacy.pairingArguments()) }.value
        } else {
            let installation = install
            data = try await Task.detached {
                try command(installation.node,installation.arguments("pair-capture-and-printer-handoff"),environment:installation.environment)
            }.value
        }
        return try PairingInvitation.decode(data)
    }
    func installAutomatically() async throws {
        if !isConfigured {
            guard let address = NetworkAddresses.current().setupAddress else { throw AgentError.commandFailed }
            let installation = install
            _ = try await Task.detached {
                try command(installation.node,installation.arguments("configure",extra:[address]),environment:installation.environment)
            }.value
        }
        try await installAgent()
    }
    private func installAgent() async throws {
        let installation = install
        do {
            let path = installation.bundle.bundleURL.resolvingSymlinksInPath().path
            let userApps = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/"
            guard path.hasPrefix("/Applications/") || path.hasPrefix(userApps) else { throw AgentError.commandFailed }
            guard isConfigured, FileManager.default.isExecutableFile(atPath: installation.node.path) else {
                throw AgentError.commandFailed
            }
            try await Task.detached {
                let fm = FileManager.default
                let legacy = installation.legacy
                let hasLegacy = fm.fileExists(atPath: legacy.path)
                let previous = hasLegacy ? try LegacyInstallation(plist:legacy) : nil
                var authSnapshot: AuthStoreSnapshot?
                if hasLegacy {
                    // Preserve dependency locations from the old installation, never its secrets.
                    let data = try Data(contentsOf: legacy)
                    let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
                    var metadata: [String: Any] = [:]
                    metadata["workingDirectory"] = plist?["WorkingDirectory"] as? String
                    if let args = plist?["ProgramArguments"] as? [String], let launcher = args.first {
                        // Read only worker executable paths, never source the launcher or
                        // copy credentials. External workers keep their original Python.
                        let code = "import json,shlex,sys; keys={'BLENDER','SCAN_TO_MAKE_CAPTURE_PYTHON','SCAN_TO_MAKE_SCAN_BLENDER','SCAN_TO_MAKE_SCAN_REPAIR_TOOL','SCAN_TO_MAKE_SCAN_CORRECT_TOOL'}; pairs=[x[7:].strip().split('=',1) for x in open(sys.argv[1]) if x.startswith('export ') and '=' in x]; print(json.dumps({k:shlex.split(v)[0] for k,v in pairs if k in keys}))"
                        let value = try command(installation.resources.appendingPathComponent("Payload/python/bin/python3"), ["-B","-c",code,launcher])
                        metadata["workerEnvironment"] = try JSONSerialization.jsonObject(with:value)
                    }
                    try JSONSerialization.data(withJSONObject: metadata).write(to: installation.state.appendingPathComponent("app-migration.json"), options: .atomic)
                }
                let wasActive = installation.service.status == .enabled && fm.fileExists(atPath:installation.marker.path)
                let manager = AgentManager(service: RegisteredAgent(service: installation.service))
                let domain = "gui/\(getuid())"
                let oldLabel = legacy.deletingPathExtension().lastPathComponent
                let legacyWasRunning = hasLegacy && (try? command(URL(fileURLWithPath:"/bin/launchctl"),["print",domain + "/" + oldLabel])) != nil
                try manager.migrate(legacy: legacy, preflight: {
                    if legacyWasRunning, let previous {
                        // New auth code may upgrade the store; preflight must use
                        // the running release, and only after background approval.
                        _ = try command(previous.launcher,[previous.healthcheck.path])
                    }
                }, stop: {
                    if legacyWasRunning { _ = try command(URL(fileURLWithPath:"/bin/launchctl"), ["bootout", domain, legacy.path]) }
                }, restore: {
                    if hasLegacy && installation.service.status == .enabled { throw AgentError.rollbackFailed }
                    try authSnapshot?.restoreIfUpgraded()
                    if legacyWasRunning { _ = try command(URL(fileURLWithPath:"/bin/launchctl"), ["bootstrap",domain,legacy.path]) }
                }, preserveExistingAgent: wasActive && !hasLegacy, activate: {
                    if let previous { authSnapshot = try AuthStoreSnapshot(file:previous.auth.appendingPathComponent("auth.json")) }
                    try Data().write(to: installation.marker, options:.atomic)
                    // The readiness probe below verifies the actual HTTPS listener, not
                    // SMAppService's registration status alone.
                    _ = try command(installation.node, installation.arguments("health"), environment: installation.environment)
                }, deactivate: {
                    if fm.fileExists(atPath: installation.marker.path) { try fm.removeItem(at: installation.marker) }
                })
            }.value
        } catch { throw error }
    }

}
