import Foundation

/// Runs one operation at a time, in the order asked: the app's one queue of pairing calls to the Mac, so
/// a credential refresh never meets a pairing or a connection check halfway.
public actor SerialGate {
    private var tail: Task<Void, Never>?
    public init() {}
    public func run<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task { () async throws -> T in
            await previous?.value
            try Task.checkCancellation()
            return try await operation()
        }
        tail = Task { _ = try? await task.value }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}

/// Pairing with a companion and keeping that pairing: pair from an invitation (v1 at one address, v2 at
/// each address in order with the public-key pin), check the stored credential (moving to whichever of the
/// Mac's addresses answers), and refresh it (`POST /v1/auth/refresh`). The token never leaves this type
/// and `PairingStore`.
public final class PairingClient: @unchecked Sendable {
    public let store: PairingStore
    private let transport: HTTPTransport
    private let now: @Sendable () -> Date
    public let gate = SerialGate()
    static let lifetimeLimitMs = 31.0 * 86_400_000
    /// Bumped by `forget`: a pairing, check or refresh that began before it never writes afterwards.
    private let lock = NSLock()
    private var generation = 0
    static let maxReply = 16_384

    public init(store: PairingStore, transport: HTTPTransport = PinnedTransport(), now: @escaping @Sendable () -> Date = Date.init) {
        self.store = store; self.transport = transport; self.now = now
    }

    // MARK: Pairing

    /// Pairs with an invitation, under `deviceName`, and stores the new record. Queued behind any other call.
    public func pair(_ invitation: PairingInvitation, deviceName: String) async throws -> PairingStatus {
        do { return try await gate.run { try await self.pairNow(invitation, deviceName: deviceName) } }
        catch is CancellationError { throw PairingError(.cancelled) }
    }

    /// Forgets the paired Mac at once. A call still answering never brings the pairing back.
    public func forget() throws {
        lock.lock(); defer { lock.unlock() }
        generation += 1
        try store.disconnect()
    }

    private var currentGeneration: Int { lock.lock(); defer { lock.unlock() }; return generation }

    /// Saves only if nothing was forgotten since `started`, and the calling task is still wanted.
    private func save(_ record: PairingRecord, notify: Bool, since started: Int) throws {
        if Task.isCancelled { throw PairingError(.cancelled) }
        lock.lock(); defer { lock.unlock() }
        guard generation == started else { throw PairingError(.pairingChanged) }
        do { try store.save(record, notify: notify) } catch { throw PairingError(.secureStorage) }
    }

    func pairNow(_ invitation: PairingInvitation, deviceName: String) async throws -> PairingStatus {
        let started = currentGeneration
        guard Pattern("[A-Za-z0-9_-]{32}").matches(invitation.code), isPlainText(deviceName, max: 80) else {
            throw PairingError(.invalidInvitation)
        }
        let installation: String, snapshot: PairingRecord?
        do { installation = try store.installationKey(); snapshot = try store.read() }
        catch { throw PairingError(.secureStorage) }

        // v1: one address, its certificate pin (or Tailscale Serve).
        guard let key = invitation.publicKeySha256 else {
            let pin = invitation.certificateSha256
            guard let url = pin != nil ? CompanionAddress.pinnedBaseURL(invitation.baseUrl, pin: pin) : CompanionAddress.companionBaseURL(invitation.baseUrl)
            else { throw PairingError(.invalidInvitation) }
            var pending: [String: JSONValue] = ["baseUrl": .string(url.absoluteString)]
            if let pin { pending["certificateSha256"] = .string(pin) }
            do {
                return try await pairAt(PairingRecord(fields: pending), code: invitation.code, name: deviceName, installation: installation, snapshot: snapshot, since: started)
            } catch let error as TransportError {
                throw Self.error(error.code == "too-large" ? "invalid-response" : error.code)
            }
        }
        // v2: each address in order, pinned to the public key; the one that answers becomes baseUrl.
        guard CompanionAddress.validPin(key), let list = CompanionAddress.pinnedAddresses(invitation.addresses, pin: key) else {
            throw PairingError(.invalidInvitation)
        }
        var failure: String?
        for (index, address) in list.enumerated() {
            let pending = PairingRecord(fields: ["addresses": .array(list.map(JSONValue.string)), "publicKeySha256": .string(key), "baseUrl": .string(address)])
            do {
                return try await pairAt(pending, code: invitation.code, name: deviceName, installation: installation, snapshot: snapshot, since: started)
            } catch let error as TransportError {
                let code = error.code == "too-large" ? "invalid-response" : error.code
                // An unreachable address beats another server's certificate as the reason to report.
                if failure == nil || ["network", "timeout"].contains(code) { failure = code }
                let remaining = index < list.count - 1
                if remaining && CompanionAddress.tryNext(after: code) { continue }
                throw Self.error(remaining ? code : failure ?? code)
            }
        }
        throw Self.error(failure ?? "network")
    }

