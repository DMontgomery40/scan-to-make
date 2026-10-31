import XCTest
import Combine
@testable import AgentKit

@MainActor final class PairingSessionTests: XCTestCase {
    final class Service: AgentService {
        var enabled = true
        func register() throws {}
        func unregister() throws {}
    }
    final class Session: PairingSession {
        var count = 0
        let service = Service()
        var listening = true
        var active = true
        let clock: () -> Date
        init(clock: @escaping () -> Date) {
            self.clock = clock
            super.init(now:clock,refreshInterval:.milliseconds(10))
        }
        override func ensureCompanionReady() async throws {
            try AgentManager(service:service).requireReady {
                if !listening { throw AgentError.commandFailed }
            }
        }
        override func isInvitationActive(_ invitation: PairingInvitation) async throws -> Bool { active }
        override func mintInvitation() async throws -> PairingInvitation {
            count += 1
            active = true
            let data = try JSONSerialization.data(withJSONObject:[
                "qrPayload":"scantomake://pair?v=1&c=fixture-\(count)",
                "expiresAt":clock().addingTimeInterval(300).timeIntervalSince1970 * 1000,
            ])
            return try PairingInvitation.decode(data,now:clock())
        }
    }

    func testDisabledAgentCannotMintOrShowCachedInvitation() async throws {
        let session = Session(clock:Date.init)
        let viewer = UUID()
        session.service.enabled = false
        await session.presentPairing(viewer)
        XCTAssertNil(session.invitation)
        XCTAssertEqual(session.count,0)
        XCTAssertEqual(session.failure as? AgentError,.approvalRequired)

        session.service.enabled = true
        await session.preparePairing()
        XCTAssertNotNil(session.invitation)
        session.hidePairing(viewer)
        session.service.enabled = false
        await session.presentPairing(viewer)
        XCTAssertNil(session.invitation)
        XCTAssertEqual(session.count,1)
        XCTAssertEqual(session.failure as? AgentError,.approvalRequired)
        session.hidePairing(viewer)
    }

    func testStoppedListenerHidesCachedInvitationAndRetryChecksReadiness() async throws {
        let session = Session(clock:Date.init)
        let viewer = UUID()
        await session.presentPairing(viewer)
        let shown = try XCTUnwrap(session.invitation?.qrPayload)
        session.hidePairing(viewer)
        session.listening = false
        await session.presentPairing(viewer)
        XCTAssertNil(session.invitation)
        XCTAssertEqual(session.failure as? AgentError,.companionUnavailable)
        XCTAssertEqual(session.count,1)

        session.listening = true
        await session.preparePairing()
        XCTAssertEqual(session.invitation?.qrPayload,shown)
        XCTAssertNil(session.failure)
        XCTAssertEqual(session.count,1)
        session.hidePairing(viewer)
    }

    func testConsumedInvitationIsReplacedOnReopen() async throws {
        let session = Session(clock:Date.init)
        let viewer = UUID()
        await session.presentPairing(viewer)
        let shown = try XCTUnwrap(session.invitation?.qrPayload)
        session.hidePairing(viewer)
        session.active = false
        await session.presentPairing(viewer)
        XCTAssertNotEqual(session.invitation?.qrPayload,shown)
        XCTAssertEqual(session.count,2)
        await session.preparePairing()
        XCTAssertEqual(session.count,2)
        session.hidePairing(viewer)
    }

    func testRenewalWaitsUntilExpirySoStoreCanRetirePreviousCode() async throws {
        var now = Date()
        let session = Session(clock:{ now })
        let viewer = UUID()
        await session.presentPairing(viewer)
        let shown = try XCTUnwrap(session.invitation?.qrPayload)
        session.hidePairing(viewer)
        now = now.addingTimeInterval(299)
        await session.presentPairing(viewer)
        XCTAssertEqual(session.invitation?.qrPayload,shown)
        XCTAssertEqual(session.count,1)
        now = now.addingTimeInterval(1)
        await session.preparePairing()
        XCTAssertNotEqual(session.invitation?.qrPayload,shown)
        XCTAssertEqual(session.count,2)
        session.hidePairing(viewer)
    }

    func testRepeatedPresentationReusesUnexpiredInvitation() async throws {
        let now = Date()
        let session = Session(clock:{ now })
        var shown: String?
        for _ in 0..<12 {
            let viewer = UUID()
            await session.presentPairing(viewer)
            let qr = try XCTUnwrap(session.invitation?.qrPayload)
            if let shown { XCTAssertEqual(qr,shown) } else { shown = qr }
            session.hidePairing(viewer)
        }
        XCTAssertEqual(session.count,1)
    }

    func testClosingPopoverPreservesWindowQRAndScheduledRefresh() async throws {
        var now = Date()
        let session = Session(clock:{ now })
        let window = UUID(), popover = UUID()
        await session.presentPairing(window)
        await session.presentPairing(popover)
        let shown = try XCTUnwrap(session.invitation?.qrPayload)

        session.hidePairing(popover)
        session.hidePairing(popover) // Duplicate disappearance cannot close another viewer.
        XCTAssertEqual(session.invitation?.qrPayload,shown)

        let refreshed = expectation(description:"Remaining window refreshes its QR")
        let observer = session.$invitation.compactMap { $0?.qrPayload }
            .filter { $0 != shown }.first().sink { _ in refreshed.fulfill() }
        now = now.addingTimeInterval(301)
        await fulfillment(of:[refreshed],timeout:2)
        observer.cancel()
        XCTAssertEqual(session.count,2)
        XCTAssertNotEqual(session.invitation?.qrPayload,shown)
        XCTAssertNotNil(session.invitation)

        session.hidePairing(window)
        XCTAssertNil(session.invitation)
    }
}
