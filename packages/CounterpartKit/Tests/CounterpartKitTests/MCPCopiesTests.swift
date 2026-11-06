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
        XCTAssertEqual(package.moveTitle(package.moveIDs[0]), "Move Bambu Lab P1S (mcp-3D-printer-server, your copy at /home/ada/mcp-3D-printer-server) to Counterpart’s updated copy")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/printers/mcps"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/printers/mcp/mcp-0000000000000002/update"), "projects:write")
    }

    /// Settings → Printers follow-up (Nov 6): David's two P1S profiles each showed "Move Bambu Lab P1S to Counterpart's
    /// updated copy", ordered by id. The companion's titles name the MCP and copy, in the order the uses are listed.
    func testTwoProfilesOfOnePrinterGetMovesThatReadApartInScreenOrder() throws {
        struct Reply: Decodable { let packages: [MCPPackageCopies] }
        let data = try Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/mcp-printer-moves.json"))
        let packages = try JSONDecoder().decode(Reply.self, from: data).packages
        let titles = packages.flatMap { $0.moves.map(\.title) }
        XCTAssertEqual(titles.count, 2)
        XCTAssertEqual(Set(titles).count, 2, "two P1S Moves never read the same")
        XCTAssertTrue(titles[0].contains("bambu-printer-mcp") && titles[0].contains("bambu-1.1.46"), titles[0])
        XCTAssertTrue(titles[1].contains("mcp-3D-printer-server"), titles[1])
        for package in packages { XCTAssertEqual(package.moveIDs, package.uses.filter(\.canMove).map(\.mcpId)) }
        XCTAssertTrue(packages[0].uses[0].words.contains("older than Counterpart’s copy (1.1.69)"), packages[0].uses[0].words)
        XCTAssertEqual(packages[0].uses[0].managed, false)
    }

    /// A companion from before Nov 6 sends no `moves`: listed order, not sorted ids, and each names its copy.
    func testAnOlderCompanionsMovesKeepListedOrder() throws {
        let json = #"""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","appMcpId":"mcp-0000000000000000",
         "uses":[{"destinationId":"z","printerId":"p","printer":"Bambu Lab P1S","mcpId":"mcp-ffff000000000000","kind":"app","path":"/x/printers/bambu-1.1.46","version":"1.1.65","canMove":true},
                 {"destinationId":"a","printerId":"p","printer":"Bambu Lab P1S","mcpId":"mcp-0000000000000001","kind":"checkout","path":"/x/bambu-printer-mcp","version":"1.1.60","canMove":true}]}
        """#
        let package = try JSONDecoder().decode(MCPPackageCopies.self, from: Data(json.utf8))
        XCTAssertEqual(package.moveIDs, ["mcp-ffff000000000000", "mcp-0000000000000001"])
        XCTAssertNotEqual(package.moveTitle(package.moveIDs[0]), package.moveTitle(package.moveIDs[1]))
        XCTAssertEqual(package.uses[0].words, "Bambu Lab P1S uses Counterpart’s older copy at /x/printers/bambu-1.1.46 (1.1.65).")
    }
}
