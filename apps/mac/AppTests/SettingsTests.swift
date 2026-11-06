import XCTest
#if canImport(ControlKit)
import ControlKit
#endif

final class FusionSetupTests: XCTestCase {
    /// fusion_mcp_setup's structured result, as the printer MCP sends it in its text content.
    func testTheMCPsSetupAnswerIsRead() throws {
        let text = #"{"platform":"darwin","supported":true,"fusion":{"installed":true,"path":"/Applications/Autodesk Fusion.app"},"ready":true,"installed":{"addin":"already-current","port_agent":"installed","env":"written"}}"#
        let setup = try FusionSetup.Setup.from(MCPCall.Reply(isError: false, text: text, server: "bambu-printer-mcp"))
        XCTAssertEqual(setup, FusionSetup.Setup(fusionInstalled: true, fusionPath: "/Applications/Autodesk Fusion.app", ready: true, env: "written", server: "bambu-printer-mcp"))
        let missing = try FusionSetup.Setup.from(MCPCall.Reply(isError: false, text: #"{"fusion":{"installed":false,"path":null},"ready":false}"#))
        XCTAssertFalse(missing.fusionInstalled)
        XCTAssertNil(missing.fusionPath)
        XCTAssertThrowsError(try FusionSetup.Setup.from(MCPCall.Reply(isError: true, text: "The downloaded add-in didn't match the pinned version, so nothing was installed."))) {
            XCTAssertEqual(($0 as? FusionSetup.Failure)?.errorDescription, "Fusion setup didn't finish: The downloaded add-in didn't match the pinned version, so nothing was installed.")
        }
        XCTAssertThrowsError(try FusionSetup.Setup.from(MCPCall.Reply(isError: false, text: "not json")))
    }

    /// The companion runs fusion_mcp_setup on the printer MCP as it runs it (its Update override included).
    func testTheCompanionsAnswerBecomesTheMCPsReply() throws {
        let answer = FusionSetupReply(setup: .object(["fusion": .object(["installed": .bool(true), "path": .string("/A.app")]), "ready": .bool(true)]), server: "bambu-printer-mcp")
        let reply = try FusionSetup.Steps.reply(from: answer)
        XCTAssertEqual(try FusionSetup.Setup.from(reply), FusionSetup.Setup(fusionInstalled: true, fusionPath: "/A.app", ready: true, env: nil, server: "bambu-printer-mcp"))
        XCTAssertEqual(try FusionSetup.Steps.reply(from: FusionSetupReply(setup: nil, server: "bambu-printer-mcp", error: "macOS only")),
                       MCPCall.Reply(isError: true, text: "macOS only", server: "bambu-printer-mcp"))
        for name in ["bambu-printer-mcp", "mcp-3D-printer-server"] {
            XCTAssertThrowsError(try FusionSetup.Steps.reply(from: FusionSetupReply(setup: nil, server: name))) {
                XCTAssertEqual(($0 as? FusionSetup.Failure)?.errorDescription, "Update \(name) in Settings → Printers so it can set up Fusion, then press Set Up again.")
            }
        }
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
