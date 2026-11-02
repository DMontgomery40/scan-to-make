import XCTest
@testable import CounterpartKit

/// Generic printer confirmations (KAN-214 PR 5): an MCP elicitation's primitive fields, checked here before
/// an answer is sent. The companion checks again.
final class ConfirmationFieldTests: XCTestCase {
    private func question(_ fields: String, supported: Bool = true) throws -> Project.PrintConfirmation {
        try JSONDecoder().decode(Project.PrintConfirmation.self, from: Data(#"{"id":"q","message":"Start?","expiresAtMs":2000,"supported":\#(supported),"fields":[\#(fields)]}"#.utf8))
    }

    func testAFieldWithoutATypeIsASwitch() throws {
        let q = try question(#"{"name":"confirmed","title":"I checked the printer","required":true}"#)
        XCTAssertEqual(q.fields[0].type, .boolean)
        XCTAssertFalse(q.canAccept([:], atMs: 1000))
        XCTAssertFalse(q.canAccept(["confirmed": false], atMs: 1000), "a required switch must be on")
        XCTAssertFalse(q.canAccept(["confirmed": "yes"], atMs: 1000), "the wrong type never passes")
        XCTAssertTrue(q.canAccept(["confirmed": true], atMs: 1000))
        XCTAssertEqual(q.fields[0].initialValue, .bool(false))
    }

    func testStringsWithLengthAndFormat() throws {
        let q = try question(#"{"name":"note","title":"Note","type":"string","required":true,"minLength":2,"maxLength":5},{"name":"mail","title":"Mail","type":"string","required":false,"format":"email"}"#)
        XCTAssertFalse(q.canAccept(["note": "a"], atMs: 1000))
        XCTAssertFalse(q.canAccept(["note": "abcdef"], atMs: 1000))
        XCTAssertTrue(q.canAccept(["note": "abc"], atMs: 1000), "an optional field may be left out")
        XCTAssertFalse(q.canAccept(["note": "abc", "mail": "not an address"], atMs: 1000))
        XCTAssertTrue(q.canAccept(["note": "abc", "mail": "d@example.com"], atMs: 1000))
        let answer = try XCTUnwrap(q.response(confirmationId: "q", action: .accept, content: ["note": "abc"], atMs: 1000))
        XCTAssertEqual(answer.answer.content, ["note": "abc"], "an optional field left out isn't sent")
    }

    func testLengthsCountCodePointsAndDatesAreRealDays() throws {
        let q = try question(#"{"name":"mark","title":"Mark","type":"string","required":true,"minLength":2,"maxLength":2},{"name":"day","title":"Day","type":"string","required":false,"format":"date"}"#)
        XCTAssertTrue(q.canAccept(["mark": "e\u{301}"], atMs: 1000), "two code points, though it reads as one letter")
        XCTAssertFalse(q.canAccept(["mark": "e\u{301}", "day": "2026-02-30"], atMs: 1000))
        XCTAssertFalse(q.canAccept(["mark": "e\u{301}", "day": "2026-99-99"], atMs: 1000))
        XCTAssertTrue(q.canAccept(["mark": "e\u{301}", "day": "2028-02-29"], atMs: 1000), "a leap day")
    }

    func testEnumsWithNamesAndADefault() throws {
        let q = try question(#"{"name":"speed","title":"Speed","type":"string","required":true,"enum":["silent","standard","sport"],"enumNames":["Silent","Standard","Sport"],"default":"standard"}"#)
        let field = q.fields[0]
        XCTAssertEqual(field.displayName(of: "sport"), "Sport")
        XCTAssertEqual(field.initialValue, .string("standard"))
        XCTAssertTrue(q.canAccept([:], atMs: 1000), "the default answers it")
        XCTAssertFalse(q.canAccept(["speed": "ludicrous"], atMs: 1000))
        let answer = try XCTUnwrap(q.response(confirmationId: "q", action: .accept, content: [:], atMs: 1000))
        XCTAssertEqual(answer.answer.content, ["speed": "standard"], "the default is sent as the answer")
    }

    func testNumbersAndIntegersWithinLimits() throws {
        let q = try question(#"{"name":"temp","title":"Bed","type":"number","required":true,"minimum":40,"maximum":110},{"name":"copies","title":"Copies","type":"integer","required":true,"minimum":1}"#)
        XCTAssertFalse(q.canAccept(["temp": 120, "copies": 1], atMs: 1000))
        XCTAssertFalse(q.canAccept(["temp": 60.5, "copies": 1.5], atMs: 1000), "an integer has no fraction")
        XCTAssertFalse(q.canAccept(["temp": 60.5, "copies": 0], atMs: 1000))
        XCTAssertTrue(q.canAccept(["temp": 60.5, "copies": 2], atMs: 1000))
        let answer = try XCTUnwrap(q.response(confirmationId: "q", action: .accept, content: ["temp": 60.5, "copies": 2], atMs: 1000))
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        let content = try XCTUnwrap((wire["answer"] as? [String: Any])?["content"] as? [String: Any])
        XCTAssertEqual(content["temp"] as? Double, 60.5)
        XCTAssertEqual(content["copies"] as? Int, 2)
    }

    func testATypeFromANewerMCPGoesToTheMac() throws {
        let q = try question(#"{"name":"tags","title":"Tags","type":"array","required":false}"#)
        XCTAssertEqual(q.fields[0].type, .unknown)
        XCTAssertFalse(q.isRenderable)
        XCTAssertFalse(q.canAccept([:], atMs: 1000))
        XCTAssertNotNil(q.response(confirmationId: "q", action: .cancel, content: [:], atMs: 1000), "it can still be stopped")
        XCTAssertFalse(try question(#"{"name":"confirmed","title":"OK","required":true}"#, supported: false).isRenderable)
    }

    func testSwitchAnswersStillWork() throws {
        let q = try question(#"{"name":"confirmed","title":"OK","required":true}"#)
        let checks: [String: Bool] = ["confirmed": true]
        XCTAssertTrue(q.canAccept(checks, atMs: 1000))
        XCTAssertEqual(q.response(confirmationId: "q", action: .accept, content: checks, atMs: 1000)?.answer.content, ["confirmed": true])
    }
}
