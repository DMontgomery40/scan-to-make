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

    @MainActor private static func waitUntil(_ condition: () -> Bool) async {
        let end = ContinuousClock.now.advanced(by: .seconds(2))
        while !condition(), ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(1)) }
        XCTAssertTrue(condition(), "The operation must start within two seconds")
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
        await Self.waitUntil { late != nil }
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
        await Self.waitUntil { late != nil }
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
            await Self.waitUntil { late != nil }
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

    @MainActor func testAllTransparentRendererOutputIsNotCachedAsSuccess() async throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("Metal is unavailable on this host") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let trace = MediaTrace(url: folder.appendingPathComponent("media-trace.ndjson"))
        let context = MediaTrace.Context(project: "transparent", version: "1", generation: "render", scene: "active")
        var material = PhysicallyBasedMaterial()
        material.blending = .transparent(opacity: .init(floatLiteral: 0))
        let invisible = ModelEntity(mesh: .generateBox(size: 0.1), materials: [material])
        let results = await MediaTrace.$destination.withValue(trace) {
            await MediaTrace.$context.withValue(context) {
                let empty = await ModelPoster.image(key: "transparent-retry", model: invisible, yaw: 0, pitch: 0, fit: 0.2)
                let repaired = await ModelPoster.image(key: "transparent-retry", model: Self.box(), yaw: 0, pitch: 0, fit: 0.2)
                return (empty, repaired)
            }
        }
        XCTAssertNil(results.0)
        XCTAssertNotNil(results.1, "A transparent output must remain retryable with visible geometry")
        let rows = try String(contentsOf: trace.url, encoding: .utf8).split(separator: "\n").map {
            try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: String]
        }
        for event in ["poster.renderer-made", "poster.submitted", "poster.whenScheduled", "poster.onComplete", "poster.readback"] {
            XCTAssertTrue(rows.contains { $0["event"] == event && $0["project"] == "transparent" && $0["generation"] == "render" })
        }
        XCTAssertTrue(rows.contains { $0["event"] == "poster.readback" && $0["visiblePixels"] == "0" })
        XCTAssertTrue(rows.contains { $0["event"] == "poster.failed" })
        XCTAssertTrue(rows.contains { $0["event"] == "poster.ready" })
    }

    @MainActor func testSceneDeferralOutsideTaskContextRetainsOperationCorrelation() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let trace = MediaTrace(url: folder.appendingPathComponent("media-trace.ndjson"))
        let work = MediaWork<Int>(label: "mesh")
        let context = MediaTrace.Context(project: "p", version: "9", generation: "cancel-me")
        var finish: CheckedContinuation<Int?, Never>?
        let pending = Task {
            await MediaTrace.$destination.withValue(trace) {
                await MediaTrace.$context.withValue(context) {
                    await work.run(key: "same") { await withCheckedContinuation { finish = $0 } }
                }
            }
        }
        await Self.waitUntil { finish != nil }
        work.cancelAll() // SwiftUI scene callbacks have no task-local media context.
        let result = await pending.value
        XCTAssertNil(result)
        finish?.resume(returning: 1)
        let text = try String(contentsOf: trace.url, encoding: .utf8)
        XCTAssertTrue(text.contains("mesh.deferred"))
        let last = try XCTUnwrap(text.split(separator: "\n").last)
        let row = try JSONSerialization.jsonObject(with: Data(last.utf8)) as! [String: String]
        XCTAssertEqual(row["generation"], "cancel-me")
        XCTAssertEqual(row["project"], "p")
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
        await Self.waitUntil { finishOld != nil }
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
        await Self.waitUntil { finishOld != nil }
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

    // MARK: A third model waits for a slot (#805, review SF4)

    @MainActor private static func rows(_ trace: MediaTrace) throws -> [[String: String]] {
        guard let text = try? String(contentsOf: trace.url, encoding: .utf8) else { return [] }
        return try text.split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: String] }
    }

    /// A printed project's page asks for the part, the scan and the two together at once. With the first two still
    /// loading, the third used to resolve nil at once (`<label>.busy`) and show as failed; it waits for a slot instead.
    @MainActor func testThirdDistinctKeyWaitsForASlotAndEndsLoadedNeverFailed() async throws {
        for label in ["mesh", "poster"] {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: folder) }
            let trace = MediaTrace(url: folder.appendingPathComponent("media-trace.ndjson"))
            let work = MediaWork<Int>(label: label)
            var part: CheckedContinuation<Int?, Never>?, scan: CheckedContinuation<Int?, Never>?
            var togetherStarted = false
            let first = Task { await work.run(key: "part") { await withCheckedContinuation { part = $0 } } }
            let second = Task { await work.run(key: "scan") { await withCheckedContinuation { scan = $0 } } }
            await Self.waitUntil { part != nil && scan != nil }
            let third = Task {
                await MediaTrace.$destination.withValue(trace) {
                    await work.run(key: "together") { togetherStarted = true; return 3 }
                }
            }
            await Self.waitUntil { work.queuedCount == 1 }
            XCTAssertFalse(togetherStarted, "\(label): two keys in flight is still the limit")
            part?.resume(returning: 1)
            let together = await third.value
            XCTAssertEqual(together, 3, "\(label): the third model loads once a slot frees, never nil for being busy")
            let firstValue = await first.value
            XCTAssertEqual(firstValue, 1)
            scan?.resume(returning: 2)
            let secondValue = await second.value
            XCTAssertEqual(secondValue, 2)
            let events = try Self.rows(trace).compactMap { $0["event"] }
            XCTAssertTrue(events.contains("\(label).queued"), "\(label): \(events)")
            XCTAssertTrue(events.contains("\(label).dequeued"), "\(label): \(events)")
            XCTAssertFalse(events.contains("\(label).busy"), "\(label): \(events)")
            XCTAssertEqual(work.queuedCount, 0)
        }
    }

    /// The same through the stage's cache: part, scan and together, the first two held.
    @MainActor func testEntityCacheThirdModelLoadsAfterTheFirstTwoInsteadOfFailing() async {
        let cache = ModelEntityCache(limit: 3)
        var part: CheckedContinuation<Entity?, Never>?, scan: CheckedContinuation<Entity?, Never>?
        let first = Task { await cache.load(key: "part") { await withCheckedContinuation { part = $0 } } }
        let second = Task { await cache.load(key: "scan") { await withCheckedContinuation { scan = $0 } } }
        await Self.waitUntil { part != nil && scan != nil }
        let third = Task { await cache.load(key: "together") { let e = Self.box(); e.name = "together"; return e } }
        await Self.waitUntil { cache.queuedLoads == 1 }
        scan?.resume(returning: Self.box())
        let together = await third.value
        XCTAssertEqual(together?.name, "together", "The third model must end loaded, never failed")
        part?.resume(returning: Self.box())
        let partValue = await first.value, scanValue = await second.value
        XCTAssertNotNil(partValue); XCTAssertNotNil(scanValue)
    }

    /// A page closed while its model waits: the waiter leaves the queue and resolves nil at once, its operation never
    /// runs, and the next waiter still gets the slot.
    @MainActor func testCancelledQueuedWaiterLeavesTheQueueResolvesNilAndNeverRuns() async {
        let work = MediaWork<Int>(label: "mesh", limit: 1)
        var held: CheckedContinuation<Int?, Never>?
        var cancelledRan = false, nextRan = false
        let owner = Task { await work.run(key: "held") { await withCheckedContinuation { held = $0 } } }
        await Self.waitUntil { held != nil }
        let closed = Task { await work.run(key: "closed") { cancelledRan = true; return 1 } }
        let next = Task { await work.run(key: "next") { nextRan = true; return 2 } }
        await Self.waitUntil { work.queuedCount == 2 }
        closed.cancel()
        let closedValue = await closed.value
        XCTAssertNil(closedValue, "A cancelled waiter resolves nil without waiting for the slot")
        await Self.waitUntil { work.queuedCount == 1 }
        XCTAssertFalse(nextRan)
        held?.resume(returning: 0)
        let ownerValue = await owner.value, nextValue = await next.value
        XCTAssertEqual(ownerValue, 0)
        XCTAssertEqual(nextValue, 2)
        XCTAssertTrue(nextRan)
        XCTAssertFalse(cancelledRan, "A cancelled waiter's operation must never start")
    }

    /// The 20 s deadline is per operation: it starts when the operation runs, not while it waits for a slot. A real
    /// timeout still fails. Margins are seconds, not milliseconds (#810 review R5: the gate Mac's load average reaches
    /// 600): the queued operation is resumed T/2 after it started, so a correct deadline has T/2 = 3 s of slack, and a
    /// deadline counted from the queue (T after it queued, before the slot freed) has already fired.
    @MainActor func testQueuedDeadlineStartsWhenTheOperationRunsNotWhileItWaits() async {
        let timeout = Duration.seconds(6)
        let work = MediaWork<Int>(label: "mesh", limit: 1, timeout: timeout)
        var hung: CheckedContinuation<Int?, Never>?, queued: CheckedContinuation<Int?, Never>?
        var dequeuedAt: ContinuousClock.Instant?
        let stuck = Task { await work.run(key: "stuck") { await withCheckedContinuation { hung = $0 } } }
        await Self.waitUntil { hung != nil }
        let waiting = Task { await work.run(key: "waiting") {
            dequeuedAt = .now
            return await withCheckedContinuation { queued = $0 }
        } }
        await Self.waitUntil { work.queuedCount == 1 }
        let queuedBy = ContinuousClock.now // no earlier than the request queued
        // The stuck operation times out at T and frees the slot; the waiter runs then.
        let stuckValue = await stuck.value
        XCTAssertNil(stuckValue, "A real timeout still fails")
        await Self.waitUntil { queued != nil }
        guard let dequeuedAt else { return XCTFail("The queued operation never ran") }
        let resumeAt = dequeuedAt.advanced(by: timeout / 2)
        // The test proves something only if a deadline counted from the queue would have fired by now.
        XCTAssertGreaterThan(resumeAt, queuedBy.advanced(by: timeout), "Too slow a start to tell the two deadlines apart")
        try? await Task.sleep(until: resumeAt, clock: .continuous)
        queued?.resume(returning: 7)
        let value = await waiting.value
        XCTAssertEqual(value, 7, "The queued operation's deadline must start when it runs")
        hung?.resume(returning: 0)
    }

    /// A running load whose page closes frees its slot at once: the next queued model starts and loads (#810 review R4,
    /// cancel → finish → pump).
    @MainActor func testCancellingARunningLoadStartsTheNextQueuedKey() async {
        let work = MediaWork<Int>(label: "mesh", limit: 1)
        var held: CheckedContinuation<Int?, Never>?
        var nextRan = false
        let running = Task { await work.run(key: "closed-page") { await withCheckedContinuation { held = $0 } } }
        await Self.waitUntil { held != nil }
        let next = Task { await work.run(key: "next") { nextRan = true; return 2 } }
        await Self.waitUntil { work.queuedCount == 1 }
        XCTAssertFalse(nextRan, "One key in flight is the limit")
        running.cancel()
        let runningValue = await running.value
        XCTAssertNil(runningValue, "The cancelled load settles with nil without waiting for its operation")
        await Self.waitUntil { nextRan }
        if !nextRan { held?.resume(returning: 1); held = nil } // a broken slot release must fail, not hang the suite
        let nextValue = await next.value
        XCTAssertEqual(nextValue, 2, "Its freed slot starts the next queued key")
        XCTAssertTrue(nextRan)
        XCTAssertEqual(work.queuedCount, 0)
        held?.resume(returning: 1) // the framework's late completion cannot publish into the next generation
        await Task.yield()
        let after = await work.run(key: "closed-page") { 3 }
        XCTAssertEqual(after, 3, "The cancelled key starts fresh")
    }

    /// Cancel, a freed slot, a scene deferral and a late cancel all race: every waiter resolves exactly once (a second
    /// resume of a checked continuation traps), one key runs once, and nothing queued starts after a deferral.
    @MainActor func testQueuedWaitersResolveExactlyOnceAcrossCancelReleaseAndDeferral() async {
        let work = MediaWork<Int>(label: "poster", limit: 1)
        var held: CheckedContinuation<Int?, Never>?
        var starts: [String: Int] = [:]
        let owner = Task { await work.run(key: "held") { await withCheckedContinuation { held = $0 } } }
        await Self.waitUntil { held != nil }
        let cancelled = Task { await work.run(key: "b") { starts["b", default: 0] += 1; return 1 } }
        let shared1 = Task { await work.run(key: "c") { starts["c", default: 0] += 1; return 3 } }
        let shared2 = Task { await work.run(key: "c") { starts["c", default: 0] += 1; return 4 } }
        await Self.waitUntil { work.queuedCount == 3 }
        // In one main-actor turn: the demand is cancelled (its cleanup hop comes later) and the slot frees.
        cancelled.cancel()
        held?.resume(returning: 0)
        let ownerValue = await owner.value, cancelledValue = await cancelled.value
        let firstShared = await shared1.value, secondShared = await shared2.value
        XCTAssertEqual(ownerValue, 0)
        XCTAssertNil(cancelledValue)
        XCTAssertEqual(firstShared, 3); XCTAssertEqual(secondShared, 3, "A queued duplicate key joins the one operation")
        XCTAssertEqual(starts["c"], 1)
        XCTAssertNil(starts["b"])
        // A deferral settles the waiters still queued; a cancel arriving afterwards finds nothing to resume.
        var late: CheckedContinuation<Int?, Never>?
        let running = Task { await work.run(key: "running") { await withCheckedContinuation { late = $0 } } }
        await Self.waitUntil { late != nil }
        let deferred = Task { await work.run(key: "deferred") { starts["deferred", default: 0] += 1; return 5 } }
        await Self.waitUntil { work.queuedCount == 1 }
        work.cancelAll()
        deferred.cancel()
        let runningValue = await running.value, deferredValue = await deferred.value
        XCTAssertNil(runningValue); XCTAssertNil(deferredValue)
        XCTAssertEqual(work.queuedCount, 0)
        await Task.yield()
        XCTAssertNil(starts["deferred"], "Nothing queued starts after the scene deferred it")
        late?.resume(returning: 9)
        let after = await work.run(key: "after") { 6 }
        XCTAssertEqual(after, 6)
    }
}
#endif
