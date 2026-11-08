import XCTest
@testable import CounterpartKit

final class PairingClientTests: XCTestCase {
    private let code = String(repeating: "C", count: 32)
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "counterpart-client-\(UUID().uuidString)")! }

    private func paired(_ body: [String: Any] = [:]) -> [String: Any] {
        ["deviceId": deviceId, "token": token, "protocolVersion": "0.1.0", "expiresAt": Date().timeIntervalSince1970 * 1000 + 30 * 86_400_000,
         "scopes": scopes].merging(body) { $1 }
    }
    private func invitation() -> PairingInvitation {
        let addresses = ["https://192.168.68.123:9077", "https://davids-mac-mini.local:9077", "https://100.101.102.103:9077"]
        return PairingInvitation(baseUrl: addresses[0], code: code, expiresAt: .max, addresses: addresses, publicKeySha256: keyPin)
    }

    func testV2PairsAtTheFirstAddressThatAnswersAndKeepsTheInvitationsPin() async throws {
        let memory = MemoryStore()
        let fake = FakeTransport { request, _ in
            if request.url?.host == "192.168.68.123" { throw TransportError("network") }
            // A response can't move the address or pin.
            return json(200, self.paired(["publicKeySha256": String(repeating: "cd", count: 32), "addresses": ["https://evil"], "activeUrl": "https://evil"]))
        }
        let client = PairingClient(store: PairingStore(store: memory, defaults: defaults()), transport: fake)
        let status = try await client.pair(invitation(), deviceName: "David's iPhone")
        XCTAssertEqual(status.state, .paired)
        XCTAssertEqual(status.baseUrl, "https://davids-mac-mini.local:9077")
        XCTAssertEqual(fake.paths, ["https://192.168.68.123:9077/v1/pair", "https://davids-mac-mini.local:9077/v1/pair"])
        let record = try XCTUnwrap(try client.store.read())
        XCTAssertEqual(record.publicKeySha256, keyPin)
        XCTAssertNil(record.activeUrl)
        XCTAssertEqual(record.addresses?.count, 3)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: fake.calls[1].request.httpBody!) as? [String: String])
        XCTAssertEqual(body["code"], code)
        XCTAssertEqual(body["deviceName"], "David's iPhone")
        XCTAssertEqual(body["installationKey"]?.count, 43)
        XCTAssertNil(fake.calls[1].request.value(forHTTPHeaderField: "Authorization"), "no earlier pairing, no token sent")
        guard case .pending(let pending) = fake.calls[1].trust else { return XCTFail("pairing must be pinned") }
        XCTAssertEqual(pending.publicKeySha256, keyPin)
    }

    func testRepairingTheSameMacSendsTheOldTokenSoItReplacesThisPhone() async throws {
        let memory = MemoryStore()
        let store = PairingStore(store: memory, defaults: defaults())
        try store.save(v2Record(), notify: false)
        let fake = FakeTransport { _, _ in json(200, self.paired()) }
        _ = try await PairingClient(store: store, transport: fake).pair(invitation(), deviceName: "iPhone")
        XCTAssertEqual(fake.calls[0].request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertEqual(fake.calls[0].request.value(forHTTPHeaderField: "X-Scan-Device"), deviceId)
        // Another Mac never sees it.
        var other = invitation(); other.publicKeySha256 = String(repeating: "cd", count: 32)
        let fake2 = FakeTransport { _, _ in json(200, self.paired()) }
        try store.save(v2Record(), notify: false)
        _ = try await PairingClient(store: store, transport: fake2).pair(other, deviceName: "iPhone")
        XCTAssertNil(fake2.calls[0].request.value(forHTTPHeaderField: "Authorization"))
    }

    func testFailuresInPlainCodes() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        for (status, code) in [(401, PairingError.Code.unauthorized), (403, .forbidden), (429, .rateLimited), (302, .wrongHost), (500, .unavailable)] {
            let fake = FakeTransport { _, _ in json(status, [:]) }
            do { _ = try await PairingClient(store: store, transport: fake).pair(invitation(), deviceName: "iPhone"); XCTFail() }
            catch { XCTAssertEqual((error as? PairingError)?.code, code) }
            XCTAssertEqual(fake.calls.count, 1, "an answer from the Mac stops the search")
        }
        // Every address unreachable reports the unreachable reason, not another server's certificate.
        let mixed = FakeTransport { request, _ in throw TransportError(request.url?.host == "192.168.68.123" ? "network" : "certificate") }
        do { _ = try await PairingClient(store: store, transport: mixed).pair(invitation(), deviceName: "iPhone"); XCTFail() }
        catch { XCTAssertEqual((error as? PairingError)?.code, .network) }
        XCTAssertEqual(mixed.calls.count, 3)
        // An expiry more than 31 days away is refused.
        let far = FakeTransport { _, _ in json(200, self.paired(["expiresAt": Date().timeIntervalSince1970 * 1000 + 40 * 86_400_000])) }
        do { _ = try await PairingClient(store: store, transport: far).pair(invitation(), deviceName: "iPhone"); XCTFail() }
        catch { XCTAssertEqual((error as? PairingError)?.code, .invalidResponse) }
        XCTAssertNil(try store.read())
    }

    /// A pairing whose screen closed mid-request (its task cancelled) never replaces the stored pairing,
    /// even when the Mac answers afterwards.
    func testACancelledPairingNeverSavesTheCredential() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        let slow = SlowTransport(reply: json(200, paired()))
        let client = PairingClient(store: store, transport: slow)
        let invitation = invitation()
        let task = Task { try await client.pair(invitation, deviceName: "iPhone") }
        try await Task.sleep(for: .milliseconds(50))
        task.cancel()
        do { _ = try await task.value; XCTFail("a cancelled pairing must not succeed") }
        catch { XCTAssertEqual((error as? PairingError)?.code, .cancelled) }
        XCTAssertNil(try store.read())
        // A call queued behind it starts only if it isn't cancelled too.
        let queued = Task { try await client.check() }
        queued.cancel()
        do { _ = try await queued.value; XCTFail() } catch {}
    }

    /// Forgetting the Mac wins over a refresh or check still answering: neither brings the pairing back.
    func testForgetWinsOverACallStillAnswering() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        try store.save(v2Record(expiresAt: Date().timeIntervalSince1970 * 1000 + 5 * 86_400_000), notify: false)
        let later = Date().timeIntervalSince1970 * 1000 + 30 * 86_400_000
        let client = PairingClient(store: store, transport: SlowTransport(reply: json(200, paired(["expiresAt": later]))))
        let refresh = Task { try await client.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        try client.forget()
        do { _ = try await refresh.value; XCTFail("a refresh that began before Forget must not save") } catch {}
        XCTAssertNil(try store.read())

        try store.save(v2Record(), notify: false)
        let moving = PairingClient(store: store, transport: SlowTransport(reply: json(200, ["protocolVersion": "0.1.0"])))
        let check = Task { try await moving.check() }
        try await Task.sleep(for: .milliseconds(50))
        try moving.forget()
        do { _ = try await check.value } catch {}
        XCTAssertNil(try store.read())
    }

    func testCheckMovesToTheAddressThatAnswersWithoutChangingThePairing() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        try store.save(v2Record(), notify: false)
        var changed = 0
        let observer = NotificationCenter.default.addObserver(forName: PairingStore.changed, object: nil, queue: nil) { _ in changed += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }
        let fake = FakeTransport { request, _ in
            if request.url?.host != "100.101.102.103" { throw TransportError("timeout") }
            XCTAssertEqual(request.url?.path, "/healthz")
            return json(200, ["protocolVersion": "0.1.0"])
        }
        let status = try await PairingClient(store: store, transport: fake).check()
        XCTAssertEqual(status.activeUrl, "https://100.101.102.103:9077")
        XCTAssertEqual(try store.read()?.activeUrl, "https://100.101.102.103:9077")
        XCTAssertEqual(try store.read()?.baseUrl, "https://192.168.68.123:9077", "baseUrl names the Mac and never moves")
        XCTAssertEqual(changed, 0, "another address is still the same pairing: requests in flight carry on")
        // Next time that address goes first.
        let again = FakeTransport { _, _ in json(200, ["protocolVersion": "0.1.0"]) }
        _ = try await PairingClient(store: store, transport: again).check()
        XCTAssertEqual(again.paths, ["https://100.101.102.103:9077/healthz"])
    }

    func testRefreshTakesOnlyTheExpiryAndScopes() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        try store.save(v2Record(), notify: false)
        let later = Date().timeIntervalSince1970 * 1000 + 30 * 86_400_000
        let fake = FakeTransport { request, _ in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/auth/refresh")
            return json(200, self.paired(["expiresAt": later, "baseUrl": "https://evil"]))
        }
        let status = try await PairingClient(store: store, transport: fake).refresh()
        XCTAssertEqual(status.expiresAtMs, later)
        XCTAssertEqual(try store.read()?.baseUrl, "https://192.168.68.123:9077")
        // A different token back is refused.
        let wrong = FakeTransport { _, _ in json(200, self.paired(["token": String(repeating: "x", count: 43)])) }
        do { _ = try await PairingClient(store: store, transport: wrong).refresh(); XCTFail() }
        catch { XCTAssertEqual((error as? PairingError)?.code, .invalidResponse) }
    }

    func testFreshness() async throws {
        let store = PairingStore(store: MemoryStore(), defaults: defaults())
        var result = await PairingFreshness.keep(PairingClient(store: store, transport: FakeTransport { _, _ in json(200, [:]) }))
        XCTAssertEqual(result, .skipped)
        try store.save(v2Record(expiresAt: Date().timeIntervalSince1970 * 1000 + 25 * 86_400_000), notify: false)
        let none = FakeTransport { _, _ in XCTFail("fresh: no request"); return json(500, [:]) }
        result = await PairingFreshness.keep(PairingClient(store: store, transport: none))
        XCTAssertEqual(result, .fresh)
        try store.save(v2Record(expiresAt: Date().timeIntervalSince1970 * 1000 + 5 * 86_400_000), notify: false)
        result = await PairingFreshness.keep(PairingClient(store: store, transport: FakeTransport { _, _ in json(401, [:]) }))
        XCTAssertEqual(result, .pairAgain)
        result = await PairingFreshness.keep(PairingClient(store: store, transport: FakeTransport { _, _ in throw TransportError("network") }))
        XCTAssertEqual(result, .skipped)
        try store.save(v2Record(expiresAt: 10), notify: false)
        result = await PairingFreshness.keep(PairingClient(store: store, transport: none))
        XCTAssertEqual(result, .pairAgain)
    }

    func testTheGateRunsOneCallAtATimeInOrder() async throws {
        let gate = SerialGate()
        let log = Log()
        async let a: Void = try gate.run { await log.add("a1"); try await Task.sleep(for: .milliseconds(50)); await log.add("a2") }
        try await Task.sleep(for: .milliseconds(5))
        async let b: Void = try gate.run { await log.add("b") }
        _ = try await (a, b)
        let entries = await log.entries
        XCTAssertEqual(entries, ["a1", "a2", "b"])
    }
    private actor Log { var entries: [String] = []; func add(_ s: String) { entries.append(s) } }
}

