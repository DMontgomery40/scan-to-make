import XCTest
import Foundation
@testable import ControlKit
import func CounterpartKit.obtainSetupValue

final class PrinterSetupTests: XCTestCase {
    func testCatalogResolvesRecordedAliasesFromTheWireAndKeepsOtherPrintersSeparate() throws {
        let catalog = try JSONDecoder().decode(PrinterCatalog.self, from: Data("""
        {"defaultDestinationId":"winner","destinations":[
          {"id":"winner","name":"Printer","backend":"test","aliases":["old-duplicate","previous-mcp"]},
          {"id":"other","name":"Printer","backend":"test"}
        ]}
        """.utf8))
        XCTAssertEqual(catalog.destination(for: "old-duplicate")?.id, "winner")
        XCTAssertEqual(catalog.destination(for: "previous-mcp")?.id, "winner")
        XCTAssertEqual(catalog.destination(for: "winner")?.id, "winner")
        XCTAssertEqual(catalog.destination(for: "other")?.id, "other")
        XCTAssertNil(catalog.destination(for: "other")?.aliases)
        XCTAssertNil(catalog.destination(for: "unknown"))
        XCTAssertNil(catalog.destination(for: "Printer"), "A matching display name is not identity evidence")
    }

    func testFormSendsOnlyTheFieldsItsBrandUses() throws {
        var bambu = PrinterForm()
        bambu.host = " 192.168.1.40 "; bambu.serial = "01P00A123456789"; bambu.model = "p1s"; bambu.secret = "12345678"
        XCTAssertEqual(bambu.json, .object(["backend": .string("bambu-printer-mcp"), "printerType": .string("bambu"), "host": .string("192.168.1.40"),
                                            "serial": .string("01P00A123456789"), "model": .string("p1s"), "secret": .string("12345678")]))
        var octo = PrinterForm()
        octo.backend = "mcp-3d-printer-server"; octo.printerType = "octoprint"; octo.host = "octopi.local"; octo.port = "80"; octo.serial = "ignored"; octo.model = "p1s"
        XCTAssertEqual(octo.json, .object(["backend": .string("mcp-3d-printer-server"), "printerType": .string("octoprint"), "host": .string("octopi.local"), "port": .string("80")]))
        XCTAssertEqual(PrinterForm(folder: "/Users/someone/mcp-3D-printer-server").json, .object(["folder": .string("/Users/someone/mcp-3D-printer-server")]))
    }

