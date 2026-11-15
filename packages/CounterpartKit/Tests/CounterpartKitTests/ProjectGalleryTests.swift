import Foundation
import XCTest
@testable import CounterpartKit

/// PRD §5.4 Pictures: the gallery is derived from the project's data, the same on every client
/// (packages/contracts/fixtures/project-gallery.json, also read by Android and Linux).
final class ProjectGalleryTests: XCTestCase {
    func testEveryClientDerivesTheSamePicturesFromTheSharedCases() throws {
        let data = try Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/project-gallery.json"))
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try XCTUnwrap(doc["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 8)
        for item in cases {
            let name = item["name"] as! String
            let project = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: item["project"]!))
            let expected = item["entries"] as! [[String: Any]]
            let gallery = ProjectGallery(project: project)
            XCTAssertEqual(gallery.entries.map(\.id), expected.map { $0["id"] as! String }, name)
            if let photo = item["photoPicture"] as? String { XCTAssertEqual(project.photoPicture, photo, name) }
            if let locate = item["canLocate"] as? Bool { XCTAssertEqual(project.canLocate, locate, name) }
            for (entry, want) in zip(gallery.entries, expected) {
                XCTAssertEqual(entry.kind.rawValue, want["kind"] as? String, name)
                XCTAssertEqual(entry.label, want["label"] as? String, name)
                XCTAssertEqual(entry.measures, want["measures"] as? String, name)
                XCTAssertEqual(entry.sizeMm, want["sizeMm"] as? [Double], name)
                XCTAssertEqual(entry.photos, (want["photos"] as? [String]) ?? [], name)
                switch entry.colour {
                case .neutral: XCTAssertEqual(want["colour"] as? String, "neutral", name)
                case .own: XCTAssertEqual(want["colour"] as? String, "own", name)
                case .spool(let hex): XCTAssertEqual(want["colour"] as? String, hex, name)
                }
                if let still = want["still"] as? String {
                    let got: String = switch project.still(for: entry) {
                    case .picture(let path): path
                    case .waiting: "waiting"
                    case .notAvailable: "not available"
                    }
                    XCTAssertEqual(got, still, "\(name): \(entry.id)'s stage")
                }
                // #840: what the stage's AR opens, the one rule every client derives (null: none).
                XCTAssertTrue(want.keys.contains("ar"), "\(name): \(entry.id) says what its AR opens")
                XCTAssertEqual(entry.ar, want["ar"] as? String, "\(name): \(entry.id)'s AR")
                let drawing = want["drawing"] as! [String: Any]
                switch entry.drawing {
                case .model(let path): XCTAssertEqual(drawing["model"] as? String, path, name)
                case .picture(let path): XCTAssertEqual(drawing["picture"] as? String, path, name)
                case .assembly(let part, let object, let seats):
                    let want = drawing["assembly"] as! [String: Any]
                    XCTAssertEqual(want["part"] as? String, part, name)
                    XCTAssertEqual(want["object"] as? String, object, name)
                    XCTAssertEqual(want["seats"] as? Int, seats.count, name)
                }
            }
        }
    }

