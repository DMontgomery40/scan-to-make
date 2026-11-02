import XCTest

/// David, 2026-11-01: plate and bed checks are not a thing in this app or either MCP. Nothing in the app or in
/// CounterpartKit asks about, rewords into, photographs or notifies about the build plate.
final class NoPlateCheckTests: XCTestCase {
    /// Each spelling is split so this file never matches itself.
    private let forbidden: [(text: String, ignoreCase: Bool)] = [
        ("plate" + " is clear", true), ("bed" + " check", true), ("bed" + "-check", true), ("PLA" + "TE", false),
        ("plate" + ".blocked", true), ("plate" + "Check", true), ("plate" + ".jpg", true), ("phone-" + "plate", true),
        ("Project." + "Plate", false),
        // A printer camera's picture inside the printer's question (KAN-214 875422c drops it).
        ("camera" + "Snapshot", true),
    ]

    func testNoPlateOrBedCheckInTheAppOrCounterpartKit() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()  // CounterpartKitTests
            .deletingLastPathComponent().deletingLastPathComponent()  // CounterpartKit
            .deletingLastPathComponent().deletingLastPathComponent()  // the repo
        let roots = ["packages/CounterpartKit/Sources", "apps/mobile/ios/ScanToMake"].map { repo.appending(path: $0) }
        var checked = 0
        var found: [String] = []
        for root in roots {
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.path), "\(root.path) is where the sources are")
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
            for file in files where ["swift", "plist", "strings", "xcstrings", "json", "entitlements"].contains(file.pathExtension) {
                guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
                checked += 1
                for word in forbidden where text.range(of: word.text, options: word.ignoreCase ? [.caseInsensitive] : []) != nil {
                    found.append("\(file.path.replacingOccurrences(of: repo.path + "/", with: "")): \(word.text)")
                }
            }
        }
        XCTAssertGreaterThan(checked, 40, "the sources were read")
        XCTAssertEqual(found, [], "plate and bed checks are gone from the app and CounterpartKit")
    }
}
