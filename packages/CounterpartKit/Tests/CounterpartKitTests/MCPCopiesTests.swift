import XCTest
@testable import CounterpartKit

final class MCPCopiesTests: XCTestCase {
    func testHiddenProfileVersionAndMoveRemainSeparateFromTheManagedCopy() throws {
        let data = try Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/mcp-profile-copies.json"))
        let package = try JSONDecoder().decode(MCPPackageCopies.self, from: data)
        let use = try XCTUnwrap(package.uses.first)
        XCTAssertEqual(use.printerId, "current")
        XCTAssertEqual(use.words, "Bambu Lab P1S uses your copy at /home/ada/mcp-3D-printer-server (1.2.25).")
        XCTAssertEqual(package.appCopy?.version, "1.2.45")
        XCTAssertEqual(package.moveIDs, ["mcp-0000000000000002"])
        XCTAssertEqual(package.moveTitle(package.moveIDs[0]), "Move Bambu Lab P1S to Counterpart’s updated copy")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/printers/mcps"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/printers/mcp/mcp-0000000000000002/update"), "projects:write")
    }
}