    /// #840: the AR rule as a table. Each row is a project as the companion keeps it, and what its first entry's AR opens.
    func testWhetherARIsOfferedAndWhatItOpensIsOneRule() {
        let rows: [(String, [String: Any], String?)] = [
            ("Mic mount: a one-colour STL design", ["state": "confirmed", "current": ["model": "current/model.stl", "renders": []]], "model.stl"),
            ("Pink snap-lid box: a pass's 3MF with its merged mesh listed",
             ["state": "confirmed", "kind": "fit", "current": ["model": "current/model.3mf", "renders": [], "mergedMesh": "current/model.stl"]], "current/model.stl"),
            ("the same 3MF when the Mac lists no merged mesh", ["state": "confirmed", "kind": "fit", "current": ["model": "current/model.3mf", "renders": ["current/renders/1.png"]]], nil),
            ("a merged mesh listed beside another file", ["state": "confirmed", "kind": "fit", "current": ["model": "current/model.3mf", "renders": [], "mergedMesh": "elsewhere/model.stl"]], nil),
            ("Bike-oil bottle holder: a designer's published 3MF plate",
             ["state": "confirmed", "kind": "published", "current": ["model": "original/6c1f-first-plate.3mf", "renders": []]], nil),
            ("a designer's published 3MF that claims a merged mesh", ["state": "confirmed", "kind": "published", "current": ["model": "current/model.3mf", "renders": [], "mergedMesh": "current/model.stl"]], nil),
            ("bag clip: a designer's published STL", ["state": "confirmed", "kind": "published", "current": ["model": "original/111c-BAG CLIP.stl", "renders": []]], "model.stl"),
            ("an earlier design sealed as touched.stl", ["state": "confirmed", "current": ["model": "versions/31cc/touched.stl", "renders": []]], "versions/31cc/touched.stl"),
            ("a result in another format", ["state": "ready", "current": ["model": "current/model.obj", "renders": []]], nil),
            ("a scan alone, Object Capture's USDZ", ["state": "ready", "kind": "fit", "scan": "scan.usdz"], "scan/scan.usdz"),
            ("a scan alone, a handheld STL", ["state": "ready", "kind": "fit", "scan": "scan.stl"], nil),
            ("no result and no scan", ["state": "new"], nil),
            // Review R2 on #843: the scan's AR is the file this phone may fetch, chosen here, never again by the chip.
            ("a 192 MB Mac rebuild with the phone's 9 MB preview beside it: the preview",
             ["state": "ready", "kind": "fit", "scan": "scan.usdz", "scanFiles": [["name": "scan.usdz", "bytes": 191_981_699], ["name": "phone-preview.usdz", "bytes": 9_201_716]]],
             "scan/phone-preview.usdz"),
            ("a 192 MB Mac rebuild alone: none (too large for a phone; its picture says so)",
             ["state": "ready", "kind": "fit", "scan": "scan.usdz", "scanFiles": [["name": "scan.usdz", "bytes": 191_981_699]]], nil),
            ("a 15 MB scan the Mac lists: the scan", ["state": "ready", "kind": "fit", "scan": "scan.usdz", "scanFiles": [["name": "scan.usdz", "bytes": 15_961_620]]], "scan/scan.usdz"),
            ("a listed handheld STL scan: none", ["state": "ready", "kind": "fit", "scan": "scan.stl", "scanFiles": [["name": "scan.stl", "bytes": 1_000]]], nil),
        ]
        for (name, json, want) in rows {
            XCTAssertEqual(ProjectGallery(project: project(json)).first?.ar, want, name)
        }
        let onlyHere = project(["state": "new"])
        XCTAssertEqual(ProjectGallery(project: onlyHere, scanOnThisDevice: true).first?.ar, "scan/scan.usdz", "a scan still only on this phone opens its own file")
    }

    /// #840, the sweep: every combination of missing, extra and odd model, merged mesh, scan, print and plates. The gallery
    /// never stops the app, and the rule holds for each entry: a part offers only an STL it turns, a scan only its own USDZ,
    /// Together and a plate nothing.
    func testEveryCombinationOfProjectMediaDerivesWithoutCrashingAndKeepsTheRule() {
        let models: [String?] = [nil, "current/model.stl", "current/model.3mf", "versions/a/touched.stl", "versions/a/touched.3mf",
                                 "original/x.3mf", "original/x.stl", "current/model.obj", "", "model.STL", "current/"]
        let merged: [String?] = [nil, "current/model.stl", "versions/a/model.stl", "", "../model.stl"]
        let scans: [String?] = [nil, "scan.usdz", "scan.stl", "scan.usdc", "scan.3mf", "", "SCAN.USDZ"]
        let kinds: [String?] = [nil, "fit", "copy", "published", "describe"]
        let prints: [[String: Any]?] = [nil, ["bundleId": "b"], ["bundleId": "b", "spools": [["colour": "#F5547C", "material": "PLA", "name": "Pink"]]],
                                       ["bundleId": "b", "spools": [["colour": "#F5547C"], ["colour": "#000000"]]]]
        let plates: [[[String: Any]]?] = [nil, [], [["id": "p:0", "name": "", "thumbnail": "renders/p0.png"], ["id": "p:1", "name": "Lid"]]]
        // Review R2 on #843: what the Mac lists of the scan, by size: nothing, a small scan, a 192 MB rebuild with and
        // without the phone's preview, the preview alone.
        let listings: [((String) -> [[String: Any]])?] = [nil, { _ in [] }, { [["name": $0, "bytes": 15_961_620]] },
                                                         { [["name": $0, "bytes": 191_981_699]] },
                                                         { [["name": $0, "bytes": 191_981_699], ["name": "phone-preview.usdz", "bytes": 9_201_716]] },
                                                         { _ in [["name": "phone-preview.usdz", "bytes": 9_201_716]] }]
        var checked = 0
        for model in models { for mesh in merged { for scan in scans { for kind in kinds { for print in prints { for plate in plates { for listing in listings {
            var json: [String: Any] = ["state": model == nil ? "new" : "confirmed"]
            if let model {
                var current: [String: Any] = ["model": model, "renders": [], "seats": [["name": "s", "rotationDeg": [0, 0, 0], "translationMm": [0, 0, 0]]]]
                if let mesh { current["mergedMesh"] = mesh }
                json["current"] = current
            }
            if let scan { json["scan"] = scan }
            if let kind { json["kind"] = kind }
            if let print { json["print"] = print }
            if let plate { json["plates"] = plate }
            if let listing, let scan { json["scanFiles"] = listing(scan) }
            let p = project(json)
            for onDevice in [false, true] {
                for entry in ProjectGallery(project: p, scanOnThisDevice: onDevice).entries {
                    switch entry.kind {
                    case .part: if let ar = entry.ar { XCTAssertTrue(ar.lowercased().hasSuffix(".stl"), "\(json): \(ar)"); XCTAssertEqual(entry.drawing, .model(ar)) }
                    case .scan:
                        if let ar = entry.ar {
                            XCTAssertTrue(ar.lowercased().hasSuffix(".usdz"), "\(json): \(ar)")
                            // The file opened is one this phone may fetch, never one over its limit.
                            let listed = p.scanFiles?.first { "scan/\($0.name)" == ar }
                            XCTAssertLessThanOrEqual(listed?.bytes ?? 0, Double(CompanionClient.scanLimit), "\(json): \(ar)")
                        }
                        if p.scanModel(limit: Double(CompanionClient.scanLimit)) == .tooLarge { XCTAssertNil(entry.ar, "\(json): too large, no AR") }
                    case .together, .plate: XCTAssertNil(entry.ar, "\(json)")
                    }
                    XCTAssertEqual(entry.arMesh, entry.kind == .part ? entry.ar : nil)
                }
            }
            _ = p.arTint; _ = p.partMesh; _ = p.mediaVersion
            checked += 1
        } } } } } } }
        XCTAssertEqual(checked, models.count * merged.count * scans.count * kinds.count * prints.count * plates.count * listings.count)
    }

