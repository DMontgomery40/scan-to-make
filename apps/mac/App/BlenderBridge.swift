import Foundation
import Darwin

/// The Blender MCP add-on's local socket (localhost:9876, `{"type": "execute_code", "params": {"code": …}}`), used to
/// import a model into the Blender the person already has open. Nothing else is sent to it.
enum BlenderBridge {
    static let port: UInt16 = 9876

    // MARK: Counterpart's own Blender

    /// The folder the Blender Counterpart starts watches: every STL put here is imported into its scene, then removed.
    static var inbox: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Scan to Make/Blender Inbox", isDirectory: true)
    }

    /// The Blender Counterpart started, while it is still watching `inbox` (it rewrites `.listening` with its pid every
    /// second). Nil when none is, so the next click starts one.
    static func listeningPid(inbox: URL = inbox, now: Date = Date()) -> pid_t? {
        let heartbeat = inbox.appendingPathComponent(".listening")
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: heartbeat.path))?[.modificationDate] as? Date,
              now.timeIntervalSince(modified) < 5,
              let text = try? String(contentsOf: heartbeat, encoding: .utf8), let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return nil }
        return pid
    }

    /// Puts a model in the inbox whole: written under a name Blender skips, then renamed, so it never reads half a file.
    static func drop(_ file: URL, inbox: URL = inbox) throws {
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        // A unique name, and the model's own after the `~`, which the watcher gives the imported object.
        let name = UUID().uuidString + "~" + file.deletingPathExtension().lastPathComponent
        let partial = inbox.appendingPathComponent("." + name + ".partial")
        try FileManager.default.copyItem(at: file, to: partial)
        try FileManager.default.moveItem(at: partial, to: inbox.appendingPathComponent(name + ".stl"))
    }

    /// Models left from a Blender that has since quit, so a new one imports only what was just asked for.
    static func clear(inbox: URL = inbox) {
        for file in (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// `--python-expr` for the Blender Counterpart starts (the inbox follows `--`): the start-up scene's objects go,
    /// then a timer imports whatever arrives in the inbox and says it is listening.
    static let watcher = """
    import bpy, os, sys
    inbox = sys.argv[sys.argv.index('--') + 1]
    for thing in list(bpy.data.objects):
        bpy.data.objects.remove(thing, do_unlink=True)
    def counterpart_inbox():
        try:
            beat = os.path.join(inbox, '.listening')
            with open(beat + '.new', 'w') as f:
                f.write(str(os.getpid()))
            os.replace(beat + '.new', beat)
            windows = bpy.context.window_manager.windows
            for name in sorted(os.listdir(inbox)):
                if name.startswith('.') or not name.lower().endswith('.stl'):
                    continue
                path = os.path.join(inbox, name)
                try:
                    before = set(bpy.data.objects)
                    with bpy.context.temp_override(**({'window': windows[0]} if windows else {})):
                        bpy.ops.wm.stl_import(filepath=path)
                    for thing in set(bpy.data.objects) - before:
                        thing.name = name.split('~', 1)[-1][:-4]
                except Exception as error:
                    print("Counterpart could not import", name, error)
                finally:
                    os.remove(path)
        except Exception as error:
            print('Counterpart inbox:', error)
        return 1.0
    bpy.app.timers.register(counterpart_inbox, first_interval=0.2, persistent=True)
    """

    // MARK: The Blender MCP add-on

    /// The Python that imports one STL into the open scene; the path is a quoted literal, never code.
    static func importCode(_ file: URL) -> String {
        let path = file.path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "import bpy; bpy.ops.wm.stl_import(filepath='\(path)')"
    }

    enum Outcome: Equatable, Sendable {
        case imported
        /// Nothing was imported: nothing listens, or the add-on answered with an error.
        case refused
        /// Sent, but no whole answer in time: it may still import, so it is never sent another way as well.
        case uncertain
    }

    /// Imports through the add-on. A large scan can take a while, so the answer gets 8 s.
    static func importSTL(_ file: URL, port: UInt16 = port, answerWithin seconds: Int = 8) async -> Outcome {
        guard let body = try? JSONSerialization.data(withJSONObject: ["type": "execute_code", "params": ["code": importCode(file)]]) else { return .refused }
        return await Task.detached { () -> Outcome in
            let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard socket >= 0 else { return .refused }
            defer { close(socket) }
            var timeout = timeval(tv_sec: 3, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            var answer = timeval(tv_sec: seconds, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &answer, socklen_t(MemoryLayout<timeval>.size))
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(port).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard connected == 0 else { return .refused }
            let sent = body.withUnsafeBytes { send(socket, $0.baseAddress, body.count, 0) }
            guard sent > 0 else { return .refused }
            guard sent == body.count else { return .uncertain }
            // The answer can arrive in pieces: read until it is whole JSON (or the 3 s timeout ends it).
            var reply = Data()
            var buffer = [UInt8](repeating: 0, count: 16_384)
            while reply.count < 1_048_576 {
                let read = recv(socket, &buffer, buffer.count, 0)
                guard read > 0 else { return .uncertain }
                reply.append(contentsOf: buffer[0..<read])
                if let object = try? JSONSerialization.jsonObject(with: reply) as? [String: Any] {
                    return (object["status"] as? String) == "success" ? .imported : .refused
                }
            }
            return .uncertain
        }.value
    }
}
