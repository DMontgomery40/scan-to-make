import Foundation

/// One HTTP answer from the companion.
public struct HTTPReply: Sendable {
    public var status: Int
    public var body: Data
    public var headers: [String: String]
    public init(status: Int, body: Data, headers: [String: String] = [:]) { self.status = status; self.body = body; self.headers = headers }
    public func header(_ name: String) -> String? { headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value }
}

/// A transport failure, in the codes the screens turn into words.
public struct TransportError: Error, Equatable, Sendable {
    /// `network`, `timeout`, `certificate`, `certificate-changed`, `too-large` or `cancelled`.
    public var code: String
    public init(_ code: String) { self.code = code }
}

/// Who the server must be for a request.
public enum TrustPolicy: Sendable {
    /// The paired companion: its pin when it has one (v1 certificate, v2 public key), else system trust.
    case record(PairingRecord)
    /// A pairing attempt at one address, pinned like the record it would become.
    case pending(PairingRecord)
    /// Nearby pairing: trust on first use, then only that key. `seen` carries S between requests.
    case nearby(base: URL, seen: NearbySeen)
}

/// The key a nearby session saw first (S), shared by its requests.
public final class NearbySeen: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?
    public init() {}
    public var key: Data? { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ key: Data) { lock.lock(); value = key; lock.unlock() }
}

/// Sends requests to the companion. The default is `PinnedTransport`; tests supply their own.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply
    /// Calls response once, then each bounded line in order on the calling task. Error bodies are bounded too.
    func lines(_ request: URLRequest, trust: TrustPolicy, lineLimit: Int,
               response: (HTTPReply) throws -> Void, line: (Data) throws -> Void) async throws
}

public extension HTTPTransport {
    func lines(_ request: URLRequest, trust: TrustPolicy, lineLimit: Int,
               response: (HTTPReply) throws -> Void, line: (Data) throws -> Void) async throws {
        throw CompanionError.unsupported
    }
}

/// Keeps the bound before allocation, including a peer that never sends a newline.
struct HTTPLineBuffer {
    let limit: Int
    private var bytes = Data()
    init(limit: Int) { self.limit = limit }
    mutating func append(_ byte: UInt8) throws -> Data? {
        guard bytes.count < limit else { throw TransportError("too-large") }
        if byte == 10 { let complete = bytes; bytes.removeAll(keepingCapacity: true); return complete }
        bytes.append(byte)
        return nil
    }
    var isEmpty: Bool { bytes.isEmpty }
}

