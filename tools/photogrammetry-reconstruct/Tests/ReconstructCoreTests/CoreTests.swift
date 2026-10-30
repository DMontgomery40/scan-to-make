// SPDX-License-Identifier: MIT
import XCTest
@testable import ReconstructCore

final class CoreTests: XCTestCase {
    func testDefaultsAndEveryDetail() throws {
        for detail in ["preview", "reduced", "medium", "full", "raw"] {
            let o = try Options.parse(["images", "--output", "out.usdz", "--detail", detail])
            XCTAssertEqual(o.detail, detail); XCTAssertEqual(o.ordering, "unordered"); XCTAssertTrue(o.masking)
        }
    }
    func testExplicitOptions() throws {
        let o = try Options.parse(["images", "--output", "out.usdz", "--ordering", "sequential", "--sensitivity", "high", "--masking", "off", "--timeout-seconds", "42", "--obj-directory", "obj"])
        XCTAssertEqual(o.ordering, "sequential"); XCTAssertEqual(o.sensitivity, "high"); XCTAssertFalse(o.masking)
        XCTAssertEqual(o.timeoutSeconds, 42); XCTAssertEqual(o.objDirectory, "obj")
    }
    func testInvalidArguments() {
        for args in [[], ["images"], ["images", "--output"], ["images", "--output", "x.obj"], ["images", "--output", "x.usdz", "--output", "y.usdz"], ["images", "--output", "x.usdz", "--unknown", "x"]] {
            XCTAssertThrowsError(try Options.parse(args))
        }
        for (key, values) in [("--detail", ["mobile", "bad"]), ("--ordering", ["bad"]), ("--sensitivity", ["bad"]), ("--masking", ["true"]), ("--timeout-seconds", ["0", "-1", "nan", "inf", "86401"])] {
            for value in values { XCTAssertThrowsError(try Options.parse(["images", "--output", "x.usdz", key, value])) }
        }
    }
    func temporaryFolder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }; return url
    }
    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=")!
    func testMissingEmptyAndUnsupportedFolderEntries() throws {
        let dir = try temporaryFolder()
        XCTAssertThrowsError(try images(in: dir.appendingPathComponent("missing")))
        XCTAssertThrowsError(try images(in: dir))
        let file = dir.appendingPathComponent("notes.txt"); try Data("hello".utf8).write(to: file)
        XCTAssertThrowsError(try images(in: dir)); try FileManager.default.removeItem(at: file)
        try Data("not a photo".utf8).write(to: dir.appendingPathComponent("bad.heic"))
        XCTAssertThrowsError(try images(in: dir))
    }
    func testSortedImagesAndHashes() throws {
        let dir = try temporaryFolder()
        try png.write(to: dir.appendingPathComponent("b.png")); try png.write(to: dir.appendingPathComponent("a.PNG"))
        let result = try images(in: dir)
        XCTAssertEqual(result.map(\.name), ["a.PNG", "b.png"])
        XCTAssertEqual(result.map(\.sha256), [digest(png), digest(png)])
        XCTAssertEqual(result, try images(in: dir))
    }
    func testDuplicateNames() throws {
        XCTAssertThrowsError(try validateNames(["one.heic", "ONE.HEIC"]))
        XCTAssertThrowsError(try validateNames(["é.png", "e\u{301}.png"]))
        try validateNames(["one.heic", "two.heic"])
    }
    func testSymlinkRejected() throws {
        let dir = try temporaryFolder(); let source = try temporaryFolder().appendingPathComponent("source.png")
        try png.write(to: source)
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("link.png"), withDestinationURL: source)
        XCTAssertThrowsError(try images(in: dir))
    }
    func testReportDeterminismAndHashBoundary() throws {
        let o = try Options.parse(["images", "--output", "x.usdz"])
        let p = Payload(os: "fixture OS", images: [], options: o, outputs: [], warnings: ["b", "a"])
        let a = try Report(payload: p, elapsedSeconds: 1); let b = try Report(payload: p, elapsedSeconds: 99)
        XCTAssertEqual(try canonical(p), try canonical(p))
        XCTAssertEqual(a.payloadSHA256, b.payloadSHA256)
        XCTAssertEqual(a.payloadSHA256, digest(try canonical(p)))
        var changed = o; changed.detail = "full"
        let changedPayload = Payload(os: "fixture OS", images: [], options: changed, outputs: [], warnings: ["a", "b"])
        XCTAssertNotEqual(a.payloadSHA256, try Report(payload: changedPayload, elapsedSeconds: 1).payloadSHA256)
        let reordered = Payload(os: "fixture OS", images: [], options: o, outputs: [], warnings: ["a", "b"])
        XCTAssertEqual(try canonical(p), try canonical(reordered))
        XCTAssertNotEqual(try canonical(a), try canonical(b))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: canonical(a)) as? [String: Any])
        let payload = try XCTUnwrap(json["payload"] as? [String: Any])
        XCTAssertEqual(payload["provesPhysicalAccuracy"] as? Bool, false)
        XCTAssertNil(payload["elapsedSeconds"])
        XCTAssertEqual(payload["warnings"] as? [String], ["a", "b"])
        XCTAssertEqual(digest(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}
