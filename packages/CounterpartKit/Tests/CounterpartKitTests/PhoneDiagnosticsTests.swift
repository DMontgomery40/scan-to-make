import XCTest
@testable import CounterpartKit

/// Settings → Share Diagnostics… on the iPhone and iPad (#799): what the ZIP holds, and that nothing secret leaves the phone.
final class PhoneDiagnosticsTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("phone-diagnostics-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    // Planted secrets: none of these may appear in any file of the ZIP.
    private let token = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e"
    private let bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwaG9uZSJ9.c2lnbmF0dXJlLXZhbHVl"
    private let pairingPin = "493817"
    private let certificatePin = String(repeating: "ab12", count: 16)
    private let email = "tester.person@icloud.com"
    private let accountName = "Taylor's MacBook Pro"
    private let host = "192.168.7.41"
    private let home = "/var/mobile/Containers/Data/Application/0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F"

    private func status() -> PairingStatus {
        PairingStatus(state: .paired, baseUrl: "https://\(host):8443", activeUrl: "https://user:\(token)@\(host):8443", deviceId: "device-\(token)",
                      expiresAtMs: 1_800_000_000_000, fixture: false, pin: certificatePin)
    }

    private func traceFiles() throws -> URL {
        let trace = folder.appendingPathComponent("Caches/media-trace.ndjson")
        try FileManager.default.createDirectory(at: trace.deletingLastPathComponent(), withIntermediateDirectories: true)
        let older = [
            #"{"event":"stage.begin","project":"p1","time":"1","scene":"active"}"#,
            #"{"event":"request.error","code":"timeout","detail":"Authorization: Bearer \#(bearer)","time":"2"}"#,
        ].joined(separator: "\n") + "\n"
        let newer = [
            #"{"event":"page.published","project":"p1","time":"3","file":"\#(home)/Library/Caches/Objects/p1/model.stl"}"#,
            #"{"event":"pair.start","pin":"\#(pairingPin)","account":"\#(email)","link":"scantomake://pair?code=\#(pairingPin)&pin=\#(certificatePin)","time":"4"}"#,
            #"{"event":"request.error","apiKey":"\#(token)","time":"5","path":"/Users/taylor/Library/Developer"}"#,
        ].joined(separator: "\n") + "\n"
        try older.write(to: trace.appendingPathExtension("1"), atomically: true, encoding: .utf8)
        try newer.write(to: trace, atomically: true, encoding: .utf8)
        return trace
    }

    private func diagnostics(trace: URL?) -> PhoneDiagnostics {
        PhoneDiagnostics(
            about: .init(version: "2.0", build: "202611141200", system: "iOS 27.7", model: "iPhone18,2"),
            pairing: .init(status: status(), link: .notAnswering, macName: accountName, cloudConfigured: true, cloudMacs: 1,
                           cloudMessage: "Signed in as \(email)."),
            errors: ["needs-pairing: The Mac refused token=\(token) from \(email)", "Printer: access_code: \(pairingPin) was refused"],
            drafts: [
                .init(run: "5b7c1f0e-8a8d-4b8e-9f4c-0d2a1e3b4c5d", project: "p1", status: "stopped", createdAt: "2026-11-14T10:00:00Z",
                      photos: 68, hasModel: false, stitchingIncomplete: false, message: "Upload to \(host) failed with password=\(pairingPin)"),
                .init(run: "1a2b3c4d-0000-4000-8000-000000000001", project: "p2", status: "ready", createdAt: "2026-11-13T09:00:00Z",
                      photos: 120, hasModel: true, stitchingIncomplete: true, message: nil),
            ],
            trace: trace,
            home: home)
    }

    private let day = Date(timeIntervalSince1970: 1_794_614_400) // 2026-11-14 00:00 UTC

    private func entries(_ zip: URL) throws -> [String: String] {
        let names = try run("/usr/bin/unzip", ["-Z1", zip.path]).split(separator: "\n").map(String.init)
        var files: [String: String] = [:]
        for name in names where !name.hasSuffix("/") { files[name] = try run("/usr/bin/unzip", ["-p", zip.path, name]) }
        return files
    }

    private func run(_ tool: String, _ arguments: [String]) throws -> String {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: tool); process.arguments = arguments; process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "\(tool) \(arguments)")
        return String(decoding: data, as: UTF8.self)
    }

    func testTheFileIsNamedForTheDayInThePhonesTimeZone() {
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(PhoneDiagnostics.fileName(date: day, timeZone: utc), "Counterpart Phone Diagnostics 2026-11-14.zip")
        // Late on Nov 13 in California is already Nov 14 in UTC: the phone's own day names the file.
        XCTAssertEqual(PhoneDiagnostics.fileName(date: day.addingTimeInterval(3600), timeZone: TimeZone(identifier: "America/Los_Angeles")!),
                       "Counterpart Phone Diagnostics 2026-11-13.zip")
    }

    func testTheZIPHoldsAboutTheTraceBothSegmentsPairingErrorsAndDrafts() throws {
        let zip = try diagnostics(trace: try traceFiles()).makeZIP(in: folder.appendingPathComponent("out"), date: day, timeZone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(zip.lastPathComponent, "Counterpart Phone Diagnostics 2026-11-14.zip")
        let files = try entries(zip)
        let top = "Counterpart Phone Diagnostics 2026-11-14/"
        XCTAssertEqual(Set(files.keys), Set(["about.txt", "notes.txt", "pairing.json", "errors.txt", "drafts.json",
                                             "media-trace.1.ndjson", "media-trace.ndjson"].map { top + $0 }))

        let about = try XCTUnwrap(files[top + "about.txt"])
        for fact in ["Counterpart 2.0 (build 202611141200)", "iOS 27.7", "iPhone18,2"] { XCTAssertTrue(about.contains(fact), about) }

        // Both segments, older first, every line still JSON.
        XCTAssertTrue(try XCTUnwrap(files[top + "media-trace.1.ndjson"]).contains("stage.begin"))
        let newer = try XCTUnwrap(files[top + "media-trace.ndjson"])
        XCTAssertTrue(newer.contains("page.published"))
        for line in newer.split(separator: "\n") { XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(line.utf8)), String(line)) }

        let pairing = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(files[top + "pairing.json"]).utf8)) as? [String: Any])
        XCTAssertEqual(pairing["state"] as? String, "paired")
        XCTAssertEqual(pairing["link"] as? String, "not answering")
        XCTAssertEqual(pairing["address"] as? String, "https, IPv4 address")
        XCTAssertEqual(pairing["pairedAddress"] as? String, "https, IPv4 address")
        XCTAssertEqual(pairing["certificatePinned"] as? Bool, true)
        XCTAssertEqual(pairing["iCloudMacs"] as? Int, 1)
        XCTAssertEqual(pairing["macNamed"] as? Bool, true, "that the Mac has a name, never the name")

        let drafts = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(files[top + "drafts.json"]).utf8)) as? [[String: Any]])
        XCTAssertEqual(drafts.map { $0["run"] as? String }, ["5b7c1f0e-8a8d-4b8e-9f4c-0d2a1e3b4c5d", "1a2b3c4d-0000-4000-8000-000000000001"])
        XCTAssertEqual(drafts.map { $0["photos"] as? Int }, [68, 120])
        XCTAssertEqual(drafts.map { $0["status"] as? String }, ["stopped", "ready"])
        XCTAssertEqual(drafts[1]["stitchingIncomplete"] as? Bool, true)

        let errors = try XCTUnwrap(files[top + "errors.txt"])
        XCTAssertTrue(errors.contains("needs-pairing: The Mac refused"), errors)
        XCTAssertTrue(errors.contains("only the latest"), errors)
        XCTAssertEqual(try XCTUnwrap(files[top + "notes.txt"]), "Everything this phone keeps is here.\n")
    }

    func testNoTokenPinEmailAccountNameAddressOrHomePathLeavesThePhone() throws {
        let zip = try diagnostics(trace: try traceFiles()).makeZIP(in: folder.appendingPathComponent("out"), date: day, timeZone: TimeZone(identifier: "UTC")!)
        let files = try entries(zip)
        XCTAssertEqual(files.count, 7)
        for (name, text) in files {
            for secret in [token, bearer, pairingPin, certificatePin, email, accountName, host, home, "/Users/taylor", "icloud.com"] {
                XCTAssertFalse(text.contains(secret), "\(name) still holds \(secret):\n\(text)")
            }
        }
        // What a person reading the report needs stays: the events, the error code, the home folder as `~`.
        let newer = try XCTUnwrap(files["Counterpart Phone Diagnostics 2026-11-14/media-trace.ndjson"])
        XCTAssertTrue(newer.contains("~/Library/Caches/Objects/p1/model.stl"), newer)
        XCTAssertTrue(newer.contains(#""event":"request.error""#), newer)
    }

    /// Paired only through iCloud, or with nothing paired and the Mac away: the export reads only what the phone has.
    func testWithNoPairingNoTraceAndNoDraftsTheZIPIsStillMade() throws {
        let alone = PhoneDiagnostics(
            about: .init(version: "2.0", build: "7", system: "iPadOS 27.7", model: "iPad16,3"),
            pairing: .init(status: .disconnected, link: .needsPairing(CompanionError(code: "needs-pairing", message: "Pair again.")),
                           macName: nil, cloudConfigured: true, cloudMacs: 0, cloudMessage: nil),
            errors: [], drafts: [], trace: folder.appendingPathComponent("Caches/media-trace.ndjson"), home: home)
        let files = try entries(try alone.makeZIP(in: folder.appendingPathComponent("out"), date: day, timeZone: TimeZone(identifier: "UTC")!))
        let top = "Counterpart Phone Diagnostics 2026-11-14/"
        XCTAssertEqual(Set(files.keys), Set(["about.txt", "notes.txt", "pairing.json", "errors.txt", "drafts.json"].map { top + $0 }))
        let notes = try XCTUnwrap(files[top + "notes.txt"])
        XCTAssertTrue(notes.contains("No media trace"), notes)
        XCTAssertTrue(notes.contains("not paired"), notes)
        XCTAssertEqual(try XCTUnwrap(files[top + "drafts.json"]).trimmingCharacters(in: .whitespacesAndNewlines), "[]")
        XCTAssertTrue(try XCTUnwrap(files[top + "errors.txt"]).contains("No request errors"))
        let pairing = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(files[top + "pairing.json"]).utf8)) as? [String: Any])
        XCTAssertEqual(pairing["state"] as? String, "disconnected")
        XCTAssertEqual(pairing["link"] as? String, "needs pairing (needs-pairing)")
        XCTAssertEqual(pairing["address"] as? String, "none")
    }

    /// A second export replaces the first's files instead of piling them up in the phone's temporary folder.
    func testASecondExportClearsTheFirst() throws {
        let out = folder.appendingPathComponent("out")
        let first = try diagnostics(trace: nil).makeZIP(in: out, date: day, timeZone: TimeZone(identifier: "UTC")!)
        let second = try diagnostics(trace: nil).makeZIP(in: out, date: day.addingTimeInterval(86_400), timeZone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(second.lastPathComponent, "Counterpart Phone Diagnostics 2026-11-15.zip")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path).count, 1)
    }

    // MARK: The rules (the companion's, `services/companion/src/diagnostics.ts` in #813, plus the phone's own)

    func testRedactionRemovesSecretShapesAndKeepsWordsAndMarkers() {
        let r = { DiagnosticsRedaction.redact($0, home: "/var/mobile/Containers/Data/Application/AAAA") }
        XCTAssertEqual(r(#"{"accessCode":"12345678","name":"P1S"}"#), #"{"accessCode":"[redacted]","name":"P1S"}"#)
        XCTAssertEqual(r(#"{"BAMBU_PRINTER_ACCESS_CODE":"[set]","token":"","auth":true}"#), #"{"BAMBU_PRINTER_ACCESS_CODE":"[set]","token":"","auth":true}"#)
        XCTAssertEqual(r(#"detail: "{\"apiKey\":\"abc123\"}""#), #"detail: "{\"apiKey\":\"[redacted]\"}""#)
        XCTAssertEqual(r("refresh_token=abc123 next"), "refresh_token=[redacted] next")
        XCTAssertEqual(r("--password hunter22 --verbose"), "--password [redacted] --verbose")
        XCTAssertEqual(r("Authorization: Bearer abcdef123456"), "Authorization: [redacted] [redacted]")
        XCTAssertEqual(r("Cookie: session=abc; other=def"), "Cookie: [redacted]")
        XCTAssertEqual(r("https://me:secret@example.com/path"), "https://[redacted]@example.com/path")
        XCTAssertEqual(r("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"), "[redacted private key]")
        XCTAssertEqual(r("pin=493817 pinCode: 1234"), "pin=[redacted] pinCode: [redacted]")
        XCTAssertEqual(r("pinned \(String(repeating: "0f", count: 32))"), "pinned [redacted hex]")
        XCTAssertEqual(r("/var/mobile/Containers/Data/Application/AAAA/Library/Caches"), "~/Library/Caches")
        XCTAssertEqual(r("/private/var/mobile/Containers/Data/Application/AAAA/tmp"), "~/tmp")
        XCTAssertEqual(r("/var/mobile/Containers/Shared/AppGroup/0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F/x"), "~/x")
        XCTAssertEqual(r("/Users/taylor/Library/Developer/CoreSimulator"), "/Users/[redacted]/Library/Developer/CoreSimulator")
        // Words that only contain a secret's name stay as they are.
        XCTAssertEqual(r("Failed to authenticate: Claude login expired"), "Failed to authenticate: Claude login expired")
        XCTAssertEqual(r(#"{"colourMapping":"ams","shipping":"x","pinnedBaseURL":"none"}"#), #"{"colourMapping":"ams","shipping":"x","pinnedBaseURL":"none"}"#)
        XCTAssertEqual(r("stage 3fa9c2d1 began"), "stage 3fa9c2d1 began")
    }

    func testAnAddressIsReducedToItsKind() {
        XCTAssertEqual(CompanionAddress.kind(nil), "none")
        XCTAssertEqual(CompanionAddress.kind("https://192.168.1.20:8443"), "https, IPv4 address")
        XCTAssertEqual(CompanionAddress.kind("https://[fe80::1]:8443"), "https, IPv6 address")
        XCTAssertEqual(CompanionAddress.kind("https://studio.local:8443"), "https, .local name")
        XCTAssertEqual(CompanionAddress.kind("https://studio:8443"), "https, single-label name")
        XCTAssertEqual(CompanionAddress.kind("https://studio.tail1234.ts.net"), "https, Tailscale name")
        XCTAssertEqual(CompanionAddress.kind("https://mac.example.com"), "https, other name")
        XCTAssertEqual(CompanionAddress.kind("not a url"), "unreadable")
    }
}
