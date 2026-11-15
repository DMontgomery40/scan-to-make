import XCTest
import Foundation
import struct CounterpartKit.Project
#if canImport(ControlKit)
import ControlKit
#endif

private func project(_ fields: [String: Any]) -> Project {
    var json: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 1,
                               "state": "new", "photos": [], "passes": [], "directory": "/tmp/object"]
    json.merge(fields) { $1 }
    return try! JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: json))
}
private let readyFields: [String: Any] = [
    "scan": "scan.usdz", "state": "ready",
    "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]],
    "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"], "sizeMm": [48.2, 50.4, 53.6]],
]
private func ready(_ fields: [String: Any] = [:]) -> Project { project(readyFields.merging(fields) { $1 }) }

/// #828: an update installs (stopping the companion agent) only when that cuts nothing short.
final class UpdateGateTests: XCTestCase {
    func testAnIdleCompanionLetsTheUpdateInstall() {
        XCTAssertEqual(UpdateGate.decide(.success([])), .install)
        XCTAssertEqual(UpdateGate.decide(.success([ready(), ready(["state": "printed"]), ready(["state": "needs-closeup", "question": ["closeup": "the underside"]])])), .install)
        XCTAssertEqual(UpdateGate.decide(.success([project([:])])), .install, "a phone's draft with nothing sent isn't work in progress")
    }

    func testARunningPassHoldsTheInstall() {
        let touchingUp = project(["scan": "scan.usdz", "state": "touching-up"])
        XCTAssertTrue(UpdateGate.interrupts(touchingUp))
        XCTAssertEqual(UpdateGate.decide(.success([ready(), touchingUp])), .wait)
        XCTAssertEqual(UpdateGate.decide(.success([project(["scan": "scan.usdz", "state": "touching-up", "progress": "Smoothing the base"])])), .wait)
    }

    func testAPrintBeingSentHoldsTheInstallButAPrintOnThePrinterDoesNot() {
        let sending = ready(["state": "printing", "print": ["bundleId": "b", "printId": "p1", "destination": ["id": "p", "name": "P1S"]]])
        XCTAssertTrue(UpdateGate.interrupts(sending), "sliced and sent by the companion: stopping it would lose the print")
        let confirming = ready(["state": "printing", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"]],
                                "printConfirmation": ["id": "q", "message": "Check.", "expiresAtMs": 2000, "fields": [], "supported": true]])
        XCTAssertTrue(UpdateGate.interrupts(confirming), "the companion holds the printer's question")
        let printing = ready(["state": "printing", "print": ["bundleId": "b", "printId": "p1", "destination": ["id": "p", "name": "P1S"],
                              "monitor": ["phase": "watching"],
                              "live": ["source": "counterpart", "observedAt": "2026-11-01T10:00:00Z", "state": "printing",
                                       "job": ["name": "mic", "progress": 61.4, "remainingSec": 1500], "problems": []]]])
        XCTAssertFalse(UpdateGate.interrupts(printing), "the printer prints on; the monitor resumes after a restart")
        XCTAssertEqual(UpdateGate.decide(.success([printing])), .install)
    }

    func testFilesArrivingFromThePhoneHoldTheInstall() {
        XCTAssertEqual(UpdateGate.decide(.success([project(["progress": "Receiving 3 of 12 photos"])])), .wait)
    }

    func testACompanionThatDoesntAnswerHasNothingToProtect() {
        XCTAssertEqual(UpdateGate.decide(.failure(ControlClientError.unavailable)), .install)
        XCTAssertEqual(UpdateGate.decide(.failure(ControlClientError.invalidResponse)), .install)
    }

    func testASlowCompanionHoldsTheInstallOnlyForAWhile() {
        let slow: Result<[Project], Error> = .failure(ControlClientError.timedOut)
        XCTAssertTrue(UpdateGate.timedOut(slow))
        XCTAssertEqual(UpdateGate.decide(slow), .wait, "too slow to answer may be working")
        XCTAssertEqual(UpdateGate.decide(slow, timeoutsBefore: UpdateGate.timeoutLimit - 2), .wait)
        XCTAssertEqual(UpdateGate.decide(slow, timeoutsBefore: UpdateGate.timeoutLimit - 1), .install, "never held off for good")
        XCTAssertFalse(UpdateGate.timedOut(.success([])))
        XCTAssertEqual(UpdateGate.decide(.failure(ControlRemoteError(code: "busy", message: "Your Mac is answering too many requests at once."))), .wait,
                       "busy answering is a working companion")
    }
}

