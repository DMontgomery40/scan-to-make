import XCTest
import CounterpartKit
import CloudKit
#if canImport(ControlKit)
import ControlKit
#endif

/// PRD §8.8 and §9.3 rules for delivery, tested apart from the socket, CloudKit and the relay.
final class EventRelayTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func event(_ type: String, minutesAgo: Double = 0, notify: String = "active", project: String = "p1", id: String = UUID().uuidString,
                       data: CounterpartEvent.Data? = nil, printId: String? = nil, title: String = "Mic mount is done") -> CounterpartEvent {
        CounterpartEvent(seq: 1, id: id, at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60)), type: type,
                         projectId: project, printId: printId, printerName: "P1S", title: title, body: "Ready to collect.",
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
        XCTAssertNil(call("answerAsk"), "missing assets never turn into an implicit Best Guess")
        XCTAssertEqual(call("answerAsk", ["bestGuess": .bool(true)]), "objects.answerCloseup")
        XCTAssertEqual(call("confirm", ["confirmationId": .string("q"), "answer": .object(["action": .string("accept")])]), "objects.answerPrintConfirmation")
        XCTAssertNil(call("confirm"), "a confirmation answers one exact question")
        XCTAssertEqual(call("pause"), "objects.pausePrint")
        XCTAssertEqual(call("resume"), "objects.resumePrint")
        XCTAssertEqual(call("cancel"), "objects.cancelPrint")
        // "Did it fit?" answered from the phone's notification away from home (UX walkthrough Nov 8, F3).
        XCTAssertEqual(call("status", ["status": .string("works")]), "objects.settings.set")
        XCTAssertEqual(PhoneCommand(id: "c", type: "status", projectId: "p", payload: ["status": .string("needs-changes")]).call()?.params,
                       ["id": .string("p"), "status": .string("needs-changes")])
        XCTAssertNil(call("status"), "a status answer names its status")
        // Needs Changes with words is one record: the status first, then the words as a change, in that order.
        let changes = PhoneCommand(id: "c", type: "status", projectId: "p", payload: ["status": .string("needs-changes"), "note": .string("After printing: wider")])
        XCTAssertEqual(changes.call()?.params, ["id": .string("p"), "status": .string("needs-changes")], "the note isn't a setting")
        XCTAssertEqual(changes.followUp, PhoneCommand(id: "c-note", type: "correct", projectId: "p", payload: ["note": .string("After printing: wider")]))
        XCTAssertNil(PhoneCommand(id: "c", type: "status", projectId: "p", payload: ["status": .string("works"), "note": .string("x")]).followUp)
        XCTAssertNil(call("status", ["status": .string("archived")]), "only the Did it fit? answers come from a notification")
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

    func testCloudAskSelectsOnlyItsUploadReceiptsIncludingRenamedFiles() async throws {
        let command = PhoneCommand(id: "c", type: "answerAsk", projectId: "p", payload: [:])
        var uploadedPaths: [String] = []
        let call = try await command.preparedCall(photos: ["/tmp/a.jpg", "/tmp/b.jpg"], acceptsText: true, printSettings: true) { path in
            uploadedPaths.append(path)
            return path == "/tmp/a.jpg" ? "a-2.jpg" : "b-3.jpg"
        }
        XCTAssertEqual(uploadedPaths, ["/tmp/a.jpg", "/tmp/b.jpg"])
        XCTAssertEqual(call?.method, "objects.answerCloseup")
        XCTAssertEqual(call?.params["photoNames"], .array([.string("a-2.jpg"), .string("b-3.jpg")]))
        XCTAssertEqual(call?.params["bestGuess"], .bool(false))
        let guess = try await PhoneCommand(id: "g", type: "answerAsk", projectId: "p", payload: ["bestGuess": .bool(true)])
            .preparedCall(photos: [], acceptsText: true, printSettings: true) { _ in XCTFail("No upload for Best Guess"); return "wrong.jpg" }
        XCTAssertEqual(guess?.params["photoNames"], .array([]))
        let correction = PhoneCommand(id: "c", type: "correct", projectId: "p", payload: ["note": .string("thicker")]).call(photos: ["/tmp/a.jpg"])
        XCTAssertEqual(correction?.params["photoNames"], .array([]), "a cloud correction imports only its own local assets")
    }

    func testCloudAskNeverDispatchesAfterAnUploadFails() async {
        let command = PhoneCommand(id: "c", type: "answerAsk", projectId: "p", payload: [:])
        var uploads = 0
        do {
            _ = try await command.preparedCall(photos: ["a.jpg", "b.jpg"], acceptsText: true, printSettings: true) { _ in
                uploads += 1
                if uploads == 2 { throw ControlRemoteError(code: "unavailable", message: "Upload failed") }
                return "a-2.jpg"
            }
            XCTFail("No prepared answer after an upload failure")
        } catch { XCTAssertEqual(uploads, 2) }
    }

    // MARK: The relay's request

    func testCloudKitOwnsPausedAndTerminalAlertsWhileTheActivityStillChanges() throws {
        for type in ["print.paused", "print.done", "print.failed", "print.cancelled"] {
            let push = try XCTUnwrap(LiveActivityPush.make(for: event(type, printId: "print-1"), token: "aa", title: "Mic mount", now: now))
            XCTAssertNil(push.alert, "\(type) already has a CloudKit alert; updating the activity must not alert again")
            XCTAssertEqual(push.kind, type == "print.paused" ? .update : .end)
        }
    }

    func testTheRelayIsOnByDefaultOnlyInProductionSignedBuildsAndAChoiceWins() {
        XCTAssertTrue(RelayDefault.enabled(stored: nil, apsEnvironment: "production"))
        XCTAssertFalse(RelayDefault.enabled(stored: nil, apsEnvironment: "development"), "Sandbox phones' tokens would be denied by the production relay")
        XCTAssertFalse(RelayDefault.enabled(stored: nil, apsEnvironment: nil))
        XCTAssertFalse(RelayDefault.enabled(stored: false, apsEnvironment: "production"), "turned off in Settings stays off")
        XCTAssertTrue(RelayDefault.enabled(stored: true, apsEnvironment: "development"))
    }

    // MARK: Milestones on the activity (David, Nov 8)

    private func tokens(_ activities: [(device: String, print: String, token: String)], starters: [String] = []) -> LiveActivityTokens {
        LiveActivityTokens(pushToStart: starters.map { .init(deviceId: $0, token: "start-" + $0, updatedAt: "") },
                           activities: activities.map { .init(printId: $0.print, deviceId: $0.device, token: $0.token, updatedAt: "") })
    }

    func testAMilestoneAlertsTheRunningActivityInsteadOfANotification() throws {
        let halfway = event("print.milestone", data: .init(progress: 50, layer: 106, totalLayers: 212, state: "printing"), printId: "print-1")
        let local = tokens([("phone", "print-1", "AA")], starters: ["phone"])
        let chosen = try XCTUnwrap(MilestoneAlert.tokens(for: halfway, relayOn: true, local: local, cloud: tokens([("phone", "print-1", "aa")]), dead: []))
        XCTAssertEqual(chosen.count, 1, "the same token over the LAN and iCloud alerts once")
        let push = try XCTUnwrap(MilestoneAlert.push(for: halfway, token: "AA", title: "Mic mount", now: now))
        XCTAssertEqual(push.kind, .update)
        XCTAssertEqual(push.priority, 10, "Apple delivers an alerting update at once only at priority 10")
        XCTAssertEqual(push.alert, .init(title: halfway.title, body: halfway.body, sound: "default"), "the notification's own words")
        XCTAssertEqual(push.contentState.progress, 50)
        XCTAssertEqual(push.alertEventId, halfway.id)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(push), encoding: .utf8))
        XCTAssertFalse(json.contains("alertEventId"), "the relay contract has no such field")
        let firstLayer = try XCTUnwrap(MilestoneAlert.push(for: event("print.first-layer", notify: "passive", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertNil(firstLayer.alert?.sound, "the first layer is passive: it lights the screen without a sound")
    }

    func testAMilestoneIsANotificationWhenNoActivityCanShowIt() {
        let halfway = event("print.milestone", printId: "print-1")
        let running = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertNil(MilestoneAlert.tokens(for: halfway, relayOn: false, local: running, cloud: .init(), dead: []), "relay off: CloudKit")
        XCTAssertNil(MilestoneAlert.tokens(for: halfway, relayOn: true, local: tokens([("phone", "other-print", "aa")], starters: ["phone"]), cloud: .init(), dead: []),
                     "no activity for this print")
        XCTAssertNil(MilestoneAlert.tokens(for: halfway, relayOn: true, local: running, cloud: .init(), dead: ["aa"]), "its token ended")
        XCTAssertNil(MilestoneAlert.tokens(for: halfway, relayOn: true, local: tokens([("phone", "print-1", "aa")], starters: ["phone", "ipad"]), cloud: .init(), dead: []),
                     "an iPad without the activity would hear nothing: CloudKit for everyone, never both")
        XCTAssertNil(MilestoneAlert.tokens(for: event("print.milestone", notify: "none", printId: "print-1"), relayOn: true, local: running, cloud: .init(), dead: []), "muted")
        for type in ["print.paused", "print.done", "print.failed", "print.not-started", "pass.ready"] {
            XCTAssertNil(MilestoneAlert.tokens(for: event(type, printId: "print-1"), relayOn: true, local: running, cloud: .init(), dead: []),
                         "\(type) stays a notification")
        }
    }

    func testRecoveryMovesTheActivityToAMilestoneButNeverAlertsAgain() throws {
        let name = "milestone-recovery-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var recovery = LiveActivityRecovery(defaults: defaults)
        recovery.record(event("print.milestone", data: .init(progress: 50, state: "printing"), printId: "print-1"), title: "Mic mount", now: now)
        var restarted = LiveActivityRecovery(defaults: defaults)
        let pushes = restarted.pushes(tokens: [.init(printId: "print-1", deviceId: "phone", token: "aa", updatedAt: "")], now: now)
        XCTAssertEqual(pushes.first?.contentState.progress, 50)
        XCTAssertNil(pushes.first?.alert, "a restart replays state, never the alert")
        let alerted = AlertedMilestones(defaults: defaults)
        alerted.insert("m1")
        XCTAssertTrue(AlertedMilestones(defaults: defaults).contains("m1"), "an alerted milestone is remembered across restarts")
    }

    func testANewerStatusKeepsAWaitingMilestoneAlertAndAnEndDropsIt() throws {
        let alerting = try XCTUnwrap(MilestoneAlert.push(for: event("print.milestone", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        let status = try XCTUnwrap(LiveActivityPush.make(for: event("print.status", notify: "none", data: .init(progress: 51), printId: "print-1"),
                                                          token: "aa", title: "Mic mount", now: now))
        let merged = LiveActivityPush.carryingAlert(of: alerting, into: status)
        XCTAssertEqual(merged.contentState.progress, 51, "the newest state")
        XCTAssertEqual(merged.alert, alerting.alert, "the milestone's alert isn't lost behind a status")
        XCTAssertEqual(merged.priority, 10)
        let end = try XCTUnwrap(LiveActivityPush.make(for: event("print.done", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertNil(LiveActivityPush.carryingAlert(of: alerting, into: end).alert, "done has its own notification")
    }

    @MainActor func testSecondMilestoneOverAWaitingFirstDeliversBoth() async throws {
        let harness = try MilestoneHarness { request, index in
            (index == 0 ? 429 : 200, ["Retry-After": "1"])
        }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let first = event("print.first-layer", printId: "print-1", title: "First layer")
        let second = event("print.milestone", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertTrue(relay.alertMilestone(first, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually { relay.lastResult.hasPrefix("Waiting:") }
        XCTAssertTrue(relay.alertMilestone(second, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually(timeout: 4) { harness.acceptedTitles.count == 2 }
        XCTAssertEqual(Set(harness.acceptedTitles), ["First layer", "Halfway"], "neither milestone may disappear during coalescing")
    }

    @MainActor func testRestartMidRetryRecoversTheUnconfirmedMilestone() async throws {
        let harness = try MilestoneHarness { _, index in (index == 0 ? 429 : 200, ["Retry-After": "30"]) }
        defer { harness.close() }
        var relay: LiveActivityRelay? = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let first = event("print.first-layer", id: "first", printId: "print-1", title: "First layer")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertTrue(relay!.alertMilestone(first, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually { relay!.lastResult.hasPrefix("Waiting:") }
        XCTAssertFalse(AlertedMilestones(defaults: harness.defaults).contains(first.id), "enqueueing is not delivery")
        relay = nil
        let restarted = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        restarted.recover(local: local, cloud: .init())
        await eventually { harness.acceptedTitles == ["First layer"] }
        XCTAssertEqual(harness.acceptedTitles, ["First layer"], "the persisted outbox must outlive the waiting task and event cursor")
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(first.id), "mark alerted only after a confirmed 200")
    }

    @MainActor func testOneOfTwoTokensFailingCannotAlsoNotifyTheDeviceThatGotAnAlert() async throws {
        let harness = try MilestoneHarness { request, index in
            let object = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
            let failing = object?["token"] as? String == "bb"
            return (failing ? (index < 2 ? 429 : 410) : 200, ["Retry-After": "1"])
        }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        var cloudFallbacks = 0
        relay.undelivered = { _ in cloudFallbacks += 1; return true }
        let event = event("print.milestone", id: "halfway", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa"), ("ipad", "print-1", "bb")], starters: ["phone", "ipad"])
        XCTAssertTrue(relay.alertMilestone(event, title: "Mic mount", local: local, cloudTokens: .init(), pairedDeviceIds: ["phone", "ipad"]))
        await eventually { harness.requestCount >= 2 }
        XCTAssertFalse(AlertedMilestones(defaults: harness.defaults).contains(event.id), "wait for every recipient's final decision")
        await eventually(timeout: 3) { harness.requestCount >= 3 && AlertedMilestones(defaults: harness.defaults).contains(event.id) }
        XCTAssertEqual(cloudFallbacks, 0, "a failed device must never trigger an account-wide alert after another device succeeded")
        XCTAssertEqual(harness.acceptedTitles, ["Halfway"])
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(event.id))
    }

    @MainActor func testRemovingACarriedMilestoneAlertPreservesPausePriority() async throws {
        let harness = try MilestoneHarness { _, index in
            if index == 0 { return (200, ["X-Test-Delay": "0.1"]) }
            return (index < 4 ? 503 : 200, ["Retry-After": "1"])
        }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        relay.undelivered = { _ in true }
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        relay.deliver(event("print.status", id: "moving", printId: "print-1"), title: "Mic mount", local: local, cloudTokens: .init())
        await eventually { harness.requestCount == 1 }
        XCTAssertTrue(relay.alertMilestone(event("print.milestone", id: "halfway-pause", printId: "print-1"),
                                          title: "Mic mount", local: local, cloudTokens: .init()))
        relay.deliver(event("print.paused", id: "paused", printId: "print-1"), title: "Mic mount", local: local, cloudTokens: .init())
        await eventually(timeout: 5) { harness.acceptedPriorities.count == 2 }
        XCTAssertEqual(harness.acceptedPriorities, [5, 10], "removing the optional milestone must keep the paused update immediate")
    }

    @MainActor func testABusyRelayRetriesTheMilestoneBeforeChoosingCloudKit() async throws {
        let harness = try MilestoneHarness { _, index in (index == 0 ? 503 : 200, ["Retry-After": "1"]) }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        var cloudFallbacks = 0
        relay.undelivered = { _ in cloudFallbacks += 1; return true }
        let milestone = event("print.milestone", id: "busy-halfway", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertTrue(relay.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually { harness.requestCount >= 1 }
        XCTAssertEqual(cloudFallbacks, 0, "a busy relay has not exhausted its retry attempts")
        XCTAssertFalse(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
        await eventually(timeout: 3) { harness.acceptedTitles == ["Halfway"] }
        XCTAssertEqual(harness.acceptedTitles, ["Halfway"], "the retry must retain its milestone alert")
        XCTAssertEqual(cloudFallbacks, 0)
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
    }

    @MainActor func testAllMilestoneTokensFailBeforeCloudKitFallbackIsChosen() async throws {
        let harness = try MilestoneHarness { _, index in (index == 0 ? 429 : 410, ["Retry-After": "1"]) }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        var cloudFallbacks = 0
        relay.undelivered = { _ in cloudFallbacks += 1; return true }
        let event = event("print.milestone", id: "halfway", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa"), ("ipad", "print-1", "bb")], starters: ["phone", "ipad"])
        XCTAssertTrue(relay.alertMilestone(event, title: "Mic mount", local: local, cloudTokens: .init(), pairedDeviceIds: ["phone", "ipad"]))
        await eventually { harness.requestCount >= 2 }
        XCTAssertEqual(cloudFallbacks, 0, "one token still has its supported short retry")
        XCTAssertFalse(AlertedMilestones(defaults: harness.defaults).contains(event.id))
        await eventually(timeout: 3) { cloudFallbacks == 1 }
        XCTAssertEqual(cloudFallbacks, 1)
        XCTAssertTrue(harness.acceptedTitles.isEmpty)
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(event.id))
    }

    func testAnEnumeratedIPadWithoutAnyTokenForcesCloudKitBeforeSending() {
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        let milestone = event("print.milestone", printId: "print-1")
        XCTAssertNil(MilestoneAlert.tokens(for: milestone, relayOn: true, local: local, cloud: .init(), dead: [],
                                           pairedDeviceIds: ["phone", "ipad"]))
        let both = tokens([("phone", "print-1", "aa"), ("ipad", "print-1", "bb")], starters: ["phone", "ipad"])
        XCTAssertEqual(MilestoneAlert.tokens(for: milestone, relayOn: true, local: both, cloud: .init(), dead: [],
                                              pairedDeviceIds: ["phone", "ipad"])?.count, 2)
        XCTAssertNil(MilestoneAlert.tokens(for: milestone, relayOn: true, local: both, cloud: .init(), dead: []),
                     "device enumeration unavailable: use the conservative single-device guard")
    }

    @MainActor func testRestartKeepsTheSuccessfulRecipientAndRetriesOnlyTheMiss() async throws {
        let harness = try MilestoneHarness { request, index in
            let object = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
            return (object?["token"] as? String == "aa" ? 200 : (index < 2 ? 429 : 410), ["Retry-After": "30"])
        }
        defer { harness.close() }
        var relay: LiveActivityRelay? = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        var fallbacks = 0
        relay!.undelivered = { _ in fallbacks += 1; return true }
        let milestone = event("print.milestone", id: "m1", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa"), ("ipad", "print-1", "bb")], starters: ["phone", "ipad"])
        XCTAssertTrue(relay!.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init(), pairedDeviceIds: ["phone", "ipad"]))
        await eventually { harness.requestCount == 2 && !harness.acceptedTitles.isEmpty && relay!.lastResult.hasPrefix("Waiting:") }
        relay = nil
        let restarted = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        restarted.undelivered = { _ in fallbacks += 1; return true }
        restarted.recover(local: local, cloud: .init())
        await eventually { AlertedMilestones(defaults: harness.defaults).contains(milestone.id) }
        XCTAssertEqual(harness.acceptedTitles, ["Halfway"], "the confirmed recipient never alerts again after restart")
        XCTAssertEqual(fallbacks, 0, "a remembered success forbids account-wide fallback")
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
    }

    @MainActor func testAnUnconfirmedCloudKitFallbackSurvivesRestart() async throws {
        let harness = try MilestoneHarness { _, _ in (410, [:]) }
        defer { harness.close() }
        var relay: LiveActivityRelay? = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        var fallbacks = 0
        relay!.undelivered = { _ in fallbacks += 1; return false }
        let milestone = event("print.milestone", id: "m1", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertTrue(relay!.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually { fallbacks == 1 }
        XCTAssertFalse(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
        relay = nil
        let restarted = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        restarted.undelivered = { event in
            XCTAssertEqual(event.id, milestone.id)
            XCTAssertEqual(event.title, milestone.title)
            XCTAssertEqual(event.printId, milestone.printId)
            fallbacks += 1; return true
        }
        restarted.recover(local: local, cloud: .init())
        await eventually { AlertedMilestones(defaults: harness.defaults).contains(milestone.id) }
        XCTAssertEqual(fallbacks, 2)
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
    }

    @MainActor func testAnOlderStatusRetryCannotReplaceTheNewerWaitingProgress() async throws {
        let harness = try MilestoneHarness { _, index in
            (index == 0 ? 429 : 200, ["Retry-After": "1", "X-Test-Delay": index == 0 ? "0.2" : "0"])
        }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        relay.deliver(event("print.status", data: .init(progress: 20), printId: "print-1"), title: "Mic mount", local: local, cloudTokens: .init())
        await eventually { harness.requestCount == 1 }
        relay.deliver(event("print.status", data: .init(progress: 70), printId: "print-1"), title: "Mic mount", local: local, cloudTokens: .init())
        await eventually(timeout: 3) { !harness.acceptedProgress.isEmpty }
        XCTAssertEqual(harness.acceptedProgress, [70], "retrying the older request must preserve the newer state that arrived in flight")
    }

    @MainActor func testADismissedTokenAfterRestartReachesFallbackAfterABoundedWait() async throws {
        let harness = try MilestoneHarness { _, _ in (429, ["Retry-After": "30"]) }
        defer { harness.close() }
        var clock = Date()
        var relay: LiveActivityRelay? = LiveActivityRelay(defaults: harness.defaults, session: harness.session, now: { clock })
        let milestone = event("print.milestone", id: "dismissed", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        XCTAssertTrue(relay!.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init()))
        await eventually { relay!.lastResult.hasPrefix("Waiting:") }
        relay = nil
        var fallbacks = 0
        let restarted = LiveActivityRelay(defaults: harness.defaults, session: harness.session, now: { clock })
        restarted.undelivered = { _ in fallbacks += 1; return true }
        restarted.recover(local: .init(), cloud: .init())
        XCTAssertEqual(fallbacks, 0, "allow token registration to catch up before declaring a miss")
        clock = clock.addingTimeInterval(31)
        restarted.recover(local: .init(), cloud: .init())
        await eventually { fallbacks == 1 && AlertedMilestones(defaults: harness.defaults).contains(milestone.id) }
        XCTAssertEqual(fallbacks, 1, "dismissed tokens need not return; the event must leave pending")
        XCTAssertTrue(AlertedMilestones(defaults: harness.defaults).contains(milestone.id))
    }

    @MainActor func testARetriedStartKeepsItsMandatoryAlert() async throws {
        let harness = try MilestoneHarness { _, index in (index == 0 ? 503 : 200, ["Retry-After": "1"]) }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let local = LiveActivityTokens(pushToStart: [.init(deviceId: "phone", token: "aa", updatedAt: "")])
        relay.deliver(event("print.started", printId: "print-1"), title: "Mic mount", local: local, cloudTokens: .init())
        await eventually(timeout: 3) { harness.requestCount >= 2 }
        XCTAssertEqual(harness.acceptedTitles, ["Mic mount is printing"], "the relay contract requires an alert on every start, including retries")
    }

    @MainActor func testSavedPhoneChoicesPreventAnActivityMilestoneAlert() async throws {
        let harness = try MilestoneHarness { _, _ in (200, [:]) }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let milestone = event("print.milestone", id: "muted-phone", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")], starters: ["phone"])
        let onActivity = relay.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init(),
            pairedDeviceIds: ["phone"], phoneChoices: ["phone": ["print.milestone": false]])
        if onActivity { await eventually { AlertedMilestones(defaults: harness.defaults).contains(milestone.id) } }
        XCTAssertFalse(onActivity, "preserve the existing CloudKit notification-choice path")
        XCTAssertTrue(harness.acceptedTitles.isEmpty, "a saved opt-out must not be bypassed by ActivityKit")
    }

    @MainActor func testSavedPhoneChoiceAlsoAppliesWithoutAPushToStartRegistration() async throws {
        let harness = try MilestoneHarness { _, _ in (200, [:]) }
        defer { harness.close() }
        let relay = LiveActivityRelay(defaults: harness.defaults, session: harness.session)
        let milestone = event("print.milestone", id: "muted-without-start-token", printId: "print-1", title: "Halfway")
        let local = tokens([("phone", "print-1", "aa")])
        let onActivity = relay.alertMilestone(milestone, title: "Mic mount", local: local, cloudTokens: .init(),
            phoneChoices: ["phone": ["print.milestone": false]])
        if onActivity { await eventually { AlertedMilestones(defaults: harness.defaults).contains(milestone.id) } }
        XCTAssertFalse(onActivity)
        XCTAssertTrue(harness.acceptedTitles.isEmpty)
    }

    func testSavedPhoneChoicesDecodeFromTheCompanionsSettings() throws {
        let data = Data(#"{"milestones":"50","notifications":{"mac":{},"devices":{"phone":{"print.milestone":false}}}}"#.utf8)
        let settings = try JSONDecoder().decode(CompanionSettings.self, from: data)
        XCTAssertEqual(settings.notificationsDevices?["phone"]?["print.milestone"], false)
    }

    @MainActor private func eventually(timeout: TimeInterval = 2, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    func testNotStartedEndsTheActivityDespiteTheLastPreparingReport() throws {
        let push = try XCTUnwrap(LiveActivityPush.make(for: event("print.not-started", data: .init(state: "preparing"), printId: "print-1"),
                                                      token: "aa", title: "Mic mount", now: now))
        XCTAssertEqual(push.kind, .end)
        XCTAssertEqual(push.contentState.state, "failed")
        XCTAssertNil(push.alert)
        XCTAssertNil(push.staleDate)
    }

    func testTerminalRecoveryWaitsForALateTokenAndSurvivesRestart() throws {
        let name = "activity-recovery-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var recovery = LiveActivityRecovery(defaults: defaults)
        recovery.record(event("print.not-started", printId: "old"), title: "Mic mount", now: now)
        XCTAssertTrue(recovery.pushes(tokens: [], now: now).isEmpty)
        var restarted = LiveActivityRecovery(defaults: defaults)
        let token = LiveActivityTokens.Activity(printId: "old", deviceId: "phone", token: "aa", updatedAt: "")
        let pushes = restarted.pushes(tokens: [token, token], now: now)
        XCTAssertEqual(pushes.count, 1, "LAN and iCloud may carry the same token")
        XCTAssertEqual(pushes.first?.kind, .end)
        XCTAssertEqual(pushes.first?.contentState.state, "failed")
        XCTAssertTrue(restarted.pushes(tokens: [token], now: now).isEmpty, "do not requeue an unchanged event/token each poll")
    }

    func testRetryEndsTheEarlierPrintWithoutEndingAnotherProjectOrRestartingTheActivity() throws {
        let name = "activity-retry-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var recovery = LiveActivityRecovery(defaults: defaults)
        recovery.record(event("print.started", printId: "old"), title: "Mic mount", now: now)
        recovery.record(event("print.started", project: "p2", printId: "other"), title: "Hook", now: now)
        recovery.record(event("print.started", printId: "new"), title: "Mic mount", now: now)
        recovery.record(event("print.status", notify: "none", data: .init(state: "printing"), printId: "old"), title: "Mic mount", now: now)
        let tokens = ["old", "new", "other"].map { LiveActivityTokens.Activity(printId: $0, deviceId: "phone", token: $0, updatedAt: "") }
        let pushes = recovery.pushes(tokens: tokens, now: now)
        XCTAssertEqual(pushes.first { $0.token == "old" }?.kind, .end)
        XCTAssertEqual(pushes.first { $0.token == "old" }?.contentState.state, "cancelled")
        XCTAssertEqual(pushes.first { $0.token == "new" }?.kind, .update, "a late token receives current state, never another start")
        XCTAssertEqual(pushes.first { $0.token == "other" }?.kind, .update)
        XCTAssertTrue(pushes.allSatisfy { $0.alert == nil })
    }

    func testAMutedRetryStillRetiresTheEarlierActivityWithoutStartingAnother() throws {
        let name = "activity-muted-retry-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var recovery = LiveActivityRecovery(defaults: defaults)
        recovery.record(event("print.started", printId: "old"), title: "Mic mount", now: now)
        recovery.record(event("print.started", notify: "none", printId: "new"), title: "Mic mount", now: now)
        let pushes = recovery.pushes(tokens: [.init(printId: "old", deviceId: "phone", token: "aa", updatedAt: "")], now: now)
        XCTAssertEqual(pushes.first?.kind, .end)
        XCTAssertTrue(pushes.allSatisfy { $0.alert == nil })
    }

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
        // Handoff item 9: a print the printer never started left its Live Activity at 0% (two orange "0%" items in the menu bar).
        let notStarted = try XCTUnwrap(LiveActivityPush.make(for: event("print.not-started", printId: "print-1"), token: "aa", title: "Mic mount", now: now))
        XCTAssertEqual(notStarted.kind, .end, "a print that never started ends its activity")
        XCTAssertEqual(notStarted.contentState.state, "failed")
        XCTAssertNil(notStarted.staleDate)
        XCTAssertNil(notStarted.alert, "its own alert already says it didn't start; the activity ends silently")
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

private final class MilestoneHarness: @unchecked Sendable {
    let name = "milestone-io-\(UUID().uuidString)"
    let defaults: UserDefaults
    let session: URLSession
    private let lock = NSLock()
    private var accepted: [String] = []
    private var progress: [Double] = []
    private var priorities: [Int] = []
    private var count = 0
    private let response: (URLRequest, Int) -> (Int, [String: String])
    var acceptedPriorities: [Int] { lock.lock(); defer { lock.unlock() }; return priorities }
    var acceptedProgress: [Double] { lock.lock(); defer { lock.unlock() }; return progress }
    var requestCount: Int { lock.lock(); defer { lock.unlock() }; return count }
    var acceptedTitles: [String] { lock.lock(); defer { lock.unlock() }; return accepted }
    @MainActor init(response: @escaping (URLRequest, Int) -> (Int, [String: String])) throws {
        defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.set(true, forKey: LiveActivityRelay.enabledKey)
        defaults.set("https://relay.invalid/" + name, forKey: LiveActivityRelay.urlKey)
        self.response = response
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MilestoneProtocol.self]
        session = URLSession(configuration: config)
        MilestoneProtocol.register(self, name: name)
    }
    func answer(_ request: URLRequest) -> (Int, [String: String]) {
        lock.lock(); defer { lock.unlock() }
        let result = response(request, count); count += 1
        if result.0 == 200, let object = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any],
           let priority = object["priority"] as? Int { priorities.append(priority) }
        if result.0 == 200, let object = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any],
           let alert = object["alert"] as? [String: Any], let title = alert["title"] as? String { accepted.append(title) }
        if result.0 == 200, let object = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any],
           let state = object["contentState"] as? [String: Any], let value = state["progress"] as? Double { progress.append(value) }
        return result
    }
    func close() { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: name); MilestoneProtocol.remove(name) }
}

private final class MilestoneProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var harnesses: [String: MilestoneHarness] = [:]
    static func register(_ harness: MilestoneHarness, name: String) { lock.lock(); harnesses[name] = harness; lock.unlock() }
    static func remove(_ name: String) { lock.lock(); harnesses[name] = nil; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "relay.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let harness = Self.harnesses[request.url?.pathComponents.dropFirst().first ?? ""]; Self.lock.unlock()
        guard let harness else { client?.urlProtocol(self, didFailWithError: URLError(.cancelled)); return }
        var sent = request
        if sent.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var body = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            sent.httpBody = body
        }
        let (code, headers) = harness.answer(sent)
        let reply = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"scope":"token-interval"}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        if let delay = Double(headers["X-Test-Delay"] ?? ""), delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: reply)
        } else { reply() }
    }
    override func stopLoading() {}
}
