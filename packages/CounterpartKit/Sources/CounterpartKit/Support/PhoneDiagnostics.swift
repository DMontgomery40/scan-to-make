import Foundation

/// The text rules every diagnostics file passes through before it leaves the phone (#799). They are the companion's
/// (`services/companion/src/diagnostics.ts`, #813) ported to Swift, so the phone, the computers and the MCPs remove the
/// same things, plus what only a phone has: its app container paths, a certificate pin, and addresses in free text.
///
/// Removed: values of secret-named keys (JSON, escaped JSON, `key=value`, `key: value`, `--flag value`), URL credentials,
/// authorization schemes, cookies, JWTs, `sk-`-style keys, PEM keys, emails, pairing links, 64-character hex values (a
/// pin or a hash), IPv4 addresses and full home paths. Kept: `[set]`, empty values and `true`/`false`/`null` after a
/// secret's name, so a report still says whether something is configured; and every word around them.
public enum DiagnosticsRedaction {
    // `auth` and `pin` only as a word of their own (`AUTH_TOKEN`, `pinCode`), so "Failed to authenticate", "colourMapping",
    // "shipping" and "pinnedBaseURL" keep their letters.
    static let secretWord = #"(?:password|passwd|passcode|pwd|secret|token|api[_-]?key|apikey|access[_-]?code|accesscode|access[_-]?key|authorization|auth(?:[_-]?key)?(?![a-z])|pin(?:[_-]?code)?(?![a-z])|cookie|credential|private[_-]?key|signature|ticket|login|email|user[_-]?info)"#
    static let secretKey = "[A-Za-z0-9_.-]*" + secretWord + "[A-Za-z0-9_.-]*"
    /// Values already safe after a secret's name.
    static let safe = #"(?!"(?:\[set\]|\[redacted[^"]*\])?"|\[set\]|\[redacted|true\b|false\b|null\b|"")"#

    private static func rule(_ pattern: String, _ template: String, _ options: NSRegularExpression.Options = []) -> (NSRegularExpression, String) {
        (try! NSRegularExpression(pattern: pattern, options: options), template)
    }

