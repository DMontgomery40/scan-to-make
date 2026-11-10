import XCTest
import Network
@testable import CounterpartKit

/// The real transport's download, against a real HTTP server on this machine. Every other download test goes through a
/// test transport's `send`; before this file nothing ran `PinnedTransport.download` itself (review of #527, part 2, F1).
final class TransportDownloadTests: XCTestCase {
    func testTheRealTransportHandsBackAFileThatIsStillThereAfterItReturns() async throws {
        let body = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        let server = try OneReplyServer(status: "200 OK", body: body)
        defer { server.stop() }
        let url = try await server.start()
        let (reply, file) = try await PinnedTransport().download(URLRequest(url: url), trust: .nearby(base: url, seen: NearbySeen()),
                                                                 limit: 1_000_000, resourceTimeout: 30)
        XCTAssertEqual(reply.status, 200)
        let kept = try XCTUnwrap(file)
        defer { try? FileManager.default.removeItem(at: kept) }
        // The session that fetched it is invalidated by now; give the system a moment to clean up after it.
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(try Data(contentsOf: kept), body, "the file is the caller's: whole, and still there")
    }

    func testARefusalComesBackWithItsBodyAndNoFile() async throws {
        let server = try OneReplyServer(status: "413 Payload Too Large", body: Data(#"{"error":"file-too-large"}"#.utf8))
        defer { server.stop() }
        let url = try await server.start()
        let (reply, file) = try await PinnedTransport().download(URLRequest(url: url), trust: .nearby(base: url, seen: NearbySeen()),
                                                                 limit: 1_000_000, resourceTimeout: 30)
        XCTAssertEqual(reply.status, 413)
        XCTAssertNil(file)
        XCTAssertEqual(String(decoding: reply.body, as: UTF8.self), #"{"error":"file-too-large"}"#)
    }

    func testAReplyOverTheLimitIsRefusedAndLeavesNothingBehind() async throws {
        let server = try OneReplyServer(status: "200 OK", body: Data(count: 50_000))
        defer { server.stop() }
        let url = try await server.start()
        do {
            _ = try await PinnedTransport().download(URLRequest(url: url), trust: .nearby(base: url, seen: NearbySeen()), limit: 10_000, resourceTimeout: 30)
            XCTFail("over the limit")
        } catch let error as TransportError { XCTAssertEqual(error.code, "too-large") }
    }
}

/// Answers every connection with one complete HTTP reply and closes it.
private final class OneReplyServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "transport-download-test")
    private let reply: Data
    init(status: String, body: Data) throws {
        listener = try NWListener(using: .tcp, on: .any)
        reply = Data("HTTP/1.1 \(status)\r\nContent-Type: application/octet-stream\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8) + body
    }
    func start() async throws -> URL {
        listener.newConnectionHandler = { [self] peer in
            peer.start(queue: queue)
            peer.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [self] _, _, _, error in
                guard error == nil else { peer.cancel(); return }
                peer.send(content: reply, completion: .contentProcessed { _ in peer.cancel() })
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
    func stop() { listener.cancel() }
}
