import XCTest
@testable import CounterpartKit

/// First look U15 (Nov 10): the first pairing screen led with "This build isn't signed for iCloud." That line shows only
/// when `CloudBuild.configured` is false. A device build (TestFlight and the App Store are device-only) with the shipped
/// Info.plist and entitlements is always configured, so a person never sees it; the Simulator and fixtures keep it.
final class CloudBuildTests: XCTestCase {
    private var ios: URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return root.appendingPathComponent("apps/mobile/ios")
    }

    private func plist(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: ios.appendingPathComponent(path))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testAReleaseBuildOnADeviceNeverSaysItIsntSignedForICloud() throws {
        let info = try plist("ScanToMake/Info.plist")
        XCTAssertTrue(CloudBuild.configured(simulator: false, fixtures: false, infoValue: info[CloudBuild.infoKey]),
                      "the shipped Info.plist turns iCloud on for every device build")
        let entitlements = try plist("ScanToMake/ScanToMake.entitlements")
        XCTAssertEqual(entitlements["com.apple.developer.icloud-services"] as? [String], ["CloudKit"])
        XCTAssertEqual(entitlements["com.apple.developer.icloud-container-identifiers"] as? [String], [CounterpartIdentifiers.cloudKitContainer])
        // Release builds use the same Info.plist and entitlements: one setting in the target's base, none per configuration.
        let project = try String(contentsOf: ios.appendingPathComponent("project.yml"), encoding: .utf8)
        XCTAssertTrue(project.contains("INFOPLIST_FILE: ScanToMake/Info.plist"))
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS: ScanToMake/ScanToMake.entitlements"))
        let pbx = try String(contentsOf: ios.appendingPathComponent("ScanToMake.xcodeproj/project.pbxproj"), encoding: .utf8)
        let appPlists = Set(pbx.components(separatedBy: "\n").filter { $0.contains("INFOPLIST_FILE = ScanToMake/") }.map { $0.trimmingCharacters(in: .whitespaces) })
        XCTAssertEqual(appPlists, ["INFOPLIST_FILE = ScanToMake/Info.plist;"], "no configuration swaps in another Info.plist")
    }

    func testOnlyTheSimulatorAndFixturesAreUnconfigured() {
        XCTAssertFalse(CloudBuild.configured(simulator: true, fixtures: false, infoValue: true))
        XCTAssertFalse(CloudBuild.configured(simulator: false, fixtures: true, infoValue: true))
        XCTAssertFalse(CloudBuild.configured(simulator: false, fixtures: false, infoValue: nil))
        XCTAssertTrue(CloudBuild.configured(simulator: false, fixtures: false, infoValue: true))
    }
}
