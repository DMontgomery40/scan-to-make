import Foundation

struct MacError: Error { let code: String; let message: String }
struct NativeCaptureDestination {
    let projectId: String; let revision: Int; let snapshot: String; let context: String?
}
@MainActor final class NativeCaptureCoordinator {
    static let stitchingWarning = "stitching warning"
    static let shared = NativeCaptureCoordinator()
    var retained: [[String: Any]] = []
    var result: [String: Any] = [:]
    func drafts() throws -> [[String: Any]] { retained }
    func start(_ origin: NativeCaptureDestination) async throws -> [String: Any] { result }
}
enum CaptureFixture {
    static let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
}
@MainActor final class MacConnection {
    static func requestedFile(_ id: String) -> URL { CaptureFixture.root.appendingPathComponent("sending-\(id)") }
    // CAPTURE_METHODS
}

@main struct CaptureSelectionTests {
    @MainActor static func main() async throws {
        var failures: [String] = []
        func check(_ condition: Bool, _ message: String) {
            if condition { print("PASS " + message) } else { failures.append(message); print("FAIL " + message) }
        }
        defer { try? FileManager.default.removeItem(at: CaptureFixture.root) }
        let coordinator = NativeCaptureCoordinator.shared
        let mac = MacConnection()
        let readyRun = "11111111-1111-4111-8111-111111111111"
        let stoppedRun = "22222222-2222-4222-8222-222222222222"
        let otherRun = "33333333-3333-4333-8333-333333333333"
        func draft(_ run: String, _ status: String, project: String = "project-one") -> [String: Any] {
            ["formatVersion": 1, "runID": run, "status": status, "createdAt": "2026-11-02T10:00:00Z",
             "origin": ["projectId": project, "revision": 0, "snapshot": "{}", "context": NSNull()]]
        }
        coordinator.retained = [draft(stoppedRun, "stopped"), draft(otherRun, "ready", project: "project-other"), draft(readyRun, "ready")]
        check(await mac.finishedScan("project-one") == readyRun, "a later stopped attempt cannot hide a ready scan")
        check(mac.localScanWarning("project-one") == nil, "legacy ready capture has no invented warning")
        coordinator.retained[0]["stitchingIncomplete"] = true
        coordinator.retained[1]["stitchingIncomplete"] = true
        check(mac.localScanWarning("project-one") == nil, "a stopped or different project's warning cannot attach to Send")
        coordinator.retained[2]["stitchingIncomplete"] = true
        check(mac.localScanWarning("project-one") == NativeCaptureCoordinator.stitchingWarning, "Send uses the warning from the same ready capture")
        check(await mac.finishedScan("missing-project") == nil, "another project's scan cannot be adopted")
        let output = CaptureFixture.root.appendingPathComponent("NativeCaptures/\(readyRun)/Models/model-mobile.usdz")
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("retained model".utf8).write(to: output)
        check(mac.localScan("project-one") == output, "preview uses the same ready scan as resumed sending")
        coordinator.result = draft(readyRun, "ready").merging(["addRequested": false]) { _, new in new }
        let oldRequest = MacConnection.requestedFile("project-one")
        try Data().write(to: oldRequest)
        check(try await mac.scan("project-one") == nil, "Keep for later does not request an immediate send")
        check(!FileManager.default.fileExists(atPath: oldRequest.path), "a new scan clears old failed-send intent so Keep for later cannot auto-resume")
        check(await mac.finishedScan("project-one") == readyRun, "a kept scan remains available for an explicit later Send")
        coordinator.result["addRequested"] = true
        check(try await mac.scan("project-one") == readyRun, "Add to this project returns its ready scan")
        coordinator.result["status"] = "failed"
        check(try await mac.scan("project-one") == nil, "failed capture cannot be sent")
        coordinator.retained = [draft(stoppedRun, "stopped")]
        check(await mac.finishedScan("project-one") == nil, "an unfinished capture cannot be resumed as a model")
        guard failures.isEmpty else { fatalError(failures.joined(separator: "; ")) }
    }
}
