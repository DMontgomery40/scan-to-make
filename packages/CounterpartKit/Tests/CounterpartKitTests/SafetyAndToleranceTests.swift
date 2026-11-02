import XCTest
@testable import CounterpartKit

/// KAN-220's final report: printer checks are ticked by a person, one odd object never drops out of the
/// list, an older Mac's waiting question still reads as needing you, and one spelling for phases.
final class SafetyAndToleranceTests: XCTestCase {
    private func question(_ fields: String) throws -> Project.PrintConfirmation {
        try JSONDecoder().decode(Project.PrintConfirmation.self, from: Data(#"{"id":"q","message":"Start?","expiresAtMs":2000,"supported":true,"fields":[\#(fields)]}"#.utf8))
    }

    func testASwitchNeverTakesItsDefault() throws {
        let q = try question(#"{"name":"confirmed","title":"I checked the printer and confirm this operation","required":true,"default":true}"#)
        XCTAssertEqual(q.fields[0].initialValue, .bool(false), "the MCP's default never ticks a printer check")
        XCTAssertFalse(q.canAccept([:], atMs: 1000), "a required check needs a person to tick it")
        XCTAssertNil(q.response(confirmationId: "q", action: .accept, content: [:], atMs: 1000))
        XCTAssertTrue(q.canAccept(["confirmed": true], atMs: 1000))
        let optional = try question(#"{"name":"watch","title":"Watch the first layer","required":false,"default":true}"#)
        XCTAssertEqual(optional.response(confirmationId: "q", action: .accept, content: [:], atMs: 1000)?.answer.content, ["watch": false],
                       "an optional check left alone is sent as off, not as its default")
    }

    func testDefaultsStillPrefillOtherFields() throws {
        let q = try question(#"{"name":"speed","title":"Speed","type":"string","required":true,"enum":["standard","sport"],"default":"standard"},{"name":"confirmed","title":"OK","required":true,"default":true}"#)
        XCTAssertEqual(q.fields[0].initialValue, .string("standard"))
        XCTAssertFalse(q.canAccept([:], atMs: 1000))
        XCTAssertEqual(q.response(confirmationId: "q", action: .accept, content: ["confirmed": true], atMs: 1000)?.answer.content,
                       ["speed": "standard", "confirmed": true])
    }

    func testAnObjectWithBrokenOptionalsStillDecodes() throws {
        let list = #"""
        {"objects":[
          {"id":"a","createdAtMs":1,"updatedAtMs":2,"state":"ready",
           "current":{"model":"current/model.stl","renders":["current/renders/a.png"],"changes":[{"tag":7}]},
           "ask":"not an object","status":{"phase":"ready"},"print":{"bundleId":3}},
          {"id":"b","createdAtMs":1,"updatedAtMs":2,"state":"touching-up"},
          {"id":"c","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[]}
        ]}
        """#
        struct List: Decodable { var objects: [Project] }
        let objects = try JSONDecoder().decode(List.self, from: Data(list.utf8)).objects
        XCTAssertEqual(objects.map(\.id), ["a", "b", "c"], "no object drops out of the list")
        XCTAssertEqual(objects[0].current?.model, "current/model.stl", "the model survives a malformed changes list")
        XCTAssertNil(objects[0].current?.changes)
        XCTAssertNil(objects[0].ask)
        XCTAssertNil(objects[0].status, "a status without its text is left out")
        XCTAssertNil(objects[0].print)
        XCTAssertEqual(objects[1].photos, [])
        XCTAssertEqual(objects[1].passes, [])
        XCTAssertEqual(ProjectWords(objects[1]).phase, .working)
    }

    func testAWaitingPrinterQuestionNeedsYouOnAnOlderMac() throws {
        let text = #"{"id":"a","createdAtMs":1,"updatedAtMs":2,"state":"printing","photos":[],"passes":[],"print":{"bundleId":"b"},"printConfirmation":{"id":"q","message":"Start?","expiresAtMs":9999999999999,"fields":[],"supported":true}}"#
        let project = try JSONDecoder().decode(Project.self, from: Data(text.utf8))
        XCTAssertEqual(ProjectWords(project).phase, .needsYou)
        var told = project
        told.status = Project.Status(phase: "printing", text: "Printing on P1S", symbol: "printer.fill", tint: "green")
        XCTAssertEqual(ProjectWords(told).phase, .printing, "the Mac's own phase wins when it sends one")
    }

    func testCloudKitUsesTheSharedPhaseSpellings() {
        XCTAssertEqual(CloudKitRecords.projectState(.needsYou), "needs-you")
        XCTAssertEqual(CloudKitRecords.projectState(.draft), "draft")
        XCTAssertEqual(Set(ProjectPhase.allCases.map(CloudKitRecords.projectState)),
                       ["draft", "sending", "working", "needs-you", "ready", "preparing", "printing", "printed", "sent", "confirmed", "failed", "unknown"])
    }

    func testTimesMidSentenceAreLowercase() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO.date("2026-11-01T12:00:00Z")!
        XCTAssertEqual(Format.whenInSentence(ISO.date("2026-10-31T09:00:00Z")!, now: now, calendar: calendar), "yesterday")
        XCTAssertEqual(Format.whenInSentence(now.addingTimeInterval(-10), now: now, calendar: calendar), "just now")
        let printed = try! JSONDecoder().decode(Project.self, from: Data(#"{"id":"a","createdAtMs":1,"updatedAtMs":2,"state":"printed","photos":[],"passes":[],"current":{"model":"m","renders":[]},"print":{"bundleId":"b","monitor":{"phase":"ended","endState":"done","endedAt":"2026-10-31T09:00:00Z"}}}"#.utf8))
        XCTAssertTrue(ProjectWords(printed, now: now).line.hasPrefix("Printed "))
        XCTAssertFalse(ProjectWords(printed, now: now).line.contains("Yesterday"))
    }
}
