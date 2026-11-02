import Foundation
import AppKit
import CryptoKit

/// Settings → AI → Design with Fusion (PRD §8.9). Counterpart never ships or requires Fusion. Set Up:
/// 1. installs the Faust Machines add-in at the pinned commit into the user's own Fusion, set to run on startup;
/// 2. adds the five `FUSION_MCP_*` settings next to `BLENDER_MCP_*` in the printer MCP's own env file;
/// 3. installs a login LaunchAgent that runs `launchctl setenv FUSION_MCP_PORT 9877` (and runs it once now), because
///    Blender's MCP add-on holds 9876 and a Fusion opened from the Dock never sees the env file.
enum FusionSetup {
    static let repository = "faust-machines/fusion360-mcp-server"
    static let commit = "19b9f1e9519235ae4a0f5e8dc6b029c08b87ff5f"
    static let shortCommit = "19b9f1e95192"
    /// Off Blender's 9876. Both the server and the add-in read `FUSION_MCP_PORT`.
    static let port = "9877"
    static let portAgentLabel = "com.scantomake.mac.fusion-port"
    static var portAgent: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(portAgentLabel).plist")
    }
    static var archive: URL { URL(string: "https://codeload.github.com/\(repository)/tar.gz/\(commit)")! }

    /// SHA-256 of every file in the add-in at the pinned commit. Set Up refuses anything else.
    static let addinFiles: [String: String] = [
        "Fusion360MCP.manifest": "28b50ab54dcc962fba726d1490dafd8d6ff7a78e31bb5011644a68c3f1788afa",
        "Fusion360MCP.py": "890ce46718720624e9b2d5f25762634a48d7ed41897121f0cd6dd8e17c40bd20",
        "server/__init__.py": "cfb2ec371f493b437d1029f82a167ff933e59d7660a0b534e7e840a3d84669de",
        "server/command_handler.py": "e260e2860e4d550b046632c322ee2cf75da03eb02ed587a13789fbf84889db1c",
        "server/event_bridge.py": "ca6ccfe2861110ac0f26fbfb867efb9728699b01f16fbd37caa7b96181db0c1e",
        "server/hints.py": "981e89c0032223de1c02ef937b3522280c0328933f07ab89912ff522f4544822",
        "server/hole_geometry.py": "872ef1c7d34a21e49e277517cf413322c609fac47e2e64d2c1ed9580af31d25c",
        "server/parameter_units.py": "1fe5bbf505cecc19902c2720d5d53e12944bb61f182c3c0348e971849afa5c00",
        "server/socket_server.py": "758419b11142b9a5068dbc9f1cf339c3d79fc6d5ab77736f4463f8499d053b4d",
    ]

    static var addinsFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns", isDirectory: true)
    }
    static var addinFolder: URL { addinsFolder.appendingPathComponent("Fusion360MCP", isDirectory: true) }

    // MARK: Finding Fusion

    /// The installed Fusion app, if any: by bundle id, then the usual places the Autodesk installer uses.
    static func installedFusion() -> URL? {
        for id in ["com.autodesk.fusion360", "com.autodesk.mas.fusion360"] {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let places = ["/Applications/Autodesk Fusion.app", "/Applications/Autodesk Fusion 360.app",
                      home.appendingPathComponent("Applications/Autodesk Fusion.app").path,
                      home.appendingPathComponent("Applications/Autodesk Fusion 360.app").path]
        return places.map(URL.init(fileURLWithPath:)).first { FileManager.default.fileExists(atPath: $0.path) }
    }

    // MARK: The env file

    /// The five settings (PRD §8.9). The command is the same `uvx` the Blender bridge already uses, when it names one.
    static func settings(blenderCommand: String?) -> [(String, String)] {
        let uvx = blenderCommand.flatMap { $0.hasSuffix("/uvx") || $0 == "uvx" ? $0 : nil } ?? "uvx"
        let args = "[\"--from\",\"git+https://github.com/\(repository)@\(shortCommit)\",\"fusion360-mcp-server\",\"--mode\",\"socket\"]"
        return [("FUSION_MCP_COMMAND", uvx), ("FUSION_MCP_ARGS", args), ("FUSION_MCP_TIMEOUT_MS", "180000"), ("FUSION_MCP_HOST", "localhost"),
                ("FUSION_MCP_PORT", port)]
    }

    /// The env file with the Fusion settings in it: replaced where they already are, else right after the last
    /// `BLENDER_MCP_*` line, else at the end. Running it twice gives the same file; every other line is kept as is.
    static func merge(env text: String) -> String {
        var lines = text.components(separatedBy: "\n")
        let trailingNewline = text.hasSuffix("\n")
        if trailingNewline { lines.removeLast() }
        let blenderCommand = lines.compactMap { line -> String? in
            let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "BLENDER_MCP_COMMAND" else { return nil }
            return parts[1].trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
        }.last
        let wanted = settings(blenderCommand: blenderCommand)
        func key(_ line: String) -> String? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("#"), let equals = trimmed.firstIndex(of: "=") else { return nil }
            return trimmed[..<equals].replacingOccurrences(of: "export ", with: "").trimmingCharacters(in: .whitespaces)
        }
        lines.removeAll { key($0).map { $0.hasPrefix("FUSION_MCP_") } ?? false }
        let block = wanted.map { "\($0.0)=\($0.1)" }
        if let last = lines.lastIndex(where: { key($0)?.hasPrefix("BLENDER_MCP_") == true }) {
            lines.insert(contentsOf: block, at: last + 1)
        } else {
            if let tail = lines.last, !tail.isEmpty { lines.append("") }
            lines.append(contentsOf: block)
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func isConfigured(env text: String) -> Bool {
        text.components(separatedBy: "\n").contains { $0.trimmingCharacters(in: .whitespaces).hasPrefix("FUSION_MCP_COMMAND=") }
    }

    /// The printer MCPs' own env files: `.env` in the working directory each printer MCP the user's configs start
    /// runs in, the ones that already hold the Blender bridge's settings first.
    static func envFiles(state: URL) -> [URL] {
        var folders: [URL] = []
        func add(cwd: String?, command: String?, args: [String]) {
            let text = ([command ?? ""] + args).joined(separator: " ").lowercased()
            guard text.contains("bambu-printer-mcp") || text.contains("3d-printer") || text.contains("printer-mcp") || cwd != nil else { return }
            // dotenv reads `.env` from the process's working directory, so only an explicit `cwd` names the file the MCP
            // actually loads. Without one, Set Up says it couldn't find the file rather than writing one that isn't read.
            if let cwd, !cwd.isEmpty { folders.append(URL(fileURLWithPath: (cwd as NSString).expandingTildeInPath, isDirectory: true)) }
        }
        // The Mac app's own printer configuration.
        if let data = try? Data(contentsOf: state.appendingPathComponent("printer-handoff.json")),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let process = json["process"] as? [String: Any] {
            add(cwd: process["cwd"] as? String, command: process["command"] as? String, args: process["args"] as? [String] ?? [])
        }
        // The same client configs the companion reads printers from (services/companion/src/objects/printers.ts):
        // Claude Code, Claude Desktop, Cursor and Codemode keep MCP servers under `mcpServers`; Codex in TOML.
        let home = FileManager.default.homeDirectoryForCurrentUser
        var queue = [".claude.json", "Library/Application Support/Claude/claude_desktop_config.json", ".cursor/mcp.json",
                     ".codex/mcp/codemode-servers.json", ".claude-desktop/mcp/codemode-servers.json",
                     ".config/codemode-mcp/codemode-mcp-temp/codemode-config.json"].map { home.appendingPathComponent($0) }
        var visited: Set<String> = []
        while let file = queue.first {
            queue.removeFirst()
            guard visited.insert(file.standardizedFileURL.path).inserted, visited.count < 64,
                  let data = try? Data(contentsOf: file), let json = try? JSONSerialization.jsonObject(with: data) else { continue }
            // Codemode's wrapper lists more config folders, each with its own .mcp.json.
            if let directories = (json as? [String: Any])?["configDirectories"] as? [String] {
                queue += directories.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true).appendingPathComponent(".mcp.json") }
            }
            func walk(_ value: Any) {
                if let object = value as? [String: Any] {
                    for (name, inner) in object {
                        if name == "mcpServers", let servers = inner as? [String: Any] {
                            for (serverName, server) in servers {
                                guard let server = server as? [String: Any] else { continue }
                                let args = server["args"] as? [String] ?? []
                                let named = serverName.lowercased().contains("printer") || serverName.lowercased().contains("bambu")
                                if named || (server["command"] as? String ?? "").contains("printer") || args.contains(where: { $0.contains("printer") }) {
                                    add(cwd: server["cwd"] as? String, command: server["command"] as? String, args: args)
                                }
                            }
                        } else { walk(inner) }
                    }
                } else if let array = value as? [Any] { array.forEach(walk) }
            }
            walk(json)
        }
        if let toml = try? String(contentsOf: home.appendingPathComponent(".codex/config.toml"), encoding: .utf8) {
            for server in codexServers(toml) where server.name.lowercased().contains("printer") || server.name.lowercased().contains("bambu")
                || (server.command ?? "").contains("printer") || server.args.contains(where: { $0.contains("printer") }) {
                add(cwd: server.cwd, command: server.command, args: server.args)
            }
        }
        let candidates = Array(Set(folders.map { $0.standardizedFileURL.appendingPathComponent(".env") }))
            .filter { FileManager.default.isReadableFile(atPath: $0.path) }
        func blender(_ url: URL) -> Bool { ((try? String(contentsOf: url, encoding: .utf8)) ?? "").contains("BLENDER_MCP_") }
        // Every printer MCP gets the settings; the ones that already bridge Blender come first.
        return candidates.sorted { (blender($0) ? 0 : 1, $0.path) < (blender($1) ? 0 : 1, $1.path) }
    }

    /// Codex's `[mcp_servers.<name>]` tables: just `command`, `args` and `cwd`, enough to find the server's `.env`.
    static func codexServers(_ toml: String) -> [(name: String, command: String?, args: [String], cwd: String?)] {
        var servers: [(name: String, command: String?, args: [String], cwd: String?)] = []
        var current: (name: String, command: String?, args: [String], cwd: String?)?
        func string(_ value: Substring) -> String? {
            let trimmed = value.trimmingCharacters(in: .whitespaces)
            guard trimmed.count >= 2, let quote = trimmed.first, quote == "\"" || quote == "'", trimmed.last == quote else { return nil }
            return String(trimmed.dropFirst().dropLast())
        }
        for raw in toml.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") {
                if let current { servers.append(current) }
                current = nil
                let header = line.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
                if header.hasPrefix("mcp_servers."), !header.dropFirst("mcp_servers.".count).contains(".") {
                    current = (String(header.dropFirst("mcp_servers.".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")), nil, [], nil)
                }
                continue
            }
            guard current != nil, let equals = line.firstIndex(of: "=") else { continue }
            let key = line[..<equals].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: equals)...]
            switch key {
            case "command": current?.command = string(value)
            case "cwd": current?.cwd = string(value)
            case "args":
                let inner = value.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
                current?.args = inner.split(separator: ",").compactMap { string($0) }
            default: break
            }
        }
        if let current { servers.append(current) }
        return servers
    }

    // MARK: Set Up

    enum Failure: LocalizedError {
        case download, verify, noEnvFile, write(String)
        var errorDescription: String? {
            switch self {
            case .download: return "The Fusion add-in couldn’t be downloaded. Check the internet connection and try again."
            case .verify: return "The downloaded add-in didn’t match the pinned version, so nothing was installed."
            case .noEnvFile: return "Counterpart couldn’t find your printer MCP’s .env file. Add the FUSION_MCP settings there by hand."
            case .write(let file): return "Counterpart couldn’t write \(file)."
            }
        }
    }

    /// Downloads the pinned add-in, checks every file, installs it set to run on startup, then adds the settings to
    /// each printer MCP env file (keeping a copy of each file next to it first). Returns the env files changed.
    static func install(state: URL) async throws -> [URL] {
        let envs = envFiles(state: state)
        guard !envs.isEmpty else { throw Failure.noEnvFile }
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("counterpart-fusion-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let tarball = work.appendingPathComponent("addin.tar.gz")
        do {
            let (data, response) = try await URLSession.shared.data(from: archive)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.download }
            try data.write(to: tarball)
        } catch { throw Failure.download }
        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-xzf", tarball.path, "-C", work.path]
        try tar.run(); tar.waitUntilExit()
        let addon = work.appendingPathComponent("fusion360-mcp-server-\(commit)/addon", isDirectory: true)
        try verify(addon)
        try install(addon: addon)
        var changed: [URL] = []
        for env in envs {
            guard let text = try? String(contentsOf: env, encoding: .utf8) else { continue }
            let merged = merge(env: text)
            guard merged != text else { changed.append(env); continue }
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
            let backup = env.deletingLastPathComponent().appendingPathComponent(".env.bak-\(stamp)-counterpart")
            do {
                try FileManager.default.copyItem(at: env, to: backup)
                try merged.write(to: env, atomically: true, encoding: .utf8)
                changed.append(env)
            } catch { throw Failure.write(env.path) }
        }
        try installPortAgent()
        return changed
    }

    /// The login agent's property list: one `launchctl setenv` at login, so Fusion gets the port however it's opened.
    static var portAgentPlist: [String: Any] {
        ["Label": portAgentLabel, "ProgramArguments": ["/bin/launchctl", "setenv", "FUSION_MCP_PORT", port], "RunAtLoad": true]
    }

    /// Writes the agent, loads it in this login session, and sets the variable now.
    static func installPortAgent() throws {
        let data = try PropertyListSerialization.data(fromPropertyList: portAgentPlist, format: .xml, options: 0)
        try FileManager.default.createDirectory(at: portAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: portAgent, options: .atomic)
        let domain = "gui/\(getuid())"
        _ = launchctl(["bootout", "\(domain)/\(portAgentLabel)"]) // a previous copy, if any
        guard launchctl(["bootstrap", domain, portAgent.path]), launchctl(["setenv", "FUSION_MCP_PORT", port]) else {
            throw Failure.write(portAgent.path)
        }
    }

    @discardableResult private static func launchctl(_ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    /// Every file present and exactly the pinned bytes; nothing more.
    static func verify(_ addon: URL) throws {
        var found: [String] = []
        let enumerator = FileManager.default.enumerator(at: addon, includingPropertiesForKeys: [.isRegularFileKey])
        while let file = enumerator?.nextObject() as? URL {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let relative = String(file.standardizedFileURL.path.dropFirst(addon.standardizedFileURL.path.count + 1))
            guard let expected = addinFiles[relative], let data = try? Data(contentsOf: file),
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expected else { throw Failure.verify }
            found.append(relative)
        }
        guard Set(found) == Set(addinFiles.keys) else { throw Failure.verify }
    }

    /// Copies the add-in into Fusion's AddIns folder with `runOnStartup` on, replacing an older copy of it.
    static func install(addon: URL) throws {
        try FileManager.default.createDirectory(at: addinsFolder, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: addinFolder.path) { try FileManager.default.removeItem(at: addinFolder) }
        try FileManager.default.copyItem(at: addon, to: addinFolder)
        let manifest = addinFolder.appendingPathComponent("Fusion360MCP.manifest")
        let text = try String(contentsOf: manifest, encoding: .utf8)
        try text.replacingOccurrences(of: "\"runOnStartup\": false", with: "\"runOnStartup\": true").write(to: manifest, atomically: true, encoding: .utf8)
    }

    /// The add-in and the port agent are in place and every printer MCP env file has the settings.
    static func isSetUp(state: URL) -> Bool {
        FileManager.default.fileExists(atPath: addinFolder.appendingPathComponent("Fusion360MCP.py").path)
            && FileManager.default.fileExists(atPath: portAgent.path)
            && { let files = envFiles(state: state)
                 return !files.isEmpty && files.allSatisfy { ((try? String(contentsOf: $0, encoding: .utf8)) ?? "").contains("FUSION_MCP_COMMAND=") } }()
    }
}
