import XCTest
@testable import CounterpartKit

/// Review F2, F3 and F4 on #456.
final class PictureLoadingTests: XCTestCase {
    func testAFailedLoadDrawsNothing() {
        var load = PictureLoad<String>()
        load.start("ask-1", cached: nil)
        XCTAssertFalse(load.hidden, "loading: the figure keeps its place")
        load.downloaded(nil, for: "ask-1")
        XCTAssertTrue(load.hidden, "the Mac is asleep: no box, no region, no caption")
        load.start("ask-1b", cached: nil)
        load.downloaded(URL(fileURLWithPath: "/tmp/ask.jpg"), for: "ask-1b")
        load.decoded(nil, for: "ask-1b")
        XCTAssertTrue(load.hidden, "a picture that won't decode draws nothing too")
    }

    func testANewQuestionClearsTheLastPictureAndIgnoresItsLateResult() {
        var load = PictureLoad<String>()
        load.start("ask-1", cached: nil)
        load.downloaded(URL(fileURLWithPath: "/tmp/one.jpg"), for: "ask-1")
        load.decoded("photo one", for: "ask-1")
        load.start("ask-2", cached: nil)
        XCTAssertNil(load.picture, "the old photo never sits under the new region")
        XCTAssertNil(load.file)
        load.decoded("photo one, decoded late", for: "ask-1")
        XCTAssertNil(load.picture, "a result for the previous question is ignored")
        load.start("ask-1", cached: "photo one")
        XCTAssertEqual(load.picture, "photo one", "a cached picture for the new key shows at once")
    }

    func testACancelledWaiterNeverDecodesAndHandsOnItsTurn() async throws {
        let lane = DecodeLane(width: 1)
        let ran = Ran()
        let gate = Gate()
        let first = Task { await lane.run { gate.wait(); return 1 } }
        while await lane.queued == 0 && !gate.entered { await Task.yield() }
        let scrolledAway = Task { await lane.run { ran.add("off screen"); return 2 } }
        while await lane.queued < 1 { await Task.yield() }
        let onScreen = Task { await lane.run { ran.add("on screen"); return 3 } }
        while await lane.queued < 2 { await Task.yield() }
        scrolledAway.cancel()
        while await lane.queued > 1 { await Task.yield() }
        gate.open()
        let results = (await first.value, await scrolledAway.value, await onScreen.value)
        XCTAssertEqual(results.0, 1)
        XCTAssertNil(results.1, "the cancelled waiter got nothing")
        XCTAssertEqual(results.2, 3)
        XCTAssertEqual(ran.items, ["on screen"], "only the frame still on screen decoded")
    }
}

private final class Ran: @unchecked Sendable {
    private let lock = NSLock(); private var list: [String] = []
    func add(_ item: String) { lock.lock(); list.append(item); lock.unlock() }
    var items: [String] { lock.lock(); defer { lock.unlock() }; return list }
}

private final class Gate: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock(); private var flag = false
    var entered: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func wait() { lock.lock(); flag = true; lock.unlock(); semaphore.wait() }
    func open() { semaphore.signal() }
}
