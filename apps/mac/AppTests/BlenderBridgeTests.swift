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
        XCTAssertTrue(imported, "an answer that arrives in pieces still counts")
        XCTAssertEqual(addOn.request?["type"] as? String, "execute_code")
        XCTAssertEqual((addOn.request?["params"] as? [String: Any])?["code"] as? String,
                       "import bpy; bpy.ops.wm.stl_import(filepath='/tmp/Mic mount/model.stl')")
    }

    func testAnErrorOrNoAddOnFallsBackToOpeningTheFile() async throws {
        let failing = try FakeAddOn(reply: #"{"status": "error", "message": "Operator failed"}"#)
        let erred = await BlenderBridge.importSTL(URL(fileURLWithPath: "/tmp/a.stl"), port: failing.port)
        failing.finish()
        XCTAssertFalse(erred)

        // Nothing listening: refused at once, not a hang.
        let closed = try FakeAddOn(reply: nil)
        let port = closed.port
        closed.finish()
        let started = Date()
        let refused = await BlenderBridge.importSTL(URL(fileURLWithPath: "/tmp/a.stl"), port: port)
        XCTAssertFalse(refused)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3.5)
    }

    func testThePathIsAQuotedLiteralNeverCode() {
        let file = URL(fileURLWithPath: "/tmp/it's\\here/x');import os;os.remove('y.stl")
        XCTAssertEqual(BlenderBridge.importCode(file),
                       #"import bpy; bpy.ops.wm.stl_import(filepath='/tmp/it\'s\\here/x\');import os;os.remove(\'y.stl')"#)
    }
}
