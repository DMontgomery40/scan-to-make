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
