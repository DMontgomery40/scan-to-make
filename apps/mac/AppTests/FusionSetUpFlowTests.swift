import XCTest

/// Settings → AI → Design with Fusion → Set Up (PRD §8.9), end to end on fixtures: a printer MCP reached through the
/// SSH stopgap, a fake add-in, a fake launchctl and a fake Fusion behind a fake printer MCP. Nothing on this Mac changes.
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

    /// The stopgap's shape: ssh to 127.0.0.1 with a key whose forced command `cd`s to the MCP's checkout.
    private func stopgap() throws -> (state: URL, home: URL, mcp: URL) {
        let home = root.appendingPathComponent("home", isDirectory: true)
        let mcp = root.appendingPathComponent("home/bambu printer mcp", isDirectory: true)
        let identity = home.appendingPathComponent(".ssh/printer_ed25519").path
        _ = try write("ssh-ed25519 AAAAC3FAKEKEYBODY counterpart\n", "home/.ssh/printer_ed25519.pub")
        _ = try write("ssh-ed25519 AAAAOTHER someone\n"
                      + "from=\"127.0.0.1,::1\",restrict,command=\"cd '\(mcp.path)' && MCP_TRANSPORT=stdio exec node dist/index.js\" ssh-ed25519 AAAAC3FAKEKEYBODY counterpart\n",
                      "home/.ssh/authorized_keys")
        _ = try write("PRINTER_HOST=192.168.1.20\nBLENDER_MCP_COMMAND=/opt/homebrew/bin/uvx\nBLENDER_MCP_ARGS=[\"blender-mcp\"]\nTEMP_DIR=./temp\n",
                      "home/bambu printer mcp/.env")
        // ssh itself starts somewhere else: that folder's .env is not the one the MCP reads.
        _ = try write("WRONG=1\n", "elsewhere/.env")
        let handoff: [String: Any] = ["process": ["command": "/usr/bin/ssh", "cwd": root.appendingPathComponent("elsewhere").path,
                                                  "args": ["-T", "-i", identity, "-o", "BatchMode=yes", "me@127.0.0.1"]]]
        let state = root.appendingPathComponent("state", isDirectory: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: handoff).write(to: state.appendingPathComponent("printer-handoff.json"))
        return (state, home, mcp)
    }

    func testTheStopgapsForcedCommandNamesTheEnvFile() throws {
        let (state, home, mcp) = try stopgap()
        XCTAssertEqual(FusionSetup.envFiles(state: state, home: home).map(\.path), [mcp.appendingPathComponent(".env").path],
                       "the forced command's folder, not where ssh starts")
        XCTAssertEqual(FusionSetup.forcedCommandFolder(
            authorizedKeys: "restrict,command=\"cd /Users/d/bambu-printer-mcp && MCP_TRANSPORT=stdio exec node x\" ssh-ed25519 KEY c", keyBody: "KEY"),
            "/Users/d/bambu-printer-mcp")
        XCTAssertNil(FusionSetup.forcedCommandFolder(authorizedKeys: "ssh-ed25519 KEY c", keyBody: "KEY"), "no forced command")
    }

    func testSetUpInstallsTheAddinTheSettingsAndThePortThenAsksFusion() async throws {
        let (state, home, mcp) = try stopgap()
        let addin = try write("{\n  \"runOnStartup\": false\n}\n", "addin/Fusion360MCP.manifest").deletingLastPathComponent()
        _ = try write("# the add-in\n", "addin/Fusion360MCP.py")
        let addins = root.appendingPathComponent("AddIns", isDirectory: true)
        let agent = root.appendingPathComponent("LaunchAgents/\(FusionSetup.portAgentLabel).plist")
        var calls: [[String]] = []
        let steps = FusionSetup.Steps(home: home, addinsFolder: addins, portAgent: agent, withAddin: { use in try use(addin) },
                                      launchctl: { calls.append($0); return true }, status: { .connected })
        let report = try await FusionSetup.install(state: state, steps: steps)

        let manifest = try String(contentsOf: addins.appendingPathComponent("Fusion360MCP/Fusion360MCP.manifest"), encoding: .utf8)
        XCTAssertTrue(manifest.contains("\"runOnStartup\": true"), "the add-in runs when Fusion starts")
        let env = try String(contentsOf: mcp.appendingPathComponent(".env"), encoding: .utf8)
        let lines = env.components(separatedBy: "\n")
        let blender = try XCTUnwrap(lines.lastIndex { $0.hasPrefix("BLENDER_MCP_") })
        XCTAssertEqual(lines[blender + 1], "FUSION_MCP_COMMAND=/opt/homebrew/bin/uvx", "right after Blender's, with Blender's uvx")
        XCTAssertTrue(lines.contains("FUSION_MCP_PORT=9877"))
        XCTAssertTrue(lines.contains("PRINTER_HOST=192.168.1.20"), "every other line kept")
        let backups = try FileManager.default.contentsOfDirectory(atPath: mcp.path).filter { $0.hasPrefix(".env.bak-") }
        XCTAssertEqual(backups.count, 1, "a copy of the file first")
        let plist = try XCTUnwrap(NSDictionary(contentsOf: agent))
        XCTAssertEqual(plist["ProgramArguments"] as? [String], ["/bin/launchctl", "setenv", "FUSION_MCP_PORT", "9877"])
        XCTAssertTrue(calls.contains { $0.first == "bootstrap" && $0.last == agent.path })
        XCTAssertTrue(calls.contains(["setenv", "FUSION_MCP_PORT", "9877"]))
        XCTAssertEqual(report.envFiles.map(\.path), [mcp.appendingPathComponent(".env").path])
        XCTAssertEqual(report.status, .connected)
        let untouched = try String(contentsOf: root.appendingPathComponent("elsewhere/.env"), encoding: .utf8)
        XCTAssertEqual(untouched, "WRONG=1\n")
    }

    func testFusionsAnswerIsSaidPlainly() {
        XCTAssertEqual(FusionSetup.Status.from(toolMissing: false, isError: false, text: #"{"connected":true,"configured":true}"#), .connected)
        XCTAssertEqual(FusionSetup.Status.from(toolMissing: false, isError: false, text: #"{"configured":false}"#), .notConfigured)
        XCTAssertEqual(FusionSetup.Status.from(toolMissing: true, isError: false, text: ""), .noBridge)
        // faust-machines/fusion360-mcp-server#12
        let twelve = FusionSetup.Status.from(toolMissing: false, isError: false,
                                             text: #"{"connected":false,"error":"'NoneType' object has no attribute 'rootComponent': no active design"}"#)
        XCTAssertEqual(twelve, .needsDesign)
        XCTAssertEqual(twelve.words, "Open a design in Fusion first (File → New Design), then press Set Up Again.")
        XCTAssertEqual(FusionSetup.Status.from(toolMissing: false, isError: false, text: #"{"connected":false,"error":"timed out after 90 s"}"#),
                       .notConnected("timed out after 90 s"))
        XCTAssertEqual(FusionSetup.Status.from(toolMissing: false, isError: true, text: "spawn uvx ENOENT"), .unreachable("spawn uvx ENOENT"))
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
        \(hang ? "/bin/sleep 30" : "")
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
        XCTAssertEqual(answer, MCPCall.Reply(isError: false, text: #"{"connected":true,"configured":true}"#))
        let older = MCPCall(command: try fakeMCP(tools: ["print_3mf"]).path, args: [], env: ["FAKE_REPLY": reply])
        let none = try await older.callTool("fusion_mcp_status", arguments: [:], timeout: 10)
        XCTAssertNil(none, "a printer MCP without the Fusion bridge")
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
