import XCTest
import CloudKit
@testable import CounterpartKit

final class PrintActivityTests: XCTestCase {
    func testProjectProgressAndTerminalStateOverrideAnOldPrinterReport() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var project = Project(id: "p", createdAtMs: 0, updatedAtMs: now.timeIntervalSince1970 * 1000, state: .printing)
        XCTAssertNil(PrintActivitySnapshot(project), "no activity without a real print identity")
        project.print = .init(bundleId: "b", printId: "j", live: .init(state: "printing", job: .init(name: "Clip", progress: 50, remainingSec: 120)))
        let current = try XCTUnwrap(PrintActivitySnapshot(project, now: now))
        XCTAssertEqual(current.content.progress, 50)
        XCTAssertEqual(current.content.endsAt, now.addingTimeInterval(120))
        XCTAssertEqual(current.observedAt, now)
        project.state = .printed
        let ended = try XCTUnwrap(PrintActivitySnapshot(project, now: now))
        XCTAssertTrue(ended.content.terminal)
        XCTAssertEqual(ended.content.progress, 100)
    }

    func testCloudMirrorAndPhoneEndDespiteAnOldPrinterReport() throws {
        let updated = Date(timeIntervalSince1970: 1_800_000_000)
        for (outcome, reported, projectState, expected) in [
            ("replaced", "printing", Project.State.ready, "cancelled"),
            ("failed", "idle", .failed, "failed"),
            ("done", "printing", .printed, "finished"),
            ("", "idle", .failed, "failed")
        ] {
            var project = Project(id: "p", createdAtMs: 0, updatedAtMs: updated.timeIntervalSince1970 * 1000, state: projectState)
            project.print = .init(bundleId: "b", printId: "j", live: .init(state: reported, job: .init(name: "Old job", progress: 42)),
                                  monitor: .init(phase: "ended", endState: outcome.isEmpty ? nil : outcome))
            let record = CKRecord(recordType: "CounterpartProject")
            record["projectId"] = project.id; record["updatedAt"] = updated
            PrintActivitySnapshot.mirror(project, into: record)
            XCTAssertEqual(record["printState"] as? String, expected)
            let remote = try XCTUnwrap(PrintActivitySnapshot(cloudRecord: record))
            XCTAssertEqual(remote.content.state, expected)
            XCTAssertTrue(remote.content.terminal)
            XCTAssertFalse(remote.shouldStart(foreground: true, dismissed: []))
            XCTAssertEqual(remote.observedAt, updated)
            // Outcome must also override a raw legacy report in a record read by the phone.
            record["printState"] = reported
            XCTAssertEqual(PrintActivitySnapshot(cloudRecord: record)?.content.state, expected)
        }
    }

    func testRelayCodingAndLifecycle() throws {
        let state = PrintAttributes.ContentState(state: "printing", progress: 50, layer: 3, totalLayers: 6,
                                                 endsAt: Date(timeIntervalSinceReferenceDate: 42), stage: "Walls")
        let data = try JSONEncoder().encode(state)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["endsAt"] as? Double, 42, "relay uses Swift reference-date seconds")
        XCTAssertEqual(Set(body.keys), ["state", "progress", "layer", "totalLayers", "endsAt", "stage"])
        XCTAssertTrue(state.canStart); XCTAssertFalse(state.terminal)
        for ended in ["finished", "failed", "cancelled"] {
            let content = PrintAttributes.ContentState(state: ended, progress: 101, endsAt: Date())
            XCTAssertTrue(content.terminal); XCTAssertFalse(content.canStart); XCTAssertEqual(content.progress, 100)
        }
        XCTAssertEqual(PrintAttributes.ContentState(state: "printing", progress: .nan, endsAt: Date()).progress, 0)
        let attributes = PrintAttributes(projectId: "p", printId: "j", title: "Clip", printerName: "Printer")
        let snapshot = PrintActivitySnapshot(attributes: attributes, content: state)
        XCTAssertTrue(snapshot.shouldStart(foreground: true, dismissed: []))
        XCTAssertFalse(snapshot.shouldStart(foreground: false, dismissed: []), "silent wake cannot start an activity")
        XCTAssertFalse(snapshot.shouldStart(foreground: true, dismissed: ["j"]), "refresh cannot recreate an activity the user dismissed")
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(attributes)) as? [String: String])
        XCTAssertEqual(encoded, ["projectId": "p", "printId": "j", "title": "Clip", "printerName": "Printer"])
    }
}
