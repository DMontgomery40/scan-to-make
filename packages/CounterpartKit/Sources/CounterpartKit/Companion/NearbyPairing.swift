import Foundation
import Network
import Security

/// A Mac advertising Counterpart on this Wi-Fi. The advert is only a hint (anyone can advertise); the
/// matching 6-digit code is the proof.
public struct NearbyMac: Equatable, Hashable, Sendable, Identifiable {
    public var name: String
    public var publicKeySha256: String?
    public var id: String { name }
}

/// A nearby session waiting for Allow on the Mac.
public struct NearbyStarted: Equatable, Sendable {
    /// Six digits; show them with `NearbyCrypto.display`.
    public var code: String
    /// The SHA-256 of the key this phone saw on the Mac's TLS connection (S).
    public var publicKeySha256: String
    public var baseUrl: String
    public var expiresAtMs: Double
}

/// The phone's half of nearby pairing (journey.md §3.4, `@scan-to-make/contracts/nearby-pairing`):
/// `browse` lists Macs advertising `_scantomake._tcp`; `pair` resolves one to an IPv4 address, commits to a
/// fresh key, reveals it, shows the code, waits for Allow, then pairs through the ordinary v2 path pinned to
/// the same key. One session at a time; the key and session never leave this type.
@MainActor public final class NearbyPairing {
    public static let serviceType = "_scantomake._tcp"
    private let client: PairingClient
    private let transport: HTTPTransport
    private var browser: NWBrowser?
    private var found: [String: NWBrowser.Result] = [:]
    /// Bumped by every `cancel`: work from an earlier attempt sees a different value and stops.
    private var generation = 0
    private var busy = false

    public init(client: PairingClient, transport: HTTPTransport = PinnedTransport()) {
        self.client = client
        self.transport = transport
    }

    // MARK: Browsing

