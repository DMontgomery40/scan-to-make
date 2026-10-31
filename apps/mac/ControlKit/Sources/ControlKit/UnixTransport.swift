import Foundation
import Network

/// One connection, one request, one response. A timeout never retries a mutation.
final class UnixExchange: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.scantomake.control.exchange")
    private let path: String, payload: Data, timeout: TimeInterval
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<Data, Error>?
    private var deadline: DispatchWorkItem?
    private var response = Data()
    private var sent = false, finished = false, cancelled = false
    init(path: String, payload: Data, timeout: TimeInterval) {
        self.path = path; self.payload = payload; self.timeout = timeout
    }
    func cancel() {
        queue.async {
            self.cancelled = true
            if self.continuation != nil { self.finish(.failure(ControlClientError.cancelled)) }
        }
    }
    func start(_ continuation: CheckedContinuation<Data, Error>) {
        queue.async {
            self.continuation = continuation
            if self.cancelled { self.finish(.failure(ControlClientError.cancelled)); return }
            let connection = NWConnection(to: .unix(path: self.path), using: .tcp)
            self.connection = connection
            let deadline = DispatchWorkItem { [weak self] in self?.finish(.failure(ControlClientError.timedOut)) }
            self.deadline = deadline
            self.queue.asyncAfter(deadline: .now() + self.timeout, execute: deadline)
            connection.stateUpdateHandler = { [weak self] state in
                guard let self, !self.finished else { return }
                switch state {
                case .ready:
                    guard !self.sent else { return }
                    self.sent = true
                    connection.send(content: self.payload, completion: .contentProcessed { [weak self] error in
                        guard let self, !self.finished else { return }
                        if error != nil { self.finish(.failure(ControlClientError.unavailable)) }
                        else { self.receive() }
                    })
                case .failed: self.finish(.failure(ControlClientError.unavailable))
                case .waiting:
                    if !self.sent { self.finish(.failure(ControlClientError.unavailable)) }
                default: break
                }
            }
            connection.start(queue: self.queue)
        }
    }
    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, !self.finished else { return }
            // Scan each incoming byte once; rescanning the growing buffer is
            // quadratic for large confirmation photos or job pages.
            let priorCount = self.response.count
            let newline = data.flatMap { chunk in chunk.firstIndex(of: 10).map { priorCount + chunk.distance(from: chunk.startIndex, to: $0) } }
            if let data { self.response.append(data) }
            if self.response.count > 8 * 1024 * 1024 { self.finish(.failure(ControlClientError.invalidResponse)); return }
            if let newline {
                guard newline == self.response.count - 1 else { self.finish(.failure(ControlClientError.invalidResponse)); return }
                self.finish(.success(Data(self.response[..<newline])))
            } else if error != nil || complete { self.finish(.failure(ControlClientError.invalidResponse)) }
            else { self.receive() }
        }
    }
    private func finish(_ result: Result<Data, Error>) {
        guard !finished else { return }
        finished = true
        deadline?.cancel(); deadline = nil
        connection?.stateUpdateHandler = nil
        connection?.cancel(); connection = nil
        continuation?.resume(with: result); continuation = nil
    }
}
