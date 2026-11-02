import XCTest
import Darwin

/// PRD §9.6: Open in Blender uses the Blender the person has open. With the Blender MCP add-on listening, the model is
/// imported into that scene over its socket; anything else falls back to asking Blender to open the file.
final class BlenderBridgeTests: XCTestCase {
    /// A one-connection stand-in for the add-on: it reads the request, then answers `reply` in `pieces`.
    private final class FakeAddOn: @unchecked Sendable {
        let port: UInt16
        private let listener: Int32
        private(set) var request: [String: Any]?
        private var closed = false
        private let done = DispatchSemaphore(value: 0)

        /// `reply` nil: bound and listening, but closed before anyone connects (a free port nothing serves).
        init(reply: String?, pieces: Int = 1) throws {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            address.sin_port = 0
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard bound == 0, Darwin.listen(fd, 1) == 0 else { Darwin.close(fd); throw POSIXError(.EADDRINUSE) }
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
            }
            listener = fd
            port = UInt16(bigEndian: address.sin_port)
            guard let reply else { Darwin.close(listener); closed = true; done.signal(); return }
            let listener = listener
            Thread.detachNewThread { [self] in
                let client = Darwin.accept(listener, nil, nil)
                defer { Darwin.close(client); done.signal() }
                var buffer = [UInt8](repeating: 0, count: 65_536)
                let read = recv(client, &buffer, buffer.count, 0)
                if read > 0 { request = try? JSONSerialization.jsonObject(with: Data(buffer[0..<read])) as? [String: Any] }
                let bytes = Array(reply.utf8)
                let size = max(1, bytes.count / pieces)
                var start = 0
                while start < bytes.count {
                    let end = min(bytes.count, start + size)
                    _ = bytes[start..<end].withUnsafeBufferPointer { send(client, $0.baseAddress, end - start, 0) }
                    start = end
                    usleep(20_000)
                }
            }
        }

        func finish() {
            _ = done.wait(timeout: .now() + 5)
            if !closed { Darwin.close(listener); closed = true }
        }
    }

    func testTheAddOnImportsTheModelIntoTheOpenScene() async throws {
        let addOn = try FakeAddOn(reply: #"{"status": "success", "result": {"executed": true, "result": ""}}"#, pieces: 4)
        let file = URL(fileURLWithPath: "/tmp/Mic mount/model.stl")
        let imported = await BlenderBridge.importSTL(file, port: addOn.port)
        addOn.finish()
        XCTAssertEqual(imported, .imported, "an answer that arrives in pieces still counts")
        XCTAssertEqual(addOn.request?["type"] as? String, "execute_code")
        XCTAssertEqual((addOn.request?["params"] as? [String: Any])?["code"] as? String,
                       "import bpy; bpy.ops.wm.stl_import(filepath='/tmp/Mic mount/model.stl')")
    }

    func testAnErrorOrNoAddOnFallsBackToOpeningTheFile() async throws {
        let failing = try FakeAddOn(reply: #"{"status": "error", "message": "Operator failed"}"#)
        let erred = await BlenderBridge.importSTL(URL(fileURLWithPath: "/tmp/a.stl"), port: failing.port)
        failing.finish()
        XCTAssertEqual(erred, .refused, "the add-on ran it and nothing was imported")

        // Nothing listening: refused at once, not a hang.
        let closed = try FakeAddOn(reply: nil)
        let port = closed.port
        closed.finish()
        let started = Date()
        let refused = await BlenderBridge.importSTL(URL(fileURLWithPath: "/tmp/a.stl"), port: port)
        XCTAssertEqual(refused, .refused)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3.5)
    }

    /// A busy Blender that doesn't answer in time may still import it: never sent a second way.
    func testNoAnswerInTimeIsUncertain() async throws {
        let slow = try FakeAddOn(reply: "", pieces: 1) // reads the request, answers nothing, then hangs up
        let outcome = await BlenderBridge.importSTL(URL(fileURLWithPath: "/tmp/a.stl"), port: slow.port, answerWithin: 1)
        slow.finish()
        XCTAssertEqual(outcome, .uncertain)
    }

    func testThePathIsAQuotedLiteralNeverCode() {
        let file = URL(fileURLWithPath: "/tmp/it's\\here/x');import os;os.remove('y.stl")
        XCTAssertEqual(BlenderBridge.importCode(file),
                       #"import bpy; bpy.ops.wm.stl_import(filepath='/tmp/it\'s\\here/x\');import os;os.remove(\'y.stl')"#)
    }
}

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
