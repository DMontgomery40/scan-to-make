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

    func testACompanionThatIsntThereHasNothingToProtect() {
        var waiter = UpdateGate.Waiter()
        XCTAssertEqual(waiter.next(.failure(ControlClientError.unavailable)), .install)
        XCTAssertEqual(waiter.next(.failure(ControlClientError.invalidEndpoint)), .install)
        // #850: beta 6's companion with no printer refuses objects.list as `unavailable`: it has no projects to protect.
        XCTAssertEqual(waiter.next(.failure(ControlRemoteError(code: "unavailable", message: "That isn’t available on your Mac right now."))), .install)
    }

    /// Review F5: a companion that answers badly, busy or not in time may be working, so it holds the install, but
    /// for 10 minutes of wall-clock time at most, however long each ask takes.
    func testACompanionThatAnswersBadlyHoldsTheInstallForTenMinutesAtMost() {
        let start = Date(timeIntervalSince1970: 1_794_700_800)
        let unanswered: [Error] = [ControlClientError.timedOut, ControlClientError.invalidResponse,
                                   ControlRemoteError(code: "busy", message: "Your Mac is answering too many requests at once.")]
        for error in unanswered {
            var waiter = UpdateGate.Waiter()
            XCTAssertEqual(waiter.next(.failure(error), now: start), .wait, "\(error): it answered, or may still")
            XCTAssertEqual(waiter.next(.failure(error), now: start.addingTimeInterval(9 * 60 + 59)), .wait, "\(error)")
            XCTAssertEqual(waiter.next(.failure(error), now: start.addingTimeInterval(10 * 60)), .install, "\(error): never held off for good")
        }
        // 24 asks of 25 s each (a 10 s timeout, then 15 s asleep) is 10 minutes, not 40 asks.
        var waiter = UpdateGate.Waiter()
        var now = start
        for _ in 0..<24 { XCTAssertEqual(waiter.next(.failure(ControlClientError.timedOut), now: now), .wait); now += 25 }
        XCTAssertEqual(waiter.next(.failure(ControlClientError.timedOut), now: now), .install)
    }

    func testAnAnswerRestartsTheClock() {
        let start = Date(timeIntervalSince1970: 1_794_700_800)
        var waiter = UpdateGate.Waiter()
        XCTAssertEqual(waiter.next(.failure(ControlClientError.timedOut), now: start), .wait)
        let working = project(["scan": "scan.usdz", "state": "touching-up"])
        XCTAssertEqual(waiter.next(.success([working]), now: start.addingTimeInterval(300)), .wait)
        XCTAssertEqual(waiter.next(.failure(ControlClientError.timedOut), now: start.addingTimeInterval(9 * 60)), .wait,
                       "a real answer in between: the 10 minutes count from the next unanswered ask")
        XCTAssertEqual(waiter.next(.failure(ControlClientError.timedOut), now: start.addingTimeInterval(19 * 60)), .install)
        XCTAssertEqual(UpdateGate.Waiter.limit, 600)
    }
}

/// #828: whether a quit would install an update (Sparkle's installer waits for the app to quit), from Sparkle's callbacks.
final class UpdateStagingTests: XCTestCase {
    func testAnUpdateWaitsToInstallOnQuitOnceItsInstallerStarted() {
        var staging = UpdateGate.Staging()
        XCTAssertFalse(staging.staged)
        staging.apply(.choice(skip: false, installerStarted: false))
        XCTAssertFalse(staging.staged, "downloaded, installer not started: nothing installs on quit")
        staging.apply(.extracted)
        XCTAssertTrue(staging.staged)
        staging.apply(.choice(skip: true, installerStarted: true))
        XCTAssertFalse(staging.staged, "Skip cancels an install that began")
        staging.apply(.choice(skip: false, installerStarted: true))
        XCTAssertTrue(staging.staged, "a dismissed Ready to Install still installs on quit")
    }

    /// Review F6: an aborted update installs nothing, so the next quit must leave the agent alone.
    func testAnAbortedUpdateIsNoLongerWaiting() {
        var staging = UpdateGate.Staging()
        staging.apply(.installing)
        staging.apply(.aborted(noUpdateFound: true))
        XCTAssertTrue(staging.staged, "a check finding nothing says nothing about the update already waiting")
        staging.apply(.aborted(noUpdateFound: false))
        XCTAssertFalse(staging.staged)
    }
}

