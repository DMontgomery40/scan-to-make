#if canImport(RealityKit) && canImport(Metal)
import XCTest
import RealityKit
import Metal
@testable import CounterpartKit

@available(macOS 15, iOS 18, *)
final class ModelPosterTests: XCTestCase {
    @MainActor private static func box() -> Entity {
        ModelEntity(mesh: .generateBox(size: 0.1), materials: [SimpleMaterial(color: .orange, isMetallic: false)])
    }

    @MainActor func testEmptyEntityAndTransparentPixelsAreFailures() async {
        let cache = ModelEntityCache(limit: 1)
        let empty = await cache.load(key: "empty") { Entity() }
        XCTAssertNil(empty)
        let fixed = await cache.load(key: "empty") { Self.box() }
        XCTAssertNotNil(fixed, "Empty geometry must never poison the successful cache")
        XCTAssertEqual(ModelPoster.visiblePixels([0, 0, 0, 0, 0, 0, 0, 0]), 0)
        XCTAssertEqual(ModelPoster.visiblePixels([0, 0, 0, 0, 4, 5, 6, 255]), 1)
        let poster = await ModelPoster.image(key: "empty", model: Entity(), yaw: 0, pitch: 0, fit: 0.2)
        XCTAssertNil(poster)
    }

    @MainActor func testHungMeshExpiresAndLateCompletionCannotReplaceReopenedGeneration() async {
        let cache = ModelEntityCache(limit: 2, timeout: .milliseconds(30))
        var late: CheckedContinuation<Entity?, Never>?
        let hung = Task { await cache.load(key: "same") { await withCheckedContinuation { late = $0 } } }
        while late == nil { await Task.yield() }
        let other = await cache.load(key: "other") { Self.box() }
        XCTAssertNotNil(other, "One stuck mesh must not monopolize the owner")
        let expired = await hung.value
        XCTAssertNil(expired)
        let reopened = await cache.load(key: "same") { let e = Self.box(); e.name = "current"; return e }
        XCTAssertEqual(reopened?.name, "current")
        late?.resume(returning: Self.box())
        await Task.yield()
        let current = await cache.load(key: "same") { XCTFail("Late generation removed new cache"); return nil }
        XCTAssertEqual(current?.name, "current")
    }

    @MainActor func testCancelledPageSettlesBeforeMeshReturnsAndReopenStartsAgain() async {
        let cache = ModelEntityCache(limit: 2)
        var late: CheckedContinuation<Entity?, Never>?
        let page = Task { await cache.load(key: "same") { await withCheckedContinuation { late = $0 } } }
        while late == nil { await Task.yield() }
        page.cancel()
        let cancelled = await page.value
        XCTAssertNil(cancelled, "Cancellation settles without waiting for the framework")
        let reopened = await cache.load(key: "same") { Self.box() }
        XCTAssertNotNil(reopened)
        late?.resume(returning: Self.box())
    }

    @MainActor func testDeactivationSettlesEachStepAndReactivationStartsFresh() async {
        for label in ["mesh", "poster"] {
            let work = MediaWork<Int>(label: label)
            var late: CheckedContinuation<Int?, Never>?
            let pending = Task { await work.run(key: "same") { await withCheckedContinuation { late = $0 } } }
            while late == nil { await Task.yield() }
            work.cancelAll()
            let deferred = await pending.value
            XCTAssertNil(deferred)
            let active = await work.run(key: "same") { 42 }
            XCTAssertEqual(active, 42)
            late?.resume(returning: 9)
        }
    }

    func testMissingRendererCallbackAndLateDuplicateCallbackSettleOnce() async {
        let callback = MediaCallback()
        let result = await callback.wait(timeout: .milliseconds(20))
        XCTAssertFalse(result)
        callback.finish(true); callback.finish(true)
        let late = await callback.wait(timeout: .milliseconds(20))
        XCTAssertFalse(late)
        let cancelled = MediaCallback()
        let page = Task { await cancelled.wait(timeout: .seconds(5)) }
        page.cancel()
        let settled = await page.value
        XCTAssertFalse(settled)
        cancelled.finish(true)
    }

    @MainActor func testARExportProducesANonemptyFileOnDemand() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let result = await ModelEntityCache.export(Self.box(), to: folder.appendingPathComponent("part.usdz"))
        let url = try XCTUnwrap(result)
        XCTAssertGreaterThan(try Data(contentsOf: url).count, 0)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(leftovers, ["part.usdz"])
    }

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
        let original = await cache.load(key: "one") { reads += 1; return Self.box() }
        original?.position = [1, 2, 3]
        let copy = await cache.load(key: "one") { reads += 1; return Self.box() }
        XCTAssertEqual(copy?.position, .zero)
        XCTAssertEqual(reads, 1)
        _ = await cache.load(key: "two") { Self.box() }
        _ = await cache.load(key: "one") { reads += 1; return Self.box() }
        XCTAssertEqual(reads, 2, "Old model resources must be evicted")
        let missing = await cache.load(key: "missing") { nil }
        XCTAssertNil(missing)
        let repaired = await cache.load(key: "missing") { Self.box() }
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
        let newer = await cache.load(key: "new") { Self.box() }
        XCTAssertNotNil(newer)
        finishOld?.resume(returning: Self.box())
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
            let entity = Self.box(); entity.name = "model"
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
            let entity = Self.box(); entity.name = "reopened"
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
