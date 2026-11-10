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
}
