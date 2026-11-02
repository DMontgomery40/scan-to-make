#if canImport(RealityKit)
import RealityKit

/// Shares parsing and GPU mesh creation between a poster, interaction and AR export.
/// Callers receive separate entity hierarchies; mesh resources remain shared.
@MainActor public final class ModelEntityCache {
    private let limit: Int
    private var entities: [String: Entity] = [:]
    private var order: [String] = []
    private var pending: [String: Task<Entity?, Never>] = [:]

    public init(limit: Int) { self.limit = max(1, limit) }

    public func load(key: String, operation: @escaping @MainActor () async -> Entity?) async -> Entity? {
        guard !Task.isCancelled else { return nil }
        if let entity = entities[key] { return entity.clone(recursive: true) }
        if let task = pending[key] {
            let entity = await task.value
            guard !Task.isCancelled else { return nil }
            return entity?.clone(recursive: true)
        }
        let task = Task { @MainActor in await operation() }
        pending[key] = task
        let entity = await task.value
        pending[key] = nil
        if let entity {
            entities[key] = entity
            order.removeAll { $0 == key }; order.append(key)
            while order.count > limit { entities[order.removeFirst()] = nil }
        }
        guard !Task.isCancelled else { return nil }
        return entity?.clone(recursive: true)
    }
}
#endif
