import XCTest

/// The Blender Counterpart starts imports from its inbox, so later clicks reuse it.
final class BlenderInboxTests: XCTestCase {
    private var inbox: URL!
    override func setUpWithError() throws {
        inbox = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-\(UUID().uuidString)", isDirectory: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: inbox) }

    func testOnlyAFreshHeartbeatCountsAsListening() throws {
        XCTAssertNil(BlenderBridge.listeningPid(inbox: inbox), "no Blender started yet")
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        let beat = inbox.appendingPathComponent(".listening")
        try "4242\n".write(to: beat, atomically: true, encoding: .utf8)
        XCTAssertEqual(BlenderBridge.listeningPid(inbox: inbox), 4242)
        XCTAssertNil(BlenderBridge.listeningPid(inbox: inbox, now: Date().addingTimeInterval(6)), "a Blender that quit stops beating")
    }

    func testADroppedModelArrivesWholeAndAStaleInboxIsCleared() throws {
        let model = FileManager.default.temporaryDirectory.appendingPathComponent("Mic mount \(UUID().uuidString).stl")
        try Data("solid x\nendsolid x\n".utf8).write(to: model)
        defer { try? FileManager.default.removeItem(at: model) }
        try BlenderBridge.drop(model, inbox: inbox)
        let names = try FileManager.default.contentsOfDirectory(atPath: inbox.path)
        XCTAssertEqual(names.count, 1)
        XCTAssertTrue(names[0].hasSuffix("~" + model.lastPathComponent) && !names[0].hasPrefix("."),
                      "the model's own name after `~`, never a half-written name the watcher reads")
        XCTAssertEqual(try Data(contentsOf: inbox.appendingPathComponent(names[0])), try Data(contentsOf: model))
        BlenderBridge.clear(inbox: inbox)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.path), [])
    }

    func testTheWatcherReadsTheInboxAfterTheSeparator() {
        XCTAssertTrue(BlenderBridge.watcher.contains("sys.argv[sys.argv.index('--') + 1]"))
        XCTAssertTrue(BlenderBridge.watcher.contains("bpy.ops.wm.stl_import(filepath=path)"))
        XCTAssertTrue(BlenderBridge.watcher.contains("name.startswith('.')"), "skips the heartbeat and partial files")
    }
}
