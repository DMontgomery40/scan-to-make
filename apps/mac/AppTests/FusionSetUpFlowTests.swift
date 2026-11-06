import XCTest
import Darwin

/// Settings → AI → Design with Fusion → Set Up (PRD §8.9), on fixtures: a fake printer MCP that answers
/// fusion_mcp_setup and a fake Fusion behind it. The MCP owns the install (PRD §8.0 item 11). Nothing on this Mac changes.
final class FusionSetUpFlowTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("fusion-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    private func write(_ text: String, _ path: String) throws -> URL {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private let ready = #"{"platform":"darwin","supported":true,"fusion":{"installed":true,"path":"/Applications/Autodesk Fusion.app"},"ready":true,"installed":{"addin":"installed","port_agent":"installed","env":"written"}}"#

    func testSetUpAsksThePrinterMCPToInstallThenAsksFusion() async throws {
        var asked: [Bool] = []
        let steps = FusionSetup.Steps(setup: { install in asked.append(install); return MCPCall.Reply(isError: false, text: self.ready, server: "bambu-printer-mcp") },
                                      status: { .connected })
        let report = try await FusionSetup.install(steps: steps)
        XCTAssertEqual(asked, [true], "one install, by the printer MCP")
        XCTAssertTrue(report.setup.ready)
        XCTAssertEqual(report.setup.env, "written")
        XCTAssertEqual(report.status, .connected)
        let checked = try await FusionSetup.check(steps: steps)
        XCTAssertEqual(asked, [true, false], "a check installs nothing")
        XCTAssertTrue(checked.fusionInstalled)
    }

    func testSetUpStopsWhenTheMCPCantInstallOrHasNoEnvFile() async throws {
        var statusAsked = false
        let refused = FusionSetup.Steps(setup: { _ in MCPCall.Reply(isError: true, text: "Fusion setup installs on macOS only.") }, status: { statusAsked = true; return .connected })
        do { _ = try await FusionSetup.install(steps: refused); XCTFail("it refused") }
        catch let failure as FusionSetup.Failure { XCTAssertEqual(failure, .setup("Fusion setup installs on macOS only.")) }
        // Not ready after installing: the MCP says what is missing, and that is what the person reads.
        let words = "This server has no .env file to add its Fusion settings to: add FUSION_MCP_COMMAND and FUSION_MCP_ARGS to its configuration."
        let notReady = FusionSetup.Steps(setup: { _ in MCPCall.Reply(isError: false, text: #"{"fusion":{"installed":true,"path":"/A.app"},"ready":false,"message":""# + words + #"","installed":{"addin":"installed","port_agent":"installed","env":"a-new-outcome"}}"#) },
                                      status: { statusAsked = true; return .connected })
        do { _ = try await FusionSetup.install(steps: notReady); XCTFail("not ready") }
        catch let failure as FusionSetup.Failure { XCTAssertEqual(failure, .notReady(words)); XCTAssertEqual(failure.errorDescription, words) }
        let older = FusionSetup.Steps(setup: { _ in nil }, status: { statusAsked = true; return .connected })
        do { _ = try await FusionSetup.install(steps: older); XCTFail("no setup tool") }
        catch let failure as FusionSetup.Failure { XCTAssertEqual(failure, .noSetupTool(server: "your printer MCP")) }
        XCTAssertFalse(statusAsked, "Fusion isn't asked until its setup finished")
    }

    /// The answer comes from `fusion_mcp_status`'s structured result through the companion (the same copy Settings →
    /// Printers runs), never from its wording (Settings → Printers follow-up, Nov 6; PRD §8.0's boundary).
    func testFusionsAnswerIsSaidPlainlyFromItsStructuredResult() {
        func status(_ json: String?, error: String? = nil) -> FusionSetup.Status {
            let value = json.flatMap { try? JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }
            return FusionSetup.Status.from(FusionStatusReply(status: value, server: "bambu-printer-mcp", error: error))
        }
        XCTAssertEqual(status(#"{"configured":true,"connected":true,"addinReachable":true,"fusionRunning":true,"activeDesign":true}"#), .connected)
        XCTAssertEqual(status(#"{"configured":true,"connected":true,"addinReachable":true,"fusionRunning":true}"#), .connected, "an MCP from before activeDesign")
        // faust-machines/fusion360-mcp-server#12: connected on Fusion's Home tab, no design open.
        let twelve = status(#"{"configured":true,"connected":true,"addinReachable":true,"fusionRunning":true,"activeDesign":false}"#)
        XCTAssertEqual(twelve, .needsDesign)
        XCTAssertEqual(twelve.words, "Open a design in Fusion first (File → New Design), then press Set Up Again.")
        XCTAssertEqual(status(#"{"configured":false,"connected":false,"addinReachable":false,"fusionRunning":false}"#), .notConfigured)
        // Fusion open from before Set Up: running, but the add-in isn't on the new port.
        XCTAssertEqual(status(#"{"configured":true,"connected":false,"addinReachable":false,"fusionRunning":true}"#), .reopenFusion)
        XCTAssertEqual(status(#"{"configured":true,"connected":false,"addinReachable":true,"fusionRunning":true,"error":"timed out after 90 s"}"#),
                       .notConnected("timed out after 90 s"))
        // Wording is shown, never matched: an error that mentions a design or port 9876 is still just Fusion not connecting.
        XCTAssertEqual(status(#"{"configured":true,"connected":false,"addinReachable":true,"fusionRunning":true,"error":"no active design; 9876 refused while running"}"#),
                       .notConnected("no active design; 9876 refused while running"))
        XCTAssertEqual(status(nil), .noBridge(server: "bambu-printer-mcp"))
        XCTAssertTrue(FusionSetup.Status.noBridge(server: "mcp-3d-printer-server").words.contains("Update it in Settings → Printers"))
        XCTAssertEqual(status(nil, error: "spawn uvx ENOENT"), .unreachable("spawn uvx ENOENT"))
        XCTAssertFalse(FusionSetup.Status.needsDesign.words.lowercased().contains("level"))
    }

    /// A fake printer MCP on stdio, answering in order; its reply to the tool call is `FAKE_REPLY`.
    private func fakeMCP(tools: [String], hang: Bool = false) throws -> URL {
        let list = tools.map { "{\"name\":\"\($0)\"}" }.joined(separator: ",")
        let script = """
        #!/bin/sh
        read line
        echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}'
        read line
        read line
        \(hang ? "/bin/sh -c 'exec /bin/sleep 30' \"$0\"" : "")
        echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[\(list)]}}'
        read line
        printf '%s\\n' "$FAKE_REPLY"
        """
        let url = try write(script, "fake-mcp.sh")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    func testTheStatusCallTalksToAFakeFusionThroughTheMCP() async throws {
        let reply = #"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"connected\":true,\"configured\":true}"}]}}"#
        let call = MCPCall(command: try fakeMCP(tools: ["fusion_mcp_status"]).path, args: [], env: ["FAKE_REPLY": reply])
        let answer = try await call.callTool("fusion_mcp_status", arguments: ["launch": true], timeout: 10)
        XCTAssertEqual(answer, MCPCall.Reply(isError: false, text: #"{"connected":true,"configured":true}"#, server: "fake"))
        let older = MCPCall(command: try fakeMCP(tools: ["print_3mf"]).path, args: [], env: ["FAKE_REPLY": reply])
        let none = try await older.callTool("fusion_mcp_status", arguments: [:], timeout: 10)
        XCTAssertNil(none, "a printer MCP without the Fusion bridge")
    }

    func testTheSetupCallTalksToThePrinterMCPOverStdio() async throws {
        let text = ready.replacingOccurrences(of: "\"", with: "\\\"")
        let reply = #"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":""# + text + #""}]}}"#
        let call = MCPCall(command: try fakeMCP(tools: ["fusion_mcp_setup"]).path, args: [], env: ["FAKE_REPLY": reply])
        let received = try await call.callTool("fusion_mcp_setup", arguments: ["install": true], timeout: 10)
        let answer = try XCTUnwrap(received)
        XCTAssertEqual(try FusionSetup.Setup.from(answer).ready, true)
        XCTAssertEqual(answer.server, "fake")
    }

    func testAStatusCallThatNeverAnswersTimesOut() async throws {
        // A wrapper (like npx) whose child keeps the output open: the deadline still ends the call.
        let wrapper = try write("#!/bin/sh\n'\(try fakeMCP(tools: [], hang: true).path)' &\nwait\n", "wrapper.sh")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        let call = MCPCall(command: wrapper.path, args: [])
        let started = Date()
        do {
            _ = try await call.callTool("fusion_mcp_status", arguments: [:], timeout: 1)
            XCTFail("it can't answer")
        } catch MCPCall.Failure.timedOut {
            XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        }
        let left = Process(), out = Pipe()
        left.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        left.arguments = ["-f", root.path]
        left.standardOutput = out
        try left.run(); left.waitUntilExit()
        XCTAssertEqual(String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self), "", "nothing of the probe is left running")
    }

    func testTheProbeFindsNodeAndHomebrewAsTheCompanionDoes() throws {
        let node = try write("#!/bin/sh\n", "Payload/node/bin/node")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let call = MCPCall.appOwned(command: "/opt/homebrew/Cellar/node/20.0.0/bin/node", args: ["dist/index.js"], cwd: nil, env: ["PATH": "/usr/bin:/bin"],
                                    bundledNode: node)
        XCTAssertEqual(call.command, node.path, "a node that is gone is the app's own")
        XCTAssertEqual(call.env["PATH"], "\(node.deletingLastPathComponent().path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        let ssh = MCPCall.appOwned(command: "/usr/bin/ssh", args: ["me@127.0.0.1"], cwd: nil, env: [:], bundledNode: node)
        XCTAssertEqual(ssh.command, "/usr/bin/ssh")
    }
}