/// #828, review R1/R2: quitting with an update waiting, its effects faked.
@MainActor final class UpdateQuitTests: XCTestCase {
    final class Fake {
        var decision = UpdateGate.Decision.install
        var unregister = UpdateQuit.Unregister.done
        var asks = 0, terminations = 0, windows = 0, closes = 0
        var recorded: [String] = []
        var cancel: (() -> Void)?
        var idle: CheckedContinuation<Void, Never>?
        var idleAtOnce = true
    }
    private func quit(_ fake: Fake) -> UpdateQuit {
        UpdateQuit(effects: .init(
            ask: { fake.asks += 1; return fake.decision },
            unregister: { fake.unregister },
            waitForJobGone: {},
            record: { fake.recorded.append($0) },
            waitUntilIdle: {
                if fake.idleAtOnce { return }
                await withCheckedContinuation { fake.idle = $0 }
            },
            showWaiting: { cancel in fake.windows += 1; fake.cancel = cancel },
            closeWaiting: { fake.closes += 1 },
            terminate: { fake.terminations += 1 }))
    }

    func testAnIdleCompanionIsStoppedAndTheAppQuits() async {
        let fake = Fake()
        let shouldQuit = await quit(fake).shouldTerminate()
        XCTAssertTrue(shouldQuit)
        XCTAssertEqual(fake.recorded, ["stopped"])
        XCTAssertEqual(fake.terminations, 0)
    }

    /// R1: launchd refusing the unregister quits anyway, once, the companion idle; the next launch restarts it.
    func testARefusedUnregisterQuitsOnceWithoutALoop() async {
        let fake = Fake()
        fake.unregister = .refused
        let shouldQuit = await quit(fake).shouldTerminate()
        XCTAssertTrue(shouldQuit, "the companion is idle: quit, never refuse and re-quit")
        XCTAssertEqual(fake.recorded, ["outdated"], "the next launch restarts the agent from the new app")
        XCTAssertEqual(fake.terminations, 0, "no quit of its own")
        XCTAssertEqual(fake.windows, 0)
    }

    /// F1, R1: a busy quit is refused once and quits by itself once idle; that quit doesn't ask again (no loop).
    func testABusyQuitIsRefusedThenQuitsOnceWhenIdle() async {
        let fake = Fake()
        fake.decision = .wait
        let quit = quit(fake)
        let first = await quit.shouldTerminate()
        XCTAssertFalse(first)
        XCTAssertEqual(fake.windows, 1)
        await quit.lastAutoQuit?.value
        XCTAssertEqual(fake.terminations, 1, "quits by itself once the work is done")
        let second = await quit.shouldTerminate()
        XCTAssertTrue(second, "its own quit isn't asked about again")
        XCTAssertEqual(fake.asks, 1)
        XCTAssertEqual(fake.terminations, 1)
    }

    /// R2: Don't Quit calls off the pending quit; a second refusal closes the first window before showing one.
    func testDontQuitCallsOffThePendingQuit() async {
        let fake = Fake()
        fake.decision = .wait
        fake.idleAtOnce = false
        let quit = quit(fake)
        _ = await quit.shouldTerminate()
        _ = await quit.shouldTerminate()
        XCTAssertEqual(fake.windows, 2)
        XCTAssertGreaterThanOrEqual(fake.closes, 1, "the old window goes before a new one")
        // The auto-quit is waiting for the companion before it is called off.
        for _ in 0..<1000 where fake.idle == nil { await Task.yield() }
        XCTAssertNotNil(fake.idle)
        fake.cancel?()
        fake.idle?.resume()
        await quit.lastAutoQuit?.value
        XCTAssertEqual(fake.terminations, 0, "called off")
    }
}

