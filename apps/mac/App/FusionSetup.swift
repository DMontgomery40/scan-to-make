import Foundation
#if canImport(ControlKit)
import ControlKit
#endif
import AppKit
import Darwin

/// Settings → AI → Design with Fusion (PRD §8.9). Counterpart never ships or requires Fusion. The printer MCP owns
/// Fusion's setup (`fusion_mcp_setup`, PRD §8.0 item 11): it finds Fusion, installs the Fusion360MCP add-in at the
/// commit it pins (checking every file), the login item that gives Fusion `FUSION_MCP_PORT`, and its own
/// `FUSION_MCP_*` settings. This app asks it, renders the answer and then asks Fusion itself (`fusion_mcp_status`).
enum FusionSetup {
    /// The add-in's port, off Blender's 9876, for the ping that tells "reopen Fusion" from "update the MCP".
    static let port = "9877"
    /// Autodesk's page for Fusion's free personal-use download.
    static let download = URL(string: "https://www.autodesk.com/products/fusion-360/personal")!

    /// What `fusion_mcp_setup` reported.
    struct Setup: Equatable {
        var fusionInstalled: Bool
        var fusionPath: String?
        /// The add-in is at the MCP's pin and runs on startup, the login item is loaded and the bridge is configured.
        var ready: Bool
        /// install: what it did with this MCP's settings, as the MCP names it (shown, never matched).
        var env: String?
        /// When not ready: what is missing, in the MCP's words.
        var message: String? = nil
        /// The MCP's name from `initialize`.
        var server: String?

        /// From the tool's structured result (its JSON text).
        static func from(_ reply: MCPCall.Reply) throws -> Setup {
            guard !reply.isError else { throw Failure.setup(reply.text) }
            guard let value = (try? JSONSerialization.jsonObject(with: Data(reply.text.utf8))) as? [String: Any],
                  let fusion = value["fusion"] as? [String: Any], let ready = value["ready"] as? Bool else { throw Failure.setup("") }
            return Setup(fusionInstalled: fusion["installed"] as? Bool ?? false, fusionPath: fusion["path"] as? String, ready: ready,
                         env: (value["installed"] as? [String: Any])?["env"] as? String,
                         message: value["message"] as? String, server: reply.server)
        }
    }

    enum Failure: LocalizedError, Equatable {
        case busy, noPrinterMCP, noSetupTool(server: String), notReady(String?), setup(String)
        var errorDescription: String? {
            switch self {
            case .busy: return "Fusion setup is already running on this Mac."
            case .noPrinterMCP: return "There's no printer MCP set up in Counterpart yet."
            case .noSetupTool(let server): return "Update \(server) in Settings → Printers so it can set up Fusion, then press Set Up again."
            case .notReady(let message): return message ?? "Fusion isn't set up yet. Check your printer MCP's Fusion setup on your Mac."
            case .setup(let reason): return reason.isEmpty ? "Fusion setup didn't finish." : "Fusion setup didn't finish: \(reason)"
            }
        }
    }

