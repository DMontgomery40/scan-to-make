import XCTest

/// David, 2026-11-01: bed checks are removed as a thing from this app and both MCPs. Nothing in apps/mac may bring
/// one back: no plate or bed check, no "plate is clear" answer, no plate prompt, event, switch or command.
final class NoBedCheckTests: XCTestCase {
    func testNoBedCheckAnywhereInTheMacApp() throws {
        let mac = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let banned = ["plate is clear", "answerPlate", "plateClear", "plate check", "bed check", "plate.blocked", "plateCheck",
                      "plate-clearance", "It's Clear"]
        let kinds: Set<String> = ["swift", "md", "strings", "mjs", "yml", "json", "plist"]
        var found: [String] = []
        let files = FileManager.default.enumerator(at: mac, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        while let file = files?.nextObject() as? URL {
            let path = file.path
            if path.contains("/Payload/") || path.contains("/Licenses/") || path.contains(".xcodeproj/") || path.contains("/build/")
                || file.lastPathComponent == "NoBedCheckTests.swift" || file.lastPathComponent == "THIRD_PARTY_NOTICES.md" { continue }
            guard kinds.contains(file.pathExtension.lowercased()), let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
            for word in banned where text.range(of: word, options: .caseInsensitive) != nil {
                found.append("\(path.replacingOccurrences(of: mac.path + "/", with: "")): \(word)")
            }
        }
        XCTAssertEqual(found, [], "a bed or plate check came back")
    }
}
