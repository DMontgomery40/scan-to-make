import Foundation

/// The text rules every diagnostics file passes through before it leaves the phone (#799). They start from the companion's
/// (`services/companion/src/diagnostics.ts`, #813) and close the gaps the lead's review of #813 found (lowercase
/// schemes, `key`/`pin`/`session` names, prefix-only safe values, more token shapes), plus what only a phone has.
///
/// Removed:
/// - the phone's own secrets by value (pairing token, certificate or public-key pin, device id), in every encoding;
/// - values of secret-named keys (JSON, escaped JSON, `key=value`, `key: value`, `--flag value`), whatever the case;
/// - `Authorization` values, `bearer` credentials in any case, URL credentials, cookies;
/// - JWTs, `sk-`/`ghp_`/`github_pat_`/`AKIA`/`AIza`/`xox?-` tokens, PEM blocks of any kind;
/// - 64-hex, colon-hex and base64 SHA-256 values, 32- and 43-character base64url runs (pairing codes, tokens);
/// - emails, pairing links, IPv4 addresses, home and container paths (also with JSON's escaped slashes).
/// Kept: a whole value of `[set]`, `[redacted…]`, empty, `true`, `false` or `null` after a secret's name (only the whole
/// value: `token=[set]hunter2` goes), so a report still says whether something is configured; and the words around them.
public enum DiagnosticsRedaction {
    // `auth`, `key`, `pin` and `otp` only as a word of their own (`AUTH_TOKEN`, `session_key`, `PAIRING_PIN`, `pinCode`), so
    // "Failed to authenticate", "keyboard", "colourMapping", "shipping" and "pinnedBaseURL" keep their letters.
    static let secretWord = #"(?:password|passwd|passphrase|passcode|pwd|secret|token|api[_-]?key|apikey|access[_-]?code|accesscode|authorization|auth(?:[_-]?key)?(?![a-z])|key(?![a-z])|pin(?:[_-]?code)?(?![a-z])|pairing[_-]?code|lan[_-]?code|otp(?![a-z])|sha256|session|cookie|credential|signature|ticket|login|email|user[_-]?info)"#
    static let secretKey = "[A-Za-z0-9_.-]*" + secretWord + "[A-Za-z0-9_.-]*"
    /// A value that is safe as a whole: a marker, empty, true, false or null, followed by the value's end.
    static let safe = #"(?!(?:"(?:\[set\]|\[redacted[^"\]]*\])?"|\[set\]|\[redacted[^\]\s"]*\]|true|false|null)(?=[\s,;&}\]"']|$))"#
    /// `/` or JSON's escaped `\/`.
    static let slash = #"\\?/"#

    private static func rule(_ pattern: String, _ template: String, _ options: NSRegularExpression.Options = []) -> (NSRegularExpression, String) {
        (try! NSRegularExpression(pattern: pattern, options: options), template)
    }

