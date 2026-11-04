import XCTest
@testable import CounterpartKit

final class StarterProjectTests: XCTestCase {
    func testCatalogContainsOnlyTheThreeCuratedProjectsAndShipsTheCard() throws {
        XCTAssertEqual(StarterProject.all.map(\.id), ["scan-platform", "caliper-card", "long-vernier-caliper"])
        let card = try XCTUnwrap(StarterProject.all.first { $0.id == "caliper-card" })
        XCTAssertTrue(card.bundled)
        XCTAssertNotNil(card.imageFile)
        XCTAssertNotNil(card.modelFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(card.modelFile).path))
        XCTAssertTrue(StarterProject.all.filter { !$0.bundled }.allSatisfy { $0.url.host == "makerworld.com" })
        XCTAssertTrue(StarterProject.all.allSatisfy { !$0.instructions.isEmpty && !$0.designer.isEmpty })
    }
}