/// Answers after a delay that ignores cancellation, like a reply already on its way.
private final class SlowTransport: HTTPTransport, @unchecked Sendable {
    let reply: HTTPReply
    init(reply: HTTPReply) { self.reply = reply }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let end = Date().addingTimeInterval(0.3)
        while Date() < end { try? await Task.sleep(for: .milliseconds(20)) }
        return reply
    }
}

final class CompanionClientTests: XCTestCase {
    func testProjectRefreshHasAShortDeadlineWithoutCuttingOffLongPollsOrSlicing() async throws {
        let fake = FakeTransport { request, _ in
            switch request.url?.path {
            case "/v1/objects": return json(200, ["objects": []])
            case "/v1/events": return json(200, ["events": [], "next": 0, "latest": 0])
            default: return json(200, ["destinationId": "current", "quality": "standard", "strength": "standard", "seconds": 30, "grams": 1])
            }
        }
        let mac = try client(fake)
        _ = try await mac.list()
        XCTAssertLessThanOrEqual(fake.calls[0].request.timeoutInterval, 10, "an unanswered refresh must leave the loading screen promptly")
        XCTAssertLessThanOrEqual(fake.calls[0].resourceTimeout, 15, "trickled bytes cannot keep the refresh alive indefinitely")
        _ = try await LongPollEventFeed(client: mac).page(after: 1, wait: 25, limit: 100)
        XCTAssertGreaterThan(fake.calls[1].request.timeoutInterval, 25)
        XCTAssertLessThanOrEqual(fake.calls[1].resourceTimeout, 50, "a stalled event poll must also end")
        _ = try await mac.request("POST", "/v1/objects/0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11/estimate", as: SliceEstimate.self, timeout: 640)
        XCTAssertEqual(fake.calls[2].request.timeoutInterval, 640, "slicing has its own longer deadline")
        XCTAssertGreaterThanOrEqual(fake.calls[2].resourceTimeout, 640, "the whole reply may take as long as the slice")
        _ = try await mac.send("GET", "/v1/objects/0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11/model.stl", limit: CompanionClient.scanLimit)
        XCTAssertGreaterThanOrEqual(fake.calls[3].resourceTimeout, 180, "a large model download keeps its transfer budget")
    }

