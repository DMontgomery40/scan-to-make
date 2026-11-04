import XCTest
@testable import CounterpartKit

/// `GET /v1/events` followed as a stream (docs/protocols/events.md): no history on the first read, events
/// after that, and "reload everything" after a reset or a truncated page.
final class EventStreamTests: XCTestCase {
    /// Pages in order; then waits until the stream is cancelled.
    final class ScriptedFeed: EventFeed, @unchecked Sendable {
        private let lock = NSLock()
        private var pages: [Result<EventsPage, Error>]
        private(set) var requests: [(after: Int, wait: Int, limit: Int)] = []
        init(_ pages: [Result<EventsPage, Error>]) { self.pages = pages }
        func page(after cursor: Int, wait: Int, limit: Int) async throws -> EventsPage {
            let next: Result<EventsPage, Error>? = lock.withLock {
                requests.append((cursor, wait, limit))
                return pages.isEmpty ? nil : pages.removeFirst()
            }
            guard let next else { try await Task.sleep(for: .seconds(60)); throw CancellationError() }
            return try next.get()
        }
    }

    private func event(_ seq: Int, _ type: String = "pass.ready") -> CounterpartEvent {
        try! JSONDecoder().decode(CounterpartEvent.self, from: Data(#"{"v":1,"seq":\#(seq),"id":"e\#(seq)","at":"2026-11-01T09:00:00Z","type":"\#(type)","projectId":"p","title":"T","body":"B","notify":"passive"}"#.utf8))
    }
    private func page(_ events: [CounterpartEvent], next: Int, reset: Bool? = nil, truncated: Bool? = nil) -> EventsPage {
        EventsPage(events: events, next: next, latest: next, truncated: truncated, reset: reset)
    }

    private func collect(_ feed: ScriptedFeed, count: Int) async throws -> [EventUpdate] {
        var updates: [EventUpdate] = []
        for try await update in EventStream(feed: feed).updates {
            updates.append(update)
            if updates.count == count { break }
        }
        return updates
    }

    func testHistoryIsSkippedThenEventsFollowAndAResetResyncs() async throws {
        let feed = ScriptedFeed([
            .success(page([event(4)], next: 5)),                      // the first read: where the log is now
            .success(page([event(6)], next: 6)),
            .success(page([], next: 2, reset: true)),                 // the Mac's log started over
            .success(page([event(3, "print.done")], next: 3)),
        ])
        let updates = try await collect(feed, count: 3)
        XCTAssertEqual(updates, [.event(event(6)), .resync, .event(event(3, "print.done"))], "the event before now is history, not news")
        XCTAssertEqual(feed.requests.first?.limit, 0, "the first read only asks where the log is")
        XCTAssertEqual(feed.requests.first?.wait, 0)
        XCTAssertEqual(feed.requests[1].after, 5)
        XCTAssertEqual(feed.requests[1].wait, 25)
        XCTAssertEqual(feed.requests[3].after, 2, "after a reset, carry on from the Mac's new cursor")
    }

    /// KAN-217 P0 (Davica3, 23:52): a long poll is silent for 25 s, iOS calls that a data stall, and a poll can end
    /// early or be cancelled underneath us. When the Mac answers a quick health check, the poll just starts again:
    /// no "reload everything", no "isn't answering", and the next event still arrives from the same cursor.
    func testALongPollThatEndsEarlyIsRetriedWhileTheMacAnswers() async throws {
        let feed = ScriptedFeed([
            .success(page([], next: 10)),
            .failure(CompanionError.unreachable),
            .failure(CompanionError.cancelled),
            .success(page([event(11)], next: 11)),
        ])
        var updates: [EventUpdate] = []
        for try await update in EventStream(feed: feed, healthy: { true }).updates {
            updates.append(update)
            if updates.count == 1 { break }
        }
        XCTAssertEqual(updates, [.event(event(11))], "no resync while the Mac answers")
        XCTAssertEqual(Array(feed.requests.map(\.after).prefix(4)), [0, 10, 10, 10], "the same cursor after each early end")
    }

    func testATruncatedPageResyncs() async throws {
        let feed = ScriptedFeed([.success(page([], next: 10)), .success(page([event(200)], next: 200, truncated: true))])
        let updates = try await collect(feed, count: 2)
        XCTAssertEqual(updates, [.resync, .event(event(200))])
    }

    func testRecoveryResyncsEvenWhenTheMacHasNoNewEvents() async throws {
        let feed = ScriptedFeed([
            .success(page([], next: 10)),
            .failure(CompanionError.unreachable),
            .success(page([], next: 10)),
            .success(page([event(11)], next: 11)),
        ])
        let updates = try await collect(feed, count: 2)
        XCTAssertEqual(updates, [.resync, .resync], "refresh once while away and again when the Mac actually answers")
    }

    func testARecoveredHealthProbeResyncsAfterAnOutage() async throws {
        actor Health {
            var probes = 0
            func answers() -> Bool { probes += 1; return probes > 1 }
        }
        let health = Health()
        let feed = ScriptedFeed([
            .success(page([], next: 10)),
            .failure(CompanionError.unreachable),
            .failure(CompanionError.cancelled),
            .success(page([event(11)], next: 11)),
        ])
        var updates: [EventUpdate] = []
        for try await update in EventStream(feed: feed, healthy: { await health.answers() }).updates {
            updates.append(update)
            if updates.count == 2 { break }
        }
        XCTAssertEqual(updates, [.resync, .resync], "a confirmed health reply clears the outage even when the event poll still ends early")
    }

    func testAnOlderMacEndsTheStreamSoTheAppPolls() async {
        let feed = ScriptedFeed([.failure(CompanionError.unsupported)])
        do {
            _ = try await collect(feed, count: 1)
            XCTFail("an older Mac must end the stream")
        } catch let error as CompanionError {
            XCTAssertTrue(error.isUnsupported)
        } catch { XCTFail("\(error)") }
    }
}