    /// OctoPrint's key approved in OctoPrint (mcp-3d-printer-server 1.2.51+): the button is the MCP's, the steps run
    /// until the person answers, and only the field's value comes back.
    @MainActor func testObtainRunsTheMCPsApprovalUntilAnswered() async throws {
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[{"printerType":"octoprint","label":"OctoPrint","backends":["mcp-3d-printer-server"],"serial":false,
          "secret":{"label":"API key","required":true,"obtain":{"label":"Approve in OctoPrint","hint":"OctoPrint asks you to allow this app in its web page","backends":["mcp-3d-printer-server"]}}}],"models":{}}
        """.utf8))
        var form = PrinterForm()
        form.backend = "mcp-3d-printer-server"; form.printerType = "octoprint"; form.host = " octopi.local "
        let control = try XCTUnwrap(ObtainControl(options: options, form: form))
        XCTAssertEqual(control.label, "Approve in OctoPrint")
        var other = form; other.backend = "bambu-printer-mcp"
        XCTAssertNil(ObtainControl(options: options, form: other), "only the MCP that declares it")

        let answers = [ObtainStep(session: "s", status: "pending", message: "Click Allow.", approveUrl: "http://octopi.local/plugin/appkeys/auth/t"),
                       ObtainStep(session: "s", status: "pending", message: "Click Allow.", approveUrl: "javascript:alert(1)"),
                       ObtainStep(status: "approved", message: "Allowed.", value: "KEY")]
        let asked = Asked()
        let shown = Shown()
        let last = try await obtainSetupValue(form, field: control.field, step: { _, field, session in
            await asked.add(field, session); return answers[await asked.count - 1]
        }, shown: { shown.steps.append($0) })
        XCTAssertEqual(last.value, "KEY")
        let sessions = await asked.sessions
        XCTAssertEqual(sessions, ["secret:-", "secret:s", "secret:s"])
        XCTAssertEqual(shown.steps.map(\.status), ["pending", "pending", "approved"])
        XCTAssertEqual(answers[0].approvalPage?.host, "octopi.local")
        XCTAssertNil(answers[1].approvalPage, "only an http or https page opens")
    }

    func testDiscoveryAndPrinterChoicesDecode() throws {
        let discovery = try JSONDecoder().decode(PrinterDiscovery.self, from: Data("""
        {"found":[{"id":"folder:/Users/someone/mcp-3D-printer-server","source":"folder","name":"Bambu Lab P1S via mcp-3D-printer-server","backend":"mcp-3d-printer-server",
          "printerType":"bambu","host":"192.168.1.40","serial":"01P00A123456789","model":"p1s","folder":"/Users/someone/mcp-3D-printer-server","added":false}],
         "network":"complete","options":{"types":[{"printerType":"bambu","label":"Bambu Lab","backends":["bambu-printer-mcp","mcp-3d-printer-server"],"serial":true,
          "secret":{"label":"Access code","hint":"On the printer: Settings → WLAN → Access Code","required":true}}],"models":{"bambu-printer-mcp":[{"value":"p1s","label":"P1S"}]}}}
        """.utf8))
        XCTAssertEqual(discovery.found.first?.folder, "/Users/someone/mcp-3D-printer-server")
        XCTAssertEqual(discovery.options.types.first?.secret?.label, "Access code")
        XCTAssertEqual(discovery.options.models["bambu-printer-mcp"]?.first?.label, "P1S")
        let printer = try JSONDecoder().decode(PrinterDestination.self, from: Data("""
        {"id":"counterpart-1","name":"P1S","backend":"mcp-3d-printer-server","source":"mcp-profile","origin":"counterpart","folder":"/x",
         "mcps":[{"backend":"mcp-3d-printer-server","destinationId":"counterpart-1"},{"backend":"bambu-printer-mcp","destinationId":"current"}]}
        """.utf8))
        XCTAssertEqual(printer.mcps?.map(\.backend), ["mcp-3d-printer-server", "bambu-printer-mcp"])
        XCTAssertEqual(printer.folder, "/x")
        XCTAssertEqual(ControlClient.timeout(for: "printers.check"), 70, "Check runs for up to 60 s on the companion")
    }

    /// PRD §8.0 item 6: the slicer settings and update notes come from the MCPs (`counterpart_setup_fields`), and the form sends them.
    func testTheSlicerSettingsTheMCPDeclaresReachTheForm() throws {
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[],"models":{},"serialModels":{"01P":"p1s"},"updates":[{"package":"mcp-3d-printer-server","message":"Update mcp-3D-printer-server in Settings → Printers so Counterpart can set up printers with it."}],
         "slicer":{"bambu-printer-mcp":{"type":"bambustudio","path":"BambuStudio","found":false,"profilesFound":false,"fields":[
           {"name":"slicer","env":"SLICER_TYPE","label":"Slicer","required":false,"choices":[{"value":"bambustudio","label":"Bambu Studio"}]},
           {"name":"slicer-path","env":"SLICER_PATH","label":"Bambu Studio app","input":"path","required":true,"hint":"Bambu Studio isn't at BambuStudio. Install it, or choose where it is."},
           {"name":"profiles","env":"BAMBU_PROFILES_ROOT","label":"Bambu profiles folder","input":"path","required":true}]}}}
        """.utf8))
        let slicer = try XCTUnwrap(options.slicer?["bambu-printer-mcp"])
        XCTAssertEqual(slicer.field("slicer-path")?.required, true)
        XCTAssertEqual(slicer.field("slicer-path")?.hint, "Bambu Studio isn't at BambuStudio. Install it, or choose where it is.")
        XCTAssertEqual(options.updates?.first?.package, "mcp-3d-printer-server")
        var form = PrinterForm(); form.host = "192.168.1.40"; form.slicer = "orcaslicer"; form.slicerPath = "/opt/bambu/bin/bambu-studio"
        guard case .object(let json) = form.json else { return XCTFail("an object") }
        XCTAssertEqual(json["slicer"], .string("orcaslicer"), "the slicer chosen from the MCP's list goes with its app")
        XCTAssertEqual(json["slicerPath"], .string("/opt/bambu/bin/bambu-studio"))
        XCTAssertNil(json["profiles"], "a setting left empty isn't sent")
        XCTAssertEqual(options.model(forSerial: "01P00A1"), "p1s", "the prefix length is the MCP table's own")
    }

    func testMissingModelIsFilledFromTheSerialOrAsked() throws {
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[],"models":{"mcp-3d-printer-server":[{"value":"p1s","label":"P1S"}]},"serialModels":{"01P":"p1s","039":"a1"}}
        """.utf8))
        XCTAssertEqual(options.model(forSerial: " 01p00a123456789"), "p1s")
        XCTAssertNil(options.model(forSerial: "ZZZ"))
        let candidate = try JSONDecoder().decode(PrinterCandidate.self, from: Data("""
        {"id":"folder:/x","source":"folder","name":"P","backend":"mcp-3d-printer-server","printerType":"bambu","folder":"/x","added":false,"missing":["BAMBU_TOKEN","BAMBU_MODEL"],"fill":{}}
        """.utf8))
        XCTAssertTrue(candidate.needsModel)
        var form = PrinterForm(folder: "/x"); form.model = "p1s"
        XCTAssertEqual(form.json, .object(["folder": .string("/x"), "model": .string("p1s")]))
        let printer = try JSONDecoder().decode(PrinterDestination.self, from: Data("""
        {"id":"counterpart-1","name":"P1S","backend":"mcp-3d-printer-server","source":"mcp-profile","origin":"counterpart","incomplete":{"missing":["BAMBU_MODEL"],"fill":{"BAMBU_MODEL":"p1s"}}}
        """.utf8))
        XCTAssertEqual(printer.incomplete, .init(missing: ["BAMBU_MODEL"], fill: ["BAMBU_MODEL": "p1s"]))
        XCTAssertEqual(ControlClient.timeout(for: "printers.completeSettings"), 40)
    }
}

private actor Asked {
    var sessions: [String] = []
    var count: Int { sessions.count }
    func add(_ field: String, _ session: String?) { sessions.append("\(field):\(session ?? "-")") }
}
@MainActor private final class Shown { var steps: [ObtainStep] = [] }