    func testLiveActivityTokenContractAndRemoval() async throws {
        let fake = FakeTransport { _, _ in json(200, ["stored": true]) }
        let client = try client(fake)
        let token = String(repeating: "ab", count: 32)
        let printId = "11111111-1111-4111-8111-111111111111"
        try await client.registerLiveActivity(pushToStart: token)
        try await client.registerLiveActivity(printId: printId, token: token)
        try await client.registerLiveActivity(printId: printId, token: nil)
        let bodies = try fake.calls.map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0.request.httpBody!) as? [String: Any]) }
        XCTAssertEqual(bodies[0]["pushToStart"] as? String, token)
        XCTAssertEqual((bodies[1]["activity"] as? [String: String])?["printId"], printId)
        XCTAssertTrue((bodies[2]["activity"] as? [String: Any])?["token"] is NSNull)
        XCTAssertTrue(fake.calls.allSatisfy { $0.request.url?.path == "/v1/devices/live-activity-tokens" && $0.request.httpMethod == "POST" })
        do { try await client.registerLiveActivity(printId: "bad", token: token); XCTFail() } catch {}
        do { try await client.registerLiveActivity(pushToStart: "bad"); XCTFail() } catch {}
        XCTAssertEqual(fake.calls.count, 3, "invalid tokens never leave the phone")
    }

    func testBlenderActionsUseMatchingMethodsAndDecodeTheCompanionStatus() async throws {
        let fake = FakeTransport { _, _ in json(200, ["blender": ["state": "restart-needed", "message": "Restart Blender when your work is saved.", "canUpdate": false]]) }
        let mac = try client(fake)
        for action in [BlenderAddonStatus.Action.status, .check, .update] {
            let status = try await mac.blenderAddon(action)
            XCTAssertEqual(status.state, "restart-needed")
            XCTAssertFalse(status.canUpdate)
        }
        XCTAssertEqual(fake.calls.map { $0.request.httpMethod }, ["GET", "POST", "POST"])
        XCTAssertEqual(fake.calls.map { $0.request.url?.path }, ["/v1/blender", "/v1/blender/check", "/v1/blender/update"])
    }

    private func client(_ fake: FakeTransport, record: PairingRecord = v2Record()) throws -> CompanionClient {
        let store = PairingStore(store: MemoryStore(), defaults: UserDefaults(suiteName: "cc-\(UUID().uuidString)")!)
        try store.save(record, notify: false)
        let cache = FileManager.default.temporaryDirectory.appending(path: "counterpart-tests-\(UUID().uuidString)")
        return CompanionClient(pairing: PairingClient(store: store, transport: fake), transport: fake, deviceModel: "iPhone18,2", cache: cache)
    }

    func testCapabilityFlagsFromHealth() async throws {
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: Data(#"{"status":"ok","protocolVersion":"0.1.0","capabilities":{"genericConfirmations":true,"structuredPasses":false}}"#.utf8)) }
        let flags = try await client(fake).capabilities()
        XCTAssertEqual(flags, ["genericConfirmations"])
        let older = FakeTransport { _, _ in HTTPReply(status: 200, body: Data(#"{"status":"ok","protocolVersion":"0.1.0"}"#.utf8)) }
        let none = try await client(older).capabilities()
        XCTAssertEqual(none, [], "an older Mac lists none")
    }

    func testAskAnswersNameOnlyTheirOwnPhotosAndBestGuessNamesNone() async throws {
        let id = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
        let object: [String: Any] = ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "photos": [], "passes": []]
        let fake = FakeTransport { _, _ in json(200, ["object": object]) }
        let c = try client(fake)
        _ = try await c.answerAsk(id, bestGuess: true)
        _ = try await c.answerAsk(id, text: "The underside is flat.")
        _ = try await c.answerAsk(id, photoNames: ["closeup.jpg"])
        let bodies = try fake.calls.map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0.request.httpBody!) as? [String: Any]) }
        XCTAssertEqual(bodies[0]["photoNames"] as? [String], [])
        XCTAssertEqual(bodies[1]["photoNames"] as? [String], [])
        XCTAssertEqual(bodies[2]["photoNames"] as? [String], ["closeup.jpg"])
    }

    func testProjectPreferencesAndDuplicateUseTheSharedCompanionContract() async throws {
        let id = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
        let object: [String: Any] = ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "photos": [], "passes": [],
            "settings": ["status": "not-printed", "archived": false, "printDefaults": ["quality": "fine", "copies": 3], "designEngine": "blender", "notifications": "problems"]]
        let fake = FakeTransport { _, _ in json(200, ["object": object]) }
        let c = try client(fake)
        let saved = try await c.setProjectSettings(id, ["printDefaults": .object(["quality": .string("fine"), "copies": .number(3)])])
        XCTAssertEqual(saved.settings?.printDefaults?.quality, "fine")
        XCTAssertEqual(saved.settings?.printDefaults?.copies, 3)
        XCTAssertEqual(saved.settings?.notifications, "problems")
        _ = try await c.duplicate(id)
        _ = try await c.print(id, choice: .init(colour: nil), overrideDefaults: true)
        XCTAssertTrue(fake.calls[0].request.url!.path.hasSuffix("/settings"))
        XCTAssertTrue(fake.calls[1].request.url!.path.hasSuffix("/duplicate"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: fake.calls[2].request.httpBody!) as? [String: Any])
        XCTAssertEqual(body["quality"] as? String, "standard", "an explicit Standard must replace saved Fine")
        XCTAssertEqual(body["strength"] as? String, "standard")
        let decoded = try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(saved))
        XCTAssertEqual(decoded.settings?.printDefaults?.copies, 3)
    }

    func testPublishedCreationUploadAndPlateChoiceUseExactContracts() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        let fake = FakeTransport { _, _ in json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": "ready", "photos": [], "passes": []]]) }
        let c = try client(fake)
        let link = URL(string: "https://makerworld.com/en/models/1531561")!
        _ = try await c.create("Print the rig", kind: "published", url: link)
        let create = try XCTUnwrap(JSONSerialization.jsonObject(with: fake.calls[0].request.httpBody!) as? [String: Any])
        XCTAssertEqual(create["kind"] as? String, "published"); XCTAssertEqual(create["url"] as? String, link.absoluteString)
        let file = FileManager.default.temporaryDirectory.appending(path: "original-\(UUID().uuidString).3mf")
        defer { try? FileManager.default.removeItem(at: file) }
        let bytes = Data([0x50, 0x4b, 1, 2, 3]); try bytes.write(to: file)
        _ = try await c.addModelFile(id, file: file)
        XCTAssertEqual(fake.calls[1].request.httpBody, bytes)
        XCTAssertEqual(fake.calls[1].request.url?.path, "/v1/objects/\(id)/model")
        XCTAssertEqual(URLComponents(url: fake.calls[1].request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, file.lastPathComponent)
        _ = try await c.choosePublishedPlate(id, askId: "question-id", choice: "1:2")
        let answer = try XCTUnwrap(JSONSerialization.jsonObject(with: fake.calls[2].request.httpBody!) as? [String: Any])
        XCTAssertEqual(answer["askId"] as? String, "question-id"); XCTAssertEqual(answer["choices"] as? [String], ["1:2"])
    }

    func testCreateSendsTheKindYouPicked() async throws {
        var bodies: [[String: Any]] = []
        let fake = FakeTransport { request, _ in
            bodies.append((request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:])
            return json(201, ["object": ["id": "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", "createdAtMs": 1, "updatedAtMs": 1, "state": "new", "photos": [], "passes": []]])
        }
        let c = try client(fake)
        _ = try await c.create("A hook", kind: "fit")
        _ = try await c.create("", kind: "copy")
        _ = try await c.create("A hook")
        _ = try await c.create("A hook", kind: "sculpt")
        XCTAssertEqual(bodies[0]["kind"] as? String, "fit")
        XCTAssertEqual(bodies[1]["kind"] as? String, "copy")
        XCTAssertNil(bodies[1]["instructions"])
        XCTAssertNil(bodies[2]["kind"], "no card picked and no scan: the Mac infers it")
        XCTAssertNil(bodies[3]["kind"], "only fit or copy is sent")
    }

    /// Project Settings' status (PRD §5.4): `PATCH /v1/objects/<id>/settings {status}`, the project back when the
    /// Mac sends it, and "update your Mac" from an older one.
    func testTheStatusIsSetInProjectSettings() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        var sent: [(String, String, [String: Any])] = []
        var replies: [HTTPReply] = [
            json(200, ["settings": ["status": "works"],
                       "object": ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "confirmed", "settings": ["status": "works"],
                                  "status": ["phase": "confirmed", "text": "It works", "symbol": "checkmark.circle.fill", "tint": "green"]]]),
            json(409, ["error": ["code": "busy", "message": "Wait for the print to finish, then set the status."]]),
            json(200, ["settings": ["status": "archived"]]),
            json(404, ["error": ["code": "not-found", "message": "Not found"]]),
        ]
        let fake = FakeTransport { request, _ in
            sent.append((request.httpMethod ?? "", request.url?.path ?? "", (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]))
            return replies.removeFirst()
        }
        let c = try client(fake)
        let works = try await c.setStatus(id, .works)
        XCTAssertEqual(works?.state, .confirmed)
        XCTAssertEqual(works?.projectStatus, .works)
        do { _ = try await c.setStatus(id, .printed); XCTFail() } catch let failure as CompanionError {
            XCTAssertEqual(failure.message, "Wait for the print to finish, then set the status.", "the Mac's sentence, as is")
        }
        let archived = try await c.setStatus(id, .archived)
        XCTAssertNil(archived, "no project in the reply: the caller reads it again")
        do { _ = try await c.setStatus(id, .needsChanges); XCTFail() } catch let failure as CompanionError { XCTAssertTrue(failure.isUnsupported) }
        XCTAssertEqual(sent.map(\.0), ["PATCH", "PATCH", "PATCH", "PATCH"])
        XCTAssertEqual(sent[0].1, "/v1/objects/\(id)/settings")
        XCTAssertEqual(sent.map { $0.2["status"] as? String }, ["works", "printed", "archived", "needs-changes"])
        XCTAssertEqual(CompanionClient.scope("PATCH", "/v1/objects/\(id)/settings"), "captures:import", "the companion's WRITE")
        replies = [json(200, ["settings": ["status": "works", "archived": true]])]
        _ = try await c.setArchived(id, true)
        XCTAssertEqual(sent.last?.2 as NSDictionary?, ["archived": true] as NSDictionary)
    }

    func testCameraConditionalResponseKeepsTheImageAndNegotiatesStreamCadence() async throws {
        let bytes = Data([255, 216, 255, 1])
        var count = 0
        let fake = FakeTransport { request, _ in
            count += 1
            XCTAssertEqual(request.url?.query, "size=full")
            if count == 1 {
                XCTAssertNil(request.value(forHTTPHeaderField: "If-None-Match"))
                return HTTPReply(status: 200, body: bytes, headers: ["ETag": "quoted-hash", "X-Camera-Stream": "1", "X-Captured-At": "2026-11-02T12:00:00Z"])
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "quoted-hash")
            return HTTPReply(status: 304, body: Data(), headers: ["ETag": "quoted-hash", "X-Camera-Stream": "1"])
        }
        let c = try client(fake)
        let first = try await c.camera(printer: "printer-one", fullScreen: true)
        let next = try await c.camera(printer: "printer-one", fullScreen: true, previous: first)
        XCTAssertEqual(next.jpeg, bytes)
        XCTAssertEqual(next.capturedAt, first.capturedAt)
        XCTAssertTrue(next.streaming)
        XCTAssertEqual(fake.calls.count, 2)
        let legacy = try client(FakeTransport { _, _ in HTTPReply(status: 200, body: bytes) })
        let snapshot = try await legacy.camera(printer: "printer-one")
        XCTAssertFalse(snapshot.streaming)
        XCTAssertNil(snapshot.etag)
    }

    func testRealSettingsResponseSurvivesClientDecodingAndRetainsReadySubscription() async throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "notification-settings", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: url)
        let transport = FakeTransport { request, _ in
            XCTAssertEqual(request.url?.path, "/v1/settings")
            return HTTPReply(status: 200, body: bytes)
        }
        let settings = try await client(transport).settings()
        XCTAssertNotNil(settings.general)
        XCTAssertEqual(settings.notifications?.mac, [:])
        XCTAssertTrue(CloudNotificationSubscriptions.changes(settings: settings, localChoices: [true]).saving.contains { $0.subscriptionID == "ev-ready" })
    }

    func testRealRuntimeSettingsResponseExposesPhoneAIAndFusion() async throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "runtime-settings", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: url)
        let transport = FakeTransport { _, _ in HTTPReply(status: 200, body: bytes) }
        let settings = try await client(transport).settings()
        XCTAssertEqual(settings.ai?.choice?.kind, "none")
        XCTAssertEqual(settings.ai?.scope, "model-jobs")
        XCTAssertEqual(settings.ai?.revision, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(settings.fusion?.state, "unavailable")
        XCTAssertEqual(settings.fusion?.message, "Open Counterpart on your Mac to check Fusion setup.")
    }

    func testScopes() {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("GET", "/healthz"), "generation:health")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/printers"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/\(id)/filaments"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/\(id)/camera.jpg"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/printers/mcp-1a2b/camera.jpg"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/\(id)/print/pause"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/\(id)/estimate"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/\(id)/corrections"), "captures:import")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/\(id)/model"), "captures:import")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/\(id)/ask"), "captures:import")
        XCTAssertEqual(CompanionClient.scope("PUT", "/v1/objects/\(id)/scan"), "captures:import")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/\(id)/scan/original.usdz"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/events"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("PATCH", "/v1/settings"), "projects:write")
        XCTAssertNil(CompanionClient.scope("GET", "/v1/auth/devices"), "the phone never calls routes it doesn't know")
        XCTAssertNil(CompanionClient.scope("DELETE", "/v1/objects"))
    }

    func testRequestsCarryTheCredentialAndModelAndArePinned() async throws {
        let data = try fixture("objects.json")
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: data) }
        let projects = try await client(fake).list()
        XCTAssertEqual(projects.count, 8)
        let request = fake.calls[0].request
        XCTAssertEqual(request.url?.absoluteString, "https://192.168.68.123:9077/v1/objects")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Scan-Device"), deviceId)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Scan-Device-Model"), "iPhone18,2")
        guard case .record = fake.calls[0].trust else { return XCTFail("requests are pinned to the record") }
    }

    func testAnExpiredOrScopelessPairingNeverLeavesThePhone() async throws {
        let fake = FakeTransport { _, _ in XCTFail("no request"); return json(200, [:]) }
        do { _ = try await client(fake, record: v2Record(expiresAt: 10)).list(); XCTFail() }
        catch { XCTAssertEqual((error as? CompanionError)?.code, "pairing-required") }
        var limited = v2Record(); limited.fields["scopes"] = .array([.string("generation:health"), .string("projects:read")])
        do { _ = try await client(fake, record: limited).filaments("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"); XCTFail() }
        catch { XCTAssertEqual((error as? CompanionError)?.code, "scope-denied") }
    }

    func testRefusalsInPlainWords() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        func refusal(_ status: Int, _ body: [String: Any] = [:], path: String = "/v1/objects/\(id)") async throws -> CompanionError {
            let fake = FakeTransport { _, _ in json(status, body) }
            do { _ = try await client(fake).request("GET", path, as: JSONValue.self); XCTFail(); return .unreachable }
            catch { return try XCTUnwrap(error as? CompanionError) }
        }
        let conflict = try await refusal(409, ["error": ["code": "invalid-state", "message": "Wait until the print finishes."]])
        XCTAssertEqual(conflict.message, "Wait until the print finishes.", "a 409's sentence is written for the person")
        let events = try await refusal(404, path: "/v1/events")
        XCTAssertEqual(events.code, "not-supported")
        let missing = try await refusal(404)
        XCTAssertEqual(missing.code, "not-found")
        let unpaired = try await refusal(401)
        XCTAssertTrue(unpaired.needsPairing)
        let camera = try await refusal(503, path: "/v1/objects/\(id)/camera.jpg")
        XCTAssertEqual(camera.message, "The printer's camera isn't answering right now.")
        // Nov 6: the Mac's own sentence is shown whatever the status, once it says it's written for the person.
        for (status, code) in [(400, "invalid-request"), (503, "unavailable"), (404, "not-found"), (500, "internal")] {
            let said = try await refusal(status, ["error": ["code": code, "message": "Update bambu-printer-mcp in Settings → Printers.",
                                                            "sentence": "Update bambu-printer-mcp in Settings → Printers."]])
            XCTAssertEqual(said.message, "Update bambu-printer-mcp in Settings → Printers.", "\(status)")
        }
        let words = try await refusal(400, ["error": ["code": "invalid-request", "message": "invalid-request"]])
        XCTAssertEqual(words.message, "Your Mac didn't accept that. Update Counterpart on your Mac, then try again.", "a bare code is never shown")
        let unreachable = FakeTransport { _, _ in throw TransportError("timeout") }
        do { _ = try await client(unreachable, record: v2Record()).get(id); XCTFail() }
        catch { XCTAssertTrue((error as? CompanionError)?.isUnreachable == true) }
    }

    func testAnUnreachableGETTriesTheMacsOtherAddressesOnce() async throws {
        let data = try fixture("objects.json")
        let fake = FakeTransport { request, _ in
            if request.url?.host == "192.168.68.123" { throw TransportError("network") }
            if request.url?.path == "/healthz" { return json(200, ["protocolVersion": "0.1.0"]) }
            return HTTPReply(status: 200, body: data)
        }
        let projects = try await client(fake).list()
        XCTAssertEqual(projects.count, 8)
        XCTAssertEqual(fake.paths.last, "https://davids-mac-mini.local:9077/v1/objects")
    }

    func testPrintBodyIsWhatEveryCompanionAcceptsUnlessYouChooseMore() throws {
        let filament = PrinterFilament(slot: 0, colour: "#141414", material: "PLA", name: "Bambu PLA Basic", filamentId: "GFA00", destinationId: "current")
        let plain = PrintChoice(filament: filament).body
        XCTAssertEqual(Set(plain.keys), ["checked", "filament"], "standard quality and strength send nothing")
        XCTAssertNil(PrintChoice(filament: filament).body["copies"], "not chosen: the printer profile's count applies")
        XCTAssertEqual(PrintChoice(filament: filament, copies: 1).body["copies"] as? Int, 1, "one, chosen, is sent")
        XCTAssertEqual(PrintChoice(filament: filament, copies: 3).body["copies"] as? Int, 3)
        XCTAssertEqual(PrintChoice(filament: filament, copies: 0).body["copies"] as? Int, 1, "never fewer than one")
        let more = PrintChoice(filament: filament, quality: .fine, strength: .strong).body
        XCTAssertEqual(more["quality"] as? String, "fine")
        XCTAssertEqual(more["strength"] as? String, "strong")
        XCTAssertNil(more["plateCheck"], "no plate check (main ac44431)")
        XCTAssertEqual(PrintChoice(colour: .auto).body["colour"] as? [String: Bool], ["auto": true])
        XCTAssertEqual(PrintChoice(colour: .external).body["colour"] as? [String: Bool], ["external": true])
        XCTAssertEqual(PrintChoice(colour: .material("PETG")).body["colour"] as? [String: String], ["material": "PETG"])
        XCTAssertNil(PrintChoice(colour: .material("PETG")).body["filament"], "filament or colour, never both")
        XCTAssertEqual(Set(PrintChoice(colour: nil).body.keys), ["checked"])
        XCTAssertEqual(filament.displayName, "Bambu PLA Basic")
        XCTAssertEqual(PrinterFilament(slot: 254, colour: "#FFFFFF", material: "PETG", name: "Generic PETG #FFFFFF", filamentId: "", destinationId: "x").slotLabel, "PETG", "no MCP label: the material, never a slot formula")
        // The printer MCP's words (PRD §8.0 item 7; Nov 2–3 review: "A1 · PLA PLA Basic PLA #000000").
        let named = PrinterFilament(slot: 1, colour: "#FEC600", material: "PLA", name: "Sunflower Yellow PLA Basic", filamentId: "GFA00", destinationId: "x", label: "A2", feed: "ams")
        XCTAssertEqual(named.title, "A2 · Sunflower Yellow PLA Basic")
        XCTAssertEqual(named.spoolName, "Sunflower Yellow PLA Basic", "the MCP's name already says its material")
        let mapping = ColourMapping(filaments: [ModelColourFilament(index: 1, colour: "#FFFFFF", slot: 1, verdict: "closest", note: "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.")],
                                    trays: [named, PrinterFilament(slot: 254, colour: "#FFFFFF", material: "PLA", name: "White PLA", filamentId: "", destinationId: "x", label: "External", feed: "external")])
        XCTAssertEqual(mapping.note(mapping.filaments[0], slots: [1: 1]), "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.")
        XCTAssertNil(mapping.note(mapping.filaments[0], slots: [1: 254]))
        XCTAssertFalse(mapping.mixesFeeds(slots: [1: 254]))
    }

    func testPausesAreSentOnlyWhenChosenSortedAndWithinTheCompanionsLimit() throws {
        let filament = PrinterFilament(slot: 0, colour: "#141414", material: "PLA", name: "Bambu PLA Basic", filamentId: "GFA00", destinationId: "current")
        XCTAssertNil(PrintChoice(filament: filament).body["pauseBeforeLayers"], "no pause, no key: an older Mac refuses it")
        XCTAssertNil(PrintChoice(colour: nil, pauseBeforeLayers: []).body["pauseBeforeLayers"], "an empty list is never sent (the companion's min is 1)")
        XCTAssertEqual(PrintChoice(colour: nil, pauseBeforeLayers: [12, 3, 12, 1]).body["pauseBeforeLayers"] as? [Int], [3, 12],
                       "sorted, once each, never layer 1")
        XCTAssertEqual((PrintChoice(colour: nil, pauseBeforeLayers: Array(2...40)).body["pauseBeforeLayers"] as? [Int])?.count, PrintChoice.maxPauses)
    }

    func testColourMappingDecodesAndChosenSpoolsReachEstimateAndPrintInOrder() async throws {
        let id = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
        let black: [String: Any] = ["slot": 0, "colour": "#000000", "material": "PETG", "name": "Black PETG", "filamentId": "GFG00", "destinationId": "p1s"]
        let yellow: [String: Any] = ["slot": 1, "colour": "#FEC600", "material": "PLA", "name": "Yellow PLA", "filamentId": "GFA00", "destinationId": "p1s"]
        let object: [String: Any] = ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "kind": "published", "photos": [], "passes": [],
                                     "current": ["model": "original/pick.3mf", "renders": []]]
        let fake = FakeTransport { request, _ in
            switch request.url?.path {
            case "/v1/objects/\(id)/colour-mapping":
                return json(200, ["filaments": [["index": 1, "name": "body", "colour": "#111111", "slot": 0, "distance": 0.04],
                                                ["index": 2, "name": "letters", "colour": "#FFD200", "material": "PLA", "slot": 1, "distance": 0.12]],
                                  "trays": [black, yellow], "modelVersion": "pick-3mf-v7"])
            case "/v1/objects/\(id)/estimate":
                return json(200, ["destinationId": "p1s", "quality": "standard", "strength": "standard", "seconds": 600, "grams": 4, "layers": 40])
            default:
                return json(200, ["object": object])
            }
        }
        let mac = try client(fake)
        let mapping = try await mac.colourMapping(id)
        XCTAssertEqual(mapping.filaments.map(\.name), ["body", "letters"])
        XCTAssertEqual(mapping.filaments.map(\.slot), [0, 1], "the Mac's nearest-colour suggestions arrive chosen")
        XCTAssertEqual(mapping.suggestedSlots, [1: 0, 2: 1])
        XCTAssertEqual(mapping.modelVersion, "pick-3mf-v7")
        XCTAssertNil(mapping.spools(slots: [1: 0]), "every colour needs a spool before anything is sent")
        // The person swaps both spools: the estimate and the print carry exactly that order, bound to the version.
        let chosen = try XCTUnwrap(mapping.spools(slots: [1: 1, 2: 0]))
        XCTAssertEqual(chosen.map(\.slot), [1, 0])
        _ = try await mac.estimate(id, destinationId: "p1s", quality: .standard, strength: .standard, overrideDefaults: true,
                                   filaments: chosen, filamentsModelVersion: mapping.modelVersion)
        let choice = PrintChoice(colour: .tray(mapping.trays[0]), checked: true, copies: 2, pauseBeforeLayers: [3],
                                 filaments: chosen, filamentsModelVersion: mapping.modelVersion)
        _ = try await mac.print(id, choice: choice, overrideDefaults: true, expectedPlate: "\(String(repeating: "ab", count: 32)):2")
        XCTAssertEqual(fake.calls.map { $0.request.url?.path }, ["/v1/objects/\(id)/colour-mapping", "/v1/objects/\(id)/estimate", "/v1/objects/\(id)/print"])
        XCTAssertEqual(fake.calls.map { $0.request.httpMethod }, ["GET", "POST", "POST"])
        for call in fake.calls.dropFirst() {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: call.request.httpBody!) as? [String: Any])
            let spools = try XCTUnwrap(body["filaments"] as? [[String: Any]])
            XCTAssertEqual(spools.map { $0["slot"] as? Int }, [1, 0], "the person's order, not the suggestion's")
            XCTAssertEqual(spools[0].mapValues { $0 as! AnyHashable }, yellow.mapValues { $0 as! AnyHashable })
            XCTAssertEqual(body["filamentsModelVersion"] as? String, "pick-3mf-v7")
            XCTAssertNil(body["filament"], "per-colour spools replace the one-spool choice, never both")
            XCTAssertNil(body["colour"])
        }
        let printed = try XCTUnwrap(JSONSerialization.jsonObject(with: fake.calls[2].request.httpBody!) as? [String: Any])
        XCTAssertEqual(printed["expectedPlate"] as? String, "\(String(repeating: "ab", count: 32)):2", "the selected plate still guards the print")
        XCTAssertEqual(printed["copies"] as? Int, 2)
        XCTAssertEqual(printed["pauseBeforeLayers"] as? [Int], [3], "pauses ride along with the per-colour spools")
        XCTAssertEqual(printed["checked"] as? Bool, true)
        // An older Mac without the route says so in words the sheet can show, and sends nothing else.
        let older = try client(FakeTransport { _, _ in json(404, ["error": ["code": "not-found", "message": "Not found"]]) })
        do { _ = try await older.colourMapping(id); XCTFail() }
        catch let error as CompanionError { XCTAssertEqual(error.message, "Update Counterpart on your Mac to choose a spool for each colour here.") }
    }

    func testPrinterDestinationsDecodeBothMCPsAndLayerPausesAndOlderMacsStillDecode() throws {
        let current = #"{"id":"current","name":"P1S","backend":"bambu-printer-mcp","source":"current","mcps":[{"backend":"bambu-printer-mcp","destinationId":"current"},{"backend":"mcp-3d-printer-server","destinationId":"mcp-1a2b"}],"capabilities":{"progress":true,"layers":true,"camera":"bambu-tcp","filaments":"ams","pause":true,"resume":true,"cancel":true,"quality":true,"strength":true,"layerPauses":true,"newerField":1}}"#
        let printer = try JSONDecoder().decode(PrinterDestination.self, from: Data(current.utf8))
        XCTAssertTrue(printer.offersMcpChoice)
        XCTAssertEqual(printer.mcps?.map(\.name), ["bambu-printer-mcp", "mcp-3D-printer-server"])
        XCTAssertTrue(printer.offersLayerPauses)
        let older = try JSONDecoder().decode(PrinterDestination.self, from: Data(#"{"id":"current","name":"P1S","backend":"bambu-printer-mcp","source":"current"}"#.utf8))
        XCTAssertFalse(older.offersMcpChoice)
        XCTAssertFalse(older.offersLayerPauses)
        // A project saved on the printer's id through the other MCP finds the printer it became.
        let catalog = PrinterCatalog(destinations: [printer], defaultDestinationId: "current")
        XCTAssertEqual(catalog.listed("current"), "current")
        XCTAssertEqual(catalog.listed("mcp-1a2b"), "current")
        XCTAssertNil(catalog.listed("gone"))
    }

    func testPrinterConnectionReadsTheMCPsOwnWordsAndChangesGoThroughTheMac() async throws {
        let route: [String: Any] = ["route": "lan", "mode": "bambu_network", "type": "lan", "choices": ["lan", "cloud", "developer"], "savedTo": "/Users/x/.env",
            "options": [["id": "lan", "label": "Local network", "available": true, "controls": "Pause, Resume and Stop go through FULU."],
                        ["id": "cloud", "label": "Bambu Cloud", "available": false, "reason": "Sign in first."],
                        ["id": "developer", "label": "Local network, Developer Mode", "available": true]]]
        let fake = FakeTransport { request, _ in
            if request.url?.path.hasSuffix("/mcp") == true { return json(200, ["destinationId": "mcp-1a2b"]) }
            if request.httpMethod == "PUT" { return json(200, ["route": route.merging(["route": "developer"]) { $1 }]) }
            return json(200, ["route": route])
        }
        let c = try client(fake)
        let maybe = try await c.printerConnection("current")
        let read = try XCTUnwrap(maybe)
        XCTAssertEqual(read.current?.label, "Local network")
        XCTAssertEqual(read.current?.controls, "Pause, Resume and Stop go through FULU.")
        XCTAssertEqual(read.shown.map(\.available), [true, false, true])
        let saved = try await c.setPrinterConnection("current", route: "developer")
        XCTAssertEqual(saved.route, "developer")
        let id = try await c.choosePrinterMcp("current", backend: "mcp-3d-printer-server")
        XCTAssertEqual(id, "mcp-1a2b")
        XCTAssertEqual(fake.calls.map { $0.request.httpMethod }, ["GET", "PUT", "PUT"])
        XCTAssertEqual(fake.calls.map { $0.request.url?.path }, ["/v1/objects/printers/current/route", "/v1/objects/printers/current/route", "/v1/objects/printers/current/mcp"])
        let bodies = try fake.calls.dropFirst().map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0.request.httpBody!) as? [String: String]) }
        XCTAssertEqual(bodies, [["route": "developer"], ["backend": "mcp-3d-printer-server"]])
        do { _ = try await c.printerConnection("../x"); XCTFail("an id that isn't one is never sent") } catch {}
        XCTAssertEqual(fake.calls.count, 3)
    }

    func testPrinterConnectionWithoutAChoiceOrOnAnOlderMacAndARefusalMidPrint() async throws {
        let none = try await client(FakeTransport { _, _ in json(200, ["route": NSNull()]) }).printerConnection("current")
        XCTAssertNil(none, "an MCP without the choice: nothing to show")
        let legacy = try JSONDecoder().decode(PrinterConnection.self, from: Data(#"{"route":"cloud","mode":"bambu_network","type":"cloud","choices":["lan","cloud"],"savedTo":null}"#.utf8))
        XCTAssertEqual(legacy.shown.map(\.label), ["Local network", "Bambu Cloud"], "an MCP from before options keeps the known names")
        let older = try client(FakeTransport { _, _ in json(404, ["error": ["code": "not-found", "message": "Not found"]]) })
        do { _ = try await older.printerConnection("current"); XCTFail() } catch let error as CompanionError { XCTAssertTrue(error.isUnsupported) }
        let busy = try client(FakeTransport { _, _ in json(409, ["error": ["code": "invalid-state", "message": "This printer is printing. Change its connection when the print finishes."]]) })
        do { _ = try await busy.setPrinterConnection("current", route: "cloud"); XCTFail() }
        catch let error as CompanionError { XCTAssertEqual(error.message, "This printer is printing. Change its connection when the print finishes.") }
    }

    func testDownloadsAreCachedPerVersion() async throws {
        let data = try fixture("objects.json")
        struct List: Decodable { var objects: [Project] }
        let p = try JSONDecoder().decode(List.self, from: data).objects[0]
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: Data("png".utf8)) }
        let c = try client(fake)
        let first = try await c.download(p, "renders/1_overview.png")
        let second = try await c.download(p, "renders/1_overview.png")
        XCTAssertEqual(first, second)
        XCTAssertEqual(fake.calls.count, 1)
        do { _ = try await c.download(p, "plate.jpg"); XCTFail("there's no plate photo to fetch") } catch {}
        XCTAssertEqual(fake.calls.count, 1)
        do { _ = try await c.download(p, "../../etc/passwd"); XCTFail() } catch {}
    }

    func testDesignedMultiColour3MFExportDoesNotMasqueradeAsSTL() async throws {
        let p = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11","createdAtMs":1,"updatedAtMs":2,"state":"ready","kind":"fit","photos":[],"passes":[],"current":{"model":"current/model.3mf","renders":[]}}"#.utf8))
        let bytes = Data("designed 3MF bytes".utf8)
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: bytes) }
        let url = try await client(fake).download(p, "model.stl")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()) }
        XCTAssertEqual(url.pathExtension, "3mf")
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testPublishedCurrent3MFExportDoesNotMasqueradeAsSTL() async throws {
        let p = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11","createdAtMs":1,"updatedAtMs":2,"state":"ready","kind":"published","photos":[],"passes":[],"current":{"model":"original/Designer.3MF","renders":["renders/plate.png"]}}"#.utf8))
        let bytes = Data("original 3MF bytes".utf8)
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: bytes) }
        let url = try await client(fake).download(p, "model.stl")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()) }
        XCTAssertEqual(url.pathExtension, "3mf")
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertTrue(p.preservesPublishedFilaments)
        XCTAssertEqual(p.settingsFiles.first?.name, "Current model (3MF)")
    }

    func testChangingPublishedOriginalInvalidatesCurrentDownloadWithoutChangingPassTime() async throws {
        func project(_ file: String) throws -> Project {
            let data: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "kind": "published", "photos": [], "passes": [], "current": ["model": file, "renders": []], "files": ["original": ["original/first.3mf", "original/second.3mf"]]]
            return try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: data))
        }
        let fake = FakeTransport { request, _ in HTTPReply(status: 200, body: Data((request.url!.path.hasSuffix("/original/0") ? "first" : "second").utf8)) }
        let c = try client(fake), firstProject = try project("original/first.3mf"), secondProject = try project("original/second.3mf")
        let first = try await c.download(firstProject, "model.stl")
        let second = try await c.download(secondProject, "model.stl")
        XCTAssertEqual(firstProject.mediaVersion, secondProject.mediaVersion)
        XCTAssertEqual(try Data(contentsOf: first), Data("first".utf8), "The current endpoint may already serve the next selection")
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(try Data(contentsOf: second), Data("second".utf8))
        XCTAssertEqual(fake.calls.count, 2)
        _ = try await c.download(secondProject, "model.stl")
        XCTAssertEqual(fake.calls.count, 2)
    }

    func testMessageUploadIntentSurvivesAnInitialPassFailingBeforeTheUpload() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02"
        var uploads: [URL] = []
        let fake = FakeTransport { request, _ in
            if request.httpMethod != "GET" { uploads.append(request.url!) }
            return json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "failed", "photos": [], "passes": []]])
        }
        let uploader = ProjectUploader(client: try client(fake))
        let photo = UploadFile(kind: .photo, name: "evidence.jpg", source: .bytes(Data("jpeg".utf8)), type: "image/jpeg")
        _ = try await uploader.send([photo], to: id, forMessage: true)
        _ = try await uploader.send([photo], to: id)
        XCTAssertEqual(uploads.map(\.query), ["name=evidence.jpg&forMessage=true", "name=evidence.jpg"],
                       "message intent comes from the action; the same failed state also permits initial retry evidence")
    }

    func testOriginalModelExportsKeepTheirExtensionAndScanUsesReadScope() async throws {
        let p = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[],"scan":"scan.usdz","files":{"original":["original/Designer Part.3mf"]}}"#.utf8))
        let fake = FakeTransport { _, _ in HTTPReply(status: 200, body: Data("original".utf8)) }
        let c = try client(fake)
        let model = try await c.download(p, "original/0")
        XCTAssertEqual(model.pathExtension, "3mf")
        XCTAssertTrue(model.lastPathComponent.contains("Designer Part"))
        let scan = try await c.download(p, "scan/scan.usdz")
        XCTAssertEqual(scan.pathExtension, "usdz")
        XCTAssertEqual(fake.calls.map { $0.request.url!.path.components(separatedBy: "/").suffix(2).joined(separator: "/") }, ["original/0", "scan/scan.usdz"])
    }

    func testUploadsSkipWhatTheMacHas() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02"
        var sent: [String] = []
        let fake = FakeTransport { request, _ in
            if request.httpMethod == "GET" {
                return json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": "new", "photos": ["have.jpg"], "passes": [], "scan": "scan.usdz"]])
            }
            sent.append(request.url!.absoluteString)
            return json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": "new", "photos": [], "passes": []]])
        }
        let uploader = ProjectUploader(client: try client(fake))
        let count = try await uploader.send([
            UploadFile(kind: .scan, name: "scan.usdz", source: .bytes(Data("usdz".utf8)), type: "model/vnd.usdz+zip"),
            UploadFile(kind: .photo, name: "have.jpg", source: .bytes(Data("a".utf8)), type: "image/jpeg"),
            UploadFile(kind: .photo, name: "new one.jpg", source: .bytes(Data("b".utf8)), type: "image/jpeg"),
        ], to: id)
        XCTAssertEqual(count, 1)
        XCTAssertEqual(sent, ["https://192.168.68.123:9077/v1/objects/\(id)/photos?name=new%20one.jpg"])
        XCTAssertEqual(ProjectUploader.spread(Array(0..<10), count: 4), [0, 3, 6, 9])
        XCTAssertEqual(ProjectUploader.spread(Array(0..<3), count: 24), [0, 1, 2])
    }

    /// A walk-around sends every Object Capture image as a capture frame, its own model last, and says how far it got;
    /// a send cut short resumes with only what's missing, and its progress starts from what the Mac already has.
    func testAWalkAroundSendsEveryImageThenThePreviewWithProgress() async throws {
        let id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02"
        let names = (0..<60).map { String(format: "%05d.%09d.HEIC", $0 * 7, $0) }
        final class Log: @unchecked Sendable { var sent: [String] = []; var shares: [Double] = []; var fail: Int? }
        let log = Log()
        let fake = FakeTransport { request, _ in
            if request.httpMethod == "GET" {
                let have = log.sent.filter { $0.contains("/capture?") }.map { String($0.split(separator: "=").last!) }
                return json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": "new", "photos": [], "passes": [], "capture": have]])
            }
            if let fail = log.fail, log.sent.count == fail { log.fail = nil; return HTTPReply(status: 503, body: Data()) }
            log.sent.append(request.url!.path + "?" + (request.url!.query ?? ""))
            return json(200, ["object": ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": "new", "photos": [], "passes": []]])
        }
        let uploader = ProjectUploader(client: try client(fake))
        let files = names.map { UploadFile(kind: .capture, name: $0, source: .bytes(Data($0.utf8)), type: "image/heic") }
            + [UploadFile(kind: .scan, name: "scan.usdz", source: .bytes(Data("preview".utf8)), type: "model/vnd.usdz+zip")]
        log.fail = 25
        do { try await uploader.send(files, to: id) { log.shares.append($0) }; XCTFail("the fake drops the 26th file") } catch {}
        XCTAssertEqual(log.sent.count, 25)
        XCTAssertEqual(log.shares.last ?? -1, 25.0 / 61.0, accuracy: 0.0001)
        log.shares = []
        let count = try await uploader.send(files, to: id) { log.shares.append($0) }
        XCTAssertEqual(count, 35, "only the frames the Mac didn't have")
        XCTAssertEqual(log.sent.count, 61)
        XCTAssertEqual(log.sent.last, "/v1/objects/\(id)/scan?", "the phone's model goes last, after every image")
        XCTAssertTrue(log.sent.dropLast().allSatisfy { $0.contains("/capture?name=") })
        XCTAssertEqual(log.shares.first ?? -1, 25.0 / 61.0, accuracy: 0.0001, "a resumed send starts from what arrived")
        XCTAssertEqual(log.shares.last, 1)
    }
}

final class DecodingTests: XCTestCase {
    func testObjectsFromTheCompanion() throws {
        struct List: Decodable { var objects: [Project] }
        let objects = try JSONDecoder().decode(List.self, from: fixture("objects.json")).objects
        XCTAssertEqual(objects.map(\.state), [.ready, .touchingUp, .needsCloseup, .printing, .printed, .failed, .new, .unknown])
        XCTAssertEqual(objects[0].title, "Mic mount")
        XCTAssertEqual(objects[0].current?.changes?.last?.toleranceMm, 0.5)
        XCTAssertEqual(objects[0].status?.text, "Ready to print · 48 × 50 × 54 mm")
        XCTAssertEqual(objects[1].runningPass?.currentStage?.words, "Matching your photos")
        XCTAssertEqual(objects[2].openAsk?.answers, ["camera", "photos", "best-guess"])
        XCTAssertEqual(objects[2].openAsk?.region?.width, 0.5)
        XCTAssertEqual(objects[3].print?.live?.job?.layer, 84)
        XCTAssertEqual(objects[3].print?.live?.temps?.nozzle?.actual, 220)
        XCTAssertNotNil(objects[3].print?.live?.endsAtDate)
        XCTAssertEqual(objects[4].print?.monitor?.endState, "done")
    }

    /// KAN-214's shared samples (packages/contracts/fixtures/counterpart-v1.json), once that file is on main.
    func testCounterpartContractSamples() throws {
        let url = repoRoot.appending(path: "packages/contracts/fixtures/counterpart-v1.json")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("counterpart-v1.json isn't on this branch yet") }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
            try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(value), options: [.fragmentsAllowed]))
        }
        let events = try decode([CounterpartEvent].self, object["events"])
        XCTAssertEqual(events.count, 20)
        XCTAssertEqual(Set(events.map(\.type)).count, 20)
        // KAN-214 #199: `print.sent` is terminal, so it opens the project, not the Printing screen.
        let sent = try XCTUnwrap(events.first { $0.type == "print.sent" })
        let sentProject = try XCTUnwrap(sent.projectId)
        XCTAssertEqual(AppRoute(notification: ["projectId": sentProject, "type": sent.type]), .project(sentProject))
        for key in ["eventsPage", "eventsPageTruncated", "eventsPageReset"] { _ = try decode(EventsPage.self, object[key]) }
        XCTAssertTrue(try decode(EventsPage.self, object["eventsPageReset"]).needsResync)
        let statuses = try decode([Project.Status].self, object["statuses"])
        for status in statuses { XCTAssertNotNil(ProjectPhase(rawValue: status.phase), status.phase) }
        let sentStatus = try XCTUnwrap(statuses.first { $0.phase == "sent" })
        XCTAssertEqual(sentStatus.symbol, ProjectPhase.sent.symbol)
        XCTAssertEqual(sentStatus.tint, "secondary")
        XCTAssertEqual(ProjectPhase.sent.tone, .secondary)
        _ = try decode(PrintLive.self, object["printLive"])
        _ = try decode(Project.PrintMonitor.self, object["printMonitor"])
        _ = try decode(PrintSettings.self, object["printSettings"])
        _ = try decode(SliceEstimate.self, object["estimate"])
        let destinations = try decode([PrinterDestination].self, object["destinations"])
        XCTAssertFalse(destinations.isEmpty)
        _ = try decode(Project.Ask.self, object["ask"])
        _ = try decode([Project.Change].self, object["changes"])
        _ = try decode([Project.Stage].self, object["stages"])
    }

    /// The Mac's control socket (`objects.list`) adds the project folder; `/v1/objects` doesn't.
    func testDirectoryDecodesWhenTheMacSendsIt() throws {
        let base = #"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[]"#
        let local = try JSONDecoder().decode(Project.self, from: Data((base + #","directory":"/Users/d/Counterpart/p"}"#).utf8))
        XCTAssertEqual(local.directory, "/Users/d/Counterpart/p")
        XCTAssertNil(try JSONDecoder().decode(Project.self, from: Data((base + "}").utf8)).directory)
        XCTAssertEqual(Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready, directory: "/tmp/p").directory, "/tmp/p")
    }

    /// The Mac and the phone build identical `objects.print` params: only what's set, and only these three.
    func testPrintSettingsEncodeOnlyWhatsSet() throws {
        func json(_ settings: PrintSettings) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
        }
        XCTAssertTrue(try json(PrintSettings()).isEmpty, "standard sends nothing")
        let chosen = try json(PrintSettings(quality: "fine", strength: "strong", colour: .object(["amsSlot": .number(2)])))
        XCTAssertEqual(Set(chosen.keys), ["quality", "strength", "colour"])
        XCTAssertEqual(chosen["quality"] as? String, "fine")
        XCTAssertEqual((chosen["colour"] as? [String: Any])?["amsSlot"] as? Int, 2)
        // A server's extra field (an older Mac's plateCheck) decodes and is never sent back.
        let decoded = try JSONDecoder().decode(PrintSettings.self, from: Data(#"{"quality":"draft","plateCheck":true}"#.utf8))
        XCTAssertEqual(decoded, PrintSettings(quality: "draft"))
        XCTAssertEqual(Set(try json(decoded).keys), ["quality"])
        // A print's saved layer pauses are read back (Print Another), never sent as a setting.
        let paused = try JSONDecoder().decode(PrintSettings.self, from: Data(#"{"quality":"fine","pauseBeforeLayers":[3,12]}"#.utf8))
        XCTAssertEqual(paused.pauseBeforeLayers, [3, 12])
        XCTAssertEqual(Set(try json(paused).keys), ["quality"])
    }

    func testConfirmationFieldsCanBeMadeInTests() {
        let field = Project.PrintConfirmation.Field(name: "confirmed", title: "I checked the printer and confirm this operation", required: true)
        let question = Project.PrintConfirmation(id: "q", message: "Start?", expiresAtMs: 2000, fields: [field], supported: true)
        XCTAssertFalse(question.canAccept([:], atMs: 1000))
        XCTAssertTrue(question.canAccept(["confirmed": true], atMs: 1000))
    }

    /// One event this version can't read never costs the page (KAN-214 PR 6's `mcp.update.*` has no project).
    func testAPageKeepsEveryEventItCanRead() throws {
        let page = #"""
        {"events":[
          {"v":1,"seq":7,"id":"e7","at":"2026-11-01T09:00:00Z","type":"pass.ready","projectId":"p","title":"Mic mount is ready","body":"About 1 h 12 m on P1S.","notify":"active"},
          {"v":1,"seq":8,"id":"e8","at":"2026-11-01T09:01:00Z","type":"mcp.update.done","title":"bambu-printer-mcp updated","body":"1.4.2 → 1.5.0","notify":"passive",
           "data":{"mcpId":"m1","fromVersion":"1.4.2","toVersion":"1.5.0","log":"added 1 package","progress":"not a number"}},
          {"garbage":true},
          {"v":1,"seq":10,"id":"e10","at":"2026-11-01T09:03:00Z","type":"print.teleported","projectId":"p","title":"T","body":"B","notify":"loud"}
        ],"next":10,"latest":10}
        """#
        let decoded = try JSONDecoder().decode(EventsPage.self, from: Data(page.utf8))
        XCTAssertEqual(decoded.events.map(\.id), ["e7", "e8", "e10"], "the garbage element is skipped; the rest decode")
        XCTAssertNil(decoded.events[1].projectId)
        XCTAssertEqual(decoded.events[1].data?.toVersion, "1.5.0")
        XCTAssertNil(decoded.events[1].data?.progress, "a malformed fact is left out, not the event")
        XCTAssertEqual(decoded.events[2].type, "print.teleported", "an unknown type is kept as its string")
        XCTAssertEqual(decoded.next, 10)
    }

    func testEventsDecodeUnknownTypesAndLevels() throws {
        let text = #"{"v":1,"seq":3,"id":"a","at":"2026-11-01T09:00:00Z","type":"print.teleported","projectId":"p","title":"T","body":"B","notify":"loud"}"#
        let event = try JSONDecoder().decode(CounterpartEvent.self, from: Data(text.utf8))
        XCTAssertEqual(event.type, "print.teleported")
        XCTAssertEqual(event.notify, .none)
    }
}

final class FormatTests: XCTestCase {
    func testSizesTimesAndGrams() {
        XCTAssertEqual(Format.size([48.2, 50.4, 53.9]), "48.2 × 50.4 × 53.9 mm")
        XCTAssertNil(Format.size([1, 2]))
        XCTAssertEqual(Format.duration(45), "45 s")
        XCTAssertEqual(Format.duration(38 * 60), "38 min")
        XCTAssertEqual(Format.duration(72 * 60), "1 h 12 m")
        XCTAssertEqual(Format.duration(3 * 3600), "3 h")
        XCTAssertNil(Format.duration(-1))
        XCTAssertEqual(Format.about(240), "about 4 min")
        XCTAssertEqual(Format.about(20), "less than a minute")
        XCTAssertEqual(Format.grams(22.4), "22 g")
        XCTAssertEqual(Format.grams(4.25), "4.2 g")
        XCTAssertEqual(Format.percent(42.9), "42%")
        XCTAssertEqual(Format.percent(140), "100%")
        XCTAssertEqual(Format.temperature(219.6), "220 °C")
    }

    func testRelativeTimes() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO.date("2026-11-01T12:00:00Z")!
        XCTAssertEqual(Format.when(now.addingTimeInterval(-30), now: now, calendar: calendar), "Now")
        XCTAssertEqual(Format.when(now.addingTimeInterval(-120), now: now, calendar: calendar), "2 min ago")
        XCTAssertEqual(Format.when(now.addingTimeInterval(-3 * 3600), now: now, calendar: calendar), "3 h ago")
        XCTAssertEqual(Format.when(ISO.date("2026-10-31T09:00:00Z")!, now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(Format.when(ISO.date("2026-10-30T09:00:00Z")!, now: now, calendar: calendar, locale: Locale(identifier: "en_US")), "Oct 30")
        XCTAssertEqual(Format.updated(now.addingTimeInterval(-3), now: now), "Updated 3 s ago")
        XCTAssertEqual(Format.ago(now.addingTimeInterval(-3), now: now), "3 s ago")
    }

    func testRoutes() {
        XCTAssertEqual(AppRoute(url: URL(string: "counterpart://project/abc")!), .project("abc"))
        XCTAssertEqual(AppRoute(url: URL(string: "counterpart://new")!), .newProject)
        if case .pair? = AppRoute(url: URL(string: "scantomake://pair?v=2&c=x")!) {} else { XCTFail() }
        XCTAssertEqual(AppRoute(notification: ["projectId": "p", "type": "pass.ready"], action: "PRINT"), .print("p"))
        XCTAssertEqual(AppRoute(notification: ["projectId": "p", "type": "print.milestone"]), .printing("p"))
        XCTAssertEqual(AppRoute(notification: ["projectId": "p", "type": "print.done"]), .project("p"))
        XCTAssertEqual(AppRoute(notification: ["ck": ["qry": ["af": ["projectId": "q", "type": "pass.ask"]]]], action: "CAMERA"), .camera("q"))
        XCTAssertNil(AppRoute(notification: [:]))
    }
}