    private func pairAt(_ pending: PairingRecord, code: String, name: String, installation: String, snapshot: PairingRecord?, since started: Int) async throws -> PairingStatus {
        guard let base = pending.requestBaseURL else { throw PairingError(.invalidInvitation) }
        var request = URLRequest(url: base.appending(path: "v1/pair"), timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpBody = JSONValue.data(["code": .string(code), "deviceName": .string(name), "installationKey": .string(installation)])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The previous token only goes to the same trusted Mac. It lets that Mac replace this phone's
        // earlier row; a public device id alone is never proof.
        if let snapshot, Self.sameCompanion(snapshot, pending), let token = snapshot.token, let device = snapshot.deviceId {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
        }
        let reply = try await transport.send(request, trust: .pending(pending), limit: Self.maxReply, resourceTimeout: 15)
        try Self.check(reply.status)
        guard var fields = JSONValue.object(from: reply.body) else { throw PairingError(.invalidResponse) }
        // The address, pin and address list come from the invitation, never the response.
        for key in ["certificateSha256", "publicKeySha256", "addresses", "activeUrl"] { fields[key] = nil }
        for key in ["baseUrl", "certificateSha256", "publicKeySha256", "addresses"] { if let v = pending.fields[key] { fields[key] = v } }
        let record = PairingRecord(fields: fields)
        let nowMs = now().timeIntervalSince1970 * 1000
        guard record.isValid, record.expiresAtMs > nowMs, record.expiresAtMs <= nowMs + Self.lifetimeLimitMs else { throw PairingError(.invalidResponse) }
        // A pairing whose screen has closed never replaces the stored one.
        try save(record, notify: true, since: started)
        return PairingStatus(record, now: now())
    }

    static func sameCompanion(_ previous: PairingRecord, _ invitation: PairingRecord) -> Bool {
        if invitation.publicKeySha256 != nil || previous.publicKeySha256 != nil {
            return previous.publicKeySha256 != nil && previous.publicKeySha256 == invitation.publicKeySha256
        }
        if invitation.certificateSha256 != nil || previous.certificateSha256 != nil {
            return previous.certificateSha256 != nil && previous.certificateSha256 == invitation.certificateSha256
        }
        return previous.baseUrl == invitation.baseUrl
    }

    // MARK: Checking and refreshing

    /// Checks the stored credential at the Mac's addresses in order (`GET /healthz`). Another address that
    /// answers is kept first for every later request; that is still the same pairing.
    public func check() async throws -> PairingStatus {
        try await gate.run { try await self.checkNow() }
    }

    func checkNow() async throws -> PairingStatus {
        let started = currentGeneration
        let snapshot = try current()
        var failure: String?
        let order = snapshot.attemptOrder
        for (index, address) in order.enumerated() {
            var attempt = snapshot
            if address == snapshot.baseUrl { attempt.fields["activeUrl"] = nil } else { attempt.fields["activeUrl"] = .string(address) }
            guard let base = attempt.requestBaseURL, let token = attempt.token, let device = attempt.deviceId else { throw PairingError(.secureStorage) }
            var request = URLRequest(url: base.appending(path: "healthz"), timeoutInterval: 10)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
            let reply: HTTPReply
            do { reply = try await transport.send(request, trust: .record(attempt), limit: Self.maxReply, resourceTimeout: 15) }
            catch let error as TransportError {
                let code = error.code == "too-large" ? "invalid-response" : error.code
                if failure == nil || ["network", "timeout"].contains(code) { failure = code }
                let remaining = index < order.count - 1
                if remaining && CompanionAddress.tryNext(after: code) { continue }
                throw Self.error(remaining ? code : failure ?? code)
            }
            try Self.check(reply.status)
            let latest: PairingRecord?
            do { latest = try store.read() } catch { throw PairingError(.pairingChanged) }
            guard latest == snapshot else { throw PairingError(.pairingChanged) }
            guard JSONValue.object(from: reply.body)?["protocolVersion"]?.string == PairingRecord.protocolVersion else { throw PairingError(.invalidResponse) }
            if attempt != snapshot { try save(attempt, notify: false, since: started) }
            return PairingStatus(attempt, now: now())
        }
        throw Self.error(failure ?? "network")
    }

    /// Asks the Mac for another full lifetime of the same credential. Only the expiry and scopes change.
    public func refresh() async throws -> PairingStatus {
        try await gate.run { try await self.refreshNow() }
    }

    func refreshNow() async throws -> PairingStatus {
        let started = currentGeneration
        let snapshot = try current()
        guard let base = snapshot.requestBaseURL, let token = snapshot.token, let device = snapshot.deviceId else { throw PairingError(.secureStorage) }
        var request = URLRequest(url: base.appending(path: "v1/auth/refresh"), timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpBody = Data()
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(device, forHTTPHeaderField: "X-Scan-Device")
        let reply: HTTPReply
        do { reply = try await transport.send(request, trust: .record(snapshot), limit: Self.maxReply, resourceTimeout: 15) }
        catch let error as TransportError { throw Self.error(error.code == "too-large" ? "invalid-response" : error.code) }
        try Self.check(reply.status)
        guard let json = JSONValue.object(from: reply.body) else { throw PairingError(.invalidResponse) }
        let latest: PairingRecord?
        do { latest = try store.read() } catch { throw PairingError(.pairingChanged) }
        guard var record = latest, record == snapshot else { throw PairingError(.pairingChanged) }
        record.fields["expiresAt"] = json["expiresAt"]
        record.fields["scopes"] = json["scopes"]
        let nowMs = now().timeIntervalSince1970 * 1000
        guard json["protocolVersion"] == snapshot.fields["protocolVersion"], json["deviceId"] == snapshot.fields["deviceId"],
              json["token"] == snapshot.fields["token"], record.isValid,
              record.expiresAtMs > nowMs, record.expiresAtMs <= nowMs + Self.lifetimeLimitMs else { throw PairingError(.invalidResponse) }
        try save(record, notify: false, since: started)
        return PairingStatus(record, now: now())
    }

    /// The current, unexpired record, or the reason there isn't one.
    private func current() throws -> PairingRecord {
        let record: PairingRecord?
        do { record = try store.read() } catch { throw PairingError(.secureStorage) }
        guard let record, !record.isExpired(now: now()) else { throw PairingError(.pairingRequired) }
        return record
    }

    static func check(_ status: Int) throws {
        guard status != 200 else { return }
        switch status {
        case 401: throw PairingError(.unauthorized)
        case 403: throw PairingError(.forbidden)
        case 429: throw PairingError(.rateLimited)
        case 300..<400: throw PairingError(.wrongHost)
        default: throw PairingError(.unavailable)
        }
    }

    static func error(_ code: String) -> PairingError {
        PairingError(PairingError.Code(rawValue: code) ?? .network)
    }
}

/// Keeps the paired Mac's credential alive. A credential lasts 30 days; under 20 days left, the phone asks
/// for another 30 days of the same one, so at most about every 10 days.
public enum PairingFreshness: Equatable, Sendable {
    case fresh, refreshed, skipped, pairAgain

    public static let refreshWithinMs = 20.0 * 86_400_000

    /// Quiet unless the Mac refuses the credential; a Mac that can't be reached is asked again next time.
    public static func keep(_ client: PairingClient, now: Date = Date()) async -> PairingFreshness {
        guard let status = try? client.store.status(now: now) else { return .skipped }
        if status.state == .expired { return .pairAgain }
        guard status.state == .paired, let expires = status.expiresAtMs else { return .skipped }
        if expires - now.timeIntervalSince1970 * 1000 > refreshWithinMs { return .fresh }
        do { _ = try await client.refresh(); return .refreshed }
        catch let error as PairingError where [.unauthorized, .forbidden, .pairingRequired].contains(error.code) { return .pairAgain }
        catch { return .skipped }
    }
}
