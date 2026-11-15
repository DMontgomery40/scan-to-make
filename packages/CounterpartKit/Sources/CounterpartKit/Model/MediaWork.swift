import Foundation

/// Logical ownership of optional media work. Never waits for an uncooperative child to exit.
/// Deadlines release logical permits; late framework completions cannot publish or remove a newer generation.
/// At most `limit` distinct keys run at once. A further key waits its turn in a FIFO queue and never resolves nil for being
/// busy (#805: a printed project's page asks for the part, the scan and the two together, and the third showed as failed).
/// Its deadline starts when it runs. A waiter whose task is cancelled, or deferred by `cancelAll`, leaves the queue with nil.
@MainActor final class MediaWork<Value> {
    private struct Waiter {
        let continuation: CheckedContinuation<Value?, Never>
        let demand: MediaDemand
    }
    /// A request waiting for a slot. It keeps its requester's trace context and priority, because it starts from
    /// whichever task frees the slot.
    private struct Queued {
        let id: UUID
        let key: String
        let waiter: Waiter
        let operation: @MainActor () async -> Value?
        let context: MediaTrace.Context?
        let trace: MediaTrace
        let priority: TaskPriority
    }
    private final class Entry {
        let generation = UUID()
        let context: MediaTrace.Context?
        let trace: MediaTrace
        var waiters: [UUID: Waiter] = [:]
        var worker: Task<Void, Never>?
        var deadline: Task<Void, Never>?
        init(context: MediaTrace.Context?, trace: MediaTrace) { self.context = context; self.trace = trace }
    }
    private var entries: [String: Entry] = [:]
    private var queue: [Queued] = []
    private let limit: Int
    let timeout: Duration
    let label: String
    init(label: String, limit: Int = 2, timeout: Duration = .seconds(20)) {
        self.label = label; self.limit = max(1, limit); self.timeout = timeout
    }
    /// Requests waiting for a slot (tests).
    var queuedCount: Int { queue.count }

    func run(key: String, operation: @escaping @MainActor () async -> Value?) async -> Value? {
        guard !Task.isCancelled else { return nil }
        let waiter = UUID(), demand = MediaDemand()
        let context = MediaTrace.context, trace = MediaTrace.destination ?? .shared, priority = Task.currentPriority
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: nil); return }
                // Cancellation marks demand synchronously, before its actor cleanup is enqueued.
                // A reopen in that gap must not join an operation with no remaining demand.
                purgeCancelled(key)
                let request = Waiter(continuation: continuation, demand: demand)
                if let entry = entries[key] {
                    MediaTrace.record("\(label).join", ["owner": entry.generation.uuidString])
                    entry.waiters[waiter] = request
                    return
                }
                // Behind anyone already waiting, so a slot goes to the oldest request.
                guard entries.count < limit, queue.isEmpty else {
                    queue.append(Queued(id: waiter, key: key, waiter: request, operation: operation,
                                        context: context, trace: trace, priority: priority))
                    MediaTrace.record("\(label).queued", ["ahead": String(queue.count - 1)])
                    return
                }
                start(key, id: waiter, waiter: request, operation: operation, context: context, trace: trace, priority: priority)
            }
        } onCancel: {
            demand.cancel()
            Task { @MainActor [weak self] in self?.cancel(key, waiter: waiter) }
        }
    }

    private func start(_ key: String, id: UUID, waiter: Waiter, operation: @escaping @MainActor () async -> Value?,
                       context: MediaTrace.Context?, trace: MediaTrace, priority: TaskPriority) {
        let entry = Entry(context: context, trace: trace)
        entry.waiters[id] = waiter
        entries[key] = entry
        trace.record("\(label).new", ["owner": entry.generation.uuidString], context: context)
        // The same key waiting further back shares this operation instead of taking a second turn.
        queue.removeAll { queued in
            guard queued.key == key, !queued.waiter.demand.cancelled else { return false }
            entry.waiters[queued.id] = queued.waiter
            queued.trace.record("\(label).dequeued", ["owner": entry.generation.uuidString, "as": "join"], context: queued.context)
            return true
        }
        // Started from whichever task frees a slot: run with the requester's trace context, not that task's.
        entry.worker = Task(priority: priority) { [weak self] in
            guard !Task.isCancelled else { return }
            let value = await MediaTrace.$destination.withValue(trace) {
                await MediaTrace.$context.withValue(context) { await operation() }
            }
            self?.finish(key, generation: entry.generation, value: value, reason: value == nil ? "failed" : "ready")
        }
        // Per operation, from when it runs: time spent waiting for a slot is not counted.
        entry.deadline = Task { [weak self, timeout] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.finish(key, generation: entry.generation, value: nil, reason: "timeout")
        }
    }

    /// Starts the oldest waiting requests while slots are free. Waiters whose demand was cancelled leave with nil.
    private func pump() {
        while entries.count < limit, !queue.isEmpty {
            let next = queue.removeFirst()
            if next.waiter.demand.cancelled {
                next.waiter.continuation.resume(returning: nil)
                next.trace.record("\(label).dequeued", ["as": "cancelled"], context: next.context)
                continue
            }
            if let entry = entries[next.key] {
                entry.waiters[next.id] = next.waiter
                next.trace.record("\(label).dequeued", ["owner": entry.generation.uuidString, "as": "join"], context: next.context)
                continue
            }
            next.trace.record("\(label).dequeued", ["as": "new"], context: next.context)
            start(next.key, id: next.id, waiter: next.waiter, operation: next.operation,
                  context: next.context, trace: next.trace, priority: next.priority)
        }
    }

    private func purgeCancelled(_ key: String) {
        if let entry = entries[key] {
            for id in Array(entry.waiters.keys) where entry.waiters[id]?.demand.cancelled == true { cancel(key, waiter: id) }
        }
        for queued in queue where queued.waiter.demand.cancelled { cancel(queued.key, waiter: queued.id) }
    }

    /// Removes the waiter before resuming it; a waiter already settled is not found, so nothing resumes twice.
    private func cancel(_ key: String, waiter: UUID) {
        if let index = queue.firstIndex(where: { $0.id == waiter }) {
            let queued = queue.remove(at: index)
            queued.waiter.continuation.resume(returning: nil)
            queued.trace.record("\(label).dequeued", ["as": "cancelled"], context: queued.context)
            return
        }
        guard let entry = entries[key], let continuation = entry.waiters.removeValue(forKey: waiter) else { return }
        continuation.continuation.resume(returning: nil)
        if entry.waiters.isEmpty { finish(key, generation: entry.generation, value: nil, reason: "cancelled") }
    }
    private func finish(_ key: String, generation: UUID, value: Value?, reason: String) {
        guard let entry = entries[key], entry.generation == generation else { return }
        entries[key] = nil
        entry.deadline?.cancel(); entry.worker?.cancel()
        entry.trace.record("\(label).\(reason)", ["owner": generation.uuidString], context: entry.context)
        let waiters = entry.waiters.values; entry.waiters = [:]
        for waiter in waiters { waiter.continuation.resume(returning: waiter.demand.cancelled ? nil : value) }
        entry.worker = nil; entry.deadline = nil
        pump()
    }
    /// The scene deactivated: every pending demand settles with nil. The queue empties first, so finishing the running
    /// entries starts nothing.
    func cancelAll() {
        let waiting = queue; queue = []
        for queued in waiting {
            queued.waiter.continuation.resume(returning: nil)
            queued.trace.record("\(label).deferred", ["queued": "true"], context: queued.context)
        }
        for (key, entry) in Array(entries) { finish(key, generation: entry.generation, value: nil, reason: "deferred") }
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
