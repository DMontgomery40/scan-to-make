#if canImport(RealityKit)
import RealityKit

/// Shares parsing and GPU mesh creation between a poster, interaction and AR export.
/// Callers receive separate entity hierarchies; mesh resources remain shared.
@MainActor public final class ModelEntityCache {
    private let limit: Int
    private final class Storage {
        var entities: [String: Entity] = [:]
        var order: [String] = []
        var pending: [String: Task<Entity?, Never>] = [:]
    }
    private var storage = Storage()

    public init(limit: Int) { self.limit = max(1, limit) }

    /// Let hidden windows release their GPU resources. An in-flight load retains
    /// only its old storage, so it cannot refill the reopened window's cache.
    public func removeAll() { storage = Storage() }

    public func load(key: String, operation: @escaping @MainActor () async -> Entity?) async -> Entity? {
        guard !Task.isCancelled else { return nil }
        let storage = storage
        if let entity = storage.entities[key] { return entity.clone(recursive: true) }
        if let task = storage.pending[key] {
            let entity = await task.value
            guard !Task.isCancelled else { return nil }
            return entity?.clone(recursive: true)
        }
        let task = Task { @MainActor in await operation() }
        storage.pending[key] = task
        let entity = await task.value
        storage.pending[key] = nil
        if let entity {
            storage.entities[key] = entity
            storage.order.removeAll { $0 == key }; storage.order.append(key)
            while storage.order.count > limit { storage.entities[storage.order.removeFirst()] = nil }
        }
        guard !Task.isCancelled else { return nil }
        return entity?.clone(recursive: true)
    }
}
#endif
