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

    // #799: the companion's part goes in as `companion/`, redacted again; a name that could leave the folder is left out.
    func testCompanionNamesStayInsideTheirFolder() {
        XCTAssertEqual(Diagnostics.safeRelativePath("mcp/P1S-bambu-printer-mcp/fulu/control-trace.log"), "mcp/P1S-bambu-printer-mcp/fulu/control-trace.log")
        for bad in ["", "/etc/passwd", "../escape.txt", "mcp/../../x", "a//b", "./a", "a\\b", "line\nbreak"] { XCTAssertNil(Diagnostics.safeRelativePath(bad), bad) }
    }

    private func unzip(_ zip: URL) throws -> URL {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("diag-out-\(UUID().uuidString)")
        let process = Process()
        process.executableURL = URL(fileURLWithPath:"/usr/bin/ditto")
        process.arguments = ["-x", "-k", zip.path, out.path]
        try process.run(); process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return out
    }

    private func everything(in folder: URL) -> [String: String] {
        var files: [String: String] = [:]
        let enumerator = FileManager.default.enumerator(at:folder, includingPropertiesForKeys:[.isRegularFileKey])
        while let url = enumerator?.nextObject() as? URL {
            guard (try? url.resourceValues(forKeys:[.isRegularFileKey]))?.isRegularFile == true else { continue }
            files[String(url.path.dropFirst(folder.path.count + 1))] = (try? String(contentsOf:url, encoding:.utf8)) ?? ""
        }
        return files
    }

    func testExportAddsTheCompanionPartTheBuildAndNotes() async throws {
        let fm = FileManager.default
        let state = fm.temporaryDirectory.appendingPathComponent("diag-state-\(UUID().uuidString)")
        try fm.createDirectory(at:state.appendingPathComponent("logs"), withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:state) }
        try "start BAMBU_TOKEN=synthetic-mac-secret login tester@example.com\n".write(to:state.appendingPathComponent("logs/companion.log"), atomically:true, encoding:.utf8)
        let zip = fm.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).zip")
        defer { try? fm.removeItem(at:zip) }
        let part = CompanionDiagnostics(files:[
            // As the companion sends it (already redacted); the Mac still removes value-shaped secrets it missed.
            .init(name:"events-tail.ndjson", content:"{\"seq\":1,\"token\":\"[redacted]\",\"by\":\"owner@example.com\"}\n", truncated:true),
            .init(name:"mcp/P1S-bambu-printer-mcp/fulu/control-trace.log", content:"serial=01P00A123456789 Authorization: Bearer synthetic-event-token mqtts://bblp:31415926@192.0.2.7\n", truncated:false),
            .init(name:"../escape.txt", content:"outside", truncated:false),
        ], notes:["mcp-3D-printer-server 1.2.26 is too old to add its own diagnostics; update it in Settings → Printers."])
        let ok = await Diagnostics.export(state:state, to:zip) { part }
        XCTAssertTrue(ok)
        let out = try unzip(zip)
        defer { try? fm.removeItem(at:out) }
        let files = everything(in:out)
        let root = files.keys.first { $0.hasSuffix("/about.txt") }.map { String($0.dropLast("about.txt".count)) } ?? ""
        XCTAssertNotNil(files[root + "companion/events-tail.ndjson"])
        XCTAssertTrue(files[root + "companion/mcp/P1S-bambu-printer-mcp/fulu/control-trace.log"]?.contains("01P00A123456789") == true, "serials stay")
        XCTAssertFalse(files.keys.contains { $0.contains("escape") }, "a name with .. never lands anywhere")
        let notes = try XCTUnwrap(files[root + "notes.txt"])
        XCTAssertTrue(notes.contains("mcp-3D-printer-server 1.2.26 is too old to add its own diagnostics; update it in Settings → Printers."))
        XCTAssertTrue(notes.contains("left out"))
        XCTAssertTrue(notes.contains("companion/events-tail.ndjson holds only its newest part."))
        XCTAssertTrue(try XCTUnwrap(files[root + "about.txt"]).contains("(build "), "the build number, not only 2.0")
        let all = files.values.joined(separator:"\n")
        for secret in ["synthetic-mac-secret", "synthetic-event-token", "31415926", "tester@example.com", "owner@example.com"] { XCTAssertFalse(all.contains(secret), secret) }
    }

    /// The companion's part arrives redacted: the Mac removes only value-shaped secrets again, so its JSON stays JSON
    /// and its words and `[set]` markers stay (#799 review).
    func testTheCompanionPartKeepsItsShape() {
        let event = "{\"seq\":1,\"passIndex\":2,\"words\":\"Failed to authenticate: Claude login\",\"BAMBU_ACCESS_CODE\": \"[set]\"}"
        XCTAssertEqual(Diagnostics.redact(companion:event), event)
        let leaky = "connect http://bblp:pw@192.0.2.7 Authorization: Bearer abc.def-ghi by tester@example.com scantomake://pair?c=secret"
        let clean = Diagnostics.redact(companion:leaky)
        for secret in ["pw@", "abc.def-ghi", "tester@example.com", "c=secret"] { XCTAssertFalse(clean.contains(secret), secret) }
        XCTAssertTrue(clean.contains("192.0.2.7"))
    }

    func testExportStillSucceedsWhenTheCompanionDoesNotAnswer() async throws {
        let fm = FileManager.default
        let state = fm.temporaryDirectory.appendingPathComponent("diag-state-\(UUID().uuidString)")
        try fm.createDirectory(at:state, withIntermediateDirectories:true)
        defer { try? fm.removeItem(at:state) }
        let zip = fm.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).zip")
        defer { try? fm.removeItem(at:zip) }
        struct Down: Error {}
        let ok = await Diagnostics.export(state:state, to:zip) { throw Down() }
        XCTAssertTrue(ok)
        let out = try unzip(zip)
        defer { try? fm.removeItem(at:out) }
        let files = everything(in:out)
        let notes = try XCTUnwrap(files.first { $0.key.hasSuffix("notes.txt") }?.value)
        XCTAssertTrue(notes.contains("couldn’t read the companion’s part"), notes)
        XCTAssertFalse(files.keys.contains { $0.contains("/companion/") })
    }
}