    func testOneEntryShowsAloneAndTheResultShowsFirst() {
        let described = project(["state": "ready", "kind": "fit", "current": ["model": "current/model.stl", "renders": []]])
        XCTAssertEqual(ProjectGallery(project: described).entries.count, 1)
        let scanned = project(["state": "ready", "kind": "fit", "scan": "scan.usdz", "current": ["model": "current/model.stl", "renders": []]])
        XCTAssertEqual(ProjectGallery(project: scanned).first?.kind, .part, "the result first once there is one")
        let waiting = project(["state": "touching-up", "kind": "fit", "scan": "scan.usdz"])
        XCTAssertEqual(ProjectGallery(project: waiting).first?.kind, .scan, "the scan before that")
    }

    func testAScanOnlyThisPhoneHoldsIsStillShown() {
        let draft = project(["state": "new", "kind": "fit"])
        XCTAssertEqual(ProjectGallery(project: draft).entries.count, 0)
        XCTAssertEqual(ProjectGallery(project: draft, scanOnThisDevice: true).entries.map(\.label), ["What you scanned"])
    }

    func testAPartListFeedsTheGalleryThroughItsSeam() {
        // The separate part-list design (a box and its lid, one part changed) feeds `parts`; nothing else changes.
        let box = project(["state": "ready", "kind": "fit", "scan": "scan.usdz", "current": ["model": "current/model.stl", "renders": []]])
        let parts = [PrintablePart(id: "box", label: "Box", drawing: .model("parts/box.stl"), colour: .spool("#FFFFFF")),
                     PrintablePart(id: "lid", label: "Lid", drawing: .model("parts/lid.stl"), colour: .neutral)]
        let gallery = ProjectGallery(project: box, parts: parts)
        XCTAssertEqual(gallery.entries.map(\.label), ["Box", "Lid", "What you scanned"])
        XCTAssertEqual(gallery.entries[0].colour, .spool("#FFFFFF"), "each printable part wears its own spool")
    }

    func testTheSizeChipNamesWhatItMeasures() {
        let entry = ProjectGallery(project: project(["state": "ready", "kind": "fit", "current": ["model": "current/model.stl", "renders": [], "sizeMm": [213, 43, 82]]])).entries[0]
        XCTAssertEqual(entry.sizeText(), "Part · 213 × 43 × 82 mm")
        XCTAssertEqual(entry.sizeText([66.2, 30.6, 150]), "Part · 66.2 × 30.6 × 150 mm")
    }

