import Foundation

/// Whether this iPhone build reads iCloud to find the Mac. Only a Simulator run or the canned-Mac fixtures say
/// "This build isn't signed for iCloud"; every build on a device carries `CounterpartCloudEnabled` in the app's own
/// Info.plist (Debug and Release alike), so a TestFlight or App Store build never shows that line (first look U15,
/// `CloudBuildTests`).
public enum CloudBuild {
    public static let infoKey = "CounterpartCloudEnabled"

    public static func configured(simulator: Bool, fixtures: Bool, infoValue: Any?) -> Bool {
        if simulator || fixtures { return false }
        return infoValue as? Bool == true
    }
}
