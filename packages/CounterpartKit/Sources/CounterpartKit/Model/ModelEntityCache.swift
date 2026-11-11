#if canImport(RealityKit)
import RealityKit
import Foundation

/// Shares parsing and GPU mesh creation between a poster and interaction. (AR writes its own USDZ: `PartUSDZ`.)
/// Callers receive separate entity hierarchies; mesh resources remain shared.
@MainActor public final class ModelEntityCache {
    private let limit: Int
    @MainActor private final class Storage {
        var entities: [String: Entity] = [:]
        var order: [String] = []
        let work: MediaWork<Entity>
        init(timeout: Duration) { work = MediaWork(label: "mesh", timeout: timeout) }
    }
    private var storage: Storage
    private let timeout: Duration

    public init(limit: Int, timeout: Duration = .seconds(20)) {
        self.limit = max(1, limit); self.timeout = timeout; storage = Storage(timeout: timeout)
    }

    /// Let hidden windows release their GPU resources. An in-flight load retains
    /// only its old storage, so it cannot refill the reopened window's cache.
    public func removeAll() { storage.work.cancelAll(); storage = Storage(timeout: timeout) }

    public func load(key: String, operation: @escaping @MainActor () async -> Entity?) async -> Entity? {
        guard !Task.isCancelled else { return nil }
        let storage = storage
        if let entity = storage.entities[key] {
            MediaTrace.record("mesh.hit")
            return entity.clone(recursive: true)
        }
        let entity = await storage.work.run(key: key) {
            guard let entity = await operation(), Self.hasGeometry(entity), !Task.isCancelled else {
                MediaTrace.record("mesh.invalid")
                return nil
            }
            MediaTrace.record("mesh.entity", ["children": String(entity.children.count)])
            return entity
        }
        guard !Task.isCancelled, self.storage === storage else { return nil }
        if let entity {
            storage.entities[key] = entity
            storage.order.removeAll { $0 == key }; storage.order.append(key)
            while storage.order.count > limit { storage.entities[storage.order.removeFirst()] = nil }
        }
        guard !Task.isCancelled else { return nil }
        return entity?.clone(recursive: true)
    }
    public static func hasGeometry(_ entity: Entity) -> Bool {
        if let model = entity.components[ModelComponent.self],
           model.mesh.contents.models.contains(where: { $0.parts.contains(where: { ($0.triangleIndices?.count ?? 0) > 0 }) }) { return true }
        return entity.children.contains { hasGeometry($0) }
    }
}
#endif