    /// The printer MCP the companion uses (printer-handoff.json's process), started fresh so it reads its current settings.
    static func printerMCP(state: URL) -> MCPCall? {
        guard let data = try? Data(contentsOf: state.appendingPathComponent("printer-handoff.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let process = json["process"] as? [String: Any],
              let command = process["command"] as? String else { return nil }
        return MCPCall.appOwned(command: command, args: process["args"] as? [String] ?? [], cwd: process["cwd"] as? String,
                                env: process["env"] as? [String: String] ?? [:])
    }

    /// Where Set Up goes. Tests swap in a fake printer MCP and a fake Fusion.
    struct Steps {
        /// `fusion_mcp_setup` (`install` installs what is missing); nil when the MCP has no such tool.
        var setup: (_ install: Bool) async throws -> MCPCall.Reply?
        /// `fusion_mcp_status {launch: true}` on the printer MCP, started fresh so it reads the new settings.
        var status: () async -> Status

        /// Through the companion, which runs the printer MCP as Settings → Printers last updated it.
        static func live(state: URL, socket: String) -> Steps {
            Steps(setup: { install in
                return try reply(from: try await ControlClient(socketPath: socket, timeout: install ? 330 : 100).fusionSetup(install: install))
            }, status: { await FusionSetup.checkStatus(state: state) })
        }

        /// The companion's answer as the MCP's reply; an MCP without the tool is named in the update message.
        static func reply(from answer: FusionSetupReply) throws -> MCPCall.Reply {
            if let error = answer.error { return MCPCall.Reply(isError: true, text: error, server: answer.server) }
            guard let setup = answer.setup else { throw Failure.noSetupTool(server: answer.server) }
            return MCPCall.Reply(isError: false, text: String(decoding: try JSONEncoder().encode(setup), as: UTF8.self), server: answer.server)
        }
    }

    /// What Set Up did, and what Fusion said when the printer MCP asked it.
    struct Report: Equatable {
        var setup: Setup
        var status: Status
    }

    /// The printer MCP's answer to "is Fusion set up?". It is read at most every ten minutes unless forced: each read
    /// starts the printer MCP.
    @MainActor private static var checked: (at: Date, setup: Setup)?
    @MainActor private static var attempted: Date?
    @MainActor private static var observing: Task<Void, Never>?
    @MainActor static func check(state: URL, socket: String, force: Bool = false) async throws -> Setup {
        if !force, let checked, Date().timeIntervalSince(checked.at) < 600 { return checked.setup }
        attempted = Date()
        let setup = try await check(steps: .live(state: state, socket: socket))
        checked = (Date(), setup)
        return setup
    }
    /// The latest answer, without waiting for one: the phone's report runs on the event path, and a printer MCP that
    /// starts slowly must never hold it up. A check older than ten minutes, or a failed attempt that long ago, starts
    /// another in the background; nil until the first answer.
    @MainActor static func latest(state: URL, socket: String) -> Setup? {
        let due = attempted.map { Date().timeIntervalSince($0) >= 600 } ?? true
        if due, observing == nil {
            attempted = Date()
            observing = Task { @MainActor in
                _ = try? await check(state: state, socket: socket, force: true)
                observing = nil
            }
        }
        return checked?.setup
    }
    static func check(steps: Steps) async throws -> Setup {
        guard let reply = try await steps.setup(false) else { throw Failure.noSetupTool(server: "your printer MCP") }
        return try Setup.from(reply)
    }

    /// Asks the printer MCP to install what Fusion's bridge is missing, then asks Fusion itself.
    @MainActor private static var installing = false
    @MainActor static func install(state: URL, socket: String) async throws -> Report {
        guard !installing else { throw Failure.busy }
        installing = true
        defer { installing = false; checked = nil; attempted = nil }
        return try await install(steps: .live(state: state, socket: socket))
    }

    static func install(steps: Steps) async throws -> Report {
        guard let reply = try await steps.setup(true) else {
            throw Failure.noSetupTool(server: "your printer MCP")
        }
        let setup = try Setup.from(reply)
        // What is still missing comes in the MCP's own words; the app never reads its codes.
        guard setup.ready else { throw Failure.notReady(setup.message) }
        return Report(setup: setup, status: await steps.status())
    }

    // MARK: Is it working?

    /// What `fusion_mcp_status {launch: true}` said, in plain words for Settings.
    enum Status: Equatable {
        case connected
        /// faust-machines/fusion360-mcp-server#12: Fusion answers only with a design open.
        case needsDesign
        /// Fusion was already open before Set Up, so it listens on the old port until it is opened again.
        case reopenFusion
        /// The add-in answers on its port, but the printer MCP doesn't recognise its reply (bambu-printer-mcp 1.1.49
        /// expects `result.pong`; the pinned add-in says `result.status: "pong"`).
        case bridgeOutdated(server: String)
        case notConfigured
        /// The printer MCP has no Fusion bridge (older than bambu-printer-mcp 1.1.4x).
        case noBridge
        case notConnected(String)
        case unreachable(String)

        var ok: Bool { self == .connected }
        /// No arbitrary MCP text, local paths or diagnostic detail crosses to a phone.
        var phoneMessage: String? {
            switch self {
            case .connected: return nil
            case .needsDesign, .reopenFusion, .notConfigured, .noBridge: return words
            case .bridgeOutdated: return "Update your printer MCP on the Mac, then try Fusion setup again."
            case .notConnected, .unreachable: return "Fusion did not connect. Check Counterpart on your Mac, then try again."
            }
        }
        var words: String {
            switch self {
            case .connected: return "Fusion is connected. New designs use it while it's running."
            case .needsDesign: return "Open a design in Fusion first (File → New Design), then press Set Up Again."
            case .reopenFusion: return "Quit Fusion and open it again, so it picks up the new settings. Then press Set Up Again."
            case .bridgeOutdated(let server):
                return "Fusion's add-in is answering, but \(server) doesn't recognise it yet. Update \(server), then press Set Up Again."
            case .notConfigured: return "Your printer MCP doesn't see the Fusion settings yet. Press Set Up Again."
            case .noBridge: return "Your printer MCP can't talk to Fusion. Update it in Settings → Printers, then press Set Up Again."
            case .notConnected(let reason): return reason.isEmpty ? "Fusion didn't connect." : "Fusion didn't connect: \(reason)"
            case .unreachable(let reason): return "Counterpart couldn't ask your printer MCP about Fusion: \(reason)"
            }
        }

        /// The status reply, then the design check when there was one.
        static func from(status: MCPCall.Reply?, design: MCPCall.Reply?) -> Status {
            let first = from(toolMissing: status == nil, isError: status?.isError ?? false, text: status?.text ?? "")
            guard first == .connected, let design, design.isError else { return first }
            let lower = design.text.lowercased()
            return lower.contains("no_active_design") || lower.contains("no active design") || lower.contains("no open design") ? .needsDesign : first
        }

        /// From the tool's reply (`{configured, connected, addinReachable, fusionRunning, error}`), or its error text.
        static func from(toolMissing: Bool, isError: Bool, text: String) -> Status {
            if toolMissing { return .noBridge }
            let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            let error = (value?["error"] as? String ?? (isError ? text : "")).trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = error.lowercased()
            if !isError, value?["configured"] as? Bool == false { return .notConfigured }
            if !isError, value?["connected"] as? Bool == true { return .connected }
            // Fusion was open before Set Up: it runs, but without the add-in on the new port until it is opened again.
            if !isError, value?["fusionRunning"] as? Bool == true, value?["addinReachable"] as? Bool == false { return .reopenFusion }
            if lower.contains("no_active_design") || lower.contains("no open design")
                || lower.contains("design") && (lower.contains("no active") || lower.contains("none open") || lower.contains("open a design")
                                            || lower.contains("activeproduct") || lower.contains("nonetype")) { return .needsDesign }
            if lower.contains("9876") || (lower.contains("refused") && lower.contains("running")) { return .reopenFusion }
            let short = error.count > 200 ? String(error.prefix(199)) + "…" : error
            return isError ? .unreachable(short) : .notConnected(short)
        }
    }

    /// Starts the printer MCP the companion uses (printer-handoff.json's process, fresh, so it reads the new settings)
    /// and asks it once.
    static func checkStatus(state: URL) async -> Status {
        guard let call = printerMCP(state: state) else { return .unreachable("there's no printer MCP set up in Counterpart yet.") }
        do {
            // Connected on Fusion's Home tab still can't make the first design (#12): a read of the open design's
            // parameters, which changes nothing, says whether one is open.
            let (reply, design) = try await call.callTool("fusion_mcp_status", arguments: ["launch": true, "timeout_ms": 90_000], timeout: 150) { reply in
                Status.from(toolMissing: false, isError: reply.isError, text: reply.text) == .connected
                    ? ("fusion_mcp_call", ["tool_name": "get_parameters", "arguments": [String: Any](), "timeout_ms": 20_000]) : nil
            }
            let status = Status.from(status: reply, design: design)
            // "Reopen Fusion" only when the add-in really doesn't answer on its port.
            if status == .reopenFusion, await addinAnswers(port: UInt16(port) ?? 9877) {
                return .bridgeOutdated(server: reply?.server ?? "your printer MCP")
            }
            return status
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}

extension FusionSetup {
    /// Whether the Fusion360MCP add-in answers a ping on this Mac (`{"type":"ping"}`, a success reply within 2 s).
    static func addinAnswers(port: UInt16, timeout: Int = 2) async -> Bool {
        await Task.detached { () -> Bool in
            let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard socket >= 0 else { return false }
            defer { close(socket) }
            // A listener that hangs up must fail the probe, not raise SIGPIPE in the app.
            var on: Int32 = 1
            setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var time = timeval(tv_sec: timeout, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(port).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard connected == 0 else { return false }
            let ping = Array("{\"type\":\"ping\",\"params\":{}}\n".utf8)
            guard ping.withUnsafeBufferPointer({ send(socket, $0.baseAddress, ping.count, 0) }) == ping.count else { return false }
            var reply = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while !reply.contains(0x0A), reply.count < 65_536 {
                let read = recv(socket, &buffer, buffer.count, 0)
                guard read > 0 else { break }
                reply.append(contentsOf: buffer[0..<read])
            }
            let line = reply.split(separator: 0x0A).first.map { Data($0) } ?? reply
            return ((try? JSONSerialization.jsonObject(with: line)) as? [String: Any])?["status"] as? String == "success"
        }.value
    }
}

/// One tool call to a stdio MCP server: initialize, list the tools, call one, then close. Newline-delimited JSON-RPC.
struct MCPCall {
    let command: String
    let args: [String]
    var cwd: String?
    var env: [String: String] = [:]

    struct Reply: Equatable {
        let isError: Bool
        let text: String
        /// The server's own name from `initialize` (`bambu-printer-mcp`, `mcp-3d-printer-server`).
        var server: String? = nil
    }

    /// As the companion starts a printer MCP (`appOwnedPrinterProcess`): a `node` that is gone is this app's own, and
    /// PATH has this app's node and the usual Homebrew folders, so `npx` and `uvx` are found from a GUI app.
    static func appOwned(command: String, args: [String], cwd: String?, env: [String: String],
                         bundledNode: URL? = Bundle.main.resourceURL?.appendingPathComponent("Payload/node/bin/node")) -> MCPCall {
        var command = command
        if (command as NSString).lastPathComponent == "node", !FileManager.default.isExecutableFile(atPath: command),
           let bundledNode, FileManager.default.isExecutableFile(atPath: bundledNode.path) { command = bundledNode.path }
        var env = env
        let inherited = env["PATH"] ?? ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let extra = [bundledNode?.deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin"].compactMap { $0 }
        env["PATH"] = (extra + [inherited]).joined(separator: ":")
        return MCPCall(command: command, args: args, cwd: cwd, env: env)
    }
    enum Failure: LocalizedError {
        case start, closed, timedOut
        var errorDescription: String? {
            switch self {
            case .start: return "it couldn't be started."
            case .closed: return "it closed before answering."
            case .timedOut: return "it didn't answer in time."
            }
        }
    }

    /// The tool's text and whether it is an error; nil when the server has no such tool.
    func callTool(_ name: String, arguments: [String: Any], timeout: TimeInterval) async throws -> Reply? {
        try await callTool(name, arguments: arguments, timeout: timeout, then: { _ in nil }).0
    }

    /// One call, then (when `then` names one from its reply) a second in the same session; nil for a tool it hasn't.
    func callTool(_ name: String, arguments: [String: Any], timeout: TimeInterval,
                  then: (Reply) -> (String, [String: Any])?) async throws -> (Reply?, Reply?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = args
        if let cwd, FileManager.default.fileExists(atPath: cwd) { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw Failure.start }
        defer {
            try? input.fileHandleForWriting.close()
            MCPCall.stop(process)
        }
        // At the deadline the call ends whether or not the output closes (a wrapper's child can keep it open), and the
        // server and its children are stopped.
        let watchdog = Watchdog()
        let lines = LineReader(output.fileHandleForReading)
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [process] in
            guard process.isRunning || !lines.isFinished else { return }
            watchdog.fire()
            lines.finish()
            MCPCall.stop(process)
        }
        func send(_ message: [String: Any]) throws {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(0x0A)
            try input.fileHandleForWriting.write(contentsOf: data)
        }
        func reply(to id: Int) async throws -> [String: Any] {
            while true {
                guard let line = await lines.next() else { throw watchdog.fired ? Failure.timedOut : Failure.closed }
                guard let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                      message["id"] as? Int == id else { continue }
                return message
            }
        }
        try send(["jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": ["protocolVersion": "2025-06-18", "capabilities": [:], "clientInfo": ["name": "Counterpart", "version": "1"]]])
        let server = ((try await reply(to: 1))["result"] as? [String: Any]).flatMap { ($0["serverInfo"] as? [String: Any])?["name"] as? String }
        try send(["jsonrpc": "2.0", "method": "notifications/initialized"])
        try send(["jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": [:]])
        let tools = Set((((try await reply(to: 2))["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String })
        func call(_ id: Int, _ name: String, _ arguments: [String: Any]) async throws -> Reply? {
            guard tools.contains(name) else { return nil }
            try send(["jsonrpc": "2.0", "id": id, "method": "tools/call", "params": ["name": name, "arguments": arguments]])
            let answer = try await reply(to: id)
            if let error = answer["error"] as? [String: Any] { return Reply(isError: true, text: error["message"] as? String ?? "", server: server) }
            let result = answer["result"] as? [String: Any] ?? [:]
            let text = (result["content"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
            return Reply(isError: result["isError"] as? Bool ?? false, text: text, server: server)
        }
        guard let first = try await call(3, name, arguments) else { return (nil, nil) }
        guard let (next, nextArguments) = then(first) else { return (first, nil) }
        return (first, try await call(4, next, nextArguments))
    }
}

/// Lines from a pipe, read on one background thread; `finish()` ends the reading at once, even if the pipe stays open.
final class LineReader: @unchecked Sendable {
    private var buffer = Data()
    private var finished = false
    private var waiting: CheckedContinuation<Void, Never>?
    private let lock = NSLock()

    init(_ handle: FileHandle) {
        Thread.detachNewThread { [self] in
            while true {
                let chunk = handle.availableData
                lock.lock()
                if finished { lock.unlock(); return }
                if chunk.isEmpty { finished = true } else { buffer.append(chunk) }
                let resume = waiting; waiting = nil
                let done = finished
                lock.unlock()
                resume?.resume()
                if done { return }
            }
        }
    }

    func next() async -> String? {
        while true {
            // A line already read comes before the end, even when the server wrote it and exited at once.
            switch takeOrEnd() {
            case .line(let line): return line
            case .end: return nil
            case .wait: break
            }
            await withCheckedContinuation { continuation in
                lock.lock()
                if finished || buffer.contains(0x0A) { lock.unlock(); continuation.resume(); return }
                waiting = continuation
                lock.unlock()
            }
        }
    }

    /// No more lines: the caller's wait ends now.
    func finish() {
        lock.lock()
        finished = true
        let resume = waiting; waiting = nil
        lock.unlock()
        resume?.resume()
    }

    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }

    private enum Next { case line(String), end, wait }
    private func takeOrEnd() -> Next {
        lock.lock(); defer { lock.unlock() }
        if let newline = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...newline)
            return .line(line)
        }
        return finished ? .end : .wait
    }
}

final class Watchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var didFire = false
    var fired: Bool { lock.lock(); defer { lock.unlock() }; return didFire }
    func fire() { lock.lock(); didFire = true; lock.unlock() }
}

extension MCPCall {
    /// Stops the server and everything under it (a wrapper's child, and its children, keep running when only the
    /// wrapper is told), deepest first.
    static func stop(_ process: Process) {
        guard process.isRunning else { return }
        let tree = descendants(of: process.processIdentifier)
        for pid in tree.reversed() { kill(pid, SIGTERM) }
        process.terminate()
    }

    static func descendants(of pid: pid_t) -> [pid_t] {
        let pgrep = Process(), out = Pipe()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-P", String(pid)]
        pgrep.standardOutput = out
        pgrep.standardError = FileHandle.nullDevice
        guard (try? pgrep.run()) != nil else { return [] }
        pgrep.waitUntilExit()
        let children = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .split(separator: "\n").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
        return children.flatMap { [$0] + descendants(of: $0) }
    }
}

/// The socket atomically claims a request. Install runs independently of the event reader,
/// so a slow download cannot block print notifications or settings refreshes.
@MainActor final class PhoneFusionSetup {
    private let report: () async throws -> Void
    private let claim: (String) async throws -> String?
    private let claimantId = UUID().uuidString
    private let install: () async -> (Bool, String?)
    private let complete: (String, Bool, String?) async throws -> Void
    private var claiming = false
    private var completing = false
    private var completion: (id: String, ok: Bool, message: String?)?
    private var task: Task<Void, Never>?
    init(report: @escaping () async throws -> Void, claim: @escaping (String) async throws -> String?,
         install: @escaping () async -> (Bool, String?), complete: @escaping (String, Bool, String?) async throws -> Void) {
        self.report = report; self.claim = claim; self.install = install; self.complete = complete
    }
    func refresh() async {
        try? await report()
        guard task == nil, !claiming else { return }
        if completion != nil { await sendCompletion(); return }
        claiming = true
        defer { claiming = false }
        guard let id = try? await claim(claimantId) else { return }
        task = Task { [self] in
            let (ok, message) = await install()
            completion = (id, ok, message)
            task = nil
            await sendCompletion()
        }
    }
    private func sendCompletion() async {
        guard let saved = completion, !completing else { return }
        completing = true
        defer { completing = false }
        do {
            try await complete(saved.id, saved.ok, saved.message)
            completion = nil
        } catch let failure as ControlRemoteError where failure.code == "conflict" {
            completion = nil // Expired/restarted companion: never reinstall to recover a result.
        } catch {
            // Preserve the exact result across a transient socket failure. Next refresh retries it.
        }
    }
}
