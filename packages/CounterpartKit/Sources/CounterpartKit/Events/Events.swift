import Foundation

/// One user-visible change (PRD §8.7, docs/protocols/events.md). The companion writes every event's words,
/// so the phone, the Mac, the Lock Screen and the menu bar say the same thing. Show `title` and `body` as is.
public struct CounterpartEvent: Codable, Equatable, Identifiable, Sendable {
    public enum Notify: String, Codable, Sendable {
        case none, passive, active, timeSensitive
        public init(from decoder: Decoder) throws {
            self = Notify(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .none
        }
    }
    public struct Payload: Codable, Equatable, Sendable {
        public var progress: Double?
        public var remainingSec: Double?
        public var endsAt: String?
        public var layer: Int?
        public var totalLayers: Int?
        public var state: String?
        public var stage: String?
        public var problems: [Problem]?
        public var estimateSec: Double?
        public var grams: Double?
        public var askId: String?
        public var confirmationId: String?
        public var expiresAt: String?
    }
    public struct Problem: Codable, Equatable, Sendable { public var code: String; public var message: String }

    public var v: Int
    public var seq: Int
    public var id: String
    public var at: String
    /// `pass.*`, `print.*` or `plate.blocked`; an unknown type from a newer Mac is kept as its string.
    public var type: String
    public var projectId: String
    public var printId: String?
    public var destinationId: String?
    public var printerName: String?
    public var title: String
    public var body: String
    public var notify: Notify
    public var data: Payload?
    /// `prints/<printId>/frames/<eventId>.jpg`, relative to the project.
    public var frame: String?
}

/// One page of the event log (`EventsPage`).
public struct EventsPage: Codable, Equatable, Sendable {
    public var events: [CounterpartEvent]
    public var next: Int
    public var latest: Int
    /// Older events were pruned, or the log was recreated: reload the projects, then carry on from `next`.
    public var truncated: Bool?
    public var reset: Bool?
    public var needsResync: Bool { truncated == true || reset == true }
}

/// Where events come from. The LAN long poll today; CloudKit (a later milestone) plugs in beside it.
public protocol EventFeed: Sendable {
    /// Waits up to about 25 s for events after `cursor`.
    func page(after cursor: Int, wait: Int, limit: Int) async throws -> EventsPage
}

/// `GET /v1/events?after=<seq>&wait=25` (PR 3). An older Mac answers `not-supported`; the app then keeps
/// refreshing projects the way it always has.
public struct LongPollEventFeed: EventFeed {
    let client: CompanionClient
    public init(client: CompanionClient) { self.client = client }
    public func page(after cursor: Int, wait: Int, limit: Int) async throws -> EventsPage {
        try await client.request("GET", "/v1/events?after=\(max(0, cursor))&wait=\(min(max(wait, 0), 25))&limit=\(min(max(limit, 0), 500))",
                                 as: EventsPage.self, timeout: 40)
    }
}

/// What following the log gives: an event, or "reload everything" after a gap.
public enum EventUpdate: Equatable, Sendable {
    case event(CounterpartEvent)
    case resync
}

/// Follows an `EventFeed` for as long as the caller's task runs. The first read starts from now (no
/// history); later reads carry on from the cursor. Finishes with `not-supported` from an older Mac, so the
/// caller can fall back to polling, and with a pairing error when the phone has to pair again.
public struct EventStream: Sendable {
    let feed: EventFeed
    public init(feed: EventFeed) { self.feed = feed }

    public var updates: AsyncThrowingStream<EventUpdate, Error> {
        let feed = feed
        return AsyncThrowingStream { continuation in
            let task = Task {
                var cursor: Int?
                var failures = 0
                while !Task.isCancelled {
                    do {
                        let page = try await feed.page(after: cursor ?? 0, wait: cursor == nil ? 0 : 25, limit: cursor == nil ? 0 : 100)
                        failures = 0
                        if cursor != nil, page.needsResync { continuation.yield(.resync) }
                        if cursor != nil { for event in page.events { continuation.yield(.event(event)) } }
                        cursor = page.next
                    } catch let error as CompanionError where error.isUnsupported || error.needsPairing {
                        continuation.finish(throwing: error); return
                    } catch is CancellationError {
                        break
                    } catch let error as CompanionError where error.code == "cancelled" {
                        break
                    } catch {
                        failures += 1
                        // While the Mac is away: 1, 2, 5, 15, then 30 s between tries. Then reload once it answers.
                        try? await Task.sleep(for: .seconds([1, 2, 5, 15, 30][min(failures - 1, 4)]))
                        if failures == 1 { continuation.yield(.resync) }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
