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
    // #775 (David, Nov 12: "messy af looking, double entries, confusing wording"): one quiet row per MCP.
    private func software(_ name: String) throws -> [MCPPackageCopies] {
        struct Reply: Decodable { let packages: [MCPPackageCopies] }
        return try JSONDecoder().decode(Reply.self, from: Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/mcp-printer-software-\(name).json"))).packages
    }

    func testTwoProfilesOfOnePrinterAreOneUsedByAndNothingNewerHasNoUpdate() throws {
        let packages = try software("current")
        let bambu = packages[0].row(), generic = packages[1].row()
        XCTAssertEqual(bambu.name, "bambu-printer-mcp")
        XCTAssertEqual(bambu.version, "1.1.94")
        XCTAssertEqual(bambu.status, .upToDate)
        XCTAssertNil(bambu.update, "nothing newer: no Update button")
        XCTAssertEqual(bambu.usedBy, "Used by P1S", "one P1S, not one line per profile")
        XCTAssertEqual(bambu.others, [])
        XCTAssertEqual(generic.version, "1.2.76")
        XCTAssertEqual(generic.usedBy, "No printer uses it yet")
        for row in [bambu, generic] { XCTAssertFalse(row.allWords.contains("Counterpart’s copy"), row.allWords) }
    }

    func testANewerVersionSaysAvailableWithOneUpdate() throws {
        let package = try software("update")[0]
        let row = package.row()
        XCTAssertEqual(row.status, .available("1.1.95"))
        XCTAssertEqual(row.status?.words, "1.1.95 available")
        XCTAssertEqual(row.update, package.appMcpId, "one Update, of Counterpart's copy")
        XCTAssertEqual(PrinterSoftwareRow.Status.upToDate.words, "Up to date")
    }

    func testAPrinterOnAnotherCopyGetsOneLineAndUseCounterparts() throws {
        let package = try software("own-copy")[0]
        let row = package.row()
        XCTAssertEqual(row.usedBy, "Used by P1S")
        XCTAssertEqual(row.others.count, 1)
        XCTAssertEqual(row.others[0].mcpId, package.uses[1].mcpId)
        XCTAssertEqual(row.others[0].words, "P1S also runs your own copy (1.1.80)", "its other profile is on Counterpart's copy")
        XCTAssertEqual(row.others[0].footnote, "Runs from a folder you manage, so Counterpart doesn't update it by itself. Your own copy is left as it is.")
        XCTAssertEqual(row.others[0].button, "Use Counterpart’s")
        XCTAssertEqual(row.others[0].accessibilityLabel, "Use Counterpart’s bambu-printer-mcp for P1S instead of your own copy (1.1.80)")
        // The printer's own page shows only what concerns it.
        XCTAssertEqual(package.row(printerId: "someone-else").others, [])
    }

    /// A companion from before #775: no `usedBy`, `available`, `upToDate` or Move `words`. No Update, no status line,
    /// printers once by `printerId`, and the other copy in the same plain words.
    func testAnOlderCompanionRendersCleanly() throws {
        let json = #"""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","appMcpId":"mcp-a","version":"1.1.94","latestVersion":"1.1.95",
         "appCopy":{"kind":"app","version":"1.1.94"},
         "uses":[{"destinationId":"current","printerId":"p1s","printer":"P1S","mcpId":"mcp-a","kind":"app","version":"1.1.94","canMove":false,"managed":true,"words":"Your printer uses Counterpart’s copy (1.1.94)."},
                 {"destinationId":"lan","printerId":"p1s","printer":"P1S","mcpId":"mcp-a","kind":"app","version":"1.1.94","canMove":false,"managed":true,"words":"Your printer uses Counterpart’s copy (1.1.94)."},
                 {"destinationId":"x1c","printerId":"x1c","printer":"X1C","mcpId":"mcp-b","kind":"checkout","path":"/x/bambu","version":"1.1.80","canMove":true}],
         "moves":[{"mcpId":"mcp-b","title":"Move X1C (bambu-printer-mcp, your copy at /x/bambu) to Counterpart’s updated copy"}]}
        """#
        let row = try JSONDecoder().decode(MCPPackageCopies.self, from: Data(json.utf8)).row()
        XCTAssertEqual(row.version, "1.1.94")
        XCTAssertNil(row.status, "an older companion doesn't say whether it's current")
        XCTAssertNil(row.update, "and offers no Update")
        XCTAssertEqual(row.usedBy, "Used by P1S", "only printers on Counterpart's copy (#775 review)")
        XCTAssertEqual(row.others.map(\.words), ["X1C runs your own copy (1.1.80)"])
        XCTAssertEqual(row.others.first?.footnote, "Your own copy is left as it is.")
    }

    /// #775 review (#320): only a hand-built copy, a newer version published: Update installs Counterpart's own copy.
    func testACheckoutOnlyInstallStillOffersUpdate() throws {
        let json = #"""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","appMcpId":"mcp-a","version":"1.1.80","latestVersion":"1.1.95","available":"1.1.95","usedBy":[],
         "uses":[{"destinationId":"lan","printerId":"p1s","printer":"P1S","mcpId":"mcp-b","kind":"checkout","version":"1.1.80","canMove":true,"managed":false}],
         "moves":[{"mcpId":"mcp-b","title":"Move P1S","printers":["P1S"],"words":"P1S runs your own copy (1.1.80)"}]}
        """#
        let row = try JSONDecoder().decode(MCPPackageCopies.self, from: Data(json.utf8)).row()
        XCTAssertEqual(row.version, "1.1.80")
        XCTAssertEqual(row.status, .available("1.1.95"))
        XCTAssertEqual(row.update, "mcp-a")
        XCTAssertEqual(row.usedBy, "No printer uses it yet", "its only profile runs its own copy")
    }

    /// A companion from before #775 with one printer on both copies: "Used by P1S" and "P1S also runs your own copy".
    func testAnOlderCompanionSaysAlsoForAPrinterOnBothCopies() throws {
        let json = #"""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","appMcpId":"mcp-a","appCopy":{"kind":"app","version":"1.1.94"},
         "uses":[{"destinationId":"current","printerId":"p1s","printer":"P1S","mcpId":"mcp-a","kind":"app","version":"1.1.94","canMove":false},
                 {"destinationId":"lan","printerId":"p1s","printer":"P1S","mcpId":"mcp-b","kind":"checkout","version":"1.1.80","canMove":true}]}
        """#
        let row = try JSONDecoder().decode(MCPPackageCopies.self, from: Data(json.utf8)).row()
        XCTAssertEqual(row.usedBy, "Used by P1S")
        XCTAssertEqual(row.others.map(\.words), ["P1S also runs your own copy (1.1.80)"])
        XCTAssertEqual(row.others.first?.accessibilityLabel, "Use Counterpart’s bambu-printer-mcp for P1S instead of your own copy (1.1.80)")
    }
}
