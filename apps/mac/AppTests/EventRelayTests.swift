import XCTest
import CounterpartKit
import CloudKit

/// PRD §8.8 and §9.3 rules for delivery, tested apart from the socket, CloudKit and the relay.
final class EventRelayTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func event(_ type: String, minutesAgo: Double = 0, notify: String = "active", project: String = "p1", id: String = UUID().uuidString,
                       data: CounterpartEvent.Data? = nil, printId: String? = nil) -> CounterpartEvent {
        CounterpartEvent(seq: 1, id: id, at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60)), type: type,
                         projectId: project, printId: printId, printerName: "P1S", title: "Mic mount is done", body: "Ready to collect.",
                         notify: notify, data: data)
    }
    private func prefs() throws -> NotificationPrefs {
        NotificationPrefs(defaults: try XCTUnwrap(UserDefaults(suiteName: "kan220-relay-\(UUID().uuidString)")))
    }

    // MARK: Cursor

    func testTheCursorPersistsAndMovesOnlyForward() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kan220-cursor-\(UUID().uuidString)"))
        let cursor = EventCursor(defaults: defaults)
        XCTAssertNil(cursor.value, "a first run starts from now, not from history")
        cursor.value = 41
        XCTAssertEqual(EventCursor(defaults: defaults).value, 41, "it survives a restart")
        XCTAssertEqual(EventCursor.advance(from: 41, page: EventsPage(events: [], next: 45, latest: 45)).cursor, 45)
        XCTAssertFalse(EventCursor.advance(from: 41, page: EventsPage(events: [], next: 45, latest: 45)).resync)
        XCTAssertEqual(EventCursor.advance(from: 41, page: EventsPage(events: [], next: 41, latest: 41)).cursor, 41)
    }

    func testAMixedPageKeepsWhatItCanReadAndMovesPastTheRest() throws {
        let json = #"""
        {"events":[
          {"v":1,"seq":41,"id":"e1","at":"2026-11-01T10:00:00Z","type":"print.done","projectId":"p1","printId":"print-1","title":"Mic mount is done","body":"Ready to collect.","notify":"active"},
          {"v":1,"seq":42,"id":"e2","at":"2026-11-01T10:00:01Z","type":"mcp.update.done","title":"bambu-printer-mcp updated","body":"1.5.0","notify":"passive","data":{"mcpId":"bambu"}},
          {"v":1,"seq":"forty-three","id":"e3","type":"print.status"},
          {"v":1,"seq":44,"id":"e4","at":"2026-11-01T10:00:03Z","type":"pass.ready","projectId":"p2","title":"Hook is ready to print","body":"Ready to print","notify":"active","data":{"progress":"lots"}}],
         "next":44,"latest":44}
        """#
        let page = try JSONDecoder().decode(EventsPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.events.map(\.id), ["e1", "e2"], "one unreadable event never fails the page")
        XCTAssertNil(page.events[1].projectId, "an event about no project still reads")
        XCTAssertEqual(page.skipped, 2)
        XCTAssertEqual(EventCursor.advance(from: 40, page: page).cursor, 44, "the cursor moves past the skipped events too")
        XCTAssertFalse(EventCursor.advance(from: 40, page: page).resync)
        XCTAssertFalse(CatchUp.shouldNotify(page.events[1], now: now, prefs: try prefs(), alreadyNotified: false, later: [], state: nil),
                       "an event type without a Mac switch never notifies")
        XCTAssertNil(LiveActivityPush.make(for: page.events[1], token: "aa", title: "x", now: now))
    }

    func testAPrunedOrRecreatedLogResyncsInsteadOfStalling() {
        let reset = EventCursor.advance(from: 900, page: EventsPage(events: [], next: 12, latest: 12, reset: true))
        XCTAssertEqual(reset.cursor, 12)
        XCTAssertTrue(reset.resync)
        let smaller = EventCursor.advance(from: 900, page: EventsPage(events: [], next: 3, latest: 3))
        XCTAssertEqual(smaller.cursor, 3, "a log behind the cursor (a reinstall) never leaves the relay waiting forever")
        XCTAssertTrue(smaller.resync)
        let truncated = EventCursor.advance(from: 5, page: EventsPage(events: [], next: 80, latest: 90, truncated: true))
        XCTAssertEqual(truncated.cursor, 80)
        XCTAssertTrue(truncated.resync)
    }

    // MARK: Catch-up and defaults

    func testRecentEventsNotifyPerTheSwitchesAndProgressIsOffByDefault() throws {
        let prefs = try prefs()
        for type in ["pass.ready", "pass.ask", "print.done", "print.failed", "print.paused", "print.not-started"] {
            XCTAssertTrue(CatchUp.shouldNotify(event(type, minutesAgo: 1), now: now, prefs: prefs, alreadyNotified: false, later: [], state: nil), type)
        }
        XCTAssertFalse(CatchUp.shouldNotify(event("print.milestone", data: .init(progress: 50)), now: now, prefs: prefs, alreadyNotified: false,
                                            later: [], state: nil), "progress events are off on the Mac by default")
        XCTAssertFalse(CatchUp.shouldNotify(event("print.status", notify: "none"), now: now, prefs: prefs, alreadyNotified: false, later: [], state: nil))
        XCTAssertFalse(CatchUp.shouldNotify(event("print.done", minutesAgo: 1), now: now, prefs: prefs, alreadyNotified: true, later: [], state: nil),
                       "never the same event twice")
    }

    func testAfterARestartOnlyStandingTerminalEventsNotifyOnce() throws {
        let prefs = try prefs()
        // Older than ten minutes: synced, not shown...
        XCTAssertFalse(CatchUp.shouldNotify(event("print.paused", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: [], state: nil))
        // ...except a terminal event that still stands.
        XCTAssertTrue(CatchUp.shouldNotify(event("print.done", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: [], state: "printed"))
        XCTAssertTrue(CatchUp.shouldNotify(event("pass.ready", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: [], state: "ready"))
        XCTAssertFalse(CatchUp.shouldNotify(event("pass.ready", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: [], state: "printing"),
                       "already acted on: the project moved on")
        XCTAssertFalse(CatchUp.shouldNotify(event("pass.ask", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: ["pass.started"],
                                            state: nil), "answered: a later event replaced it")
        XCTAssertFalse(CatchUp.shouldNotify(event("print.done", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: true, later: [], state: nil),
                       "once each")
        XCTAssertFalse(CatchUp.shouldNotify(event("print.done", minutesAgo: 30), now: now, prefs: prefs, alreadyNotified: false, later: ["print.preparing"],
                                            state: nil))
    }

    func testShownEventsAreRememberedAcrossRestarts() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kan220-notified-\(UUID().uuidString)"))
        NotifiedEvents(defaults: defaults).insert("e1")
        XCTAssertTrue(NotifiedEvents(defaults: defaults).contains("e1"))
        for index in 0..<600 { NotifiedEvents(defaults: defaults).insert("x\(index)") }
        XCTAssertEqual(defaults.stringArray(forKey: NotifiedEvents.key)?.count, 500, "bounded")
    }

    // MARK: Upsert cap

    func testPrintUpsertsAreCappedAtOneAMinuteExceptOnStateChanges() {
        var gate = UpsertGate()
        XCTAssertTrue(gate.allow(projectId: "p", printId: "print1", state: "printing", now: now))
        XCTAssertFalse(gate.allow(projectId: "p", printId: "print1", state: "printing", now: now.addingTimeInterval(10)))
        XCTAssertFalse(gate.allow(projectId: "p", printId: "print1", state: "printing", now: now.addingTimeInterval(59)))
        XCTAssertTrue(gate.allow(projectId: "p", printId: "print1", state: "printing", now: now.addingTimeInterval(61)))
        XCTAssertTrue(gate.allow(projectId: "p", printId: "print1", state: "printed", now: now.addingTimeInterval(62)), "a state change always goes")
        XCTAssertTrue(gate.allow(projectId: "p", printId: "print2", state: "printing", now: now.addingTimeInterval(63)), "per print")
        XCTAssertTrue(gate.allow(projectId: "p", printId: nil, state: "ready", now: now), "project events without a print aren't capped")
        XCTAssertTrue(gate.allow(projectId: "p", printId: nil, state: "ready", now: now))
    }

    // MARK: Commands

    func testOnlyFreshCommandsRunJudgedByTheServersClock() {
        XCTAssertTrue(CommandFreshness.isFresh(created: now.addingTimeInterval(-9 * 60), now: now))
        XCTAssertFalse(CommandFreshness.isFresh(created: now.addingTimeInterval(-11 * 60), now: now))
        XCTAssertFalse(CommandFreshness.isFresh(created: nil, now: now))
        XCTAssertFalse(CommandFreshness.isFresh(created: now.addingTimeInterval(5 * 60), now: now), "never from the future")
    }

    func testCommandsRunThroughTheControlMethodsThatAlreadyDoTheJob() {
        func call(_ type: String, _ payload: [String: JSONValue] = [:], photos: [String] = []) -> String? {
            PhoneCommand(id: "c", type: type, projectId: "p", payload: payload).call(photos: photos)?.method
        }
        XCTAssertEqual(call("print", ["checked": .bool(true)]), "objects.print")
        XCTAssertEqual(call("correct", ["note": .string("thicker")]), "objects.correct")
        XCTAssertNil(call("correct"), "a correction needs its note")
        XCTAssertEqual(call("answerAsk"), "objects.answerCloseup")
        XCTAssertEqual(call("confirm", ["confirmationId": .string("q"), "answer": .object(["action": .string("accept")])]), "objects.answerPrintConfirmation")
        XCTAssertNil(call("confirm"), "a confirmation answers one exact question")
        XCTAssertEqual(call("pause"), "objects.pausePrint")
        XCTAssertEqual(call("resume"), "objects.resumePrint")
        XCTAssertEqual(call("cancel"), "objects.cancelPrint")
        XCTAssertNil(call("format-disk"))
        let photos = PhoneCommand(id: "c", type: "correct", projectId: "p", payload: ["note": .string("n")]).call(photos: ["/tmp/a.jpg"])
        XCTAssertEqual(photos?.params["photos"], .array([.string("/tmp/a.jpg")]))
        XCTAssertEqual(PhoneCommand(id: "c", type: "answerAsk", projectId: "p", payload: [:]).call(photos: ["/tmp/a.jpg"])?.params["bestGuess"], .bool(false),
                       "a photo answers the question; no guess")
        let typed = PhoneCommand(id: "c", type: "answerAsk", projectId: "p", payload: ["text": .string("It's 25 mm")])
        XCTAssertNil(typed.call(), "an older companion can't take a typed answer, so it isn't sent as one it would refuse")
        XCTAssertEqual(typed.call(acceptsText: true)?.params["text"], .string("It's 25 mm"))
        XCTAssertEqual(typed.call(acceptsText: true)?.params["bestGuess"], .bool(false))
        XCTAssertNil(typed.call(photos: ["/tmp/a.jpg"])?.params["text"], "photos still answer it on an older companion")
    }

    // MARK: The relay's request

    func testRelayRequestsFollowTheClientContract() throws {
        let start = LiveActivityPush.make(for: event("print.started", printId: "print-1"), token: "ABCDEF0123456789ABCDEF0123456789",
                                          title: "Mic mount", now: now)
        let push = try XCTUnwrap(start)
        XCTAssertEqual(push.kind, .start)
        XCTAssertEqual(push.priority, 10)
        XCTAssertEqual(push.token, "abcdef0123456789abcdef0123456789")
        XCTAssertEqual(push.attributes?.title, "Mic mount")
        XCTAssertEqual(push.alert?.title, "Mic mount is printing")
        XCTAssertNotNil(push.staleDate)
        XCTAssertEqual(push.contentState.state, "preparing")
        // endsAt is reference-date seconds, staleDate is Unix seconds: 978,307,200 apart.
        XCTAssertEqual(Double(push.staleDate!) - push.contentState.endsAt, 978_307_200 + 600, accuracy: 1)

        let ends = ISO8601DateFormatter().string(from: now.addingTimeInterval(3600))
        let update = try XCTUnwrap(LiveActivityPush.make(for: event("print.status", notify: "none", data: .init(progress: 42.5, endsAt: ends, layer: 120, totalLayers: 300, stage: "Printing"),
                                                                  printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertEqual(update.kind, .update)
        XCTAssertEqual(update.priority, 5)
        XCTAssertNil(update.attributes, "attributes only on start")
        XCTAssertNil(update.alert)
        XCTAssertEqual(update.contentState.endsAt, now.addingTimeInterval(3600).timeIntervalSinceReferenceDate, accuracy: 1)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(update), encoding: .utf8))
        XCTAssertFalse(json.contains("null"), "optionals are left out, never null")
        XCTAssertFalse(json.contains("problem"))

        XCTAssertNil(LiveActivityPush.make(for: event("print.started", notify: "none", printId: "print-1"), token: "aa", title: "Mic mount", now: now), "muted projects never start an alerting activity remotely")
        let mutedEnd = try XCTUnwrap(LiveActivityPush.make(for: event("print.done", notify: "none", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertEqual(mutedEnd.kind, .end)
        XCTAssertEqual(mutedEnd.contentState.state, "finished")
        XCTAssertNil(mutedEnd.alert, "Only problems still ends an existing activity, silently")
        let done = try XCTUnwrap(LiveActivityPush.make(for: event("print.done", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertEqual(done.kind, .end)
        XCTAssertNil(done.staleDate, "an ended activity is never marked stale")
        XCTAssertEqual(done.contentState.state, "finished")
        XCTAssertEqual(done.contentState.progress, 100)
        XCTAssertNil(LiveActivityPush.make(for: event("pass.ready"), token: "aa", title: "x", now: now))
        XCTAssertNil(LiveActivityPush.make(for: event("print.started"), token: "aa", title: "x", now: now), "a start needs its print")
        let long = LiveActivityPush.alert(title: String(repeating: "t", count: 150), body: String(repeating: "b\n", count: 100))
        XCTAssertLessThanOrEqual(long.title.unicodeScalars.count + long.body.unicodeScalars.count, 200)
        XCTAssertFalse(long.body.contains("\n"), "no control characters")
    }

    func testAnEndThatCantReachTheRelayIsSentAgainForAboutAnHour() {
        let waits = (1...10).compactMap { RelayRetry.delay(failures: $0, kind: .end) }
        XCTAssertEqual(waits.count, 10)
        XCTAssertEqual(waits.prefix(3), [15, 30, 60])
        XCTAssertEqual(waits.max(), 900, "never more than 15 minutes between tries")
        XCTAssertEqual(waits.reduce(0, +), 4545, accuracy: 1, "about an hour and a quarter in all")
        XCTAssertNil(RelayRetry.delay(failures: 11, kind: .end), "then it stops")
        XCTAssertEqual(RelayRetry.delay(failures: 3, kind: .update), 60)
        XCTAssertNil(RelayRetry.delay(failures: 4, kind: .update), "an update is soon replaced by the next one")
        XCTAssertNil(RelayRetry.delay(failures: 4, kind: .start))
        XCTAssertNil(RelayRetry.delay(failures: 0, kind: .end))
    }

    func testPrintSettingsGoOnlyToACompanionThatTakesThem() {
        let fine = PhoneCommand(id: "c", type: "print", projectId: "p",
                                payload: ["quality": .string("fine"), "strength": .string("strong"), "colour": .object(["amsSlot": .number(2)]), "checked": .bool(true)])
        XCTAssertNil(fine.call(), "an older companion refuses the whole request, and other settings are never swapped for its defaults")
        XCTAssertTrue(fine.refusal.contains("standard settings"))
        let sent = fine.call(printSettings: true)?.params
        XCTAssertEqual(sent?["quality"], .string("fine"))
        XCTAssertEqual(sent?["colour"], .object(["amsSlot": .number(2)]))
        XCTAssertEqual(sent?["checked"], .bool(true))

        let standard = PhoneCommand(id: "c", type: "print", projectId: "p",
                                    payload: ["quality": .string("standard"), "strength": .string("standard"), "colour": .object(["auto": .bool(true)]), "checked": .bool(false)])
        XCTAssertEqual(standard.call()?.params, ["id": .string("p"), "checked": .bool(false)],
                       "standard settings and an automatic colour are what an older companion prints anyway, so they are left out")
        XCTAssertEqual(standard.call(printSettings: true)?.params["strength"], .string("standard"))
    }

    func testTheMirrorCarriesThePrintersQuestionWhole() throws {
        let json = #"{"id":"q1","message":"Print Mic mount on P1S?","expiresAtMs":1800000000000,"supported":true,"fields":[{"name":"confirm","title":"Print it","required":true},{"name":"note","title":"Spool","description":"Loaded","required":false}]}"#
        let confirmation = try JSONDecoder().decode(Project.PrintConfirmation.self, from: Data(json.utf8))
        let text = try XCTUnwrap(MirroredConfirmation.fieldsJSON(confirmation.fields))
        XCTAssertEqual(text, #"[{"name":"confirm","required":true,"title":"Print it"},{"description":"Loaded","name":"note","required":false,"title":"Spool"}]"#)
        // The phone's `confirm` command built from it reaches the one control method that answers it.
        let answer = PhoneCommand(id: "c", type: "confirm", projectId: "p",
                                  payload: ["confirmationId": .string(confirmation.id), "answer": .object(["action": .string("accept"), "content": .object(["confirm": .bool(true)])])])
        XCTAssertEqual(answer.call()?.params["confirmationId"], .string("q1"))
    }

    // MARK: Replays after a restart

    private func project(_ state: String, printId: String?, monitor: String?) throws -> Project {
        var print: [String: Any] = ["bundleId": "b"]
        if let printId { print["printId"] = printId }
        if let monitor { print["monitor"] = ["phase": monitor] }
        let json: [String: Any] = ["id": "p1", "createdAtMs": 1, "updatedAtMs": 1, "state": state, "photos": [], "passes": [],
                                   "directory": "/tmp/p1", "print": print]
        return try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testAReplayedStartNeverStartsAnActivityForAPrintThatEnded() throws {
        let start = event("print.started", notify: "passive", printId: "print-1")
        XCTAssertTrue(LiveActivityStart.stillRunning(start, project: try project("printing", printId: "print-1", monitor: "watching")))
        XCTAssertFalse(LiveActivityStart.stillRunning(start, project: try project("printed", printId: "print-1", monitor: "ended")),
                       "it finished while the Mac app was closed")
        XCTAssertFalse(LiveActivityStart.stillRunning(start, project: try project("printing", printId: "print-2", monitor: "watching")),
                       "a newer print replaced it")
        XCTAssertFalse(LiveActivityStart.stillRunning(start, project: try project("printing", printId: "print-1", monitor: "ended")))
        XCTAssertFalse(LiveActivityStart.stillRunning(start, project: nil))
    }

    // MARK: The mirror clears what is gone

    func testAClearedFieldIsSentAsAChange() {
        // Each upsert builds a new record and saves it with `.changedKeys`: a key set to nil must count as changed, or an
        // answered question would stay on the phone.
        let record = CKRecord(recordType: "CounterpartProject", recordID: CKRecord.ID(recordName: "p1", zoneID: CKRecordZone.ID(zoneName: "Counterpart")))
        record["title"] = "Mic mount"
        record["openAsk"] = nil as String?
        record["confirmationId"] = nil as String?
        XCTAssertEqual(Set(record.changedKeys()), ["title", "openAsk", "confirmationId"])
    }

    // MARK: This Mac in iCloud (PRD §5.10)

    func testTheMacRecordCarriesWhatAPhoneNeedsToEnrol() throws {
        let enrolment = ICloudEnrolment(token: "tok", expiresAt: "2026-11-01T10:10:00Z", macId: "mac-1", spkiSha256: "abc",
                                        addresses: [.init(kind: "lan", host: "192.168.1.20", port: 9077), .init(kind: "mdns", host: "mac-mini.local", port: 9077),
                                                    .init(kind: "tailscale", host: "100.64.0.2", port: 9077)])
        let fields = MacPublication.fields(enrolment, name: "Mac mini", now: now)
        XCTAssertEqual(fields["macId"] as? String, "mac-1")
        XCTAssertEqual(fields["name"] as? String, "Mac mini")
        XCTAssertEqual(fields["enrolmentToken"] as? String, "tok")
        XCTAssertEqual(fields["spkiSha256"] as? String, "abc")
        XCTAssertEqual((fields["tokenExpiresAt"] as? Date)?.timeIntervalSince1970 ?? 0, 1_793_527_800, accuracy: 1)
        let addresses = try JSONDecoder().decode([ICloudEnrolment.Address].self, from: Data(try XCTUnwrap(fields["addresses"] as? String).utf8))
        XCTAssertEqual(addresses.map(\.kind), ["lan", "mdns", "tailscale"], "every address, in the order to try them")
        let decoded = try JSONDecoder().decode(ICloudEnrolment.self, from: Data(#"{"token":"t","expiresAt":"2026-11-01T10:10:00.000Z","macId":"m","spkiSha256":"s","addresses":[{"kind":"lan","host":"10.0.0.2","port":9077}]}"#.utf8))
        XCTAssertNotNil(decoded.expiresAtDate, "ISO 8601, with or without fractions")
    }

    func testTheRecordIsRewrittenOnLaunchOnAnAddressChangeAndEveryFiveMinutes() {
        XCTAssertTrue(MacPublication.isDue(lastWritten: nil, lastAddresses: nil, addresses: "a", tokenExpires: nil, now: now), "on launch")
        let written = now.addingTimeInterval(-60)
        XCTAssertFalse(MacPublication.isDue(lastWritten: written, lastAddresses: "a", addresses: "a", tokenExpires: now.addingTimeInterval(540), now: now))
        XCTAssertTrue(MacPublication.isDue(lastWritten: written, lastAddresses: "a", addresses: "b", tokenExpires: now.addingTimeInterval(540), now: now),
                      "an address changed")
        XCTAssertTrue(MacPublication.isDue(lastWritten: now.addingTimeInterval(-300), lastAddresses: "a", addresses: "a", tokenExpires: now.addingTimeInterval(540), now: now),
                      "every 5 minutes")
        XCTAssertTrue(MacPublication.isDue(lastWritten: written, lastAddresses: "a", addresses: "a", tokenExpires: now.addingTimeInterval(120), now: now),
                      "before the published token runs out")
    }
}
