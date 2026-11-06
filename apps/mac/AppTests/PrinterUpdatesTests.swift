import XCTest
import Darwin

/// PRD §8.10: Update asks the companion, which updates the install its own way and reports with `mcp.update.*`.
@MainActor final class PrinterUpdatesTests: XCTestCase {
    func testPackageShowsTheProfileCopySeparatelyFromTheAppCopy() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf:root.appendingPathComponent("packages/contracts/fixtures/mcp-profile-copies.json"))
        let package = try JSONDecoder().decode(PrinterMcpPackage.self, from:data)
        let use = try XCTUnwrap(package.uses?.first)
        XCTAssertEqual(use.words, "Bambu Lab P1S uses your copy at /home/ada/mcp-3D-printer-server (1.2.25).")
        XCTAssertEqual(package.appCopy?.version, "1.2.45")
        XCTAssertTrue(use.canMove)
        XCTAssertNotEqual(use.mcpId, package.appMcpId)
    }

    /// Settings → Printers follow-up (Nov 6): David's two P1S profiles each showed "Move Bambu Lab P1S to Counterpart's
    /// updated copy", ordered by id. Each Move now names its MCP and copy, in the order the uses are listed, and a stale
    /// copy (printers/bambu-1.1.46 behind ssh) says it's older than Counterpart's.
    func testTwoProfilesOfOnePrinterGetMovesThatReadApartInScreenOrder() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        struct Reply: Decodable { let packages: [PrinterMcpPackage] }
        let packages = try JSONDecoder().decode(Reply.self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/mcp-printer-moves.json"))).packages
        let titles = packages.flatMap { $0.moves.map(\.title) }
        XCTAssertEqual(titles.count, 2)
        XCTAssertEqual(Set(titles).count, 2, "two P1S Moves never read the same")
        XCTAssertTrue(titles[0].contains("bambu-printer-mcp") && titles[0].contains("bambu-1.1.46"), titles[0])
        XCTAssertTrue(titles[1].contains("mcp-3D-printer-server") && titles[1].contains("~/mcp-3D-printer-server"), titles[1])
        for package in packages { XCTAssertEqual(package.moves.map(\.mcpId), (package.uses ?? []).filter(\.canMove).map(\.mcpId)) }
        let stale = try XCTUnwrap(packages.first?.uses?.first)
        XCTAssertTrue(stale.words.contains("older than Counterpart’s copy (1.1.69)"), stale.words)
        XCTAssertEqual(packages[0].updateLabel(failed: false), "Update bambu-printer-mcp to 1.1.69")
    }

    /// A companion from before Nov 6 sends no `moves` or `words`: the Mac names the MCP and copy itself, still in listed order.
    func testAnOlderCompanionsMovesStillNameTheirCopyInListedOrder() throws {
        let json = #"""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","description":"d","installed":true,"appMcpId":"mcp-0000000000000000","installs":[],
         "uses":[{"destinationId":"z","printer":"Bambu Lab P1S","mcpId":"mcp-ffff000000000000","kind":"app","path":"/x/printers/bambu-1.1.46","version":"1.1.65","canMove":true},
                 {"destinationId":"a","printer":"Bambu Lab P1S","mcpId":"mcp-0000000000000001","kind":"checkout","path":"/x/bambu-printer-mcp","version":"1.1.60","canMove":true}]}
        """#
        let package = try JSONDecoder().decode(PrinterMcpPackage.self, from: Data(json.utf8))
        XCTAssertEqual(package.moves.map(\.mcpId), ["mcp-ffff000000000000", "mcp-0000000000000001"], "listed order, not sorted ids")
        XCTAssertEqual(package.moves.map(\.title), ["Move Bambu Lab P1S (bambu-printer-mcp, Counterpart’s older copy at /x/printers/bambu-1.1.46) to Counterpart’s updated copy",
                                                     "Move Bambu Lab P1S (bambu-printer-mcp, your copy at /x/bambu-printer-mcp) to Counterpart’s updated copy"])
        XCTAssertEqual(package.uses?.first?.words, "Bambu Lab P1S uses Counterpart’s older copy at /x/printers/bambu-1.1.46 (1.1.65).")
    }

    private func event(_ type: String, _ data: String) throws -> CounterpartEvent {
        try JSONDecoder().decode(CounterpartEvent.self, from: Data(#"""
        {"seq":1,"id":"e","at":"2026-11-01T10:00:00Z","type":"\#(type)","title":"t","body":"b","notify":"passive","data":\#(data)}
        """#.utf8))
    }

    /// Mac, Nov 5: mcp-3D was only a hand-built checkout no printer used, 1.2.25 with 1.2.35 published, and Settings
    /// offered neither Update nor Download. Update now installs the latest as Counterpart's own copy (#320's path).
    func testAnInstalledMcpNoPrinterUsesOffersUpdateWhenANewerVersionIsPublished() {
        let checkout = PrinterMcpPackage(package: "mcp-3d-printer-server", label: "mcp-3D-printer-server", description: "d", installed: true,
                                         version: "1.2.25", latestVersion: "1.2.35", appMcpId: "app-generic")
        XCTAssertTrue(checkout.offersUpdate)
        let current = PrinterMcpPackage(package: "mcp-3d-printer-server", label: "l", description: "d", installed: true,
                                        version: "1.2.35", latestVersion: "1.2.35", appMcpId: "app-generic")
        XCTAssertFalse(current.offersUpdate, "already the latest")
        let unknown = PrinterMcpPackage(package: "mcp-3d-printer-server", label: "l", description: "d", installed: true,
                                        version: "1.2.25", appMcpId: "app-generic")
        XCTAssertFalse(unknown.offersUpdate, "npm not asked yet")
        let missing = PrinterMcpPackage(package: "mcp-3d-printer-server", label: "l", description: "d", installed: false,
                                        latestVersion: "1.2.35", appMcpId: "app-generic")
        XCTAssertFalse(missing.offersUpdate, "not installed: Download, not Update")
    }

    func testTheEventsCarryAnUpdateFromStartToItsResult() throws {
        let updates = PrinterUpdates()
        XCTAssertFalse(updates.apply(try event("mcp.update.started", #"{"mcpId":"bambu","fromVersion":"1.4.2","toVersion":"1.5.0"}"#)))
        XCTAssertEqual(updates.status["bambu"], .updating(from: "1.4.2", to: "1.5.0"))
        XCTAssertEqual(updates.status["bambu"]?.words, "Updating to 1.5.0…")
        XCTAssertTrue(updates.status["bambu"]?.busy == true)
        XCTAssertFalse(updates.apply(try event("mcp.update.waiting", #"{"mcpId":"bambu"}"#)))
        XCTAssertEqual(updates.status["bambu"]?.words, "Updates as soon as Counterpart finishes its work on this printer.")
        XCTAssertTrue(updates.apply(try event("mcp.update.done", #"{"mcpId":"bambu","toVersion":"1.5.0"}"#)), "a finished update reads the printers again")
        XCTAssertEqual(updates.status["bambu"]?.words, "Updated to 1.5.0.")
        XCTAssertFalse(updates.apply(try event("mcp.update.failed", #"{"mcpId":"generic","log":"npm ERR! 404"}"#)))
        XCTAssertEqual(updates.status["generic"], .failed(log: "npm ERR! 404"), "the log's tail goes with a failure")
        XCTAssertFalse(updates.apply(try event("print.done", #"{"progress":100}"#)))
        XCTAssertFalse(updates.apply(try event("mcp.update.done", #"{}"#)), "an update event without its install changes nothing")
    }

    /// Nov 6, David: "mcps won't update they just spin forever". Update did reach the companion; a print was running, so
    /// it answered `waiting`, and the row drew a spinner for the hours the print had left. Pressing Update sends
    /// `printers.updateMcp` for that install, and waiting reads as the sentence, with no spinner.
    func testPressingUpdateSendsTheRequestAndWaitingForAPrintIsASentenceNotASpinner() async throws {
        let companion = try OneRequestSocket(reply: ["update": ["mcpId": "mcp-c9d06fd7c405328e", "state": "waiting", "fromVersion": "1.1.73", "toVersion": "1.1.76"]])
        let updates = PrinterUpdates()
        await updates.update("mcp-c9d06fd7c405328e", fresh: false, socket: companion.path)
        let request = try XCTUnwrap(companion.request)
        XCTAssertEqual(request["method"] as? String, "printers.updateMcp")
        XCTAssertEqual((request["params"] as? [String: Any])?["mcpId"] as? String, "mcp-c9d06fd7c405328e")
        XCTAssertNil((request["params"] as? [String: Any])?["fresh"], "Update, not a fresh copy")
        let status = try XCTUnwrap(updates.status["mcp-c9d06fd7c405328e"])
        XCTAssertEqual(status, .waiting)
        XCTAssertEqual(status.words, "Updates as soon as Counterpart finishes its work on this printer.")
        XCTAssertFalse(status.spinning, "a print can take hours: waiting never spins")
        XCTAssertTrue(status.busy, "Update isn't offered again while it waits")
        XCTAssertTrue(McpUpdateStatus.updating(from: "1.1.73", to: "1.1.76").spinning, "an update under way does")
        for finished in [McpUpdateStatus.updated(version: "1.1.76"), .current, .failed(log: nil), .problem("x"), .unresolved(found: "x")] {
            XCTAssertFalse(finished.spinning, "\(finished)")
        }
    }

    /// Nov 6, David: "now i only see one to update and missing the other one". printers.mcps timed out once, and the
    /// rows fell back to the printer list, where a P1S set up in both MCPs is one printer: mcp-3D-printer-server had no row.
    func testEveryMcpAPrinterIsSetUpInHasARowEvenWhenTheMcpListCantBeRead() {
        let p1s = PrinterDestination(id: "current", name: "Bambu Lab P1S", backend: "bambu-printer-mcp",
                                     capabilities: PrinterCapabilities(server: .init(name: "bambu-printer-mcp", version: "1.1.73"),
                                                                       update: .init(message: "", package: "bambu-printer-mcp", command: nil, latestVersion: "1.1.76")),
                                     mcpId: "mcp-812bcaf2d1ff2948",
                                     mcps: [.init(backend: "bambu-printer-mcp", destinationId: "current"),
                                            .init(backend: "mcp-3d-printer-server", destinationId: "counterpart-a07c6f7d")])
        let rows = PrinterMCP.list([p1s])
        XCTAssertEqual(rows.map(\.name), ["bambu-printer-mcp", "mcp-3D-printer-server"])
        XCTAssertTrue(rows[0].updateAvailable, "the MCP prints go through keeps its Update")
        XCTAssertEqual(rows[1].printers, ["Bambu Lab P1S"])
        let alone = PrinterDestination(id: "a1", name: "A1", backend: "bambu-printer-mcp", mcpId: "m",
                                       mcps: [.init(backend: "bambu-printer-mcp", destinationId: "a1")])
        XCTAssertEqual(PrinterMCP.list([alone]).count, 1, "a printer in one MCP lists just that one")
    }

    /// The companion restarted with both MCPs current, and no event said so: reading the list again ends the stale state.
    func testReadingTheMcpListAgainEndsAWaitOrUpdateThatIsAlreadyCurrent() {
        let updates = PrinterUpdates()
        updates.set("app-bambu", .waiting); updates.set("use-bambu", .updating(from: "1.1.73", to: "1.1.76"))
        updates.set("app-generic", .waiting); updates.set("failed", .failed(log: "x"))
        let current = PrinterMcpPackage(package: "bambu-printer-mcp", label: "bambu-printer-mcp", description: "d", installed: true,
                                        version: "1.1.76", latestVersion: "1.1.76", appMcpId: "app-bambu")
        let behind = PrinterMcpPackage(package: "mcp-3d-printer-server", label: "mcp-3D-printer-server", description: "d", installed: true,
                                       version: "1.2.53", latestVersion: "1.2.56", appMcpId: "app-generic")
        updates.settle([current, behind])
        XCTAssertNil(updates.status["app-bambu"])
        XCTAssertEqual(updates.status["app-generic"], .waiting, "one that still has an update to make keeps its state")
        XCTAssertEqual(updates.status["failed"], .failed(log: "x"))
    }

    func testTheAnswerSaysWhetherItStartedWaitsOrNeedsAFreshCopy() {
        XCTAssertEqual(McpUpdateStatus(McpUpdate(state: "started", mcpId: "m", fromVersion: "1.0.0", toVersion: "1.1.0")), .updating(from: "1.0.0", to: "1.1.0"))
        XCTAssertEqual(McpUpdateStatus(McpUpdate(state: "waiting", mcpId: "m")), .waiting)
        XCTAssertEqual(McpUpdateStatus(McpUpdate(state: "current", mcpId: "m")), .current)
        XCTAssertEqual(McpUpdateStatus(McpUpdate(state: "unresolved", mcpId: "m", found: "It runs over SSH on 127.0.0.1, and the key's forced command isn't readable.")),
                       .unresolved(found: "It runs over SSH on 127.0.0.1, and the key's forced command isn't readable."))
        XCTAssertEqual(McpUpdateStatus(McpUpdate(state: "unresolved", mcpId: "m")), .unresolved(found: "Counterpart couldn’t tell how this copy is installed."))
    }

    func testUpdateIsOfferedOnlyWhenANewerVersionIsOut() {
        XCTAssertTrue(McpUpdateStatus.newer(installed: "1.4.2", latest: "1.5.0"))
        XCTAssertTrue(McpUpdateStatus.newer(installed: "1.9.0", latest: "1.10.0"), "numeric, not alphabetical")
        XCTAssertFalse(McpUpdateStatus.newer(installed: "1.5.0", latest: "1.5.0"))
        XCTAssertFalse(McpUpdateStatus.newer(installed: "2.0.0", latest: "1.9.9"))
        XCTAssertFalse(McpUpdateStatus.newer(installed: nil, latest: "1.0.0"), "an unknown installed version isn't called old")
        let printer = PrinterDestination(id: "p", name: "P1S", backend: "bambu", capabilities: PrinterCapabilities(
            server: .init(name: "bambu-printer-mcp", version: "1.4.2"),
            update: .init(message: "", package: "bambu-printer-mcp", command: nil, latestVersion: "1.5.0")), mcpId: "bambu")
        let mcp = PrinterMCP.list([printer])[0]
        XCTAssertEqual(mcp.mcpId, "bambu")
        XCTAssertTrue(mcp.updateAvailable)
    }

    func testTwoInstallsNeverShareARow() {
        func printer(_ id: String, mcp: String?) -> PrinterDestination {
            PrinterDestination(id: id, name: id, backend: "mcp-3d-printer-server", origin: "claude-code",
                               capabilities: PrinterCapabilities(server: .init(name: "mcp-3d-printer-server", version: "1.2.9")), mcpId: mcp)
        }
        let rows = PrinterMCP.list([printer("a", mcp: "one"), printer("b", mcp: "two"), printer("c", mcp: "one")])
        XCTAssertEqual(rows.map(\.mcpId).sorted { ($0 ?? "") < ($1 ?? "") }, ["one", "two"], "same package, origin and version, but two installs")
        XCTAssertEqual(rows.first { $0.mcpId == "one" }?.printers.sorted(), ["a", "c"])
        XCTAssertEqual(PrinterMCP.list([printer("a", mcp: nil), printer("b", mcp: nil)]).count, 1, "an older companion groups as before")
    }
}

/// A companion control socket that answers one request, and keeps that request.
private final class OneRequestSocket: @unchecked Sendable {
    let path = "/tmp/stm-update-\(UUID().uuidString.prefix(8)).sock"
    private let descriptor: Int32
    private let lock = NSLock()
    private var received: [String: Any]?
    private let done = DispatchSemaphore(value: 0)
    var request: [String: Any]? { _ = done.wait(timeout: .now() + 5); return lock.withLock { received } }

    init(reply: [String: Any]) throws {
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = path.utf8CString
        withUnsafeMutablePointer(to: &address.sun_path) { target in
            target.withMemoryRebound(to: CChar.self, capacity: 104) { pointer in bytes.withUnsafeBufferPointer { pointer.update(from: $0.baseAddress!, count: $0.count) } }
        }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard descriptor >= 0, bound == 0, listen(descriptor, 4) == 0 else { throw NSError(domain: "OneRequestSocket", code: 1) }
        let fd = descriptor
        DispatchQueue.global().async { [self] in
            defer { done.signal() }
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            defer { close(client) }
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while !data.contains(10) {
                let count = read(client, &buffer, buffer.count)
                if count <= 0 { return }
                data.append(contentsOf: buffer.prefix(count))
            }
            guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            lock.withLock { received = request }
            guard var answer = try? JSONSerialization.data(withJSONObject: ["v": 1, "id": request["id"] ?? NSNull(), "result": reply]) else { return }
            answer.append(10)
            _ = answer.withUnsafeBytes { write(client, $0.baseAddress!, $0.count) }
            shutdown(client, SHUT_WR)
            while read(client, &buffer, buffer.count) > 0 {}
        }
    }
    deinit { shutdown(descriptor, SHUT_RDWR); close(descriptor); unlink(path) }
}