    /// The stage stays dark for every colour (David, Nov 11: "we just entered light mode without a flashbang
    /// alert"): a dark part is made readable in its material, not by changing the backdrop. Its drawn colour is
    /// lifted to the floor the Mac's still pictures use; colours already above it are drawn as they are.
    func testEveryFilamentColourStaysReadableOnTheDarkStage() throws {
        let data = try Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/project-gallery.json"))
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let drawn = try XCTUnwrap((doc["stage"] as? [String: Any])?["drawnColours"] as? [String: String])
        XCTAssertEqual(StageMaterial.stage, "#22242B", "the one stage, dark")
        for (spool, want) in drawn where spool.hasPrefix("#") {
            XCTAssertEqual(StageMaterial.drawnHex(hex: spool), want, spool)
            let brightness = try XCTUnwrap(StageMaterial.brightness(hex: want), want)
            XCTAssertGreaterThanOrEqual(brightness, StageMaterial.minimumBrightness - 0.01, "\(spool) drawn as \(want) is above the floor")
        }
        XCTAssertEqual(StageMaterial.drawnHex(hex: "#000000"), "#333435", "a true black filament is drawn as charcoal, not a silhouette")
        XCTAssertEqual(StageMaterial.drawnHex(hex: "#5B6579"), "#5B6579", "blue grey is already above the floor")
        XCTAssertNil(StageMaterial.drawnHex(for: .neutral))
        XCTAssertNil(StageMaterial.drawnHex(for: .own), "a scan's own colours are drawn as they are")
    }

    /// Review of #451, finding 5: a locate pass changes no file, so the phone doesn't download the model and scan again.
    func testALocatePassNeverRollsTheMediaVersionOver() {
        let made = project(["state": "ready", "kind": "fit", "passes": [["startedAtMs": 10, "endedAtMs": 20, "status": "done", "trigger": "new"],
                                                                         ["startedAtMs": 30, "endedAtMs": 40, "status": "done", "trigger": "locate"]]])
        XCTAssertEqual(made.mediaVersion, 20)
    }

    /// Finding 8: the same colour written two ways is one spool, as on Android and Linux.
    func testOneColourWrittenTwoWaysIsOneSpool() {
        let p = project(["state": "printed", "kind": "fit", "current": ["model": "current/model.stl", "renders": []],
                         "print": ["bundleId": "b", "spools": [["index": 1, "colour": "#fec600"], ["index": 2, "colour": "FEC600"]]]])
        XCTAssertEqual(p.spoolColour, "#FEC600")
    }

    /// Finding 7: a project with only photos shows the subject the Mac cut out, on its page as on its card.
    func testAPhotoOnlyProjectHasThePhotoPicture() {
        let p = project(["state": "new", "kind": "fit", "photos": ["clip.jpg"], "picture": "pictures/photo-1.png", "pictures": ["photo": "pictures/photo-1.png"]])
        XCTAssertTrue(ProjectGallery(project: p).entries.isEmpty)
        XCTAssertEqual(p.photoPicture, "pictures/photo-1.png")
        XCTAssertEqual(p.picturePath, "pictures/photo-1.png")
    }

