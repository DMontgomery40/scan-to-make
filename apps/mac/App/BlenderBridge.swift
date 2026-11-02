import Foundation
import Darwin

/// The Blender MCP add-on's local socket (localhost:9876, `{"type": "execute_code", "params": {"code": …}}`), used to
/// import a model into the Blender the person already has open. Nothing else is sent to it.
enum BlenderBridge {
    static let port: UInt16 = 9876

    /// The Python that imports one STL into the open scene; the path is a quoted literal, never code.
    static func importCode(_ file: URL) -> String {
        let path = file.path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "import bpy; bpy.ops.wm.stl_import(filepath='\(path)')"
    }

    /// Whether the add-on imported it. False when nothing listens, it errs, or it doesn't answer within 3 s.
    static func importSTL(_ file: URL, port: UInt16 = port) async -> Bool {
        guard let body = try? JSONSerialization.data(withJSONObject: ["type": "execute_code", "params": ["code": importCode(file)]]) else { return false }
        return await Task.detached { () -> Bool in
            let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard socket >= 0 else { return false }
            defer { close(socket) }
            var timeout = timeval(tv_sec: 3, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(port).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard connected == 0 else { return false }
            guard body.withUnsafeBytes({ send(socket, $0.baseAddress, body.count, 0) }) == body.count else { return false }
            // The answer can arrive in pieces: read until it is whole JSON (or the 3 s timeout ends it).
            var reply = Data()
            var buffer = [UInt8](repeating: 0, count: 16_384)
            while reply.count < 1_048_576 {
                let read = recv(socket, &buffer, buffer.count, 0)
                guard read > 0 else { return false }
                reply.append(contentsOf: buffer[0..<read])
                if let object = try? JSONSerialization.jsonObject(with: reply) as? [String: Any] {
                    return (object["status"] as? String) == "success"
                }
            }
            return false
        }.value
    }
}
