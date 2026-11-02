import Foundation

/// A zip of the companion's logs and settings with every secret removed: no auth or TLS files, and every value whose
/// name says token, key, secret, password or access code replaced.
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

    static func export(state: URL, to destination: URL) async -> Bool {
        await Task.detached {
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
                let version = Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "—"
                let about = "Counterpart \(version)\nmacOS \(ProcessInfo.processInfo.operatingSystemVersionString)\n"
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
