import Foundation

/// Logical ownership of optional media work. Never waits for an uncooperative child to exit.
/// Deadlines release logical permits; late framework completions cannot publish or remove a newer generation.
@MainActor final class MediaWork<Value> {
    private struct Waiter {
        let continuation: CheckedContinuation<Value?, Never>
        let demand: MediaDemand
    }
    private final class Entry {
        let generation = UUID()
        var waiters: [UUID: Waiter] = [:]
        var worker: Task<Void, Never>?
        var deadline: Task<Void, Never>?
    }
    private var entries: [String: Entry] = [:]
    private let limit: Int
    let timeout: Duration
    let label: String
    init(label: String, limit: Int = 2, timeout: Duration = .seconds(20)) {
        self.label = label; self.limit = max(1, limit); self.timeout = timeout
    }
    func run(key: String, operation: @escaping @MainActor () async -> Value?) async -> Value? {
        guard !Task.isCancelled else { return nil }
        let waiter = UUID(), demand = MediaDemand()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: nil); return }
                // Cancellation marks demand synchronously, before its actor cleanup is enqueued.
                // A reopen in that gap must not join an operation with no remaining demand.
                if let entry = entries[key] {
                    for id in entry.waiters.keys where entry.waiters[id]?.demand.cancelled == true { cancel(key, waiter: id) }
                }
                if let entry = entries[key] {
                    MediaTrace.record("\(label).join", ["owner": entry.generation.uuidString])
                    entry.waiters[waiter] = Waiter(continuation: continuation, demand: demand)
                    return
                }
                guard entries.count < limit else {
                    MediaTrace.record("\(label).busy")
                    continuation.resume(returning: nil); return
                }
                let entry = Entry()
                entry.waiters[waiter] = Waiter(continuation: continuation, demand: demand)
                entries[key] = entry
                MediaTrace.record("\(label).new", ["owner": entry.generation.uuidString])
                entry.worker = Task { [weak self] in
                    let value = await operation()
                    self?.finish(key, generation: entry.generation, value: value, reason: value == nil ? "failed" : "ready")
                }
                entry.deadline = Task { [weak self, timeout] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    self?.finish(key, generation: entry.generation, value: nil, reason: "timeout")
                }
            }
        } onCancel: {
            demand.cancel()
            Task { @MainActor [weak self] in self?.cancel(key, waiter: waiter) }
        }
    }
    private func cancel(_ key: String, waiter: UUID) {
        guard let entry = entries[key], let continuation = entry.waiters.removeValue(forKey: waiter) else { return }
        continuation.continuation.resume(returning: nil)
        if entry.waiters.isEmpty { finish(key, generation: entry.generation, value: nil, reason: "cancelled") }
    }
    private func finish(_ key: String, generation: UUID, value: Value?, reason: String) {
        guard let entry = entries[key], entry.generation == generation else { return }
        entries[key] = nil
        entry.deadline?.cancel(); entry.worker?.cancel()
        MediaTrace.record("\(label).\(reason)", ["owner": generation.uuidString])
        let waiters = entry.waiters.values; entry.waiters = [:]
        for waiter in waiters { waiter.continuation.resume(returning: waiter.demand.cancelled ? nil : value) }
        entry.worker = nil; entry.deadline = nil
    }
    func cancelAll() {
        for (key, entry) in entries { finish(key, generation: entry.generation, value: nil, reason: "deferred") }
    }
}

/// A callback may race cancellation, its deadline, a throw and a duplicate/late callback.
/// The first result wins, including when it arrives before the continuation is installed.
final class MediaCallback: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Bool?
    private var continuation: CheckedContinuation<Bool, Never>?
    func finish(_ value: Bool) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let continuation = continuation; self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }
    private func install(_ continuation: CheckedContinuation<Bool, Never>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(returning: result) }
        else { self.continuation = continuation; lock.unlock() }
    }
    func wait(timeout: Duration) async -> Bool {
        let timer = Task { do { try await Task.sleep(for: timeout); finish(false) } catch {} }
        defer { timer.cancel() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { install($0) }
        } onCancel: { self.finish(false) }
    }
}

private final class MediaDemand: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func cancel() { lock.lock(); value = true; lock.unlock() }
}
