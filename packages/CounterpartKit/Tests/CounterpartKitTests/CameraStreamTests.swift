import XCTest
import Network
@testable import CounterpartKit

private final class CameraTransport: HTTPTransport, @unchecked Sendable {
    var reply = HTTPReply(status: 200, body: Data(), headers: ["Content-Type": "application/x-ndjson", "X-Camera-Protocol": "1"])
    var records: [Data] = []
    var beforeLine: (() throws -> Void)?
    var streamFailure: TransportError?
    var health: ((URLRequest) throws -> HTTPReply)?
    var stopped: (() -> Void)?
    var request: URLRequest?
    var trust: TrustPolicy?
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        if let health { return try health(request) }
        XCTFail("Streaming must not issue snapshot requests"); throw TransportError("network")
    }
    func lines(_ request: URLRequest, trust: TrustPolicy, lineLimit: Int,
               response: (HTTPReply) throws -> Void, line: (Data) throws -> Void) async throws {
        self.request = request; self.trust = trust
        XCTAssertEqual(lineLimit, 65_536)
        defer { stopped?() }
        if let streamFailure { throw streamFailure }
        try response(reply)
        for data in records { try beforeLine?(); try line(data) }
        try await Task.sleep(for: .seconds(60))
    }
}

final class CameraStreamTests: XCTestCase {
    private func wire(_ extra: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 1, "seq": 0, "capturedAt": "2026-11-02T12:00:00.000Z", "base64": Data([0xff, 0xd8, 0xff, 0xd9]).base64EncodedString()].merging(extra) { $1 })
    }
    private func client(_ transport: CameraTransport) throws -> CompanionClient {
        let store = PairingStore(store: MemoryStore(), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        try store.save(v2Record(), notify: false)
        return CompanionClient(pairing: PairingClient(store: store, transport: transport), transport: transport)
    }
    func testLinesAreBoundedBeforeNewlineAndCanArriveInArbitraryChunks() throws {
        var buffer = HTTPLineBuffer(limit: 5)
        var lines: [Data] = []
        for chunk in [Data("a".utf8), Data("b\n\nxy".utf8), Data("z\n".utf8)] {
            for byte in chunk { if let line = try buffer.append(byte) { lines.append(line) } }
        }
        XCTAssertEqual(lines, [Data("ab".utf8), Data(), Data("xyz".utf8)])
        XCTAssertTrue(buffer.isEmpty)
        for byte in Data("12345".utf8) { _ = try buffer.append(byte) }
        XCTAssertThrowsError(try buffer.append(10)) { XCTAssertEqual($0 as? TransportError, .init("too-large")) }
    }
    func testFrameValidationRejectsInvalidOrOutOfOrderEvidence() throws {
        var decoder = CameraFrameDecoder(fullScreen: false)
        XCTAssertNil(try decoder.decode(Data()))
        XCTAssertNil(try decoder.decode(Data([13])))
        XCTAssertEqual(try decoder.decode(wire())?.jpeg, Data([0xff, 0xd8, 0xff, 0xd9]))
        XCTAssertThrowsError(try decoder.decode(wire()), "sequence must advance")
        for invalid in [["v": 2], ["seq": -1], ["capturedAt": "not a date"], ["base64": "garbage"], ["base64": Data(repeating: 0xff, count: 20_001).base64EncodedString()]] {
            var fresh = CameraFrameDecoder(fullScreen: false)
            XCTAssertThrowsError(try fresh.decode(wire(invalid)))
        }
        var full = CameraFrameDecoder(fullScreen: true)
        let large = Data([0xff, 0xd8, 0xff]) + Data(repeating: 0, count: 41_997)
        XCTAssertEqual(try full.decode(wire(["base64": large.base64EncodedString()]))?.jpeg.count, 42_000)
    }
    func testStreamYieldsBeforeResponseEndsAndCancellationStopsTheProducer() async throws {
        let transport = CameraTransport(); transport.records = [try wire()]
        let stopped = expectation(description: "transport released")
        transport.stopped = { stopped.fulfill() }
        let client = try client(transport)
        let received = expectation(description: "frame arrived while request remained open")
        let task = Task {
            do {
                for try await frame in client.cameraFrames(printer: "mcp-1", fullScreen: true) {
                    XCTAssertTrue(frame.streaming); received.fulfill()
                }
            } catch {}
        }
        await fulfillment(of: [received], timeout: 2)
        XCTAssertEqual(transport.request?.url?.path, "/v1/objects/printers/mcp-1/camera.jpg")
        XCTAssertEqual(transport.request?.url?.query, "stream=1&size=full")
        XCTAssertEqual(transport.request?.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        guard case .record(let record)? = transport.trust else { task.cancel(); return XCTFail("missing pin") }
        XCTAssertEqual(record.publicKeySha256, keyPin)
        task.cancel()
        await fulfillment(of: [stopped], timeout: 2)
        await task.value
    }
    func testOnlyExplicitUnsupportedOrLegacyJPEGAllowsSnapshotFallback() async throws {
        let cases: [(HTTPReply, String)] = [
            (.init(status: 200, body: Data(), headers: ["Content-Type": "image/jpeg"]), "not-supported"),
            (json(404, ["error": ["code": "not-supported"]]), "not-supported"),
            (json(404, ["error": ["code": "not-found"]]), "unavailable"),
            (json(503, ["error": ["code": "unavailable"]]), "unavailable"),
            (json(403, ["error": ["code": "scope-denied"]]), "pairing"),
            (.init(status: 200, body: Data(), headers: ["Content-Type": "application/x-ndjson", "X-Camera-Protocol": "2"]), "invalid-response")
        ]
        for (reply, expected) in cases {
            let transport = CameraTransport(); transport.reply = reply
            do { for try await _ in try client(transport).cameraFrames(printer: "mcp-1") { XCTFail() }; XCTFail() }
            catch let error as CompanionError { XCTAssertEqual(error.code, expected) }
        }
    }
    func testNetworkFailureRecoversThePairedAddressBeforeTheNextStreamAttempt() async throws {
        let transport = CameraTransport(); transport.streamFailure = .init("network")
        transport.health = { request in
            XCTAssertEqual(request.url?.path, "/healthz", "only address recovery, no snapshot fallback")
            if request.url?.host == "192.168.68.123" { throw TransportError("network") }
            return json(200, ["protocolVersion": PairingRecord.protocolVersion])
        }
        let client = try client(transport)
        do { for try await _ in client.cameraFrames(printer: "mcp-1") { XCTFail() }; XCTFail() }
        catch let error as CompanionError { XCTAssertEqual(error.code, "unreachable") }
        XCTAssertEqual(try client.pairing.store.read()?.activeUrl, "https://davids-mac-mini.local:9077")
    }

    func testPairingChangeRejectsTheNextFrameEvenOnAnAlreadyOpenStream() async throws {
        let transport = CameraTransport(); transport.records = [try wire()]
        let client = try client(transport)
        transport.beforeLine = { try client.pairing.store.disconnect() }
        do { for try await _ in client.cameraFrames(printer: "mcp-1") { XCTFail() }; XCTFail() }
        catch let error as CompanionError { XCTAssertEqual(error.code, "pairing-changed") }
    }
}

/// A real HTTP response that remains open after its first line. No printer or live companion involved.
private final class CameraHTTPFixture: @unchecked Sendable {
    let listener: NWListener
    let queue = DispatchQueue(label: "camera-stream-test")
    private let lock = NSLock()
    private var peers: [NWConnection] = []
    init() throws { listener = try NWListener(using: .tcp, on: .any) }
    func start(disconnected: @escaping () -> Void) async throws -> URL {
        listener.newConnectionHandler = { [self] peer in
            lock.lock(); peers.append(peer); lock.unlock()
            peer.start(queue: queue)
            peer.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { _, _, _, error in
                guard error == nil else { return }
                peer.send(content: Data("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\nfirst\n".utf8), completion: .contentProcessed { _ in
                    peer.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, ended, error in
                        if ended || error != nil { disconnected() }
                    }
                })
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            listener.stateUpdateHandler = { [self] state in
                switch state {
                case .ready: listener.stateUpdateHandler = nil; continuation.resume()
                case .failed(let error): listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return URL(string: "http://127.0.0.1:\(listener.port!.rawValue)")!
    }
    func stop() {
        listener.cancel()
        lock.lock(); let peers = peers; self.peers = []; lock.unlock()
        for peer in peers { peer.cancel() }
    }
}

extension CameraStreamTests {
    func testPinnedTransportDeliversAnOpenHTTPResponseAndClosesItOnCancellation() async throws {
        let disconnected = expectation(description: "HTTP peer saw cancellation")
        let firstLine = expectation(description: "line before EOF")
        let server = try CameraHTTPFixture()
        defer { server.stop() }
        let url = try await server.start { disconnected.fulfill() }
        let task = Task {
            do {
                try await PinnedTransport().lines(URLRequest(url: url), trust: .nearby(base: url, seen: NearbySeen()), lineLimit: 65_536,
                    response: { XCTAssertEqual($0.status, 200) },
                    line: { XCTAssertEqual($0, Data("first".utf8)); firstLine.fulfill() })
                XCTFail("The server holds the request open")
            } catch let error as TransportError { XCTAssertEqual(error.code, "cancelled") }
        }
        await fulfillment(of: [firstLine], timeout: 5)
        task.cancel()
        await fulfillment(of: [disconnected], timeout: 5)
        try await task.value
    }
}
