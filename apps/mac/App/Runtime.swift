import Foundation
import ServiceManagement
import AgentKit

struct Installation {
    let bundle: Bundle
    var variant: String { bundle.object(forInfoDictionaryKey: "STMVariant") as? String ?? "" }
    var label: String { "com.scantomake.mac\(variant).companion" }
    var state: URL {
        for plist in [legacy,legacy.appendingPathExtension("pre-app")] {
            if let previous = try? LegacyInstallation(plist:plist) { return previous.state }
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Scan to Make\(variant)")
    }
    var resources: URL { bundle.resourceURL! }
    var node: URL { resources.appendingPathComponent("Payload/node/bin/node") }
    var script: URL { resources.appendingPathComponent("agent.mjs") }
    var marker: URL { state.appendingPathComponent("app-agent-enabled") }
    var legacy: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(variant.isEmpty ? "org.scantomake.companion" : label + ".legacy").plist") }
    var service: SMAppService { .agent(plistName: "\(label).plist") }
    func arguments(_ mode: String, extra: [String] = []) -> [String] { [script.path, mode] + extra }
    var environment: [String: String] { ["HOME": FileManager.default.homeDirectoryForCurrentUser.path,"PATH":"/usr/bin:/bin","STM_STATE":state.path, "STM_TEST_PORT":variant.isEmpty ? "9077" : "19077"] }
}

struct RegisteredAgent: AgentService {
    let service: SMAppService
    var enabled: Bool { service.status == .enabled }
    func register() throws {
        if service.status == .requiresApproval { throw AgentError.approvalRequired }
        if service.status != .enabled { try service.register() }
    }
    func unregister() throws { try service.unregister() }
}

/// Never include captured output or arguments in errors (pairing output is secret).
func command(_ executable: URL, _ args: [String], environment: [String: String]? = nil, input: Data? = nil) throws -> Data {
    let task = Process()
    let output = Pipe()
    task.executableURL = executable
    task.arguments = args
    task.environment = environment
    task.standardOutput = output
    task.standardError = FileHandle.nullDevice
    let inputPipe = input == nil ? nil : Pipe()
    task.standardInput = inputPipe?.fileHandleForReading ?? FileHandle.nullDevice
    try task.run()
    let timeout = DispatchWorkItem { if task.isRunning { task.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 20, execute: timeout)
    defer {
        timeout.cancel()
        try? inputPipe?.fileHandleForWriting.close()
        if task.isRunning { task.terminate() }
    }
    if let input, let inputPipe {
        try inputPipe.fileHandleForWriting.write(contentsOf:input)
        try inputPipe.fileHandleForWriting.close()
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    guard task.terminationStatus == 0 else { throw AgentError.commandFailed }
    return data
}

func launchAgent(_ installation: Installation) -> Never {
    umask(0o077)
    // Keep the signed app executable alive as the responsible code and supervise
    // Node as its child, rather than replacing the app process with Node.
    let child = Process()
    child.executableURL = installation.node
    child.arguments = installation.arguments("serve")
    child.environment = installation.environment
    child.environment?["SCAN_TO_MAKE_MODEL_WORKER"] = installation.bundle.executableURL?.path
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    child.terminationHandler = { process in exit(process.terminationStatus) }
    var sources: [DispatchSourceSignal] = []
    for number in [SIGTERM,SIGINT] {
        signal(number,SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal:number,queue:.main)
        source.setEventHandler { if child.isRunning { kill(child.processIdentifier,number) } }
        source.resume(); sources.append(source)
    }
    do { try child.run() } catch { exit(1) }
    withExtendedLifetime(sources) { RunLoop.main.run() }
    exit(1)
}

/// Headless signed entry point; it does not initialize SwiftUI or open windows.
/// The secret exists only in this short-lived helper and the worker it spawns.
func launchModelWorker(_ installation: Installation) -> Never {
    umask(0o077)
    do {
        let args = Array(CommandLine.arguments.dropFirst(2))
        guard let mode = args.first, ["check", "run"].contains(mode), mode != "check" || args.count == 1 else { exit(2) }
        var input = Data()
        while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
            input.append(chunk)
            guard input.count <= 65536 else { exit(2) }
        }
        let choice = try JSONDecoder().decode(ModelAccessChoice.self, from: input)
        var environment = try ModelWorkerEnvironment.make(choice: choice, base: ProcessInfo.processInfo.environment, credentials: ModelKeychain())
        if choice.keychainReference != nil {
            // App-owned paths, never values supplied by the helper caller.
            environment["SCAN_TO_MAKE_CAPTURE_PYTHON"] = installation.resources.appendingPathComponent("Payload/python/bin/python3").path
            let blender = "/Applications/Blender.app/Contents/MacOS/Blender"
            if FileManager.default.isExecutableFile(atPath: blender) { environment["SCAN_TO_MAKE_SCAN_BLENDER"] = blender }
        }
        let arguments = [installation.node.path, installation.resources.appendingPathComponent("Payload/source/services/companion/dist/ai-tweak-cli.js").path] + args
        let null = open("/dev/null", O_RDWR)
        guard null >= 0, dup2(null, STDIN_FILENO) >= 0, dup2(null, STDERR_FILENO) >= 0 else { exit(2) }
        if null > STDERR_FILENO { close(null) }
        var argv = arguments.map { strdup($0) } + [nil]
        var envp = environment.map { strdup($0.key + "=" + $0.value) } + [nil]
        defer { for value in argv + envp { free(value) } }
        // Replace this process: Foundation.Process would create a second process
        // group, outside the companion's cancellation/SIGKILL target.
        installation.node.path.withCString { executable in
            argv.withUnsafeMutableBufferPointer { arguments in
                envp.withUnsafeMutableBufferPointer { environment in
                    _ = execve(executable, arguments.baseAddress!, environment.baseAddress!)
                }
            }
        }
    } catch {
        // Never include Keychain errors, input metadata, keys or provider output.
    }
    exit(2)
}
