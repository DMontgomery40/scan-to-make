/* See LICENSE.txt for the Apple sample license. */
import Foundation

/// The scan's steps: Apple's freeform Object Capture with no box and no mode, the only capture
/// (docs/design/overhaul/research/quick-sweep-capture.md §3.1).
///
/// Record calls `startCapturing()` straight from `.ready`: "In freeform scanning where the user skips the bounding
/// box selection, this call moves the session state from `.ready` directly into `.capturing`". Done pauses the session
/// ("Call this when object capture view is not visible"), the person reviews Apple's point cloud, then **Use scan**
/// calls `finish()` or **Keep scanning** calls `resume()`.
///
/// Kept free of RealityKit so the steps compile and are checked off-device (tests/freeform).
struct FreeformCaptureFlow: Equatable {
    enum Step: Equatable {
        /// Apple's camera view with no reticle; Record is offered once the session is `.ready`.
        case ready
        case capturing
        /// Paused, showing `ObjectCapturePointCloudView`.
        case review
        /// `finish()` was called; Apple saves the images and the session goes `.finishing` → `.completed`.
        case finishing
        /// Stopped from the review sheet; the capture screen's stop takes over and the files are kept.
        case stopped
    }

    /// The session call each step asks for. The model makes it; the flow never touches RealityKit.
    enum SessionCall: Equatable {
        case startCapturing
        case pause
        case resume
        case finish
    }

    /// Done waits for enough photos to rebuild. Apple sets no minimum; David's Nov 9 rescan stopped at 28 photos from
    /// one low height and Apple placed only 15 of them. Apple's guide: "different angles at different heights".
    static let minimumShots = 60
    /// Photos needed at each of the two heights: low (about level with it) and high (looking down at it).
    static let minimumPerHeight = 15
    /// A photo whose camera looks down at least this far is "from above". David's Nov 9 photos, all from one low
    /// height, looked 2–8° down.
    static let aboveDegrees = 25.0

    private(set) var step: Step = .ready

    /// How far the camera looks down, in degrees, from the device's gravity vector (CMDeviceMotion.gravity, in g, in
    /// the device's frame). The back camera looks along the device's −z, so straight down is gravity (0, 0, −1): 90°.
    /// Held upright it is 0°, whichever way the phone or iPad is turned.
    static func lookDownDegrees(gravityX x: Double, y: Double, z: Double) -> Double {
        let length = (x * x + y * y + z * z).squareRoot()
        guard length > 0 else { return 0 }
        return asin(max(-1, min(1, -z / length))) * 180 / .pi
    }

    /// What the photos so far cover: how many look down from above and how many are low.
    struct Coverage: Equatable {
        var shots: Int
        var low: Int
        var high: Int
        /// Heights aren't known (no motion sensor): only the count gates Done.
        var heightsKnown = true

        init(shots: Int, lookDowns: [Double], heightsKnown: Bool = true) {
            self.shots = shots
            self.high = lookDowns.filter { $0 >= FreeformCaptureFlow.aboveDegrees }.count
            self.low = lookDowns.count - high
            self.heightsKnown = heightsKnown
        }

        /// Enough to rebuild: the count, and both heights.
        var isEnough: Bool {
            shots >= FreeformCaptureFlow.minimumShots
                && (!heightsKnown || (low >= FreeformCaptureFlow.minimumPerHeight && high >= FreeformCaptureFlow.minimumPerHeight))
        }

        /// One plain line: the count and the next thing to do.
        var line: String {
            let count = "\(shots) photo\(shots == 1 ? "" : "s")"
            let per = FreeformCaptureFlow.minimumPerHeight
            if isEnough { return "\(count) · ready when you are" }
            if heightsKnown && low >= per && high < per { return "\(count) · now go higher and look down" }
            if heightsKnown && high >= per && low < per { return "\(count) · now go lower, level with it" }
            if heightsKnown && (low < per || high < per) { return "\(count) · keep going round it" }
            return "\(count) · keep going, \(FreeformCaptureFlow.minimumShots - shots) more"
        }
    }

    /// Record is offered only while Apple's session is `.ready` and tracking is normal: otherwise Apple's coaching
    /// overlay has the screen ("the app may need to hide its UI at this time").
    func canRecord(sessionReady: Bool, trackingNormal: Bool) -> Bool { step == .ready && sessionReady && trackingNormal }

    /// Done is offered once the photos are enough to rebuild (``Coverage/isEnough``) while tracking is normal and the
    /// session isn't paused. There are no segments in freeform.
    func canFinish(coverage: Coverage, trackingNormal: Bool) -> Bool {
        step == .capturing && trackingNormal && coverage.isEnough
    }

    mutating func record(sessionReady: Bool, trackingNormal: Bool) -> SessionCall? {
        guard canRecord(sessionReady: sessionReady, trackingNormal: trackingNormal) else { return nil }
        step = .capturing
        return .startCapturing
    }

    mutating func done(coverage: Coverage, trackingNormal: Bool) -> SessionCall? {
        guard canFinish(coverage: coverage, trackingNormal: trackingNormal) else { return nil }
        step = .review
        return .pause
    }

    mutating func keepScanning() -> SessionCall? {
        guard step == .review else { return nil }
        step = .capturing
        return .resume
    }

    mutating func useScan() -> SessionCall? {
        guard step == .review else { return nil }
        step = .finishing
        return .finish
    }

    /// Stop from review. Returns whether the capture should stop; the session's own stop does the rest.
    mutating func stop() -> Bool {
        guard step == .review else { return false }
        step = .stopped
        return true
    }

    /// While the person reviews, the session is paused on purpose; the watchdog must not stop it.
    var isReviewing: Bool { step == .review }
}