/// URLSession with exactly the pinning the app has always used: a pinned companion is trusted only by its
/// certificate or key, on its own host and port; redirects are refused; replies over `limit` bytes are cut
/// off as they arrive, never buffered first.
public struct PinnedTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let exchange = Exchange(trust: trust, limit: limit)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = resourceTimeout
        let session = URLSession(configuration: configuration, delegate: exchange, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                exchange.start(task, continuation)
            }
        } onCancel: {
            task.cancel()
        }
    }

    public func lines(_ request: URLRequest, trust: TrustPolicy, lineLimit: Int,
                      response: (HTTPReply) throws -> Void, line: (Data) throws -> Void) async throws {
        let delegate = TrustDelegate(trust: trust)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = 86_400
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        do {
            try await withTaskCancellationHandler {
                let (bytes, answer) = try await session.bytes(for: request, delegate: delegate)
                var headers: [String: String] = [:]
                for (key, value) in (answer as? HTTPURLResponse)?.allHeaderFields ?? [:] {
                    if let key = key as? String, let value = value as? String { headers[key] = value }
                }
                var reply = HTTPReply(status: (answer as? HTTPURLResponse)?.statusCode ?? 0, body: Data(), headers: headers)
                if reply.status != 200 {
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        guard reply.body.count < 16_384 else { throw TransportError("too-large") }
                        reply.body.append(byte)
                    }
                    try response(reply)
                    return
                }
                try response(reply)
                var buffer = HTTPLineBuffer(limit: lineLimit)
                for try await byte in bytes {
                    try Task.checkCancellation()
                    if let complete = try buffer.append(byte) { try line(complete) }
                }
                guard buffer.isEmpty else { throw TransportError("network") }
            } onCancel: { session.invalidateAndCancel() }
        } catch {
            if Task.isCancelled || error is CancellationError { throw TransportError("cancelled") }
            if error is CompanionError || error is TransportError { throw error }
            throw TransportError(delegate.rejectedPin ? "certificate-changed" : Self.code(for: error))
        }
    }

    static func code(for error: Error) -> String {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return "network" }
        if error.code == NSURLErrorCancelled { return "cancelled" }
        if error.code <= NSURLErrorSecureConnectionFailed && error.code >= NSURLErrorClientCertificateRequired { return "certificate" }
        if error.code == NSURLErrorTimedOut { return "timeout" }
        return "network"
    }

    /// Shared by buffered and streaming requests: redirects never bypass the paired endpoint's pin.
    private class TrustDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let trust: TrustPolicy
        private let lock = NSLock()
        private var pinRejected = false
        var rejectedPin: Bool { lock.lock(); defer { lock.unlock() }; return pinRejected }
        init(trust: TrustPolicy) { self.trust = trust }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            let space = challenge.protectionSpace
            guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let serverTrust = space.serverTrust else {
                completionHandler(.performDefaultHandling, nil); return
            }
            let leaf = CompanionTrust.leaf(serverTrust)
            switch trust {
            case .record(let record), .pending(let record):
                guard record.pin != nil else { completionHandler(.performDefaultHandling, nil); return }
                if CompanionTrust.accepts(record: record, host: space.host, port: space.port, leafCertificate: leaf) {
                    completionHandler(.useCredential, URLCredential(trust: serverTrust))
                } else {
                    lock.lock(); pinRejected = true; lock.unlock()
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
            case .nearby(let base, let seen):
                if let key = NearbyCrypto.trust(host: space.host, port: space.port, leafCertificate: leaf, base: base, seen: seen.key) {
                    seen.set(key)
                    completionHandler(.useCredential, URLCredential(trust: serverTrust))
                } else {
                    lock.lock(); pinRejected = seen.key != nil; lock.unlock()
                    completionHandler(.cancelAuthenticationChallenge, nil)
                }
            }
        }

    }

    private final class Exchange: TrustDelegate, URLSessionDataDelegate, @unchecked Sendable {
        let limit: Int
        private let lock = NSLock()
        private var continuation: CheckedContinuation<HTTPReply, Error>?
        private var received = Data()
        private var status = 0
        private var headers: [String: String] = [:]
        private var tooLarge = false

        init(trust: TrustPolicy, limit: Int) { self.limit = limit; super.init(trust: trust) }

        func start(_ task: URLSessionDataTask, _ continuation: CheckedContinuation<HTTPReply, Error>) {
            lock.lock(); self.continuation = continuation; lock.unlock()
            task.resume()
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            lock.lock()
            if response.expectedContentLength > Int64(limit) { tooLarge = true; lock.unlock(); completionHandler(.cancel); return }
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            for (key, value) in (response as? HTTPURLResponse)?.allHeaderFields ?? [:] {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            lock.unlock()
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock()
            if data.count > limit - min(limit, received.count) { tooLarge = true; lock.unlock(); dataTask.cancel(); return }
            received.append(data)
            lock.unlock()
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let continuation = self.continuation; self.continuation = nil
            let result: Result<HTTPReply, Error>
            if tooLarge { result = .failure(TransportError("too-large")) }
            else if let error {
                result = .failure(TransportError(rejectedPin ? "certificate-changed" : PinnedTransport.code(for: error)))
            } else { result = .success(HTTPReply(status: status, body: received, headers: headers)) }
            lock.unlock()
            continuation?.resume(with: result)
        }
    }
}