/// #850: a companion left running by an app replaced by hand is restarted at launch, unless it is working.
@MainActor final class CompanionBuildCheckTests: XCTestCase {
    static let ours = "/Applications/Counterpart.app/Contents/Resources/Payload"
    final class Fake {
        /// What status.get answers, in order; the last repeats. A nil build: no `appBuild` (every companion before #850).
        var answers: [Result<CompanionBuildCheck.Reported, Error>] = [.success(.init(build: nil, payload: nil))]
        var decision = UpdateGate.Decision.install
        var events: [String] = [], said: [String] = []
        var pauses = 0
        var restarts: Int { events.filter { $0 == "restart" }.count }
        func next() -> Result<CompanionBuildCheck.Reported, Error> { answers.count > 1 ? answers.removeFirst() : answers[0] }
    }
    private static func running(_ build: String?, _ payload: String? = ours) -> Result<CompanionBuildCheck.Reported, Error> {
        .success(.init(build: build, payload: payload))
    }
    private func check(_ fake: Fake) -> CompanionBuildCheck {
        CompanionBuildCheck(appBuild: "202611151700", appPayload: Self.ours, effects: .init(
            status: { fake.events.append("status"); return fake.next() },
            ask: { fake.decision },
            waitUntilIdle: { fake.events.append("wait") },
            restart: { fake.events.append("restart") },
            pause: { fake.pauses += 1 },
            say: { fake.said.append($0) }))
    }

    func testACompanionWithoutABuildIsRestartedAndComesBackCurrent() async {
        let fake = Fake()
        fake.answers = [Self.running(nil, nil), Self.running("202611151700")]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .restarted)
        XCTAssertEqual(fake.restarts, 1)
        XCTAssertEqual(fake.said, [])
    }

    func testAStaleBuildIsRestarted() async {
        let fake = Fake()
        fake.answers = [Self.running("202611061933"), .failure(ControlClientError.unavailable), Self.running("202611151700")]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .restarted, "it waits for the restarted companion to answer")
        XCTAssertEqual(fake.restarts, 1)
    }

    func testTheCurrentBuildIsLeftAlone() async {
        let fake = Fake()
        fake.answers = [Self.running("202611151700")]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .current)
        XCTAssertEqual(fake.restarts, 0)
    }

    /// Review F5: the wait comes before the restart, never after.
    func testABusyCompanionIsRestartedOnlyOnceIdle() async {
        let fake = Fake()
        fake.answers = [Self.running("202611061933"), Self.running("202611151700")]
        fake.decision = .wait
        let outcome = await check(fake).run()
        XCTAssertEqual(fake.events.filter { $0 != "status" }, ["wait", "restart"], "waits (saying so) for the pass or print first")
        XCTAssertEqual(outcome, .restarted)
    }

    /// Review F3: about two minutes for a restarted companion to answer under load, then it is said plainly.
    func testACompanionThatDoesntComeBackIsSaidPlainly() async {
        let fake = Fake()
        fake.answers = [Self.running("202611061933"), .failure(ControlClientError.unavailable)]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .didNotComeBack)
        XCTAssertEqual(fake.said, [CompanionBuildCheck.didNotComeBack])
        XCTAssertGreaterThanOrEqual(Double(fake.pauses) * CompanionBuildCheck.pauseSeconds, 120)
        let stillOld = Fake()
        stillOld.answers = [Self.running("202611061933")]
        let again = await check(stillOld).run()
        XCTAssertEqual(again, .didNotComeBack, "restarted but still the old build")
    }

    /// Review F2: one slow first answer is asked again before it is left alone.
    func testTheFirstAskIsTriedTwice() async {
        let fake = Fake()
        fake.answers = [.failure(ControlClientError.timedOut), Self.running(nil, nil), Self.running("202611151700")]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .restarted)
        let silent = Fake()
        silent.answers = [.failure(ControlClientError.unavailable)]
        let left = await check(silent).run()
        XCTAssertEqual(left, .notRunning)
        XCTAssertEqual(silent.events, ["status", "status"], "two tries, then the usual start deals with it")
        XCTAssertEqual(silent.restarts, 0)
    }

    /// Review F1 (P2): the agent belongs to another installed copy; restarting it would relaunch that copy, not this one.
    func testAnotherInstalledCopysCompanionIsNamedNotRestarted() async {
        let fake = Fake()
        let theirs = NSHomeDirectory() + "/Applications/Counterpart.app/Contents/Resources/Payload"
        fake.answers = [Self.running("202611061933", theirs)]
        let outcome = await check(fake).run()
        XCTAssertEqual(outcome, .otherCopy)
        XCTAssertEqual(fake.restarts, 0)
        XCTAssertEqual(fake.said, ["Another copy of Counterpart, in ~/Applications, runs in the background. Open that one, or remove the extra copy."])
        // Ours, reported through a symlinked or unnormalised path, is still ours.
        let same = Fake()
        same.answers = [Self.running("202611151700", "/Applications/./Counterpart.app/Contents/Resources/Payload/")]
        let current = await check(same).run()
        XCTAssertEqual(current, .current)
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
