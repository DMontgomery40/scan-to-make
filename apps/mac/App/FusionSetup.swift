import Foundation
import AppKit
import CryptoKit
import Darwin

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
    /// Autodesk's page for Fusion's free personal-use download.
    static let download = URL(string: "https://www.autodesk.com/products/fusion-360/personal")!
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
        // Autodesk's own installer keeps Fusion under webdeploy, with a stable link to the current build.
        let places = [home.appendingPathComponent("Library/Application Support/Autodesk/webdeploy/production/Autodesk Fusion.app").path,
                      "/Applications/Autodesk Fusion.app", "/Applications/Autodesk Fusion 360.app",
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
    static func envFiles(state: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
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
            // Reached through `ssh` to this Mac (the Local Network stopgap), the MCP runs where the key's forced command
            // `cd`s to, not where ssh starts.
            add(cwd: forcedCommandFolder(process: process, home: home) ?? process["cwd"] as? String,
                command: process["command"] as? String, args: process["args"] as? [String] ?? [])
        }
        // The same client configs the companion reads printers from (services/companion/src/objects/printers.ts):
        // Claude Code, Claude Desktop, Cursor and Codemode keep MCP servers under `mcpServers`; Codex in TOML.
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

    /// The folder a printer MCP reached with `ssh` to this Mac runs in: the `cd <folder> &&` that starts the forced
    /// command on the key it uses (`~/.ssh/authorized_keys`, read only). Nil for any other command.
    static func forcedCommandFolder(process: [String: Any], home: URL) -> String? {
        guard let command = process["command"] as? String, (command as NSString).lastPathComponent == "ssh" else { return nil }
        let args = process["args"] as? [String] ?? []
        let host = args.last.map { $0.split(separator: "@").last.map(String.init) ?? $0 } ?? ""
        guard ["127.0.0.1", "localhost", "::1"].contains(host), let flag = args.firstIndex(of: "-i"), flag + 1 < args.count else { return nil }
        let identity = (args[flag + 1] as NSString).expandingTildeInPath
        guard let publicKey = try? String(contentsOfFile: identity + ".pub", encoding: .utf8),
              let body = publicKey.split(separator: " ").dropFirst().first,
              let keys = try? String(contentsOf: home.appendingPathComponent(".ssh/authorized_keys"), encoding: .utf8) else { return nil }
        return forcedCommandFolder(authorizedKeys: keys, keyBody: String(body))
    }

    static func forcedCommandFolder(authorizedKeys: String, keyBody: String) -> String? {
        for line in authorizedKeys.split(separator: "\n") where line.contains(" \(keyBody)") {
            guard let start = line.range(of: "command=\"") else { continue }
            var command = "", escaped = false
            for character in line[start.upperBound...] {
                if escaped { command.append(character); escaped = false }
                else if character == "\\" { escaped = true }
                else if character == "\"" { break }
                else { command.append(character) }
            }
            let trimmed = command.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("cd ") else { return nil }
            let rest = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
            if let quote = rest.first, quote == "'" || quote == "\"" {
                let body = rest.dropFirst()
                return body.firstIndex(of: quote).map { String(body[..<$0]) }
            }
            return rest.split(separator: " ").first.map(String.init).map { ($0 as NSString).expandingTildeInPath }
        }
        return nil
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

    /// Where Set Up writes and what it runs. Tests swap in folders, a fake add-in, a fake launchctl and a fake MCP.
    struct Steps {
        var home: URL
        var addinsFolder: URL
        var portAgent: URL
        /// Hands the verified add-in folder to `use` (the download is removed afterwards).
        var withAddin: (_ use: (URL) throws -> Void) async throws -> Void
        var launchctl: ([String]) -> Bool
        /// `fusion_mcp_status {launch: true}` on the printer MCP, started fresh so it reads the new settings.
        var status: () async -> Status

        @MainActor static func live(state: URL) -> Steps {
            Steps(home: FileManager.default.homeDirectoryForCurrentUser, addinsFolder: FusionSetup.addinsFolder, portAgent: FusionSetup.portAgent,
                  withAddin: FusionSetup.downloadAddin, launchctl: FusionSetup.launchctl,
                  status: { await FusionSetup.checkStatus(state: state) })
        }
    }

    /// What Set Up did, and what Fusion said when the printer MCP asked it.
    struct Report: Equatable {
        var envFiles: [URL]
        var status: Status
    }

    /// Downloads the pinned add-in, checks every file, installs it set to run on startup, adds the settings to each
    /// printer MCP env file (keeping a copy of each file next to it first), installs the login item that sets
    /// `FUSION_MCP_PORT`, then asks the printer MCP for `fusion_mcp_status {launch: true}`.
    @MainActor static func install(state: URL) async throws -> Report { try await install(state: state, steps: .live(state: state)) }

    static func install(state: URL, steps: Steps) async throws -> Report {
        let envs = envFiles(state: state, home: steps.home)
        guard !envs.isEmpty else { throw Failure.noEnvFile }
        try await steps.withAddin { addon in try install(addon: addon, into: steps.addinsFolder) }
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
        try installPortAgent(at: steps.portAgent, launchctl: steps.launchctl)
        return Report(envFiles: changed, status: await steps.status())
    }

    /// The pinned add-in, downloaded and checked file by file.
    static func downloadAddin(_ use: (URL) throws -> Void) async throws {
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
        try use(addon)
    }

    /// The login agent's property list: one `launchctl setenv` at login, so Fusion gets the port however it's opened.
    static var portAgentPlist: [String: Any] {
        ["Label": portAgentLabel, "ProgramArguments": ["/bin/launchctl", "setenv", "FUSION_MCP_PORT", port], "RunAtLoad": true]
    }

    /// Writes the agent, loads it in this login session, and sets the variable now.
    static func installPortAgent(at portAgent: URL, launchctl: ([String]) -> Bool) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: portAgentPlist, format: .xml, options: 0)
        try FileManager.default.createDirectory(at: portAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: portAgent, options: .atomic)
        let domain = "gui/\(getuid())"
        _ = launchctl(["bootout", "\(domain)/\(portAgentLabel)"]) // a previous copy, if any
        guard launchctl(["bootstrap", domain, portAgent.path]), launchctl(["setenv", "FUSION_MCP_PORT", port]) else {
            throw Failure.write(portAgent.path)
        }
    }

    @discardableResult static func launchctl(_ arguments: [String]) -> Bool {
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
    static func install(addon: URL, into addinsFolder: URL) throws {
        let addinFolder = addinsFolder.appendingPathComponent("Fusion360MCP", isDirectory: true)
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

    // MARK: Is it working?

    /// What `fusion_mcp_status {launch: true}` said, in plain words for Settings.
    enum Status: Equatable {
        case connected
        /// faust-machines/fusion360-mcp-server#12: Fusion answers only with a design open.
        case needsDesign
        /// Fusion was already open before Set Up, so it listens on the old port until it is opened again.
        case reopenFusion
        /// The add-in answers on its port, but the printer MCP doesn't recognise its reply (bambu-printer-mcp 1.1.49
        /// expects `result.pong`; the pinned add-in says `result.status: "pong"`).
        case bridgeOutdated(server: String)
        case notConfigured
        /// The printer MCP has no Fusion bridge (older than bambu-printer-mcp 1.1.4x).
        case noBridge
        case notConnected(String)
        case unreachable(String)

        var ok: Bool { self == .connected }
        var words: String {
            switch self {
            case .connected: return "Fusion is connected. New designs use it while it's running."
            case .needsDesign: return "Open a design in Fusion first (File → New Design), then press Set Up Again."
            case .reopenFusion: return "Quit Fusion and open it again, so it picks up the new settings. Then press Set Up Again."
            case .bridgeOutdated(let server):
                return "Fusion's add-in is answering, but \(server) doesn't recognise it yet. Update \(server), then press Set Up Again."
            case .notConfigured: return "Your printer MCP doesn't see the Fusion settings yet. Press Set Up Again."
            case .noBridge: return "Your printer MCP can't talk to Fusion. Update it in Settings → Printers, then press Set Up Again."
            case .notConnected(let reason): return reason.isEmpty ? "Fusion didn't connect." : "Fusion didn't connect: \(reason)"
            case .unreachable(let reason): return "Counterpart couldn't ask your printer MCP about Fusion: \(reason)"
            }
        }

        /// The status reply, then the design check when there was one.
        static func from(status: MCPCall.Reply?, design: MCPCall.Reply?) -> Status {
            let first = from(toolMissing: status == nil, isError: status?.isError ?? false, text: status?.text ?? "")
            guard first == .connected, let design, design.isError else { return first }
            let lower = design.text.lowercased()
            return lower.contains("no_active_design") || lower.contains("no active design") || lower.contains("no open design") ? .needsDesign : first
        }

        /// From the tool's reply (`{configured, connected, addinReachable, fusionRunning, error}`), or its error text.
        static func from(toolMissing: Bool, isError: Bool, text: String) -> Status {
            if toolMissing { return .noBridge }
            let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            let error = (value?["error"] as? String ?? (isError ? text : "")).trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = error.lowercased()
            if !isError, value?["configured"] as? Bool == false { return .notConfigured }
            if !isError, value?["connected"] as? Bool == true { return .connected }
            // Fusion was open before Set Up: it runs, but without the add-in on the new port until it is opened again.
            if !isError, value?["fusionRunning"] as? Bool == true, value?["addinReachable"] as? Bool == false { return .reopenFusion }
            if lower.contains("no_active_design") || lower.contains("no open design")
                || lower.contains("design") && (lower.contains("no active") || lower.contains("none open") || lower.contains("open a design")
                                            || lower.contains("activeproduct") || lower.contains("nonetype")) { return .needsDesign }
            if lower.contains("9876") || (lower.contains("refused") && lower.contains("running")) { return .reopenFusion }
            let short = error.count > 200 ? String(error.prefix(199)) + "…" : error
            return isError ? .unreachable(short) : .notConnected(short)
        }
    }

    /// Starts the printer MCP the companion uses (printer-handoff.json's process, fresh, so it reads the new settings)
    /// and asks it once.
    static func checkStatus(state: URL) async -> Status {
        guard let data = try? Data(contentsOf: state.appendingPathComponent("printer-handoff.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let process = json["process"] as? [String: Any],
              let command = process["command"] as? String else {
            return .unreachable("there's no printer MCP set up in Counterpart yet.")
        }
        let call = MCPCall.appOwned(command: command, args: process["args"] as? [String] ?? [], cwd: process["cwd"] as? String,
                                    env: process["env"] as? [String: String] ?? [:])
        do {
            // Connected on Fusion's Home tab still can't make the first design (#12): a read of the open design's
            // parameters, which changes nothing, says whether one is open.
            let (reply, design) = try await call.callTool("fusion_mcp_status", arguments: ["launch": true, "timeout_ms": 90_000], timeout: 150) { reply in
                Status.from(toolMissing: false, isError: reply.isError, text: reply.text) == .connected
                    ? ("fusion_mcp_call", ["tool_name": "get_parameters", "arguments": [String: Any](), "timeout_ms": 20_000]) : nil
            }
            let status = Status.from(status: reply, design: design)
            // "Reopen Fusion" only when the add-in really doesn't answer on its port.
            if status == .reopenFusion, await addinAnswers(port: UInt16(port) ?? 9877) {
                return .bridgeOutdated(server: reply?.server ?? "your printer MCP")
            }
            return status
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}

extension FusionSetup {
    /// Whether the Fusion360MCP add-in answers a ping on this Mac (`{"type":"ping"}`, a success reply within 2 s).
    static func addinAnswers(port: UInt16, timeout: Int = 2) async -> Bool {
        await Task.detached { () -> Bool in
            let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard socket >= 0 else { return false }
            defer { close(socket) }
            // A listener that hangs up must fail the probe, not raise SIGPIPE in the app.
            var on: Int32 = 1
            setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var time = timeval(tv_sec: timeout, tv_usec: 0)
            setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(port).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard connected == 0 else { return false }
            let ping = Array("{\"type\":\"ping\",\"params\":{}}\n".utf8)
            guard ping.withUnsafeBufferPointer({ send(socket, $0.baseAddress, ping.count, 0) }) == ping.count else { return false }
            var reply = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while !reply.contains(0x0A), reply.count < 65_536 {
                let read = recv(socket, &buffer, buffer.count, 0)
                guard read > 0 else { break }
                reply.append(contentsOf: buffer[0..<read])
            }
            let line = reply.split(separator: 0x0A).first.map { Data($0) } ?? reply
            return ((try? JSONSerialization.jsonObject(with: line)) as? [String: Any])?["status"] as? String == "success"
        }.value
    }
}

/// One tool call to a stdio MCP server: initialize, list the tools, call one, then close. Newline-delimited JSON-RPC.
struct MCPCall {
    let command: String
    let args: [String]
    var cwd: String?
    var env: [String: String] = [:]

    struct Reply: Equatable {
        let isError: Bool
        let text: String
        /// The server's own name from `initialize` (`bambu-printer-mcp`, `mcp-3d-printer-server`).
        var server: String? = nil
    }

    /// As the companion starts a printer MCP (`appOwnedPrinterProcess`): a `node` that is gone is this app's own, and
    /// PATH has this app's node and the usual Homebrew folders, so `npx` and `uvx` are found from a GUI app.
    static func appOwned(command: String, args: [String], cwd: String?, env: [String: String],
                         bundledNode: URL? = Bundle.main.resourceURL?.appendingPathComponent("Payload/node/bin/node")) -> MCPCall {
        var command = command
        if (command as NSString).lastPathComponent == "node", !FileManager.default.isExecutableFile(atPath: command),
           let bundledNode, FileManager.default.isExecutableFile(atPath: bundledNode.path) { command = bundledNode.path }
        var env = env
        let inherited = env["PATH"] ?? ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let extra = [bundledNode?.deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin"].compactMap { $0 }
        env["PATH"] = (extra + [inherited]).joined(separator: ":")
        return MCPCall(command: command, args: args, cwd: cwd, env: env)
    }
    enum Failure: LocalizedError {
        case start, closed, timedOut
        var errorDescription: String? {
            switch self {
            case .start: return "it couldn't be started."
            case .closed: return "it closed before answering."
            case .timedOut: return "it didn't answer in time."
            }
        }
    }

    /// The tool's text and whether it is an error; nil when the server has no such tool.
    func callTool(_ name: String, arguments: [String: Any], timeout: TimeInterval) async throws -> Reply? {
        try await callTool(name, arguments: arguments, timeout: timeout, then: { _ in nil }).0
    }

    /// One call, then (when `then` names one from its reply) a second in the same session; nil for a tool it hasn't.
    func callTool(_ name: String, arguments: [String: Any], timeout: TimeInterval,
                  then: (Reply) -> (String, [String: Any])?) async throws -> (Reply?, Reply?) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = args
        if let cwd, FileManager.default.fileExists(atPath: cwd) { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.environment = ProcessInfo.processInfo.environment.merging(env) { $1 }
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw Failure.start }
        defer {
            try? input.fileHandleForWriting.close()
            MCPCall.stop(process)
        }
        // At the deadline the call ends whether or not the output closes (a wrapper's child can keep it open), and the
        // server and its children are stopped.
        let watchdog = Watchdog()
        let lines = LineReader(output.fileHandleForReading)
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [process] in
            guard process.isRunning || !lines.isFinished else { return }
            watchdog.fire()
            lines.finish()
            MCPCall.stop(process)
        }
        func send(_ message: [String: Any]) throws {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(0x0A)
            try input.fileHandleForWriting.write(contentsOf: data)
        }
        func reply(to id: Int) async throws -> [String: Any] {
            while true {
                guard let line = await lines.next() else { throw watchdog.fired ? Failure.timedOut : Failure.closed }
                guard let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                      message["id"] as? Int == id else { continue }
                return message
            }
        }
        try send(["jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": ["protocolVersion": "2025-06-18", "capabilities": [:], "clientInfo": ["name": "Counterpart", "version": "1"]]])
        let server = ((try await reply(to: 1))["result"] as? [String: Any]).flatMap { ($0["serverInfo"] as? [String: Any])?["name"] as? String }
        try send(["jsonrpc": "2.0", "method": "notifications/initialized"])
        try send(["jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": [:]])
        let tools = Set((((try await reply(to: 2))["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String })
        func call(_ id: Int, _ name: String, _ arguments: [String: Any]) async throws -> Reply? {
            guard tools.contains(name) else { return nil }
            try send(["jsonrpc": "2.0", "id": id, "method": "tools/call", "params": ["name": name, "arguments": arguments]])
            let answer = try await reply(to: id)
            if let error = answer["error"] as? [String: Any] { return Reply(isError: true, text: error["message"] as? String ?? "", server: server) }
            let result = answer["result"] as? [String: Any] ?? [:]
            let text = (result["content"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
            return Reply(isError: result["isError"] as? Bool ?? false, text: text, server: server)
        }
        guard let first = try await call(3, name, arguments) else { return (nil, nil) }
        guard let (next, nextArguments) = then(first) else { return (first, nil) }
        return (first, try await call(4, next, nextArguments))
    }
}

/// Lines from a pipe, read on one background thread; `finish()` ends the reading at once, even if the pipe stays open.
final class LineReader: @unchecked Sendable {
    private var buffer = Data()
    private var finished = false
    private var waiting: CheckedContinuation<Void, Never>?
    private let lock = NSLock()

    init(_ handle: FileHandle) {
        Thread.detachNewThread { [self] in
            while true {
                let chunk = handle.availableData
                lock.lock()
                if finished { lock.unlock(); return }
                if chunk.isEmpty { finished = true } else { buffer.append(chunk) }
                let resume = waiting; waiting = nil
                let done = finished
                lock.unlock()
                resume?.resume()
                if done { return }
            }
        }
    }

    func next() async -> String? {
        while true {
            // A line already read comes before the end, even when the server wrote it and exited at once.
            switch takeOrEnd() {
            case .line(let line): return line
            case .end: return nil
            case .wait: break
            }
            await withCheckedContinuation { continuation in
                lock.lock()
                if finished || buffer.contains(0x0A) { lock.unlock(); continuation.resume(); return }
                waiting = continuation
                lock.unlock()
            }
        }
    }

    /// No more lines: the caller's wait ends now.
    func finish() {
        lock.lock()
        finished = true
        let resume = waiting; waiting = nil
        lock.unlock()
        resume?.resume()
    }

    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }

    private enum Next { case line(String), end, wait }
    private func takeOrEnd() -> Next {
        lock.lock(); defer { lock.unlock() }
        if let newline = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...newline)
            return .line(line)
        }
        return finished ? .end : .wait
    }
}

final class Watchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var didFire = false
    var fired: Bool { lock.lock(); defer { lock.unlock() }; return didFire }
    func fire() { lock.lock(); didFire = true; lock.unlock() }
}

extension MCPCall {
    /// Stops the server and everything under it (a wrapper's child, and its children, keep running when only the
    /// wrapper is told), deepest first.
    static func stop(_ process: Process) {
        guard process.isRunning else { return }
        let tree = descendants(of: process.processIdentifier)
        for pid in tree.reversed() { kill(pid, SIGTERM) }
        process.terminate()
    }

    static func descendants(of pid: pid_t) -> [pid_t] {
        let pgrep = Process(), out = Pipe()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-P", String(pid)]
        pgrep.standardOutput = out
        pgrep.standardError = FileHandle.nullDevice
        guard (try? pgrep.run()) != nil else { return [] }
        pgrep.waitUntilExit()
        let children = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .split(separator: "\n").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
        return children.flatMap { [$0] + descendants(of: $0) }
    }
}
