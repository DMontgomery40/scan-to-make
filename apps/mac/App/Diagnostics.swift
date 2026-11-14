import Foundation
#if canImport(ControlKit)
import ControlKit
#endif

/// A zip of the companion's logs and settings with every secret removed: no auth or TLS files, and every value whose
/// name says token, key, secret, password or access code replaced. Since #799 it also holds the companion's own part
/// (`diagnostics.bundle`: the event log's tail, the printers, their printer software and each printer MCP's own bundle)
/// as `companion/`, the build in `about.txt`, and `notes.txt`, which says what didn't answer.
enum Diagnostics {
    static let secretNames = try! NSRegularExpression(pattern:"(TOKEN|KEY|SECRET|PASSWORD|PASS|ACCESS_CODE|AUTH|CREDENTIAL)", options:[.caseInsensitive])

    /// `scheme://user:password@host` keeps its host and loses its credentials, wherever it appears.
    static func stripURLCredentials(_ text: String) -> String {
        let regex = try! NSRegularExpression(pattern:#"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@"']+(:[^/\s@"']*)?@"#)
        return regex.stringByReplacingMatches(in:text, range:NSRange(text.startIndex..., in:text), withTemplate:"$1<removed>@")
    }

    static func redact(env text: String) -> String {
        stripURLCredentials(text).components(separatedBy:"\n").map { line in
            guard let equals = line.firstIndex(of:"="), !line.trimmingCharacters(in:.whitespaces).hasPrefix("#") else { return line }
            let name = String(line[..<equals])
            let hit = secretNames.firstMatch(in:name, range:NSRange(name.startIndex..., in:name)) != nil
            return hit ? name + "=<removed>" : line
        }.joined(separator:"\n")
    }

    /// Log lines: `NAME=value` or `"name": "value"` for a secret-looking name, and bearer tokens, are removed.
    static func redact(log text: String) -> String {
        var out = stripURLCredentials(text)
        let rules: [(String, String)] = [
            (#"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"#, "$1<removed>"),
            (#"(?i)("?[A-Za-z0-9_.-]*(?:token|key|secret|password|pass|access_code|accesscode|auth|credential)[A-Za-z0-9_.-]*"?\s*[=:]\s*)("[^"]*"|[^\s,}]+)"#, "$1<removed>"),
            (#"scantomake://pair\?[^\s"]+"#, "scantomake://pair?<removed>"),
            // An Apple Account or printer account email (#799).
            (#"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"#, "<removed email>"),
        ]
        for (pattern, template) in rules {
            let regex = try! NSRegularExpression(pattern: pattern)
            out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }

    static func redact(json value: Any) -> Any {
        if let object = value as? [String: Any] {
            return object.reduce(into:[String: Any]()) { result, pair in
                let hit = secretNames.firstMatch(in:pair.key, range:NSRange(pair.key.startIndex..., in:pair.key)) != nil
                result[pair.key] = hit ? "<removed>" : redact(json:pair.value)
            }
        }
        if let array = value as? [Any] { return array.map(redact(json:)) }
        if let string = value as? String { return stripURLCredentials(string) }
        return value
    }

    /// A name the companion gave, as a path inside `companion/`: relative, no `..`, `.` or empty part, nothing unprintable.
    static func safeRelativePath(_ name: String) -> String? {
        guard !name.isEmpty, name.utf8.count <= 512, !name.hasPrefix("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where:{ $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        let parts = name.split(separator:"/", omittingEmptySubsequences:false)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        return name
    }

    /// `companion` is `diagnostics.bundle` on the companion's control socket. The export never waits on it to succeed:
    /// a companion that doesn't answer leaves its folder out and says so in `notes.txt`.
    static func export(state: URL, to destination: URL, companion: @Sendable () async throws -> CompanionDiagnostics) async -> Bool {
        var bundle: CompanionDiagnostics?
        var problem: String?
        do { bundle = try await companion() }
        catch { problem = "Counterpart couldn’t read the companion’s part (\(error.localizedDescription)), so this export has no event log, printer list, printer software or printer MCP diagnostics. Export again once Counterpart is running." }
        let answered = bundle, unanswered = problem
        return await Task.detached {
            let fm = FileManager.default
            let folder = fm.temporaryDirectory.appendingPathComponent("Counterpart Diagnostics \(UUID().uuidString)", isDirectory:true)
            defer { try? fm.removeItem(at:folder) }
            do {
                try fm.createDirectory(at:folder.appendingPathComponent("logs"), withIntermediateDirectories:true)
                for name in (try? fm.contentsOfDirectory(atPath:state.appendingPathComponent("logs").path)) ?? [] where name.hasSuffix(".log") {
                    let data = (try? Data(contentsOf:state.appendingPathComponent("logs/\(name)"))) ?? Data()
                    let text = String(decoding:data.suffix(4 * 1024 * 1024), as:UTF8.self)
                    try redact(log:text).write(to:folder.appendingPathComponent("logs/\(name)"), atomically:true, encoding:.utf8)
                }
                if let env = try? String(contentsOf:state.appendingPathComponent("companion.env"), encoding:.utf8) {
                    try redact(env:env).write(to:folder.appendingPathComponent("companion.env"), atomically:true, encoding:.utf8)
                }
                for name in ["printer-handoff.json", "app-migration.json"] {
                    guard let data = try? Data(contentsOf:state.appendingPathComponent(name)),
                          let json = try? JSONSerialization.jsonObject(with:data) else { continue }
                    try JSONSerialization.data(withJSONObject:redact(json:json), options:[.prettyPrinted, .sortedKeys])
                        .write(to:folder.appendingPathComponent(name))
                }
                var notes = unanswered.map { [$0] } ?? []
                if let answered {
                    // The companion already redacted it; the app's own redaction runs again over every file.
                    let root = folder.appendingPathComponent("companion", isDirectory:true)
                    for file in answered.files {
                        guard let name = safeRelativePath(file.name) else { notes.append("The companion named a file this export can’t use; it was left out."); continue }
                        let url = root.appendingPathComponent(name)
                        try fm.createDirectory(at:url.deletingLastPathComponent(), withIntermediateDirectories:true)
                        try redact(log:file.content).write(to:url, atomically:true, encoding:.utf8)
                        if file.truncated { notes.append("companion/\(name) holds only its newest part.") }
                    }
                    notes += answered.notes.map(redact(log:))
                }
                let notesText = notes.isEmpty ? "Everything answered.\n" : notes.map { "- \($0)" }.joined(separator:"\n") + "\n"
                try notesText.write(to:folder.appendingPathComponent("notes.txt"), atomically:true, encoding:.utf8)
                let version = Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "—"
                let build = Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "—"
                let about = "Counterpart \(version) (build \(build))\nmacOS \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
                try about.write(to:folder.appendingPathComponent("about.txt"), atomically:true, encoding:.utf8)
                try? fm.removeItem(at:destination)
                let zip = Process()
                zip.executableURL = URL(fileURLWithPath:"/usr/bin/ditto")
                zip.arguments = ["-c", "-k", "--keepParent", folder.path, destination.path]
                try zip.run(); zip.waitUntilExit()
                return zip.terminationStatus == 0
            } catch { return false }
        }.value
    }
}