    static let rules: [(NSRegularExpression, String)] = [
        // PEM blocks of any kind (private keys, certificates), whole.
        rule(#"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)"#, "[redacted PEM block]"),
        // scheme://user:password@host keeps its host.
        rule(#"\b([a-z][a-z0-9+.-]*:(?://|\\/\\/))[^/\\\s:@"'<>]+(?::[^/\\\s@"'<>]*)?@"#, "$1[redacted]@", .caseInsensitive),
        // An Authorization header's whole value (`basic`, `digest`, `bearer`, anything), in any case and in JSON.
        rule(#"(authorization["']?[ \t]*[:=][ \t]*["']?)[^\r\n"',}]+"#, "$1[redacted]", .caseInsensitive),
        // A bearer credential anywhere, in any case; `Basic`/`Digest`/`Token` as written in headers.
        rule(#"\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}"#, "$1 [redacted]", .caseInsensitive),
        rule(#"\b(Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}"#, "$1 [redacted]"),
        // A PIN or pairing code in prose: "The pairing code is 482913", "Enter PIN 482913".
        rule(#"\b((?:pairing\s+code|access\s+code|lan\s+code|passcode|pin)(?:\s+(?:is|was))?[\s:=#]+)\d{4,8}\b"#, "$1[redacted]", .caseInsensitive),
        // Escaped JSON inside a string: \"accessCode\":\"1234\".
        rule(#"(\\""# + secretKey + #"\\"\s*:\s*)\\"(?:[^"\\]|\\[^"])*\\""#, #"$1\\"[redacted]\\""#, .caseInsensitive),
        // JSON: "accessCode": "1234" (a number or bare word too).
        rule(#"(""# + secretKey + #""\s*:\s*)"# + safe + #"(?:"(?:[^"\\]|\\.)*"|[^\s,}]+)"#, #"$1"[redacted]""#, .caseInsensitive),
        // key=value, key: value, ?key=value&, --key value (on one line).
        rule(#"(\b"# + secretKey + #"[ \t]*[=:][ \t]*|--"# + secretKey + #"[ \t]+)"# + safe + #"(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}"']+)"#, "$1[redacted]", .caseInsensitive),
        // Cookie headers, whole line.
        rule(#"^((?:Set-)?Cookie:).*$"#, "$1 [redacted]", [.caseInsensitive, .anchorsMatchLines]),
        // JSON web tokens.
        rule(#"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+"#, "[redacted token]"),
        // Tokens and keys with a known prefix.
        rule(#"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"#, "[redacted key]"),
        rule(#"\bgithub_pat_[A-Za-z0-9_]{20,}"#, "[redacted token]"),
        rule(#"\bgh[pousr]_[A-Za-z0-9]{20,}"#, "[redacted token]"),
        rule(#"\bA(?:KIA|SIA)[0-9A-Z]{16}\b"#, "[redacted key]"),
        rule(#"\bAIza[0-9A-Za-z_-]{35}"#, "[redacted key]"),
        rule(#"\bxox[abprs]-[A-Za-z0-9-]{10,}"#, "[redacted token]"),
        // DER (a certificate or key in base64 without its PEM lines).
        rule(#"\bMII[A-Za-z0-9+/]{20,}={0,2}"#, "[redacted DER]"),
        // Email addresses (an Apple Account, a printer account), also percent-encoded.
        rule(#"[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"#, "[redacted email]"),
        // A pairing link carries its code and pin, also percent-encoded.
        rule(#"scantomake:(?://|\\/\\/)pair\?[^\s"']+"#, "scantomake://pair?[redacted]", .caseInsensitive),
        rule(#"scantomake%3A%2F%2Fpair[^\s"'&]*"#, "scantomake://pair?[redacted]", .caseInsensitive),
        // Certificate pins and hashes: 64 hex, colon-separated hex, base64 SHA-256.
        rule(#"\b[A-Fa-f0-9]{64}\b"#, "[redacted hex]"),
        rule(#"\b(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}\b"#, "[redacted hex]"),
        rule(#"(?<![A-Za-z0-9+])[A-Za-z0-9+/]{43}="#, "[redacted hash]"),
        // Pairing codes (32) and pairing tokens (43): exact base64url runs; a 36-character UUID is never one.
        rule(#"(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{32})(?![A-Za-z0-9_-])"#, "[redacted token]"),
        // Any app's container on a phone is `~`; another /var/mobile path keeps only its start.
        rule(#"(?:\\?/private)?\\?/var\\?/mobile\\?/Containers\\?/(?:Data|Shared)\\?/(?:Application|AppGroup|PluginKitPlugin)\\?/[A-Fa-f0-9-]{36}"#, "~"),
        rule(#"(\\?/var\\?/mobile)(?:\\?/[^\n"',;]*)?"#, "$1/[redacted path]"),
        // A person's home folder on a Mac or Linux (the Simulator's paths hold the Mac's user name).
        // A name may have spaces ("/Users/Taylor Person/…"): everything up to the next slash goes.
        rule(#"(\\?/(?:Users|home)\\?/)(?!\[redacted)[^/\\\n"',;]+"#, "$1[redacted]"),
        rule(#"([A-Za-z]:\\{1,2}Users\\{1,2})[^\\/\n"',;]+"#, "$1[redacted]"),
        rule(#"(?<![A-Za-z0-9])~[A-Za-z][A-Za-z0-9._-]*(?=/)"#, "~[redacted]"),
        // IPv4 addresses in free text: the pairing state says only what kind of address the phone uses.
        rule(#"\b(?:\d{1,3}\.){3}\d{1,3}\b"#, "[redacted address]"),
    ]

    /// Every form a known secret might be written in: as is, either case, base64 of a hex value's bytes, colon hex, and
    /// JSON's escaped slashes.
    static func forms(_ secret: String) -> [String] {
        var forms = [secret, secret.lowercased(), secret.uppercased(), secret.replacingOccurrences(of: "/", with: #"\/"#)]
        if secret.count % 2 == 0, secret.allSatisfy(\.isHexDigit) {
            var bytes = Data(), index = secret.startIndex
            while index < secret.endIndex {
                let next = secret.index(index, offsetBy: 2)
                bytes.append(UInt8(secret[index..<next], radix: 16)!); index = next
            }
            let base64 = bytes.base64EncodedString()
            forms += [base64, base64.replacingOccurrences(of: "/", with: #"\/"#),
                      base64.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")]
            let pairs = stride(from: 0, to: secret.count, by: 2).map { offset -> String in
                let start = secret.index(secret.startIndex, offsetBy: offset)
                return String(secret[start..<secret.index(start, offsetBy: 2)])
            }
            forms += [pairs.joined(separator: ":").lowercased(), pairs.joined(separator: ":").uppercased()]
        }
        return forms
    }

    static let wordEscape = try! NSRegularExpression(pattern: #"\\u00([3-7][0-9A-Fa-f])"#)
    static func unescapeWordCharacters(_ text: String) -> String {
        guard text.contains(#"\u00"#) else { return text }
        var out = "", last = text.startIndex
        for match in wordEscape.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(match.range, in: text), let hex = Range(match.range(at: 1), in: text),
                  let scalar = UInt8(text[hex], radix: 16).map(Unicode.Scalar.init), scalar.properties.isAlphabetic || ("0"..."9").contains(Character(scalar)) || scalar == "_" else { continue }
            out += text[last..<whole.lowerBound] + String(Character(scalar)); last = whole.upperBound
        }
        return out + text[last...]
    }

    /// `text` with every secret removed; `secrets` (known values) go first, then the home folder reads `~`.
    public static func redact(_ text: String, secrets: [String] = [], home: String? = NSHomeDirectory()) -> String {
        var out = text
        let known = Set(secrets.filter { $0.count >= 4 }.flatMap(forms)).sorted { $0.count > $1.count }
        for secret in known { out = out.replacingOccurrences(of: secret, with: "[redacted]") }
        if let home, home.count > 1 {
            for form in ["/private" + home, home] {
                out = out.replacingOccurrences(of: form, with: "~").replacingOccurrences(of: form.replacingOccurrences(of: "/", with: #"\/"#), with: "~")
            }
        }
        // `\u0070assword` is `password`: letters and digits written as JSON escapes are read as themselves first.
        out = unescapeWordCharacters(out)
        for (regex, template) in rules {
            out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }
}

extension CompanionAddress {
    /// What kind of address a pairing uses, never the address itself: "https, IPv4 address", "https, Tailscale name".
    public static func kind(_ value: String?) -> String {
        guard let value else { return "none" }
        guard let url = URL(string: value), let scheme = url.scheme, let host = url.host?.lowercased(), !host.isEmpty else { return "unreadable" }
        let kind: String
        if isFixture(url) { kind = "simulator test address" }
        else if ipv4.matches(host) { kind = "IPv4 address" }
        else if host.contains(":") { kind = "IPv6 address" }
        else if tailscaleHost.matches(host) { kind = "Tailscale name" }
        else if host.hasSuffix(".local") { kind = ".local name" }
        else if !host.contains(".") { kind = "single-label name" }
        else { kind = "other name" }
        return "\(scheme), \(kind)"
    }
}

/// Settings → Share Diagnostics… on the iPhone and iPad (#799): what this phone knows, redacted, as one ZIP a tester can
/// mail or attach to TestFlight feedback. It reads only what the phone keeps; it never asks the Mac, so it works with the
/// Mac away, with nothing paired, or paired only through iCloud.
public struct PhoneDiagnostics: Sendable {
    public struct About: Sendable {
        public var version, build, system, model: String
        public init(version: String, build: String, system: String, model: String) {
            self.version = version; self.build = build; self.system = system; self.model = model
        }
    }

    /// The pairing and connection state: chosen fields only, never a token, pin, certificate, address or name.
    public struct Pairing: Encodable, Sendable {
        public var state: String
        public var link: String
        public var address: String
        public var pairedAddress: String
        public var certificatePinned: Bool
        public var expires: String?
        public var simulatorFixture: Bool
        public var macNamed: Bool
        public var iCloudConfigured: Bool
        public var iCloudMacs: Int
        public var iCloudMessage: String?

        public init(status: PairingStatus?, unreadable: Bool = false, link: MacLink, macName: String?,
                    cloudConfigured: Bool, cloudMacs: Int, cloudMessage: String?) {
            state = unreadable ? "unreadable (protected storage locked)" : (status ?? .disconnected).state.rawValue
            switch link {
            case .checking: self.link = "checking"
            case .connected: self.link = "connected"
            case .notAnswering: self.link = "not answering"
            case .needsPairing(let error): self.link = "needs pairing (\(error.code))"
            }
            address = CompanionAddress.kind(status?.activeUrl ?? status?.baseUrl)
            pairedAddress = CompanionAddress.kind(status?.baseUrl)
            certificatePinned = CompanionAddress.validPin(status?.pin)
            expires = status?.expiresAtMs.map { ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: $0 / 1000)) }
            simulatorFixture = status?.fixture ?? false
            macNamed = !(macName ?? "").isEmpty
            iCloudConfigured = cloudConfigured; iCloudMacs = cloudMacs; iCloudMessage = cloudMessage
        }
    }

    /// One capture kept on this phone (`NativeCaptures/<run>`): its state and how much it kept, never its photos.
    public struct Draft: Encodable, Sendable {
        public var run, project, status, createdAt: String
        public var photos: Int
        public var hasModel: Bool
        public var stitchingIncomplete: Bool
        public var message: String?
        public init(run: String, project: String, status: String, createdAt: String, photos: Int, hasModel: Bool,
                    stitchingIncomplete: Bool, message: String?) {
            self.run = run; self.project = project; self.status = status; self.createdAt = createdAt; self.photos = photos
            self.hasModel = hasModel; self.stitchingIncomplete = stitchingIncomplete; self.message = message
        }
    }

    public var about: About
    public var pairing: Pairing
    /// The request errors the app still holds (it keeps only the latest of each kind).
    public var errors: [String]
    public var drafts: [Draft]
    /// `MediaTrace.shared.url`; its older segment is `<url>.1`.
    public var trace: URL?
    /// The phone's own secret values (pairing token, pins, device id): removed by value, in every form, from every file.
    public var secrets: [String]
    /// What the app couldn't read while gathering (the drafts, the pairing): each becomes a line in `notes.txt`.
    public var notes: [String]
    public var home: String?

    public init(about: About, pairing: Pairing, errors: [String], drafts: [Draft], trace: URL?, secrets: [String] = [],
                notes: [String] = [], home: String? = NSHomeDirectory()) {
        self.about = about; self.pairing = pairing; self.errors = errors; self.drafts = drafts; self.trace = trace
        self.secrets = secrets; self.notes = notes; self.home = home
    }

    /// "Counterpart Phone Diagnostics 2026-11-14.zip", in the phone's own day.
    public static func fileName(date: Date = Date(), timeZone: TimeZone = .current) -> String {
        "\(folderName(date: date, timeZone: timeZone)).zip"
    }

    static func folderName(date: Date, timeZone: TimeZone) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX"); format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = timeZone; format.dateFormat = "yyyy-MM-dd"
        return "Counterpart Phone Diagnostics \(format.string(from: date))"
    }

    /// The files, by name, every one redacted. A part that can't be made becomes a line in `notes.txt` and the rest go on.
    func files(date: Date) -> (files: [(String, Data)], notes: [String]) {
        func clean(_ text: String) -> Data { Data(DiagnosticsRedaction.redact(text, secrets: secrets, home: home).utf8) }
        var files: [(String, Data)] = []
        var notes = self.notes
        func add(_ name: String, _ make: () throws -> String) {
            do { files.append((name, clean(try make()))) }
            catch { notes.append("\(name) couldn’t be made (\((error as NSError).domain) \((error as NSError).code)), so it is left out.") }
        }

        add("about.txt") {
            "Counterpart \(about.version) (build \(about.build))\n\(about.system)\nDevice \(about.model)\nExported \(ISO8601DateFormatter().string(from: date))\n"
        }
        let json = JSONEncoder(); json.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        add("pairing.json") { String(decoding: try json.encode(pairing), as: UTF8.self) + "\n" }
        if pairing.state == "disconnected" {
            notes.append(pairing.iCloudConfigured
                ? "This phone is not paired with a Mac by code; iCloud lists \(pairing.iCloudMacs) Mac\(pairing.iCloudMacs == 1 ? "" : "s")."
                : "This phone is not paired with a Mac, and this build has no iCloud.")
        }
        add("errors.txt") {
            errors.isEmpty ? "No request errors are held on this phone.\n"
                : "The app keeps only the latest of each; earlier ones are in the media trace as request.error.\n\n" + errors.map { "- \($0)" }.joined(separator: "\n") + "\n"
        }
        add("drafts.json") { (drafts.isEmpty ? "[]" : String(decoding: try json.encode(drafts), as: UTF8.self)) + "\n" }

        var traced = false
        if let trace {
            // Older segment first. A segment that isn't there (mid-rotation, or never written) is not an error; one that is
            // there and can't be read gets a note.
            for (name, url) in [("media-trace.1.ndjson", trace.appendingPathExtension("1")), ("media-trace.ndjson", trace)] {
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                do {
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty else { continue }
                    files.append((name, clean(String(decoding: data, as: UTF8.self)))); traced = true
                } catch { notes.append("\(name) is on this phone but couldn’t be read (\((error as NSError).domain) \((error as NSError).code)).") }
            }
        }
        if !traced { notes.append("No media trace on this phone yet: it starts when a project's picture or model is shown.") }

        return (files, notes)
    }

    func notesText(_ notes: [String]) -> Data {
        Data(DiagnosticsRedaction.redact(notes.isEmpty ? "Everything this phone keeps is here.\n" : notes.map { "- \($0)" }.joined(separator: "\n") + "\n",
                                         secrets: secrets, home: home).utf8)
    }

    /// Writes the files to a folder and zips it with the system's own archiver (`NSFileCoordinator`, `.forUploading`,
    /// which zips a folder with the folder as its top entry). `directory` holds only the newest export: an earlier one
    /// is removed first. Returns the ZIP's URL.
    public func makeZIP(in directory: URL, date: Date = Date(), timeZone: TimeZone = .current) throws -> URL {
        let fm = FileManager.default
        try? fm.removeItem(at: directory)
        let work = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let staged = work.appendingPathComponent(Self.folderName(date: date, timeZone: timeZone), isDirectory: true)
        try fm.createDirectory(at: staged, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }
        let made = files(date: date)
        var notes = made.notes
        for (name, data) in made.files {
            do { try data.write(to: staged.appendingPathComponent(name), options: .atomic) }
            catch { notes.append("\(name) couldn’t be written, so it is left out.") }
        }
        // If even the notes can't be written, the ZIP goes without them.
        try? notesText(notes).write(to: staged.appendingPathComponent("notes.txt"), options: .atomic)

        let destination = directory.appendingPathComponent(Self.fileName(date: date, timeZone: timeZone))
        var coordinated: NSError?, copied: Error?
        NSFileCoordinator().coordinate(readingItemAt: staged, options: .forUploading, error: &coordinated) { zip in
            // The coordinator removes its ZIP when this returns: move it out first.
            do { try fm.moveItem(at: zip, to: destination) } catch { copied = error }
        }
        if let failure = coordinated ?? copied { throw failure }
        return destination
    }
}