    func testASeatIsTheTransformTheFitCheckTakes() {
        let seat = Project.Seat(translationMm: [10, 20, 30], rotationDeg: [90, 0, 90])
        let m = seat.matrix
        func apply(_ p: [Double]) -> [Double] { (0..<3).map { r in m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3] } }
        let y = apply([0, 1, 0]), x = apply([1, 0, 0])
        XCTAssertEqual(y[0], 10, accuracy: 1e-9); XCTAssertEqual(y[1], 20, accuracy: 1e-9); XCTAssertEqual(y[2], 31, accuracy: 1e-9)
        XCTAssertEqual(x[0], 10, accuracy: 1e-9); XCTAssertEqual(x[1], 21, accuracy: 1e-9); XCTAssertEqual(x[2], 30, accuracy: 1e-9)
    }

    /// Nov 10, David's five scans: what each stage fetches. What you scanned draws the phone's own model beside a Mac
    /// rebuild; Together draws the scan (the seats' frame); nothing over the phone's limit is asked for.
    func testEachStageFetchesAScanThePhoneCanTake() {
        let limit = Double(64 * 1024 * 1024)
        func scanned(_ files: [Project.ScanFile]?) -> Project {
            var p = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready, scan: "scan.usdz")
            p.scanFiles = files
            return p
        }
        let sign = scanned([.init(name: "scan.usdz", bytes: 191_981_699), .init(name: "phone-preview.usdz", bytes: 9_201_716)])
        XCTAssertEqual(sign.scanModel(limit: limit), .file("scan/phone-preview.usdz"), "the 192 MB rebuild: the phone's own model")
        XCTAssertEqual(sign.scanModel(together: true, limit: limit), .tooLarge, "Together needs the rebuild's frame: its picture instead")
        let holder = scanned([.init(name: "scan.usdz", bytes: 15_961_620), .init(name: "phone-preview.usdz", bytes: 7_125_785)])
        XCTAssertEqual(holder.scanModel(limit: limit), .file("scan/phone-preview.usdz"))
        XCTAssertEqual(holder.scanModel(together: true, limit: limit), .file("scan/scan.usdz"))
        let potato = scanned([.init(name: "scan.usdz", bytes: 7_088_924)])
        XCTAssertEqual(potato.scanModel(limit: limit), .file("scan/scan.usdz"), "sent from the phone as it was: the scan is the phone's model")
        XCTAssertEqual(scanned([.init(name: "scan.usdz", bytes: 70_000_000)]).scanModel(limit: limit), .tooLarge)
        XCTAssertEqual(scanned(nil).scanModel(limit: limit), .file("scan/scan.usdz"), "a Mac that doesn't list them: asked as before")
        XCTAssertEqual(scanned([]).scanModel(limit: limit), .none, "listed, and no file there")
        var designer = scanned(nil); designer.scan = "scan.3mf"
        XCTAssertEqual(designer.scanModel(limit: limit), .none, "a designer's 3MF is not a scanned object")
    }

    /// Board X100: the line under the stage comes from why the model can't be had and names the right thing. A refused
    /// part is never "too detailed", never "a scan"; too large is said only for size; picture and model both missing is
    /// one line.
    func testTheLineUnderTheStageSaysTheActualReasonAndNamesTheRightThing() {
        XCTAssertEqual(ModelUnavailable.refused.line(.part), "Your Mac didn’t send this part’s 3D model.")
        XCTAssertEqual(ModelUnavailable.notAnswering.line(.part), "Your Mac isn’t answering, so this part’s 3D model can’t come yet.")
        XCTAssertEqual(ModelUnavailable.didntCome.line(.scan), "Your scan’s 3D model didn’t come from your Mac.")
        XCTAssertEqual(ModelUnavailable.tooLarge.line(.scan), "Your scan’s 3D model is too large a file to show on a phone. Open it on your Mac to see it from every side.")
        XCTAssertEqual(ModelUnavailable.tooLarge.line(.part), "This part’s 3D model is too large a file to show on a phone. Open it on your Mac to see it from every side.")
        XCTAssertEqual(ModelUnavailable.refused.line(.together), "Your Mac didn’t send the part and your scan in 3D.")
        XCTAssertEqual(ModelUnavailable.refused.line(.part, pictureToo: true), "Your Mac didn’t send the picture or 3D model of this part.")
        XCTAssertEqual(ModelUnavailable.notAnswering.line(.plate, pictureToo: true), "Your Mac isn’t answering, so the picture and 3D model of this plate can’t come yet.")
        XCTAssertEqual(ModelUnavailable.tooLarge.line(.scan, pictureToo: true), "The picture didn’t come from your Mac, and your scan’s 3D model is too large a file to show on a phone.")
        // Review of #527 part 4, S4: a picture the Mac never drew is said as that, in the same one line.
        XCTAssertEqual(ModelUnavailable.refused.line(.part, pictureToo: true, neverDrawn: true), "Your Mac couldn’t draw a picture of this part, and it didn’t send this part’s 3D model.")
        XCTAssertEqual(ModelUnavailable.didntCome.line(.together, pictureToo: true, neverDrawn: true), "Your Mac couldn’t draw a picture of the part and your scan, and the part and your scan in 3D didn’t come.")
        for reason in [ModelUnavailable.notAnswering, .didntCome, .refused, .undrawable] {
            for kind in [ProjectGallery.Entry.Kind.part, .plate, .together] {
                let line = reason.line(kind)
                XCTAssertFalse(line.contains("scan") && kind != .together, "a \(kind) is not a scan: \(line)")
                XCTAssertFalse(line.contains("too"), "only size is too large: \(line)")
            }
        }
        XCTAssertTrue(ModelUnavailable.refused.retryable && ModelUnavailable.notAnswering.retryable && ModelUnavailable.didntCome.retryable)
        XCTAssertFalse(ModelUnavailable.tooLarge.retryable || ModelUnavailable.undrawable.retryable)
    }
}
