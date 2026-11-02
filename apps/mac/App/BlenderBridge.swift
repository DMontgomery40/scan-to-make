import Foundation

/// Open in Blender's own Blender (PRD §9.6). It is never reached through the Blender MCP port: that port (9876) is the
/// companion's touch-up Blender during a pass, and a model sent there would land in the pass's scene.
enum BlenderBridge {
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
}
