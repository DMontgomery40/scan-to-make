import XCTest
@testable import ObjectsCore

private func decode(_ json: String) throws -> StmObject { try JSONDecoder().decode(StmObject.self, from: Data(json.utf8)) }
private let base = #""id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "photos": [], "passes": []"#

final class MeasurementTests: XCTestCase {
    func testDecodesWhatTheTouchUpMeasured() throws {
        let object = try decode("{\(base), \"current\": {\"model\": \"current/model.stl\", \"renders\": [], \"measurements\": [" +
            #"{"what": "long", "mm": 120, "source": "scan"}, {"what": "across the top", "mm": 62.3, "source": "caliper"}, "# +
            #"{"what": "high", "mm": 40.5, "source": "ruler"}, {"what": "wide", "mm": 30, "source": "description"}, "# +
            #"{"what": "deep", "mm": 7, "source": "laser"}]}}"#)
        XCTAssertEqual(object.current?.measurements?.count, 5)
        XCTAssertEqual(ObjectWords.measurements(object), [
            "62.3 mm across the top, read from the caliper",
            "About 40.5 mm high, read from a ruler (an estimate)",
            "30 mm wide, from what you asked for",
            "120 mm long, from the scan",
            "7 mm deep",
        ])
    }

    func testOlderMacsWithoutMeasurementsStillDecode() throws {
        let object = try decode("{\(base), \"current\": {\"model\": \"current/model.stl\", \"renders\": []}}")
        XCTAssertNil(object.current?.measurements)
        XCTAssertEqual(ObjectWords.measurements(object), [])
        XCTAssertNil(object.kind)
    }

    func testTheCaliperObject() throws {
        let object = try decode("{\(base), \"kind\": \"caliper\", \"instructions\": \"Scan to Make caliper\", " +
            #""current": {"model": "current/model.stl", "renders": ["current/renders/1_front.png"], "sizeMm": [160, 105, 4.6]}}"#)
        XCTAssertEqual(object.kind, "caliper")
        XCTAssertEqual(ObjectWords(object).title, "Scan to Make caliper")
        XCTAssertEqual(ObjectWords(object).size, "160 × 105 × 5 mm")
        XCTAssertEqual(ObjectWords(object).status, "Ready to print")
    }
}
