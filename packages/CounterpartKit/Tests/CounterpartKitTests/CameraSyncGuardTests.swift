import XCTest

/// KAN-217 P0 (Davica3 syslog, 2026-11-01): setting a frame duration on the LiDAR depth camera reprograms its
/// sync generator ("SetExternalSyncFrameRateRational … 0/1") and leaves every app's camera black until a reboot.
/// The app sets formats only, as Apple's LiDAR depth sample does. This fails if a frame-duration write comes back.
final class CameraSyncGuardTests: XCTestCase {
    func testNoFrameDurationIsEverSetOnACamera() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let roots = ["apps/mobile/ios/ScanToMake", "apps/mobile/modules/object-capture"].map { repo.appending(path: $0) }
        // An assignment (not a read, not ==) to any frame-duration property, spelled so this file never matches itself.
        let names = ["activeVideo" + "MinFrameDuration", "activeVideo" + "MaxFrameDuration", "activeDepthData" + "MinFrameDuration"]
        let write = try NSRegularExpression(pattern: "\\.(" + names.joined(separator: "|") + ")\\s*=(?!=)")
        var checked = 0, found: [String] = []
        for root in roots where FileManager.default.fileExists(atPath: root.path) {
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
            for file in files where ["swift", "m", "mm"].contains(file.pathExtension) {
                guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
                checked += 1
                for match in write.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    let line = text[..<Range(match.range, in: text)!.lowerBound].filter { $0 == "\n" }.count + 1
                    found.append("\(file.path.replacingOccurrences(of: repo.path + "/", with: "")):\(line)")
                }
            }
        }
        XCTAssertGreaterThan(checked, 20, "the capture sources were read")
        XCTAssertEqual(found, [], "set formats only; never a frame duration on a camera")
    }
}
