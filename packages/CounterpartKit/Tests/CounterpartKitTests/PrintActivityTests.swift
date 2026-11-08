import XCTest
import CloudKit
import ImageIO
import SwiftUI
@testable import CounterpartKit

final class PrintActivityTests: XCTestCase {
    func testRetrySupersedesOnlyTheEarlierActivityForTheSameProject() {
        let snapshot = PrintActivitySnapshot(attributes: .init(projectId: "p", printId: "new", title: "Clip", printerName: "Printer"),
            content: .init(state: "printing", progress: 0, endsAt: Date()))
        XCTAssertTrue(snapshot.supersedes(.init(projectId: "p", printId: "old", title: "Clip", printerName: "Printer")))
        XCTAssertFalse(snapshot.supersedes(snapshot.attributes))
        XCTAssertFalse(snapshot.supersedes(.init(projectId: "other", printId: "old", title: "Hook", printerName: "Printer")))
    }
    func testProjectProgressAndTerminalStateOverrideAnOldPrinterReport() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var project = Project(id: "p", createdAtMs: 0, updatedAtMs: now.timeIntervalSince1970 * 1000, state: .printing)
        XCTAssertNil(PrintActivitySnapshot(project), "no activity without a real print identity")
        project.print = .init(bundleId: "b", printId: "j", live: .init(state: "printing", job: .init(name: "Clip", progress: 50, remainingSec: 120)))
        let current = try XCTUnwrap(PrintActivitySnapshot(project, now: now))
        XCTAssertEqual(current.content.progress, 50)
        XCTAssertEqual(current.content.endsAt, now.addingTimeInterval(120))
        XCTAssertEqual(current.observedAt, now)
        project.state = .printed
        let ended = try XCTUnwrap(PrintActivitySnapshot(project, now: now))
        XCTAssertTrue(ended.content.terminal)
        XCTAssertEqual(ended.content.progress, 100)
    }

    func testCloudMirrorAndPhoneEndDespiteAnOldPrinterReport() throws {
        let updated = Date(timeIntervalSince1970: 1_800_000_000)
        for (outcome, reported, projectState, expected) in [
            ("replaced", "printing", Project.State.ready, "cancelled"),
            ("failed", "idle", .failed, "failed"),
            ("done", "printing", .printed, "finished"),
            ("", "idle", .failed, "failed")
        ] {
            var project = Project(id: "p", createdAtMs: 0, updatedAtMs: updated.timeIntervalSince1970 * 1000, state: projectState)
            project.print = .init(bundleId: "b", printId: "j", live: .init(state: reported, job: .init(name: "Old job", progress: 42)),
                                  monitor: .init(phase: "ended", endState: outcome.isEmpty ? nil : outcome))
            let record = CKRecord(recordType: "CounterpartProject")
            record["projectId"] = project.id; record["updatedAt"] = updated
            PrintActivitySnapshot.mirror(project, into: record)
            XCTAssertEqual(record["printState"] as? String, expected)
            let remote = try XCTUnwrap(PrintActivitySnapshot(cloudRecord: record))
            XCTAssertEqual(remote.content.state, expected)
            XCTAssertTrue(remote.content.terminal)
            XCTAssertFalse(remote.shouldStart(foreground: true, dismissed: []))
            XCTAssertEqual(remote.observedAt, updated)
            // Outcome must also override a raw legacy report in a record read by the phone.
            record["printState"] = reported
            XCTAssertEqual(PrintActivitySnapshot(cloudRecord: record)?.content.state, expected)
        }
    }

    func testRelayCodingAndLifecycle() throws {
        let state = PrintAttributes.ContentState(state: "printing", progress: 50, layer: 3, totalLayers: 6,
                                                 endsAt: Date(timeIntervalSinceReferenceDate: 42), stage: "Walls")
        let data = try JSONEncoder().encode(state)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["endsAt"] as? Double, 42, "relay uses Swift reference-date seconds")
        XCTAssertEqual(Set(body.keys), ["state", "progress", "layer", "totalLayers", "endsAt", "stage"])
        XCTAssertTrue(state.canStart); XCTAssertFalse(state.terminal)
        for ended in ["finished", "failed", "cancelled"] {
            let content = PrintAttributes.ContentState(state: ended, progress: 101, endsAt: Date())
            XCTAssertTrue(content.terminal); XCTAssertFalse(content.canStart); XCTAssertEqual(content.progress, 100)
        }
        XCTAssertEqual(PrintAttributes.ContentState(state: "printing", progress: .nan, endsAt: Date()).progress, 0)
        let attributes = PrintAttributes(projectId: "p", printId: "j", title: "Clip", printerName: "Printer")
        let snapshot = PrintActivitySnapshot(attributes: attributes, content: state)
        XCTAssertTrue(snapshot.shouldStart(foreground: true, dismissed: []))
        XCTAssertFalse(snapshot.shouldStart(foreground: false, dismissed: []), "silent wake cannot start an activity")
        XCTAssertFalse(snapshot.shouldStart(foreground: true, dismissed: ["j"]), "refresh cannot recreate an activity the user dismissed")
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(attributes)) as? [String: String])
        XCTAssertEqual(encoded, ["projectId": "p", "printId": "j", "title": "Clip", "printerName": "Printer"])
    }

    /// The activity's picture goes in through the same store the app and the notification service write and
    /// comes out where the widget reads it, scaled to fit the presentation; with none it's the mark.
    func testActivityPictureRoundTripsAndFallsBackToTheMark() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("activity-pictures-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = PrintActivityThumbnails(folder: folder)
        let project = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a03"
        XCTAssertEqual(store.artwork(for: project), .mark, "no picture yet: the mark, never a generic printer")

        let large = try Self.png(width: 1000, height: 600)
        XCTAssertTrue(store.store(imageData: large, projectId: project, version: 2_000, source: "renders/clip.png#1"))
        guard case .thumbnail(let url) = store.artwork(for: project) else { return XCTFail("expected the stored picture") }
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL, folder.standardizedFileURL)
        let image = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        XCTAssertEqual(max(image.width, image.height), PrintActivityThumbnails.maxPixels, "never larger than the presentation")
        XCTAssertEqual(store.entry(for: project), .init(version: 2_000, source: "renders/clip.png#1"))

        // An older write (the notification service with a stale record) never replaces a newer picture.
        XCTAssertFalse(store.store(imageData: large, projectId: project, version: 1_000, source: "cloud"))
        XCTAssertEqual(store.entry(for: project)?.source, "renders/clip.png#1")
        XCTAssertTrue(store.store(imageData: large, projectId: project, version: 3_000, source: "cloud"))
        XCTAssertEqual(store.entry(for: project)?.source, "cloud")

        XCTAssertFalse(store.store(imageData: Data("not a picture".utf8), projectId: "other", version: 1, source: "x"))
        XCTAssertEqual(store.artwork(for: "other"), .mark)

        // An id can't name a file outside the folder.
        XCTAssertTrue(store.store(imageData: large, projectId: "../../escape", version: 1, source: "x"))
        guard case .thumbnail(let escaped) = store.artwork(for: "../../escape") else { return XCTFail("expected the stored picture") }
        XCTAssertEqual(escaped.deletingLastPathComponent().standardizedFileURL, folder.standardizedFileURL)

        store.remove(projectId: project)
        XCTAssertEqual(store.artwork(for: project), .mark)
    }

    /// The mark fills the frame it's given (a 20 pt compact slot shows a 20 pt mark), centred, and the outline
    /// is cut back where it passes behind the solid piece, as on the app icon.
    func testTheMarkFillsItsFrame() {
        let path = CounterpartMark().path(in: CGRect(x: 0, y: 0, width: 20, height: 20))
        XCTAssertEqual(path.boundingRect.height, 20, accuracy: 0.01)
        XCTAssertEqual(path.boundingRect.midX, 10, accuracy: 0.01)
        let scale = 20.0 / 56
        XCTAssertTrue(path.contains(CGPoint(x: (40 - 23) * scale, y: (50 - 25) * scale)), "the solid piece")
        XCTAssertFalse(path.contains(CGPoint(x: (47 - 23) * scale + (20 - 54 * scale) / 2, y: (77.5 - 25) * scale)),
                       "the outline's gap where it passes behind the solid piece")
        XCTAssertTrue(path.contains(CGPoint(x: (66 - 23) * scale + (20 - 54 * scale) / 2, y: (77.5 - 25) * scale)), "the outline beyond the gap")
    }

    func testActivityWordsMatchTheMilestoneNotification() {
        let halfway = PrintAttributes.ContentState(state: "printing", progress: 50, layer: 106, totalLayers: 212, endsAt: Date())
        XCTAssertEqual(PrintActivityWords.detail(halfway, printer: "P1S"), "layer 106 of 212 · P1S")
        XCTAssertEqual(PrintActivityWords.detail(.init(state: "preparing", progress: 0, endsAt: Date()), printer: "P1S"), "P1S")
    }

    private static func png(width: Int, height: Int) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0.45, blue: 0.18, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}
