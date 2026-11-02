import XCTest

final class FusionSetupTests: XCTestCase {
    private let env = """
    PRINTER_HOST=192.168.1.20
    BAMBU_TOKEN=secret
    BLENDER_MCP_COMMAND=/opt/homebrew/bin/uvx
    BLENDER_MCP_ARGS=["blender-mcp"]
    TEMP_DIR=./temp

    """

    func testSetUpWritesTheFiveSettingsRightAfterBlendersAndKeepsEveryOtherLine() {
        let merged = FusionSetup.merge(env:env)
        let lines = merged.components(separatedBy:"\n")
        let blender = lines.firstIndex { $0.hasPrefix("BLENDER_MCP_ARGS=") }!
        XCTAssertEqual(Array(lines[(blender + 1)...(blender + 5)]).map { $0.components(separatedBy:"=")[0] },
                       ["FUSION_MCP_COMMAND", "FUSION_MCP_ARGS", "FUSION_MCP_TIMEOUT_MS", "FUSION_MCP_HOST", "FUSION_MCP_PORT"])
        XCTAssertTrue(merged.contains("FUSION_MCP_COMMAND=/opt/homebrew/bin/uvx\n"), "the same uvx the Blender bridge uses")
        XCTAssertTrue(merged.contains("FUSION_MCP_ARGS=[\"--from\",\"git+https://github.com/DMontgomery40/fusion360-mcp-server@86a3016a5a5b\",\"fusion360-mcp-server\",\"--mode\",\"socket\"]\n"))
        XCTAssertTrue(merged.contains("FUSION_MCP_PORT=9877\n"), "off Blender's 9876")
        for line in env.components(separatedBy:"\n") where !line.isEmpty { XCTAssertTrue(lines.contains(line), line) }
        XCTAssertTrue(FusionSetup.isConfigured(env:merged))
        XCTAssertFalse(FusionSetup.isConfigured(env:env))
    }

    func testSetUpTwiceChangesNothingAndReplacesAnOlderBlock() {
        let once = FusionSetup.merge(env:env)
        XCTAssertEqual(FusionSetup.merge(env:once), once)
        let stale = env + "FUSION_MCP_COMMAND=old\nFUSION_MCP_PORT=9876\n"
        let fixed = FusionSetup.merge(env:stale)
        XCTAssertFalse(fixed.contains("FUSION_MCP_COMMAND=old"))
        XCTAssertEqual(fixed.components(separatedBy:"FUSION_MCP_PORT=").count, 2, "one port line")
        XCTAssertEqual(FusionSetup.merge(env:"A=1"), "A=1\n\nFUSION_MCP_COMMAND=uvx\n" + FusionSetup.settings(blenderCommand:nil).dropFirst().map { "\($0.0)=\($0.1)" }.joined(separator:"\n") + "\n",
                       "without Blender's settings the block goes at the end, with plain uvx")
    }

    func testOnlyThePinnedAddInFilesPassVerification() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fusion-verify-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:folder) }
        try FileManager.default.createDirectory(at:folder.appendingPathComponent("server"), withIntermediateDirectories:true)
        try Data("not the add-in".utf8).write(to:folder.appendingPathComponent("Fusion360MCP.py"))
        XCTAssertThrowsError(try FusionSetup.verify(folder))
        XCTAssertEqual(FusionSetup.addinFiles.count, 10)
        XCTAssertEqual(FusionSetup.commit.count, 40)
        XCTAssertTrue(FusionSetup.commit.hasPrefix(FusionSetup.shortCommit))
    }

    func testCodexPrinterServersAreReadFromItsTOML() {
        let toml = """
        model = "gpt-6"
        [mcp_servers.bambu]
        command = "node"
        args = ["/Users/me/bambu-printer-mcp/dist/index.js", "--stdio"]
        cwd = "/Users/me/bambu-printer-mcp"
        [mcp_servers.bambu.env]
        BAMBU_TOKEN = "x"
        [mcp_servers.other]
        command = 'uvx'
        """
        let servers = FusionSetup.codexServers(toml)
        XCTAssertEqual(servers.map(\.name), ["bambu", "other"])
        XCTAssertEqual(servers[0].cwd, "/Users/me/bambu-printer-mcp")
        XCTAssertEqual(servers[0].args, ["/Users/me/bambu-printer-mcp/dist/index.js", "--stdio"])
        XCTAssertEqual(servers[1].command, "uvx")
    }

    func testThePortAgentSetsTheVariableAtLogin() {
        let plist = FusionSetup.portAgentPlist
        XCTAssertEqual(plist["ProgramArguments"] as? [String], ["/bin/launchctl", "setenv", "FUSION_MCP_PORT", "9877"])
        XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
    }
}

final class DiagnosticsTests: XCTestCase {
    func testSecretsNeverLeaveInAnExport() {
        let env = "SCAN_TO_MAKE_PORT=9077\nBAMBU_ACCESS_CODE=12345678\nANTHROPIC_API_KEY=sk-ant\n# TOKEN=commented\nMCP_TRANSPORT=stdio"
        XCTAssertEqual(Diagnostics.redact(env:env),
                       "SCAN_TO_MAKE_PORT=9077\nBAMBU_ACCESS_CODE=<removed>\nANTHROPIC_API_KEY=<removed>\n# TOKEN=commented\nMCP_TRANSPORT=stdio")
        let json: [String: Any] = ["process": ["command": "/usr/bin/ssh", "env": ["BAMBU_TOKEN": "t", "MCP_TRANSPORT": "stdio"]], "selection": ["model": "p1s"]]
        let redacted = Diagnostics.redact(json:json) as! [String: Any]
        let env2 = (redacted["process"] as! [String: Any])["env"] as! [String: Any]
        XCTAssertEqual(env2["BAMBU_TOKEN"] as? String, "<removed>")
        XCTAssertEqual(env2["MCP_TRANSPORT"] as? String, "stdio")
        let log = "12:00 start BAMBU_TOKEN=synthetic-review-secret host=192.168.1.20\n{\"accessCode\": \"1234\", \"model\": \"p1s\"}\nAuthorization: Bearer abc.def-ghi\n"
        let clean = Diagnostics.redact(log:log)
        for secret in ["synthetic-review-secret", "1234", "abc.def-ghi"] { XCTAssertFalse(clean.contains(secret), secret) }
        XCTAssertTrue(clean.contains("host=192.168.1.20") && clean.contains("p1s"), "everything else stays readable")
        let url = "PRINTER_HOST=https://octo:hunter2@printer.example:5000/api"
        XCTAssertEqual(Diagnostics.redact(env:url), "PRINTER_HOST=https://<removed>@printer.example:5000/api")
        XCTAssertFalse(Diagnostics.redact(log:"connecting to http://user:pw@10.0.0.2").contains("pw"))
        XCTAssertEqual((Diagnostics.redact(json:["host": "http://a:b@h"]) as? [String: Any])?["host"] as? String, "http://<removed>@h")
    }
}
