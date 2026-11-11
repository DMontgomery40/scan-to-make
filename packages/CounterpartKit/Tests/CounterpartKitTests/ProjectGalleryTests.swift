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

    /// A part stays readable on the stage (lead review, Nov 10: a black holder was a silhouette): black and a dark slate
    /// blue move to the light stage; white, yellow and the neutral material stay on the dark one.
    func testEveryFilamentColourStaysReadableOnItsStage() {
        XCTAssertTrue(StageContrast.lightStage(hex: "#000000"))
        XCTAssertTrue(StageContrast.lightStage(hex: "#5B6579"), "a blue grey close to the dark stage")
        XCTAssertTrue(StageContrast.lightStage(hex: "#1F2A44"))
        XCTAssertFalse(StageContrast.lightStage(hex: "#FFFFFF"))
        XCTAssertFalse(StageContrast.lightStage(hex: "#FEC600"))
        XCTAssertFalse(StageContrast.lightStage(for: .neutral))
        XCTAssertFalse(StageContrast.lightStage(for: .own), "a scan's own colours stay on the dark stage")
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
