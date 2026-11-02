import XCTest
@testable import CounterpartKit

final class ProjectReadsTests: XCTestCase {
    private func project(_ id: String, _ state: Project.State = .ready) -> Project {
        Project(id: id, createdAtMs: 1, updatedAtMs: 2, state: state)
    }

    func testLateReadySnapshotCannotReplaceWorking() {
        var reads = ProjectReads()
        let ready = reads.start(), working = reads.start()
        XCTAssertTrue(reads.accept("mount", ticket: working))
        XCTAssertFalse(reads.accept("mount", ticket: ready))
        let result = reads.merge([project("mount")], ticket: ready, current: [project("mount", .touchingUp)])
        XCTAssertEqual(result.first?.state, .touchingUp)
    }

    func testOldListPreservesNewlyCreatedProjectAndCannotResurrectDeletedProject() {
        var reads = ProjectReads()
        let list = reads.start()
        XCTAssertTrue(reads.accept("new", ticket: reads.start()))
        reads.remove("deleted")
        XCTAssertEqual(reads.merge([project("deleted")], ticket: list, current: [project("new")]).map(\.id), ["new"])
        XCTAssertTrue(reads.merge([], ticket: reads.start(), current: [project("new")]).isEmpty, "A later authoritative list can remove it")
    }

    func testPreviousMacCannotRepopulateAfterReset() {
        var reads = ProjectReads()
        let previous = reads.start()
        reads.reset()
        XCTAssertFalse(reads.accept("old", ticket: previous))
        XCTAssertTrue(reads.merge([project("old")], ticket: previous, current: []).isEmpty)
        XCTAssertTrue(reads.accept("current", ticket: reads.start()))
    }
}
