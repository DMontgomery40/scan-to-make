import XCTest
@testable import CounterpartKit

final class PublishedModelTests: XCTestCase {
    func testPublishedLinkDoesNotTurnAnOrdinaryReferenceIntoARedraw() {
        XCTAssertEqual(PublishedModelLink.find(in: "Print https://makerworld.com/en/models/1531561")?.host, "makerworld.com")
        XCTAssertNotNil(PublishedModelLink.find(in: "https://example.com/designer.3mf"))
        XCTAssertNil(PublishedModelLink.find(in: "https://makerworld.com.evil.example/model/1"))
        XCTAssertNil(PublishedModelLink.find(in: "https://example.com/phone-dimensions"))
    }
    func testOnlyPublished3MFHidesSingleMaterialControls() throws {
        for (kind, file, expected) in [("published", "original/model.3mf", true), ("published", "original/model.3MF", true), ("published", "original/model.stl", false), ("fit", "current/model.3mf", false)] {
            let json: [String: Any] = ["id": "p", "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "kind": kind, "photos": [], "passes": [], "current": ["model": file, "renders": []]]
            let project = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: json))
            XCTAssertEqual(project.preservesPublishedFilaments, expected, file)
        }
    }
    func testPublicPlateAskAndSelectionDecodeWithoutWorkerActivity() throws {
        let json = #"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"needs-closeup","kind":"published","photos":[],"passes":[],"ask":{"id":"a","type":"choice","question":"Which plate?","answers":["choice"],"status":"open","options":[{"id":"0:1","label":"Plate 2"}]},"publishedSelection":{"fileIndex":0,"plateIndex":1,"sliced":true},"credit":{"url":"https://makerworld.com/en/models/1","designer":"The designer"}}"#
        let project = try JSONDecoder().decode(Project.self, from: Data(json.utf8))
        XCTAssertEqual(project.openAsk?.type, "choice")
        XCTAssertEqual(project.openAsk?.options?.first?.id, "0:1")
        XCTAssertEqual(project.publishedSelection?.plateIndex, 1)
        XCTAssertEqual(project.publishedSelection?.sliced, true)
        XCTAssertEqual(project.credit?.object?["designer"]?.string, "The designer")
    }
}