    static let rules: [(NSRegularExpression, String)] = [
        // PEM private keys, whole.
        rule(#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"#, "[redacted private key]"),
        // scheme://user:password@host keeps its host.
        rule(#"\b([a-z][a-z0-9+.-]*://)[^/\s:@"'<>]+(?::[^/\s@"'<>]*)?@"#, "$1[redacted]@", .caseInsensitive),
        // Authorization schemes, before `key: value`, so "Authorization: Bearer <token>" loses the token as well as the word.
        rule(#"\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}"#, "$1 [redacted]"),
        // Escaped JSON inside a string: \"accessCode\":\"1234\".
        rule(#"(\\""# + secretKey + #"\\"\s*:\s*)\\"(?:[^"\\]|\\[^"])*\\""#, #"$1\\"[redacted]\\""#, .caseInsensitive),
        // JSON: "accessCode": "1234" (a number or bare word too).
        rule(#"(""# + secretKey + #""\s*:\s*)"# + safe + #"(?:"(?:[^"\\]|\\.)*"|[^\s,}\]]+)"#, #"$1"[redacted]""#, .caseInsensitive),
        // key=value, key: value, ?key=value&, --key value (on one line).
        rule(#"(\b"# + secretKey + #"[ \t]*[=:][ \t]*|--"# + secretKey + #"[ \t]+)"# + safe + #"(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]"']+)"#, "$1[redacted]", .caseInsensitive),
        // Cookie headers, whole line.
        rule(#"^((?:Set-)?Cookie:).*$"#, "$1 [redacted]", [.caseInsensitive, .anchorsMatchLines]),
        // JSON web tokens.
        rule(#"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+"#, "[redacted token]"),
        // API keys with a known prefix.
        rule(#"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"#, "[redacted key]"),
        // Email addresses (an Apple Account, a printer account).
        rule(#"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"#, "[redacted email]"),
        // A pairing link carries its code.
        rule(#"scantomake://pair\?[^\s"']+"#, "scantomake://pair?[redacted]"),
        // The phone's own: a certificate pin or any 64-character hex value.
        rule(#"\b[A-Fa-f0-9]{64}\b"#, "[redacted hex]"),
        // Any app's container on a phone, and a Mac's home folder (the Simulator's paths hold the Mac's user name).
        rule(#"(?:/private)?/var/mobile/Containers/(?:Data|Shared)/(?:Application|AppGroup)/[A-Fa-f0-9-]{36}"#, "~"),
        rule(#"/Users/[^/\s"']+"#, "/Users/[redacted]"),
        // IPv4 addresses in free text: the pairing state says only what kind of address the phone uses.
        rule(#"\b(?:\d{1,3}\.){3}\d{1,3}\b"#, "[redacted address]"),
    ]

    /// `text` with every secret removed; `secrets` (known values) go first, then the home folder reads `~`.
    public static func redact(_ text: String, secrets: [String] = [], home: String? = NSHomeDirectory()) -> String {
        var out = text
        for secret in secrets.filter({ $0.count >= 4 }).sorted(by: { $0.count > $1.count }) {
            out = out.replacingOccurrences(of: secret, with: "[redacted]")
        }
        if let home, home.count > 1 {
            out = out.replacingOccurrences(of: "/private" + home, with: "~").replacingOccurrences(of: home, with: "~")
        }
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
    public var home: String?

    public init(about: About, pairing: Pairing, errors: [String], drafts: [Draft], trace: URL?, home: String? = NSHomeDirectory()) {
        self.about = about; self.pairing = pairing; self.errors = errors; self.drafts = drafts; self.trace = trace; self.home = home
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

    /// The files, by name, every one redacted.
    func files(date: Date) throws -> [(String, Data)] {
        func clean(_ text: String) -> Data { Data(DiagnosticsRedaction.redact(text, home: home).utf8) }
        var files: [(String, Data)] = []
        var notes: [String] = []

        let exported = ISO8601DateFormatter().string(from: date)
        files.append(("about.txt", clean("Counterpart \(about.version) (build \(about.build))\n\(about.system)\nDevice \(about.model)\nExported \(exported)\n")))

        let json = JSONEncoder(); json.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        files.append(("pairing.json", clean(String(decoding: try json.encode(pairing), as: UTF8.self) + "\n")))
        if pairing.state == "disconnected" {
            notes.append(pairing.iCloudConfigured
                ? "This phone is not paired with a Mac by code; iCloud lists \(pairing.iCloudMacs) Mac\(pairing.iCloudMacs == 1 ? "" : "s")."
                : "This phone is not paired with a Mac, and this build has no iCloud.")
        }

        let errorText = errors.isEmpty ? "No request errors are held on this phone.\n"
            : "The app keeps only the latest of each; earlier ones are in the media trace as request.error.\n\n" + errors.map { "- \($0)" }.joined(separator: "\n") + "\n"
        files.append(("errors.txt", clean(errorText)))
        files.append(("drafts.json", clean((drafts.isEmpty ? "[]" : String(decoding: try json.encode(drafts), as: UTF8.self)) + "\n")))

        var traced = false
        if let trace {
            // Older segment first. A segment missing mid-rotation is not an error.
            for (name, url) in [("media-trace.1.ndjson", trace.appendingPathExtension("1")), ("media-trace.ndjson", trace)] {
                guard let data = try? Data(contentsOf: url), !data.isEmpty else { continue }
                files.append((name, clean(String(decoding: data, as: UTF8.self)))); traced = true
            }
        }
        if !traced { notes.append("No media trace on this phone yet: it starts when a project's picture or model is shown.") }

        files.append(("notes.txt", Data((notes.isEmpty ? "Everything this phone keeps is here.\n" : notes.map { "- \($0)" }.joined(separator: "\n") + "\n").utf8)))
        return files
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
        for (name, data) in try files(date: date) { try data.write(to: staged.appendingPathComponent(name), options: .atomic) }

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
