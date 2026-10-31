import XCTest
@testable import AgentKit

final class AgentManagerTests: XCTestCase {
    final class Service: AgentService {
        var enabled = true
        var fail = false
        var registered = false
        func register() throws { if fail { throw CocoaError(.fileWriteUnknown) }; registered = true }
        func unregister() throws { registered = false }
    }
    func testMigrationRestoresLegacyOnActivationFailureAndPreservesFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let plist = root.appendingPathComponent("legacy.plist")
        let bytes = Data("existing agent".utf8)
        try bytes.write(to: plist)
        let service = Service()
        var stopped = false; var restored = false
        XCTAssertThrowsError(try AgentManager(service: service).migrate(legacy: plist, stop: { stopped = true }, restore: { restored = true }, activate: { throw CocoaError(.fileWriteUnknown) }))
        XCTAssertTrue(stopped)
        XCTAssertTrue(restored)
        XCTAssertEqual(try Data(contentsOf: plist), bytes)
    }
    func testSuccessfulMigrationRetiresOnlyThePlist() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let plist = root.appendingPathComponent("legacy.plist")
        try Data("launch".utf8).write(to: plist)
        for name in ["auth", "tls", "capture"] { try Data(name.utf8).write(to: root.appendingPathComponent(name)) }
        try AgentManager(service: Service()).migrate(legacy: plist, stop: {}, restore: { XCTFail("rollback") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: plist.path))
        XCTAssertEqual(try Data(contentsOf: plist.appendingPathExtension("pre-app")), Data("launch".utf8))
        for name in ["auth", "tls", "capture"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), Data(name.utf8)) }
    }
    func testExpiredOrNonPairingPayloadIsRejected() throws {
        XCTAssertThrowsError(try PairingInvitation.decode(Data(#"{"qrPayload":"https://example.com","expiresAt":9999999999999}"#.utf8)))
        XCTAssertThrowsError(try PairingInvitation.decode(Data(#"{"qrPayload":"scantomake://pair?v=1","expiresAt":1}"#.utf8)))
        let data = Data(#"{"qrPayload":"scantomake://pair?v=1&c=fixture","expiresAt":9999999999999}"#.utf8)
        XCTAssertEqual(try PairingInvitation.decode(data).qrPayload, "scantomake://pair?v=1&c=fixture")
    }
    func testProbeFailureDoesNotUnregisterAnExistingActiveAgent() {
        let service = Service(); service.registered = true
        var deactivated = false
        XCTAssertThrowsError(try AgentManager(service:service).migrate(legacy:URL(fileURLWithPath:"/unused"),stop:{},restore:{},preserveExistingAgent:true,activate:{throw AgentError.commandFailed},deactivate:{deactivated = true}))
        XCTAssertTrue(service.registered)
        XCTAssertFalse(deactivated)
    }
    func testRollbackAttemptsRestoreEvenWhenDeactivationFails() {
        let service = Service()
        var restored = false
        XCTAssertThrowsError(try AgentManager(service:service).migrate(legacy:URL(fileURLWithPath:"/unused"),stop:{},restore:{restored = true},activate:{throw AgentError.commandFailed},deactivate:{throw AgentError.commandFailed})) { error in
            XCTAssertEqual(error as? AgentError, .rollbackFailed)
        }
        XCTAssertTrue(restored)
        XCTAssertFalse(service.registered)
    }
    func testApprovalRequiredKeepsLegacyRunning() throws {
        let service = Service(); service.enabled = false
        var stopped = false; var preflight = false
        XCTAssertThrowsError(try AgentManager(service: service).migrate(legacy: URL(fileURLWithPath: "/unused"), preflight:{ preflight = true }, stop: { stopped = true }, restore: {}))
        XCTAssertFalse(preflight)
        XCTAssertFalse(stopped)
    }

    func testFailedActivationRestoresV1BytesBeforeLegacyRestart() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let auth = root.appendingPathComponent("auth.json")
        let backup = root.appendingPathComponent("auth.v1.json")
        let original = Data(#"{"version":1,"devices":[{"tokenHash":"fixture-hash"}]}"#.utf8)
        try original.write(to:auth)
        let service = Service()
        var snapshot: AuthStoreSnapshot?
        var stopped = false; var restored = false
        XCTAssertThrowsError(try AgentManager(service:service).migrate(legacy:root.appendingPathComponent("legacy.plist"), preflight:{
            XCTAssertEqual(try Data(contentsOf:auth),original)
        }, stop:{ stopped = true }, restore:{
            XCTAssertFalse(service.registered)
            try snapshot?.restoreIfUpgraded()
            XCTAssertEqual(try Data(contentsOf:auth),original)
            restored = true
        }, activate:{
            XCTAssertTrue(stopped)
            snapshot = try AuthStoreSnapshot(file:auth)
            try original.write(to:backup)
            try Data(#"{"version":2,"devices":[]}"#.utf8).write(to:auth)
            throw AgentError.companionUnavailable
        }))
        XCTAssertTrue(restored)
        XCTAssertFalse(FileManager.default.fileExists(atPath:backup.path))
        let attributes = try FileManager.default.attributesOfItem(atPath:auth.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue,0o600)
    }

    func testRollbackKeepsPreexistingBackupAndCompatibleStoreChanges() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let auth = root.appendingPathComponent("auth.json")
        let backup = root.appendingPathComponent("auth.v1.json")
        try Data("existing backup".utf8).write(to:backup)
        let original = Data(#"{"version":1}"#.utf8)
        try original.write(to:auth)
        let first = try AuthStoreSnapshot(file:auth)
        try Data(#"{"version":2}"#.utf8).write(to:auth)
        try first.restoreIfUpgraded()
        XCTAssertEqual(try Data(contentsOf:auth),original)
        XCTAssertEqual(try Data(contentsOf:backup),Data("existing backup".utf8))

        try Data(#"{"version":2}"#.utf8).write(to:auth)
        let second = try AuthStoreSnapshot(file:auth)
        let changed = Data(#"{"version":2,"devices":["new fixture"]}"#.utf8)
        try changed.write(to:auth)
        try second.restoreIfUpgraded()
        XCTAssertEqual(try Data(contentsOf:auth),changed)
    }

    func testLegacyCustomRootResolvesPairingAndHealthWithoutOpeningAuthStore() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let state = root.appendingPathComponent("custom state")
        let source = state.appendingPathComponent("releases/old release")
        try FileManager.default.createDirectory(at:state.appendingPathComponent("auth"),withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let bytes = Data(#"{"version":1,"configuration":{"transport":"lan","allowedLogins":["lan"]}}"#.utf8)
        let auth = state.appendingPathComponent("auth/auth.json")
        try bytes.write(to:auth)
        let plist = root.appendingPathComponent("legacy.plist")
        let arguments = [state.appendingPathComponent("companion").path,source.appendingPathComponent("services/companion/dist/server-cli.js").path]
        try PropertyListSerialization.data(fromPropertyList:["ProgramArguments":arguments],format:.xml,options:0).write(to:plist)
        let legacy = try LegacyInstallation(plist:plist)
        XCTAssertEqual(legacy.state.path,state.path)
        XCTAssertEqual(legacy.healthcheck,source.appendingPathComponent("deploy/companion/healthcheck.mjs"))
        XCTAssertEqual(try legacy.pairingArguments(),[source.appendingPathComponent("services/companion/dist/remote-auth-cli.js").path,"pair-capture-and-printer-handoff",state.appendingPathComponent("auth").path])
        XCTAssertEqual(try Data(contentsOf:auth),bytes)
        let retired = plist.appendingPathExtension("pre-app")
        try FileManager.default.moveItem(at:plist,to:retired)
        XCTAssertEqual(try LegacyInstallation(plist:retired).state.path,state.path)
    }
}

final class NetworkAddressTests: XCTestCase {
    func testSetupSkipsUnsupportedPublicAddressesWithoutDroppingDiscovery() {
        let values = ["203.0.113.5","192.168.1.50"]
        let addresses = NetworkAddresses(lan:values,tailscale:["100.64.1.2"],localHostname:"fixture.local")
        XCTAssertEqual(addresses.setupAddress,"192.168.1.50")
        XCTAssertEqual(addresses.all,values + ["fixture.local","100.64.1.2"])
        for ip in ["203.0.113.5","100.64.1.2","127.0.0.1","169.254.1.2","172.15.0.1","172.32.0.1"] {
            XCTAssertNil(NetworkAddresses(lan:[ip],tailscale:[],localHostname:nil).setupAddress)
        }
        for ip in ["10.1.2.3","172.16.0.1","172.31.255.254","192.168.1.1"] {
            XCTAssertEqual(NetworkAddresses(lan:[ip],tailscale:[],localHostname:nil).setupAddress,ip)
        }
    }
    func testPrimaryPhysicalInterfaceWinsOverVirtualBridgeAddressOrder() {
        let values = [(interface:"bridge100",address:"10.0.0.1"),(interface:"en0",address:"192.168.1.50"),(interface:"en1",address:"172.16.1.10")]
        XCTAssertEqual(NetworkAddresses.orderedLAN(values,primaryInterface:"en0").first,"192.168.1.50")
        XCTAssertEqual(NetworkAddresses.orderedLAN(values,primaryInterface:"en1").first,"172.16.1.10")
    }
    func testVPNDefaultRouteStillPrefersPhysicalLANAndRetainsBridgeCandidates() {
        let values = [(interface:"bridge100",address:"10.0.0.1"),(interface:"en0",address:"192.168.1.50"),(interface:"en0",address:"192.168.1.50")]
        XCTAssertEqual(NetworkAddresses.orderedLAN(values,primaryInterface:"utun4"),["192.168.1.50","10.0.0.1"])
    }
    func testRejectsLoopbackLinkLocalAndMalformedAddresses() {
        for ip in ["127.0.0.1","169.254.1.2","0.0.0.0","999.1.1.1","192.168.1","1..2.3.4","::1","224.1.2.3"] {
            XCTAssertFalse(NetworkAddresses.isUsableIPv4(ip), ip)
        }
        for ip in ["192.168.1.10","10.0.0.2","172.16.1.20","100.64.1.2"] {
            XCTAssertTrue(NetworkAddresses.isUsableIPv4(ip), ip)
        }
    }
}
