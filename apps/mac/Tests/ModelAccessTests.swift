import XCTest
@testable import AgentKit

private final class Credentials: ModelCredentialStore {
    var saved: ModelAccessChoice = .api(provider: .openai, model: "gpt-6-astra", keychainRef: UUID())
    var reads = 0
    var error: ModelAccessError?
    func read(_ reference: UUID) throws -> ModelCredential { reads += 1; if let error { throw error }; return ModelCredential(choice: saved, secret: "fixture-secret") }
    func save(_ secret: String, for choice: ModelAccessChoice) throws { saved = choice }
    func remove(_ reference: UUID) throws {}
}
final class ModelAccessTests: XCTestCase {
    func testSharedEnvironmentContract() throws {
        struct Fixture: Decodable { let choice: ModelAccessChoice; let environment: [String: String] }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/model-access.json")))
        for fixture in fixtures {
            let store = Credentials(); store.saved = fixture.choice
            let env = try ModelWorkerEnvironment.make(choice: fixture.choice, base: [:], credentials: store)
            XCTAssertEqual(env.filter { $0.key.hasPrefix("SCAN_TO_MAKE_AI_") || $0.key == "SCAN_TO_MAKE_MODEL_KEY" }, fixture.environment)
        }
    }
    func testRejectsCallerEnvironmentForKeyedWorker() throws {
        let store = Credentials()
        for name in ["PATH", "HOME", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SCAN_TO_MAKE_CODEX_PATH", "SCAN_TO_MAKE_CLAUDE_PATH", "SCAN_TO_MAKE_AI_ENDPOINT", "SCAN_TO_MAKE_AI_JUDGE_TOOL", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"] {
            XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: store.saved, base: [name: "/tmp/attacker"], credentials: store), name)
        }
        XCTAssertEqual(store.reads, 0)
    }
    func testRejectsProviderKindModelAndEndpointOverrides() throws {
        let store = Credentials(), ref = UUID()
        store.saved = .api(provider: .openai, model: "gpt-6-astra", keychainRef: ref)
        let attacks: [ModelAccessChoice] = [
            .api(provider: .anthropic, model: "gpt-6-astra", keychainRef: ref),
            .api(provider: .openai, model: "other-model", keychainRef: ref),
            .endpoint(url: URL(string: "https://attacker.test/v1")!, model: "gpt-6-astra", keychainRef: ref)
        ]
        for choice in attacks { XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: choice, base: [:], credentials: store)) }
        store.saved = .endpoint(url: URL(string: "https://saved.test/v1")!, model: "local", keychainRef: ref)
        XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: .endpoint(url: URL(string: "https://attacker.test/v1")!, model: "local", keychainRef: ref), base: [:], credentials: store))
    }
    func testSharedURLValidation() throws {
        struct Fixture: Decodable { let url: String; let valid: Bool }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let rows = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/model-access-urls.json")))
        for row in rows {
            let data = try JSONSerialization.data(withJSONObject: ["kind": "endpoint", "url": row.url, "model": "local"])
            let choice = try? JSONDecoder().decode(ModelAccessChoice.self, from: data)
            XCTAssertEqual(choice != nil, row.valid, row.url)
        }
    }
    func testChoiceWireRoundTrips() throws {
        let choices: [ModelAccessChoice] = [.none, .claudeCode, .codexCLI, .api(provider: .anthropic, model: "claude-opus-5-5", keychainRef: UUID()), .endpoint(url: URL(string: "http://127.0.0.1:1234/v1")!, model: "local", keychainRef: nil)]
        for choice in choices { XCTAssertEqual(try JSONDecoder().decode(ModelAccessChoice.self, from: JSONEncoder().encode(choice)), choice) }
    }
    func testSubscriptionModesNeverReadKeychainOrInheritSecrets() throws {
        let store = Credentials()
        for choice in [ModelAccessChoice.none, .claudeCode, .codexCLI] {
            let env = try ModelWorkerEnvironment.make(choice: choice, base: ["HOME": "/home/test", "ANTHROPIC_API_KEY": "old-key", "BAMBU_TOKEN": "printer-key", "SCAN_TO_MAKE_MODEL_KEY": "stale", "SCAN_TO_MAKE_AI_ACCESS": "api"], credentials: store)
            XCTAssertEqual(Set(env.keys), ["HOME", "SCAN_TO_MAKE_AI_ACCESS"])
            XCTAssertFalse(env.values.contains("old-key")); XCTAssertFalse(env.values.contains("stale"))
        }
        XCTAssertEqual(store.reads, 0)
    }
    func testKeylessWorkersReceiveTheCompanionsJudgeTool() throws {
        let store = Credentials()
        for choice in [ModelAccessChoice.claudeCode, .codexCLI, .endpoint(url: URL(string: "http://localhost:1234")!, model: "local", keychainRef: nil)] {
            let env = try ModelWorkerEnvironment.make(choice: choice, base: ["SCAN_TO_MAKE_AI_JUDGE_TOOL": "/release/installed/ai-tweak-judge", "MY_KEY": "x"], credentials: store)
            XCTAssertEqual(env["SCAN_TO_MAKE_AI_JUDGE_TOOL"], "/release/installed/ai-tweak-judge"); XCTAssertNil(env["MY_KEY"])
        }
        XCTAssertEqual(store.reads, 0)
    }
    func testKeyedWorkersFindTheJudgeToolInAppState() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("stm-judge-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = root.appendingPathComponent("state"), release = root.appendingPathComponent("releases/install-x")
        let judge = release.appendingPathComponent("installed/ai-tweak-judge")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        XCTAssertNil(ModelWorkerEnvironment.judgeTool(state: state))
        // The migrated launcher's repair tool locates the release.
        let migration = ["workerEnvironment": ["SCAN_TO_MAKE_SCAN_REPAIR_TOOL": release.appendingPathComponent("installed/repair-tool/repair.py").path]]
        try JSONSerialization.data(withJSONObject: migration).write(to: state.appendingPathComponent("app-migration.json"))
        XCTAssertNil(ModelWorkerEnvironment.judgeTool(state: state), "an older release without the judge folder")
        try FileManager.default.createDirectory(at: judge, withIntermediateDirectories: true)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        // companion.env wins, as it does for agent.mjs and the companion.
        let other = root.appendingPathComponent("other/installed/repair-tool/repair.py"), otherJudge = root.appendingPathComponent("other/installed/ai-tweak-judge")
        try FileManager.default.createDirectory(at: otherJudge, withIntermediateDirectories: true)
        try "# operator\nexport SCAN_TO_MAKE_SCAN_REPAIR_TOOL=\"\(other.path)\"\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), otherJudge.path)
        try "SCAN_TO_MAKE_AI_JUDGE_TOOL='\(judge.path)'\nSCAN_TO_MAKE_SCAN_REPAIR_TOOL=\(other.path)\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        // Inline comments and quotes read the way Node's loadEnvFile reads them for the companion.
        try "SCAN_TO_MAKE_AI_JUDGE_TOOL=\(judge.path) # installed\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        try "SCAN_TO_MAKE_AI_JUDGE_TOOL=\"\(judge.path)\" # installed\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        XCTAssertEqual(ModelWorkerEnvironment.envFile(state.appendingPathComponent("companion.env")), ["SCAN_TO_MAKE_AI_JUDGE_TOOL": judge.path])
        try "A=/x/y # c\nB=/x#y\nC=\"/q r\" # c\nD='/s'\nexport E=/e\n  F = /f  \nG=\"/unterminated\n# H=/h\n".write(to: root.appendingPathComponent("parse.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.envFile(root.appendingPathComponent("parse.env")), ["A": "/x/y", "B": "/x", "C": "/q r", "D": "/s", "E": "/e", "F": "/f", "G": "\"/unterminated"])
        // A blank value falls back to the migrated launcher's tool, as agent.mjs does.
        try "SCAN_TO_MAKE_AI_JUDGE_TOOL=\nSCAN_TO_MAKE_SCAN_REPAIR_TOOL=  \n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        // A double-quoted value spanning lines swallows them, as Node's loadEnvFile does.
        try "NOTE=\"first\nSCAN_TO_MAKE_SCAN_REPAIR_TOOL=\(other.path)\nend\" # c\nAFTER=/a\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ModelWorkerEnvironment.envFile(state.appendingPathComponent("companion.env")), ["NOTE": "first\nSCAN_TO_MAKE_SCAN_REPAIR_TOOL=\(other.path)\nend", "AFTER": "/a"])
        XCTAssertEqual(ModelWorkerEnvironment.judgeTool(state: state), judge.path)
        try "SCAN_TO_MAKE_SCAN_REPAIR_TOOL=relative/repair.py\n".write(to: state.appendingPathComponent("companion.env"), atomically: true, encoding: .utf8)
        XCTAssertNil(ModelWorkerEnvironment.judgeTool(state: state))
    }
    func testCustomLoginDirectoriesBelongOnlyToSubscriptionWorkers() throws {
        let store = Credentials(), login = ["CODEX_HOME": "/custom/codex", "CLAUDE_CONFIG_DIR": "/custom/claude"]
        for choice in [ModelAccessChoice.claudeCode, .codexCLI] {
            let env = try ModelWorkerEnvironment.make(choice: choice, base: login, credentials: store)
            for (key, value) in login { XCTAssertEqual(env[key], value) }
        }
        for choice in [ModelAccessChoice.none, .endpoint(url: URL(string: "http://localhost:1234")!, model: "local", keychainRef: nil)] {
            let env = try ModelWorkerEnvironment.make(choice: choice, base: login, credentials: store)
            for key in login.keys { XCTAssertNil(env[key]) }
        }
        for choice in [store.saved, .endpoint(url: URL(string: "https://example.test")!, model: "local", keychainRef: UUID())] {
            XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: choice, base: login, credentials: store))
        }
        XCTAssertEqual(store.reads, 0)
    }
    func testAPIAndEndpointReadOnlySelectedReferenceAtSpawn() throws {
        let store = Credentials()
        let env = try ModelWorkerEnvironment.make(choice: store.saved, base: [:], credentials: store)
        XCTAssertEqual(store.reads, 1); XCTAssertEqual(env["SCAN_TO_MAKE_MODEL_KEY"], "fixture-secret")
        XCTAssertEqual(env["SCAN_TO_MAKE_AI_KEY_ENV"], "SCAN_TO_MAKE_MODEL_KEY")
        XCTAssertEqual(env["SCAN_TO_MAKE_AI_PROVIDER"], "openai")
        let endpoint = try ModelWorkerEnvironment.make(choice: .endpoint(url: URL(string: "http://localhost:1234/v1")!, model: "local", keychainRef: nil), base: [:], credentials: store)
        XCTAssertEqual(store.reads, 1); XCTAssertNil(endpoint["SCAN_TO_MAKE_MODEL_KEY"])
        store.error = .credentialLocked
        XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: .api(provider: .anthropic, model: "claude", keychainRef: UUID()), base: [:], credentials: store)) { XCTAssertEqual($0 as? ModelAccessError, .credentialLocked) }
    }
    func testRejectsCredentialsInURLsAndMalformedModels() throws {
        for url in ["https://user:secret@example.test", "https://example.test?key=secret", "https://example.test/#secret", "file:///tmp/model"] {
            XCTAssertThrowsError(try ModelAccessChoice.endpoint(url: URL(string: url)!, model: "local", keychainRef: nil).validate())
        }
        XCTAssertThrowsError(try ModelAccessChoice.api(provider: .openai, model: "--override", keychainRef: UUID()).validate())
    }
    func testKeychainRoundTripInLoginSession() throws {
        guard ProcessInfo.processInfo.environment["STM_TEST_KEYCHAIN"] == "1" else { throw XCTSkip("Run explicitly in a GUI login session") }
        let keychain = ModelKeychain(), secret = "fixture-" + UUID().uuidString
        let reference = UUID()
        let choice = ModelAccessChoice.api(provider: .openai, model: "gpt-6-astra", keychainRef: reference)
        try keychain.save(secret, for: choice)
        defer { try? keychain.remove(reference) }
        XCTAssertThrowsError(try keychain.save("replacement-key", for: .endpoint(url: URL(string: "https://attacker.test")!, model: "gpt-6-astra", keychainRef: reference)))
        let saved = try keychain.read(reference)
        XCTAssertEqual(saved.secret, secret); XCTAssertEqual(saved.choice, choice)
        XCTAssertFalse(String(describing: saved).contains(secret))
        XCTAssertEqual(try ModelWorkerEnvironment.make(choice: choice, base: [:], credentials: keychain)["SCAN_TO_MAKE_MODEL_KEY"], secret)
        XCTAssertThrowsError(try ModelWorkerEnvironment.make(choice: .endpoint(url: URL(string: "https://attacker.test/v1")!, model: "gpt-6-astra", keychainRef: reference), base: [:], credentials: keychain))
        try keychain.remove(reference)
        XCTAssertThrowsError(try keychain.read(reference)) { XCTAssertEqual($0 as? ModelAccessError, .credentialMissing) }
    }
}
