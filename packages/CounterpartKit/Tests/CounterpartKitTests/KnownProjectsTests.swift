import XCTest
@testable import CounterpartKit

/// Board X100: a project page opens from what the phone already has when the Mac stops answering, relaunch included.
final class KnownProjectsTests: XCTestCase {
    private struct List: Decodable { let objects: [Project] }
    private var file: URL { FileManager.default.temporaryDirectory.appending(path: "known-\(UUID().uuidString)/projects.json") }

    func testEveryListedProjectSurvivesARelaunchWithItsTitleStateAndRequest() throws {
        let listed = try JSONDecoder().decode(List.self, from: fixture("objects.json")).objects
        var known = KnownProjects(mac: "https://192.168.68.123:9077")
        let heard = Date(timeIntervalSince1970: 1_762_800_000)
        known.heard(listed, at: heard)
        let url = file
        known.save(to: url)
        let back = try XCTUnwrap(KnownProjects.load(from: url, mac: "https://192.168.68.123:9077"))
        XCTAssertEqual(back.projects, listed, "the whole project as the Mac gave it: title, state, request, sizes, picture paths")
        XCTAssertEqual(back.heard[listed[0].id], heard)
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    func testAnotherMacsCopyIsNeverShown() {
        let url = file
        KnownProjects(mac: "https://a:9077", projects: [Project(id: "x", createdAtMs: 1, updatedAtMs: 2, state: .ready)]).save(to: url)
        XCTAssertNil(KnownProjects.load(from: url, mac: "https://b:9077"))
        XCTAssertNil(KnownProjects.load(from: url.appending(path: "missing"), mac: "https://a:9077"))
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    func testAListDropsWhatTheMacNoLongerHasAndOneAnswerKeepsTheRestsTimes() {
        var known = KnownProjects(mac: "m")
        let early = Date(timeIntervalSince1970: 100), late = Date(timeIntervalSince1970: 200)
        known.heard([Project(id: "a", createdAtMs: 1, updatedAtMs: 2, state: .ready), Project(id: "b", createdAtMs: 1, updatedAtMs: 2, state: .ready)], at: early)
        known.heard(Project(id: "a", createdAtMs: 1, updatedAtMs: 3, state: .printing), at: late)
        XCTAssertEqual(known.heard["a"], late); XCTAssertEqual(known.heard["b"], early)
        XCTAssertEqual(known.projects.first { $0.id == "a" }?.state, .printing)
        known.heard([Project(id: "a", createdAtMs: 1, updatedAtMs: 3, state: .printing)], at: late)
        XCTAssertEqual(known.projects.map(\.id), ["a"]); XCTAssertNil(known.heard["b"])
        known.forget("a")
        XCTAssertTrue(known.projects.isEmpty)
    }

    func testTheAwayLineSaysTheMacIsntAnsweringAndWhenWhatIsShownWasTrue() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "America/Denver")!
        let locale = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_762_819_200) // Nov 10 2025 17:00 MST
        let line = { (date: Date?) in KnownProjects.awayLine(heard: date, now: now, calendar: calendar, locale: locale) }
        XCTAssertTrue(line(now.addingTimeInterval(-48 * 60)).hasPrefix("Your Mac isn’t answering, so anything that needs it waits. This is what your phone had at 4:12"), line(now.addingTimeInterval(-48 * 60)))
        XCTAssertTrue(line(now.addingTimeInterval(-86_400)).contains("had yesterday at 5:00"))
        XCTAssertTrue(line(now.addingTimeInterval(-3 * 86_400)).contains("had on Nov 7 at 5:00"))
        XCTAssertEqual(line(nil), "Your Mac isn’t answering, so anything that needs it waits. This is what your phone already had.")
        // Restored at launch, before the Mac has answered: said without claiming it is down.
        XCTAssertTrue(KnownProjects.awayLine(heard: nil, checking: true).hasPrefix("Checking with your Mac, so anything that needs it waits."))
    }

    /// Review of #527 part 4, S2: the copy is keyed by who the Mac is (its pin), not where it answers from, and nothing
    /// unpaired has a key.
    func testTheKeyIsTheMacsPinNotItsAddress() {
        let a = PairingStatus(state: .paired, baseUrl: "https://192.168.1.5:9077", activeUrl: nil, deviceId: "d1", expiresAtMs: nil, fixture: false, pin: "aa")
        let b = PairingStatus(state: .paired, baseUrl: "https://192.168.1.5:9077", activeUrl: nil, deviceId: "d2", expiresAtMs: nil, fixture: false, pin: "bb")
        XCTAssertNotEqual(KnownProjects.key(for: a), KnownProjects.key(for: b), "another Mac at the same address is another Mac")
        var moved = a; moved.baseUrl = "https://100.64.0.9:9077"
        XCTAssertEqual(KnownProjects.key(for: a), KnownProjects.key(for: moved), "the same Mac at another address is the same Mac")
        var unpinned = a; unpinned.pin = nil
        XCTAssertEqual(KnownProjects.key(for: unpinned), "https://192.168.1.5:9077")
        XCTAssertNil(KnownProjects.key(for: .disconnected))
        let url = FileManager.default.temporaryDirectory.appending(path: "known-\(UUID().uuidString)/projects.json")
        KnownProjects(mac: KnownProjects.key(for: a)!).save(to: url)
        XCTAssertEqual(KnownProjects.owner(of: url), KnownProjects.key(for: a))
        XCTAssertEqual(try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, "kept off backups")
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}