/// #829: a copy run from App Translocation is recognised, and only that one.
final class TranslocationTests: XCTestCase {
    func testATranslocatedCopyIsDetected() {
        XCTAssertTrue(Translocation.isTranslocated(URL(fileURLWithPath: "/private/var/folders/x8/abc123/T/AppTranslocation/4F2E1C3A-0000-4000-8000-000000000001/d/Counterpart.app")))
        XCTAssertFalse(Translocation.isTranslocated(URL(fileURLWithPath: "/Applications/Counterpart.app")))
        XCTAssertFalse(Translocation.isTranslocated(URL(fileURLWithPath: NSHomeDirectory() + "/Applications/Counterpart.app")))
        XCTAssertFalse(Translocation.isTranslocated(URL(fileURLWithPath: NSHomeDirectory() + "/Downloads/Counterpart.app")))
        XCTAssertNil(Translocation.originalURL(of: URL(fileURLWithPath: "/Applications/Counterpart.app")), "only a translocated copy has an original elsewhere")
        XCTAssertEqual(Translocation.sentence, "Move Counterpart to Applications, then open it again.")
    }
}

/// #829: Export Diagnostics' ZIP has no AppleDouble files and its folder is named by date.
final class DiagnosticsZipTests: XCTestCase {
    private func entries(_ zip: URL) throws -> [String] {
        let list = Process()
        let out = Pipe()
        list.executableURL = URL(fileURLWithPath: "/usr/bin/zipinfo")
        list.arguments = ["-1", zip.path]
        list.standardOutput = out
        try list.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        list.waitUntilExit()
        XCTAssertEqual(list.terminationStatus, 0)
        return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }

    func testFilesWithExtendedAttributesZipWithoutAppleDoubleEntries() throws {
        let fm = FileManager.default
        let parent = fm.temporaryDirectory.appendingPathComponent("diag-xattr-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: parent) }
        let folder = parent.appendingPathComponent(Diagnostics.folderName(Date(timeIntervalSince1970: 1_794_700_800)))
        try fm.createDirectory(at: folder.appendingPathComponent("logs"), withIntermediateDirectories: true)
        let log = folder.appendingPathComponent("logs/companion.log")
        try "hello\n".write(to: log, atomically: true, encoding: .utf8)
        // What a downloaded app's own files carry (the clean-Mac run's ZIP had `._` twins of them).
        for (url, name) in [(log, "com.apple.quarantine"), (folder.appendingPathComponent("logs"), "com.example.counterpart-test")] {
            let value = Array("0083;00000000;Safari;".utf8)
            XCTAssertEqual(setxattr(url.path, name, value, value.count, 0, 0), 0, "fixture xattr \(name)")
        }
        let zip = parent.appendingPathComponent("out.zip")
        XCTAssertTrue(try Diagnostics.zip(folder, to: zip))
        let names = try entries(zip)
        XCTAssertTrue(names.contains("Counterpart Diagnostics 2026-11-15/logs/companion.log"), names.joined(separator: "\n"))
        XCTAssertFalse(names.contains { $0.hasPrefix("__MACOSX") || $0.split(separator: "/").contains { $0.hasPrefix("._") } }, names.joined(separator: "\n"))
    }

    func testTheExportsFolderIsNamedByDate() async throws {
        let fm = FileManager.default
        let state = fm.temporaryDirectory.appendingPathComponent("diag-state-\(UUID().uuidString)")
        try fm.createDirectory(at: state.appendingPathComponent("logs"), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: state) }
        try "start\n".write(to: state.appendingPathComponent("logs/companion.log"), atomically: true, encoding: .utf8)
        let zip = fm.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).zip")
        defer { try? fm.removeItem(at: zip) }
        let ok = await Diagnostics.export(state: state, to: zip, now: Date(timeIntervalSince1970: 1_794_700_800)) { CompanionDiagnostics(files: [], notes: []) }
        XCTAssertTrue(ok)
        let names = try entries(zip)
        XCTAssertEqual(Set(names.map { String($0.split(separator: "/")[0]) }), ["Counterpart Diagnostics 2026-11-15"], names.joined(separator: "\n"))
        XCTAssertTrue(names.contains("Counterpart Diagnostics 2026-11-15/about.txt"))
        XCTAssertFalse(names.contains { $0.contains("._") })
    }
}
