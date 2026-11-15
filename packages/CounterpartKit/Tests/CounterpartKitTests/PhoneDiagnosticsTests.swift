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

    /// Every leak the lead's review of #813 found (https://github.com/DMontgomery40/scan-to-make/pull/813#issuecomment-6886304221),
    /// planted one by one: each secret must be gone, and the words around it kept.
    func testEveryLeakFromTheCompanionReviewIsCaught() {
        let home = "/var/mobile/Containers/Data/Application/AAAA"
        let cases: [(planted: String, secret: String, kept: String?)] = [
            // Authorization schemes in any case.
            ("authorization: bearer eyJhbGciOi.payload123.sig", "eyJhbGciOi", "authorization:"),
            ("Authorization: Bearer abcdef1234567890", "abcdef1234567890", "Authorization:"),
            ("authorization: basic dXNlcjpodW50ZXIy", "dXNlcjpodW50ZXIy", "authorization:"),
            ("AUTHORIZATION: BASIC dXNlcjpodW50ZXIy", "dXNlcjpodW50ZXIy", nil),
            (#"{"headers":{"authorization":"Digest username=x, response=6629fae4"}}"#, "6629fae4", #""headers""#),
            ("sent bearer abcdef1234567890 to the Mac", "abcdef1234567890", "to the Mac"),
            // Secret names, including this codebase's own.
            ("SCAN_TO_MAKE_MODEL_KEY=mk-1234567890", "mk-1234567890", "SCAN_TO_MAKE_MODEL_KEY="),
            ("SCAN_TO_MAKE_AI_KEY=ai-abcdefgh", "ai-abcdefgh", nil),
            ("session_key=s3ss10nvalue", "s3ss10nvalue", "session_key="),
            ("encryption_key: enc0ded", "enc0ded", nil),
            ("passphrase=correct horse", "correct", "passphrase="),
            ("PAIRING_PIN=493817", "493817", "PAIRING_PIN="),
            (#"{"pin":"493817","pinCode":5521}"#, "493817", #""pin""#),
            (#"{"pin":"493817","pinCode":5521}"#, "5521", nil),
            ("sessionId=abc123def", "abc123def", nil),
            ("refresh_token=abc123 next", "abc123", "next"),
            (#"{"clientSecret":"cs-998877"}"#, "cs-998877", nil),
            ("--password hunter22 --verbose", "hunter22", "--verbose"),
            ("Cookie: session=abc; other=def", "session=abc", "Cookie:"),
            ("x-credential: cred-77", "cred-77", nil),
            (#"detail: "{\"apiKey\":\"abc123\"}""#, "abc123", "detail:"),
            // Safe words count only as the whole value.
            ("token=[set]hunter2", "hunter2", nil),
            ("password=true-secret-value", "true-secret-value", nil),
            ("api_key=null-123456789", "null-123456789", nil),
            (#"{"token":"[set]hunter2"}"#, "hunter2", nil),
            (#"{"secret":"falsehood99"}"#, "falsehood99", nil),
            // Bare tokens and PEM blocks.
            ("cloned with ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghij", "cloned with"),
            ("github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG", nil),
            ("aws AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE", "here"),
            ("maps AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA1234567890", nil),
            ("key sk-ant-api03-abcdefghijklmnop", "abcdefghijklmnop", nil),
            ("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "MIIabc", nil),
            ("-----BEGIN CERTIFICATE-----\nMIIcert\n-----END CERTIFICATE-----", "MIIcert", nil),
            ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaA", nil),
            (#"{"pem":"-----BEGIN EC PRIVATE KEY-----\nMHcCAQ\n-----END EC PRIVATE KEY-----"}"#, "MHcCAQ", nil),
            ("https://me:secret@example.com/path", "me:secret", "example.com/path"),
            // Emails and paths with a person's name in them.
            ("signed in as Taylor.Person+beta@icloud.com", "Taylor.Person", "signed in as"),
            ("to=taylor%40example.com", "taylor%40example", nil),
            ("/Users/taylor/Library/Developer/CoreSimulator", "taylor", "/Library/Developer/CoreSimulator"),
            (#"{"path":"\/Users\/taylor\/Library"}"#, "taylor", #"\/Library"#),
            ("/home/taylor/.config", "taylor", "/.config"),
            ("/Users/Taylor Person/Desktop", "Person", "/Desktop"),
            ("\(home)/Library/Caches", "AAAA", "~/Library/Caches"),
            ("/private\(home)/tmp", "AAAA", "~/tmp"),
            (#"\/var\/mobile\/Containers\/Data\/Application\/0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F\/Documents"#, "0C4F6B0E", "Documents"),
            ("/var/mobile/Containers/Shared/AppGroup/0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F/x", "0C4F6B0E", nil),
            ("/var/mobile/Library/Mobile Documents/Taylor", "Taylor", "/var/mobile"),
            // The pairing code, token and certificate, in any form.
            ("scantomake://pair?v=2&c=AbCdEfGhIjKlMnOpQrStUvWxYz012345&k=\(String(repeating: "ab", count: 32))", "AbCdEfGhIjKlMnOp", "scantomake://pair?"),
            ("scantomake%3A%2F%2Fpair%3Fv%3D2%26c%3DAbCdEfGhIjKlMnOpQrStUvWxYz012345", "AbCdEfGhIjKlMnOp", nil),
            ("code AbCdEfGhIjKlMnOpQrStUvWxYz012345 sent", "AbCdEfGhIjKlMnOp", "sent"),
            ("token value Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e is new", "Z9y8X7w6V5u4", "is new"),
            ("pinned \(String(repeating: "0f", count: 32))", "0f0f0f0f", "pinned"),
            ("pin \(Array(repeating: "AB", count: 32).joined(separator: ":"))", "AB:AB:AB", nil),
            ("sha256/q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJabo=", "q83vEjRWeJq83vEjRWeJ", nil),
            ("Mac at 192.168.7.41 refused", "192.168.7.41", "refused"),
        ]
        for (planted, secret, kept) in cases {
            let out = DiagnosticsRedaction.redact(planted, home: home)
            XCTAssertFalse(out.contains(secret), "\(planted) → \(out)")
            if let kept { XCTAssertTrue(out.contains(kept), "\(planted) → \(out) lost \(kept)") }
        }
    }

    /// The lead's three regressions (Nov 14), each seen in a sibling redactor: a key=value rule taking "Bearer" as the value
    /// before the scheme rule; a plural-stripping step that turned "access" into "acces"; a harmless `https:` match that
    /// swallowed the rest of the URL, query and all.
    func testTheThreeSiblingRegressionsAreCaught() {
        let r = { DiagnosticsRedaction.redact($0, home: nil) }
        for header in ["Authorization: Bearer s3cr3tBearerValue99", "authorization: bearer s3cr3tBearerValue99",
                       "Proxy-Authorization: Bearer s3cr3tBearerValue99", #"{"Authorization":"Bearer s3cr3tBearerValue99"}"#] {
            let out = r(header)
            XCTAssertFalse(out.contains("s3cr3tBearerValue99"), "\(header) → \(out)")
            XCTAssertFalse(out.contains("[redacted] s3cr3t"), out)
        }
        for code in ["access-code: 31415926", "access_code=31415926", "ACCESS-CODE=31415926", "accessCodes: 31415926",
                     "BAMBU_ACCESS_CODE=31415926", #"{"access-code":"31415926"}"#] {
            XCTAssertFalse(r(code).contains("31415926"), "\(code) → \(r(code))")
        }
        for url in ["GET https://api.example.com/x?access_token=tokABC123456&y=1", "https://ex.com/cb#id_token=tokXYZ987654",
                    "see https: then https://ex.com/a?b=1&access_token=tokABC123456", #"{"url":"https:\/\/ex.com\/x?access_token=tokABC123456"}"#] {
            let out = r(url)
            XCTAssertFalse(out.contains("tokABC123456") || out.contains("tokXYZ987654"), "\(url) → \(out)")
        }
        XCTAssertTrue(r("GET https://api.example.com/x?access_token=tokABC123456&y=1").contains("api.example.com/x?access_token="), "the URL's start stays")
    }

    /// #814's planted-secret cases (Android `DiagnosticsTests.everyPlantedSecretIsRemoved`), ported as probes: each secret
    /// must not survive the phone's rules either.
    func testAndroidsPlantedSecretsAreRemovedToo() {
        let pin = String(repeating: "ab", count: 32)
        let pinBytes = Data(repeating: 0xab, count: 32)
        let token = "Zq3vK9xT2mWb7NcR4pLs8YdF1hGj6UeA0oIk5BnVt_w"
        let cases: [(String, String)] = [
            ("authorization: bearer abcDEF123456ghiJKL789", "abcDEF123456ghiJKL789"),
            ("Authorization: Bearer abcDEF123456ghiJKL789", "abcDEF123456ghiJKL789"),
            ("AUTHORIZATION: BASIC dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="),
            ("Proxy-Authorization: basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="),
            ("authorization: digest abcdef0123456789", "abcdef0123456789"),
            ("authorization=Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            ("sent with bearer abc-def_123456 to it", "abc-def_123456"),
            ("set-cookie: sid=lowcookie123; HttpOnly", "lowcookie123"),
            ("{\"headers\":{\"authorization\":\"Bearer abcdefghijkl\"}}", "abcdefghijkl"),
            ("SCAN_TO_MAKE_MODEL_KEY=hf_9f8e7d6c5b4a39281706f5e4d3c2b1a0", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"),
            ("{\"SCAN_TO_MAKE_LAN_TLS_KEY\":\"/k/p.key\",\"SCAN_TO_MAKE_AI_KEY\":\"plainhex0123456789abcdef0123\"}", "plainhex0123456789abcdef0123"),
            ("{\"session_key\":\"s3ss10nV4lue98765\"}", "s3ss10nV4lue98765"),
            ("session_key=s3ss10nV4lue98765", "s3ss10nV4lue98765"),
            ("encryption_key: deadbeefcafe0123456789", "deadbeefcafe0123456789"),
            ("passphrase=hunter2-horse-battery", "hunter2-horse-battery"),
            ("PAIRING_PIN=482910", "482910"),
            ("{\"pin\":\"482913\"}", "482913"),
            ("{\"pairingCode\":482913}", "482913"),
            ("pin: 482913", "482913"),
            ("The pairing code is 482913", "482913"),
            ("Enter PIN 482913 on the Mac", "482913"),
            ("{\"otp\":\"731204\"}", "731204"),
            ("{\"sessionId\":\"7f3a9c1e88b24d6fa015\"}", "7f3a9c1e88b24d6fa015"),
            ("{\"cookie\":\"sid=zzz999yyy888\"}", "zzz999yyy888"),
            ("access-code: 31415926", "31415926"),
            ("lan_code=87654321", "87654321"),
            ("client_secret=cs_9876543210abcdef", "cs_9876543210abcdef"),
            ("refresh token: rt_abcdef0123456789", "rt_abcdef0123456789"),
            ("X-Api-Key: headervalue123456", "headervalue123456"),
            ("{\"privateKey\":\"MIIEvQIBADANBgkq\"}", "MIIEvQIBADANBgkq"),
            ("{\"credentials\":{\"user\":\"x\"},\"bambuCredential\":\"cred-value-77\"}", "cred-value-77"),
            ("MY_SECRET=topsecret77 DB_PASSWORD='correct horse battery'", "correct horse"),
            ("{\"password\":\"correct horse battery\"}", "correct horse"),
            ("{\"\\u0070assword\":\"unicodesecret1\"}", "unicodesecret1"),
            ("say \\\"refresh_token\\\":\\\"abc.def.ghi\\\"", "abc.def.ghi"),
            ("--api-key sk_live_0123456789abcdefgh", "sk_live_0123456789abcdefgh"),
            ("--token=tok0123456789", "tok0123456789"),
            ("GET https://api.example.com/x?access_token=tokABC123456&y=1", "tokABC123456"),
            ("https://ex.com/cb#id_token=tokXYZ987654", "tokXYZ987654"),
            ("https://me:pw0rd99@printer.local/", "pw0rd99"),
            ("token=[set]hunter2value", "hunter2value"),
            ("password=true-secret-value", "true-secret-value"),
            ("api_key=null-123456789", "null-123456789"),
            ("secret=false_value99", "false_value99"),
            ("{\"password\":\"true-secret\"}", "true-secret"),
            ("{\"token\":\"[set]hunter2\"}", "hunter2"),
            ("cloned with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"),
            ("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "11ABCDEFG0123456789_abcdefghij"),
            ("aws id AKIAIOSFODNN7EXAMPLE ok", "IOSFODNN7EXAMPLE"),
            ("key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r done", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r"),
            ("k sk-ant-api03-abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"),
            ("t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart99", "eyJzdWIiOiIxIn0"),
            ("-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZZZ\n-----END CERTIFICATE-----", "MIIBszCCAVmgAwIBAgIUZZZ"),
            ("-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAbc123\n-----END EC PRIVATE KEY-----", "MHQCAQEEIAbc123"),
            ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk="),
            ("{\"pem\":\"-----BEGIN CERTIFICATE-----\\nMIIBszCCAVmgAwIBAgIUYYY\\n-----END CERTIFICATE-----\"}", "MIIBszCCAVmgAwIBAgIUYYY"),
            ("der MIIBszCCAVmgAwIBAgIUZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ== end", "MIIBszCCAVmgAwIBAgIUZZZZ"),
            ("a.b+tag@sub.example.co.uk", "a.b+tag@sub.example.co.uk"),
            ("mail someone@example.com now", "someone@example.com"),
            ("/Users/someoneelse/Library/x", "someoneelse"),
            ("/home/otherperson/y", "otherperson"),
            ("C:\\Users\\DavidM\\z", "DavidM"),
            ("{\\\"path\\\":\\\"\\/Users\\/davidm\\/Library\\\"}", "davidm"),
            ("log at ~davidm/Library/Logs", "davidm"),
            ("scantomake://pair?v=2&code=482913&pk=abc", "482913"),
            (pin, pin), (pin.uppercased(), pin.uppercased()),
            (Array(repeating: "ab", count: 32).joined(separator: ":"), Array(repeating: "ab", count: 32).joined(separator: ":")),
            (pinBytes.base64EncodedString(), pinBytes.base64EncodedString()),
            ("token \(token)", token),
        ]
        let leaks = cases.filter { DiagnosticsRedaction.redact($0.0, home: nil).contains($0.1) }
            .map { "\($0.0) → \(DiagnosticsRedaction.redact($0.0, home: nil))" }
        XCTAssertTrue(leaks.isEmpty, "Leaked:\n" + leaks.joined(separator: "\n"))
        for kept in ["Failed to authenticate: retry", "pinned: yes, colour-mapping: auto", "keyboard: us", "code: unreachable",
                     #"{"code":"timeout","route":"/v1/objects/x/passes/2/activity","status":409}"#, "Device: Google Pixel 8",
                     "TOKEN=[set] password=false KEY=", "Tailscale address (IPv4)"] {
            XCTAssertEqual(DiagnosticsRedaction.redact(kept, home: nil), kept)
        }
    }

    func testMarkersAndOrdinaryWordsStay() {
        let r = { DiagnosticsRedaction.redact($0, home: "/var/mobile/Containers/Data/Application/AAAA") }
        XCTAssertEqual(r(#"{"BAMBU_PRINTER_ACCESS_CODE":"[set]","token":"","auth":true,"key":null}"#),
                       #"{"BAMBU_PRINTER_ACCESS_CODE":"[set]","token":"","auth":true,"key":null}"#)
        XCTAssertEqual(r("token=[set] password=false"), "token=[set] password=false")
        XCTAssertEqual(r("Failed to authenticate: Claude login expired"), "Failed to authenticate: Claude login expired")
        XCTAssertEqual(r(#"{"colourMapping":"ams","shipping":"x","pinnedBaseURL":"none","keyboard":"on"}"#),
                       #"{"colourMapping":"ams","shipping":"x","pinnedBaseURL":"none","keyboard":"on"}"#)
        XCTAssertEqual(r("basic settings and a Token of thanks"), "basic settings and a Token of thanks")
        XCTAssertEqual(r(#"{"event":"stage.begin","stage":"3fa9c2d1","generation":"0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F"}"#),
                       #"{"event":"stage.begin","stage":"3fa9c2d1","generation":"0C4F6B0E-7E0A-4B8C-9F0A-1A2B3C4D5E6F"}"#)
    }

    /// The phone's own pairing token and pin go by value, however they were written down.
    func testThePhonesOwnSecretsGoInEveryForm() {
        let token = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c"
        let pin = String(repeating: "c0ffee", count: 10) + "c0ff"
        let bytes = Data(stride(from: 0, to: 64, by: 2).map { offset -> UInt8 in
            let start = pin.index(pin.startIndex, offsetBy: offset); return UInt8(pin[start..<pin.index(start, offsetBy: 2)], radix: 16)!
        })
        let planted = ["t=\(token)!", "PIN \(pin.uppercased())", "b64 \(bytes.base64EncodedString())",
                       "b64 escaped \(bytes.base64EncodedString().replacingOccurrences(of: "/", with: #"\/"#))", "x\(pin)x"].joined(separator: "\n")
        let out = DiagnosticsRedaction.redact(planted, secrets: [token, pin], home: nil)
        for leaked in [token, pin, pin.uppercased(), bytes.base64EncodedString(), String(token.prefix(12))] {
            XCTAssertFalse(out.contains(leaked), out)
        }
    }

    /// A trace segment that is there but can't be read gets a note; the export carries on with everything else.
    func testAnUnreadableTraceIsANoteNotAFailedExport() throws {
        let trace = folder.appendingPathComponent("Caches/media-trace.ndjson")
        try FileManager.default.createDirectory(at: trace, withIntermediateDirectories: true) // a folder where the file should be
        try #"{"event":"older"}"#.write(to: trace.appendingPathExtension("1"), atomically: true, encoding: .utf8)
        var input = diagnostics(trace: trace)
        input.notes = ["The capture drafts couldn’t be listed (NSCocoaErrorDomain 257)."]
        let files = try entries(try input.makeZIP(in: folder.appendingPathComponent("out"), date: day, timeZone: TimeZone(identifier: "UTC")!))
        let top = "Counterpart Phone Diagnostics 2026-11-14/"
        XCTAssertNotNil(files[top + "media-trace.1.ndjson"], "the readable segment is kept")
        XCTAssertNil(files[top + "media-trace.ndjson"])
        let notes = try XCTUnwrap(files[top + "notes.txt"])
        XCTAssertTrue(notes.contains("media-trace.ndjson is on this phone but couldn’t be read"), notes)
        XCTAssertTrue(notes.contains("The capture drafts couldn’t be listed"), notes)
        XCTAssertNotNil(files[top + "about.txt"])
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
