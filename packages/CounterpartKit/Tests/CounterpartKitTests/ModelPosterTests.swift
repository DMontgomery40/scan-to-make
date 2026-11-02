#if canImport(RealityKit) && canImport(Metal)
import XCTest
import RealityKit
import Metal
@testable import CounterpartKit

@available(macOS 15, iOS 18, *)
final class ModelPosterTests: XCTestCase {
    @MainActor func testActualRenderHasVisibleOpaqueModelAndTransparentUnclippedBorder() async throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("Metal is unavailable on this host") }
        let model = ModelEntity(mesh: .generateBox(size: 0.1), materials: [SimpleMaterial(color: .orange, isMetallic: false)])
        let firstResult = await ModelPoster.image(key: "cube-v1", model: model, yaw: 0.6, pitch: -0.35, fit: 0.27)
        let first = try XCTUnwrap(firstResult)
        let bytes = try XCTUnwrap(first.dataProvider?.data) as Data
        let alpha = stride(from: 3, to: bytes.count, by: 4).map { bytes[$0] }
        XCTAssertGreaterThan(alpha.filter { $0 > 240 }.count, 10_000)
        for y in 0..<first.height {
            for x in 0..<first.width where x < 8 || y < 8 || x >= first.width - 8 || y >= first.height - 8 {
                XCTAssertEqual(bytes[y * first.bytesPerRow + x * 4 + 3], 0, "Model must not clip the transparent border")
            }
        }
        let cached = await ModelPoster.image(key: "cube-v1", model: model, yaw: 0.6, pitch: -0.35, fit: 0.27)
        XCTAssertTrue(first === cached)
        let changed = ModelEntity(mesh: .generateSphere(radius: 0.05), materials: [SimpleMaterial(color: .blue, isMetallic: false)])
        let newerResult = await ModelPoster.image(key: "cube-v2", model: changed, yaw: 0.6, pitch: -0.35, fit: 0.27)
        let newer = try XCTUnwrap(newerResult)
        XCTAssertNotEqual(bytes, newer.dataProvider!.data! as Data, "A new file version must not reuse old pixels")
        let turnedResult = await ModelPoster.image(key: "cube-v1", model: model, yaw: 0, pitch: 0, fit: 0.27)
        let turned = try XCTUnwrap(turnedResult)
        XCTAssertNotEqual(bytes, turned.dataProvider!.data! as Data, "Different framing must not reuse old pixels")
    }

    @MainActor func testEntityCacheBoundsStorageAndReturnsIndependentHierarchies() async {
        let cache = ModelEntityCache(limit: 1)
        var reads = 0
        let original = await cache.load(key: "one") { reads += 1; return Entity() }
        original?.position = [1, 2, 3]
        let copy = await cache.load(key: "one") { reads += 1; return Entity() }
        XCTAssertEqual(copy?.position, .zero)
        XCTAssertEqual(reads, 1)
        _ = await cache.load(key: "two") { Entity() }
        _ = await cache.load(key: "one") { reads += 1; return Entity() }
        XCTAssertEqual(reads, 2, "Old model resources must be evicted")
        let missing = await cache.load(key: "missing") { nil }
        XCTAssertNil(missing)
        let repaired = await cache.load(key: "missing") { Entity() }
        XCTAssertNotNil(repaired, "A failed load must remain retryable")
    }

    @MainActor func testConcurrentLoadsShareWorkAndCancelledOldVersionCannotPublish() async {
        let cache = ModelEntityCache(limit: 1)
        var finishOld: CheckedContinuation<Entity?, Never>?
        var starts = 0
        let old = Task { @MainActor in await cache.load(key: "old") {
            starts += 1
            return await withCheckedContinuation { finishOld = $0 }
        } }
        while finishOld == nil { await Task.yield() }
        let peer = Task { @MainActor in await cache.load(key: "old") { starts += 1; return nil } }
        await Task.yield()
        old.cancel()
        let newer = await cache.load(key: "new") { Entity() }
        XCTAssertNotNil(newer)
        finishOld?.resume(returning: Entity())
        let oldResult = await old.value
        let peerResult = await peer.value
        XCTAssertNil(oldResult)
        XCTAssertNotNil(peerResult)
        XCTAssertEqual(starts, 1)
        let cached = await cache.load(key: "old") { XCTFail("Concurrent result must be reusable"); return nil }
        XCTAssertNotNil(cached)
    }

    @MainActor func testCacheReleaseDropsPrototypeWithoutInvalidatingDisplayedClone() async {
        let cache = ModelEntityCache(limit: 1)
        weak var prototype: Entity?
        let displayed = await cache.load(key: "model") {
            let entity = Entity(); entity.name = "model"
            prototype = entity
            return entity
        }
        XCTAssertNotNil(prototype)
        cache.removeAll()
        XCTAssertNil(prototype, "Closing the window must release the cache's retained entity")
        XCTAssertEqual(displayed?.name, "model", "Another active consumer owns its independent hierarchy")
    }

    @MainActor func testCacheReleaseSeparatesReopenedLoadFromOldPendingWork() async {
        let cache = ModelEntityCache(limit: 1)
        var finishOld: CheckedContinuation<Entity?, Never>?
        let old = Task { @MainActor in await cache.load(key: "model") {
            await withCheckedContinuation { finishOld = $0 }
        } }
        while finishOld == nil { await Task.yield() }
        old.cancel()
        cache.removeAll()
        let started = expectation(description: "Reopened window starts its own load")
        var newStarted = false
        let reopened = Task { @MainActor in await cache.load(key: "model") {
            newStarted = true; started.fulfill()
            let entity = Entity(); entity.name = "reopened"
            return entity
        } }
        await fulfillment(of: [started], timeout: 2)
        // A broken implementation joins the old pending task; release it even
        // after the failed expectation so the regression cannot hang the suite.
        if newStarted { _ = await reopened.value }
        let obsolete = Entity(); obsolete.name = "closed"
        finishOld?.resume(returning: obsolete)
        let oldResult = await old.value
        let newResult = await reopened.value
        XCTAssertNil(oldResult)
        XCTAssertEqual(newResult?.name, "reopened")
        let cached = await cache.load(key: "model") { XCTFail("Old completion evicted the new window's model"); return nil }
        XCTAssertEqual(cached?.name, "reopened")
    }
}
#endif