    /// Macs seen within `timeout`. Throws `local-network` when Local Network access is off. The browser keeps
    /// running afterwards, so `pair` also finds Macs that appear later.
    public func browse(timeout: Duration = .seconds(3)) async throws -> [NearbyMac] {
        stopBrowsing()
        found = [:]
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: "local."), using: parameters)
        self.browser = browser
        return try await withCheckedThrowingContinuation { continuation in
            var settled = false
            func settle(_ result: Result<[NearbyMac], Error>) {
                guard !settled else { return }
                settled = true
                continuation.resume(with: result)
            }
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                MainActor.assumeIsolated {
                    guard let self, self.browser === browser else { return }
                    var next: [String: NWBrowser.Result] = [:]
                    for result in results { if let name = Self.name(result) { next[name] = result } }
                    self.found = next
                }
            }
            browser.stateUpdateHandler = { [weak self] state in
                MainActor.assumeIsolated {
                    switch state {
                    case .cancelled: settle(.failure(PairingError(.cancelled)))
                    case .failed(let error):
                        self?.stopBrowsing()
                        settle(.failure(PairingError(Self.policyDenied(error) ? .localNetwork : .network)))
                    case .waiting(let error) where Self.policyDenied(error):
                        self?.stopBrowsing()
                        settle(.failure(PairingError(.localNetwork)))
                    default: break
                    }
                }
            }
            browser.start(queue: .main)
            let wait = min(max(timeout, .milliseconds(500)), .seconds(10))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: wait)
                guard let self, self.browser === browser else { return }
                settle(.success(self.list))
            }
        }
    }

    public var list: [NearbyMac] {
        found.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }.map { name in
            NearbyMac(name: name, publicKeySha256: Self.keyHint(found[name]))
        }
    }

    public func stopBrowsing() {
        browser?.cancel()
        browser = nil
    }

    /// Ends the session and browsing; work in flight stops with `cancelled`.
    public func cancel() {
        generation += 1
        busy = false
        stopBrowsing()
        found = [:]
    }

    private static func name(_ result: NWBrowser.Result) -> String? {
        if case let .service(name, _, _, _) = result.endpoint { return name }
        return nil
    }

    private static func keyHint(_ result: NWBrowser.Result?) -> String? {
        guard case let .bonjour(txt)? = result?.metadata, let value = txt["k"], Pattern("[a-f0-9]{64}").matches(value) else { return nil }
        return value
    }

    nonisolated static func policyDenied(_ error: NWError) -> Bool {
        if case let .dns(code) = error { return code == -65570 } // kDNSServiceErr_PolicyDenied
        return false
    }

    // MARK: Pairing

    /// Pairs with `mac`: shows the code through `onCode`, waits for Allow (about two minutes at most),
    /// then pairs pinned to the key this phone saw. Throws `nearby-denied` when the Mac says no and
    /// `nearby-expired` when the wait runs out.
    public func pair(with mac: NearbyMac, deviceName: String, onCode: @MainActor (NearbyStarted) -> Void) async throws -> PairingStatus {
        guard !busy else { throw PairingError(.busy) }
        guard let result = found[mac.name], isPlainText(deviceName, max: 80) else { throw PairingError(.invalidInvitation) }
        busy = true
        let attempt = generation
        defer { if attempt == generation { busy = false } }
        func live() throws { if attempt != generation || Task.isCancelled { throw PairingError(.cancelled) } }

        let base = try await resolve(result.endpoint)
        try live()
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PairingError(.unavailable) }
        let key = Data(bytes)
        let seen = NearbySeen()
        // Commit to the key before the Mac's nonce exists.
        let opened = try await post(base, "v1/pair/nearby", ["commit": NearbyCrypto.base64URL(NearbyCrypto.commit(key: key)!), "deviceName": deviceName], seen: seen, timeout: 10)
        try live()
        guard let nonce = NearbyCrypto.bytes(opened["nonce"]?.string),
              let session = opened["session"]?.string, Pattern("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(session),
              let expiresAt = opened["expiresAt"]?.number else { throw PairingError(.invalidResponse) }
        let revealed = try await post(base, "v1/pair/nearby/reveal", ["session": session, "key": NearbyCrypto.base64URL(key)], seen: seen, timeout: 10)
        try live()
        guard revealed["status"]?.string == "waiting", let s = seen.key, let code = NearbyCrypto.code(publicKeySha256: s, key: key, nonce: nonce) else {
            throw PairingError(.invalidResponse)
        }
        let started = NearbyStarted(code: code, publicKeySha256: Hex.string(s), baseUrl: base.absoluteString, expiresAtMs: expiresAt)
        onCode(started)

        // Wait for Allow. A dropped wait keeps the session on the Mac: ask again, but not forever.
        var dropped = 0
        while true {
            try live()
            let answer: [String: JSONValue]
            do {
                answer = try await post(base, "v1/pair/nearby/result", ["session": session, "key": NearbyCrypto.base64URL(key)], seen: seen, timeout: 40)
                dropped = 0
            } catch let error as PairingError where [.network, .timeout].contains(error.code) {
                dropped += 1
                if dropped < 3 { continue }
                throw error
            }
            try live()
            switch answer["status"]?.string {
            case "waiting" where answer["expiresAt"]?.number != nil: continue
            case "denied": throw PairingError(.nearbyDenied)
            case "allowed":
                guard let text = answer["link"]?.string, text.utf8.count <= 4096,
                      case let .v2(addresses, linkCode, expires, linkKey, name)? = try? PairingLink.parse(text),
                      linkKey == started.publicKeySha256 else { throw PairingError(.invalidResponse) }
                // The link came over the connection pinned to S; a different key means a broken Mac.
                let invitation = PairingInvitation(baseUrl: addresses[0], code: linkCode, expiresAt: expires, addresses: addresses, publicKeySha256: linkKey, name: name)
                return try await client.pair(invitation, deviceName: deviceName)
            default: throw PairingError(.invalidResponse)
            }
        }
    }

    /// The advertised service's IPv4 address and port, as an origin the pin rules accept.
    private func resolve(_ endpoint: NWEndpoint) async throws -> URL {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        return try await withCheckedThrowingContinuation { continuation in
            var finished = false
            func finish(_ result: Result<URL, Error>) {
                guard !finished else { return }
                finished = true
                connection.cancel()
                continuation.resume(with: result)
            }
            connection.stateUpdateHandler = { state in
                MainActor.assumeIsolated {
                    switch state {
                    case .ready:
                        if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint, case let .ipv4(address) = host,
                           address.rawValue.count == 4,
                           let url = CompanionAddress.pinnedBaseURL("https://\(address.rawValue.map(String.init).joined(separator: ".")):\(port.rawValue)", pin: String(repeating: "0", count: 64)) {
                            finish(.success(url))
                        } else { finish(.failure(PairingError(.network))) }
                    case .failed: finish(.failure(PairingError(.network)))
                    case .cancelled: finish(.failure(PairingError(.cancelled)))
                    case .waiting(let error) where Self.policyDenied(error): finish(.failure(PairingError(.localNetwork)))
                    default: break
                    }
                }
            }
            connection.start(queue: .main)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(8))
                finish(.failure(PairingError(.timeout)))
            }
        }
    }

    private func post(_ base: URL, _ path: String, _ body: [String: String], seen: NearbySeen, timeout: TimeInterval) async throws -> [String: JSONValue] {
        var request = URLRequest(url: base.appending(path: path), timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = JSONValue.data(body.mapValues(JSONValue.string))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let reply: HTTPReply
        do { reply = try await transport.send(request, trust: .nearby(base: base, seen: seen), limit: 16_384, resourceTimeout: 45) }
        catch let error as TransportError { throw PairingClient.error(error.code == "too-large" ? "invalid-response" : error.code) }
        guard reply.status == 200 else {
            switch reply.status {
            case 401: throw PairingError(.nearbyExpired)
            case 403: throw PairingError(.forbidden)
            case 429: throw PairingError(.rateLimited)
            default: throw PairingError(.unavailable)
            }
        }
        return JSONValue.object(from: reply.body) ?? [:]
    }
}
