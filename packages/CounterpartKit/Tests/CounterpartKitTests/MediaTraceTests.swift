import XCTest
@testable import CounterpartKit

final class MediaTraceTests: XCTestCase {
    func testSuccessAndFailureAreCorrelatedAndRotationKeepsWholeBoundedLines() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let trace = MediaTrace(url: folder.appendingPathComponent("media-trace.ndjson"), maximumBytes: 8192)
        let success = MediaTrace.Context(project: "p", version: "42", generation: "visit-1")
        for event in ["page.begin", "file.miss", "request.start", "request.response", "file.committed", "mesh.new", "mesh.parse-end", "mesh.resource-end", "poster.onComplete", "poster.readback", "page.published"] {
            trace.record(event, ["bytes": "84"], context: success)
        }
        let failed = MediaTrace.Context(project: "p", version: "42", generation: "visit-2")
        trace.record("page.begin", [:], context: failed)
        trace.record("request.error", ["code": "timeout"], context: failed)
        let rows = try String(contentsOf: trace.url, encoding: .utf8).split(separator: "\n").map {
            try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: String]
        }
        XCTAssertTrue(rows.contains { $0["event"] == "page.published" && $0["generation"] == "visit-1" })
        XCTAssertTrue(rows.contains { $0["event"] == "request.error" && $0["generation"] == "visit-2" })
        for _ in 0..<100 { trace.record("mesh.new", ["owner": UUID().uuidString], context: success) }
        let sizes = try [trace.url, trace.url.appendingPathExtension("1")].map { url -> Int in
            let data = try Data(contentsOf: url)
            XCTAssertEqual(data.last, 10)
            for line in data.split(separator: 10) { XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(line))) }
            return data.count
        }
        XCTAssertLessThanOrEqual(sizes.reduce(0, +), 8192)
    }
}
