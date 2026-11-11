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

    /// Review F2 (Nov 10): a project's printer saved under its other MCP's id is the same printer. The Mac app's
    /// `ObjectsModel.printer(for:)` calls this; only the Xcode scheme compiles that file, so the member is tested here.
    func testCatalogResolvesAPrinterSavedUnderItsOtherMCPsId() throws {
        let catalog = try JSONDecoder().decode(PrinterCatalog.self, from: Data("""
        {"defaultDestinationId":"other","destinations":[
          {"id":"through-bambu","name":"Printer","backend":"bambu-printer-mcp","aliases":["old"],
           "mcps":[{"backend":"bambu-printer-mcp","destinationId":"through-bambu"},{"backend":"mcp-3d-printer-server","destinationId":"through-generic"}]},
          {"id":"other","name":"Printer","backend":"test"}
        ]}
        """.utf8))
        XCTAssertEqual(catalog.resolved("through-generic")?.id, "through-bambu", "its id through the other MCP")
        XCTAssertEqual(catalog.resolved("through-bambu")?.id, "through-bambu")
        XCTAssertEqual(catalog.resolved("old")?.id, "through-bambu", "a recorded alias")
        XCTAssertNil(catalog.resolved("gone"), "an id nothing lists is not the default printer: the caller decides")
        XCTAssertNil(catalog.resolved(nil))
    }

    /// The kinds' fields as the MCPs declare them (bambu-printer-mcp's Bambu kind, mcp-3d-printer-server's OctoPrint), and a
    /// made-up kind with the same roles under other names: the form knows each only by its fields.
    private func setupOptions() throws -> PrinterSetupOptions {
        try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[
          {"printerType":"bambu","label":"Bambu Lab","backends":["bambu-printer-mcp","mcp-3d-printer-server"],"serial":true,"checkCamera":["bambu-printer-mcp"],
           "fields":[{"name":"host","env":"PRINTER_HOST","label":"Address","required":true},{"name":"serial","env":"BAMBU_SERIAL","label":"Serial number","required":true},
                     {"name":"model","env":"BAMBU_MODEL","label":"Model","required":true},{"name":"secret","env":"BAMBU_TOKEN","label":"Access code","required":true}]},
          {"printerType":"octoprint","label":"OctoPrint","backends":["mcp-3d-printer-server"],"serial":false,"checkCamera":[],
           "fields":[{"name":"host","env":"PRINTER_HOST","label":"Address","required":true},{"name":"port","env":"PRINTER_PORT","label":"Port","required":false},
                     {"name":"secret","env":"API_KEY","label":"API key","required":true}]},
          {"printerType":"acme","label":"Acme","backends":["mcp-3d-printer-server"],"serial":true,"checkCamera":["mcp-3d-printer-server"],
           "fields":[{"name":"host","env":"PRINTER_HOST","label":"Address","required":true},{"name":"serial","env":"ACME_SN","label":"Serial","required":true},
                     {"name":"model","env":"ACME_KIND","label":"Kind","required":true}]}],
         "models":{}}
        """.utf8))
    }

    func testFormSendsOnlyTheFieldsItsBrandUses() throws {
        let options = try setupOptions()
        let type = { (kind: String) in options.types.first { $0.printerType == kind } }
        var bambu = PrinterForm()
        XCTAssertEqual([bambu.backend, bambu.printerType], ["", ""], "the sheet sets both from the MCPs' own list")
        bambu.backend = "bambu-printer-mcp"; bambu.printerType = "bambu"
        bambu.host = " 192.168.1.40 "; bambu.serial = "01P00A123456789"; bambu.model = "p1s"; bambu.secret = "12345678"; bambu.port = "8883"
        XCTAssertEqual(bambu.lacks(type("bambu")).map(\.name), [])
        bambu.keepFields(of: type("bambu"))
        XCTAssertEqual(bambu.json, .object(["backend": .string("bambu-printer-mcp"), "printerType": .string("bambu"), "host": .string("192.168.1.40"),
                                            "serial": .string("01P00A123456789"), "model": .string("p1s"), "secret": .string("12345678")]),
                       "no port: the Bambu kind's MCP declares none")
        var octo = PrinterForm()
        octo.backend = "mcp-3d-printer-server"; octo.printerType = "octoprint"; octo.host = "octopi.local"; octo.port = "80"; octo.serial = "ignored"; octo.model = "p1s"
        octo.keepFields(of: type("octoprint"))
        XCTAssertEqual(octo.json, .object(["backend": .string("mcp-3d-printer-server"), "printerType": .string("octoprint"), "host": .string("octopi.local"), "port": .string("80")]))
        // Another kind with a serial and a model under its own names: sent the same way, so nothing keys on "bambu".
        var acme = PrinterForm()
        acme.backend = "mcp-3d-printer-server"; acme.printerType = "acme"; acme.host = "192.0.2.7"; acme.port = "1"
        XCTAssertEqual(acme.lacks(type("acme")).map(\.label), ["Serial", "Kind"], "its required fields, in its MCP's words and order")
        acme.serial = " sn-1 "; acme.model = "k2"
        acme.keepFields(of: type("acme"))
        XCTAssertEqual(acme.json, .object(["backend": .string("mcp-3d-printer-server"), "printerType": .string("acme"), "host": .string("192.0.2.7"),
                                           "serial": .string("sn-1"), "model": .string("k2")]))
        // Check asks for a camera picture where the chosen MCP says camera_snapshot reads that kind, by its name nowhere.
        XCTAssertEqual(type("bambu")?.checksCamera("bambu-printer-mcp"), true)
        XCTAssertEqual(type("bambu")?.checksCamera("mcp-3d-printer-server"), false)
        XCTAssertEqual(type("octoprint")?.checksCamera("mcp-3d-printer-server"), false)
        XCTAssertEqual(type("acme")?.checksCamera("mcp-3d-printer-server"), true)
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
        let kinds = try setupOptions()
        XCTAssertTrue(candidate.needsModel(kinds), "by the kind's own model field")
        XCTAssertEqual(candidate.modelSetting(kinds), "BAMBU_MODEL")
        XCTAssertNil(candidate.route)
        var form = PrinterForm(folder: "/x"); form.model = "p1s"
        XCTAssertEqual(form.json, .object(["folder": .string("/x"), "model": .string("p1s")]))
        // Settings → Printers names the model's variable and the copied route by the companion's words, never by its own.
        let printer = try JSONDecoder().decode(PrinterDestination.self, from: Data("""
        {"id":"counterpart-1","name":"P1S","backend":"mcp-3d-printer-server","source":"mcp-profile","origin":"counterpart",
         "incomplete":{"missing":["BAMBU_MODEL"],"fill":{"BAMBU_MODEL":"p1s"},"modelSetting":"BAMBU_MODEL","route":true}}
        """.utf8))
        XCTAssertEqual(printer.incomplete, .init(missing: ["BAMBU_MODEL"], fill: ["BAMBU_MODEL": "p1s"], modelSetting: "BAMBU_MODEL", route: true))
        XCTAssertEqual(printer.incomplete?.needsModel, false, "filled")
        XCTAssertEqual(PrinterDestination.Incomplete(missing: ["ACME_KIND"], modelSetting: "ACME_KIND").needsModel, true)
        XCTAssertEqual(PrinterDestination.Incomplete(missing: ["BAMBU_MODEL"]).needsModel, false, "no model setting from an older companion: nothing asked")
        XCTAssertEqual(ControlClient.timeout(for: "printers.completeSettings"), 40)
    }
}

private actor Asked {
    var sessions: [String] = []
    var count: Int { sessions.count }
    func add(_ field: String, _ session: String?) { sessions.append("\(field):\(session ?? "-")") }
}
@MainActor private final class Shown { var steps: [ObtainStep] = [] }
