import Foundation

/// One question picture's loading state, keyed by what it shows (review F2, F3 on #456).
/// - A new key starts from that key's cached picture or none, so the previous question's photo never sits under the new
///   question's region and caption.
/// - A result for an older key is ignored, so a slow load of the last project can't land on this one.
/// - A load that fails with nothing to show hides the whole figure (picture, region and caption): a blank box captioned
///   "The outlined part is…" says something untrue, the ordinary case being a Mac that is asleep.
public struct PictureLoad<Picture> {
    public private(set) var key: String?
    public private(set) var picture: Picture?
    public private(set) var file: URL?
    public private(set) var failed = false

    public init() {}

    /// Draw nothing: the load failed and there is no picture for this key.
    public var hidden: Bool { failed && picture == nil }

    public mutating func start(_ key: String, cached: Picture?) {
        self.key = key; picture = cached; file = nil; failed = false
    }
    public mutating func downloaded(_ file: URL?, for key: String) {
        guard key == self.key else { return }
        if let file { self.file = file } else { failed = true }
    }
    public mutating func decoded(_ picture: Picture?, for key: String) {
        guard key == self.key else { return }
        if let picture { self.picture = picture } else { failed = true }
    }
}

/// At most `width` decodes at once, off the caller's actor; the rest wait in order. A waiter whose task is cancelled
/// (a cell that scrolled away) leaves the queue and never decodes, so frames on screen come first (review F4 on #456).
public actor DecodeLane {
    public static let shared = DecodeLane(width: 3)
    private let width: Int
    private var running = 0
    private var waiting: [(id: UUID, slot: CheckedContinuation<Bool, Never>)] = []

    public init(width: Int) { self.width = max(1, width) }

    /// The work's result, or nil when the task was cancelled before its turn came.
    public func run<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T? {
        guard await acquire() else { return nil }
        guard !Task.isCancelled else { release(); return nil }
        let result = await Task.detached(priority: .userInitiated) { work() }.value
        release()
        return result
    }

    /// How many are queued, for tests.
    public var queued: Int { waiting.count }

    private func acquire() async -> Bool {
        if running < width { running += 1; return true }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (slot: CheckedContinuation<Bool, Never>) in
                if Task.isCancelled { slot.resume(returning: false) } else { waiting.append((id, slot)) }
            }
        } onCancel: {
            Task { await self.drop(id) }
        }
    }

    private func drop(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).slot.resume(returning: false)
    }

    /// A finished decode hands its slot straight to the next waiter.
    private func release() {
        if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().slot.resume(returning: true) }
    }
}
