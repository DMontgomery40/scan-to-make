/* See LICENSE.txt for the Apple sample license. */
import Foundation

/// The quick scan's steps: Apple's freeform Object Capture with no box and no mode
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

    /// Stage 1 sits behind this launch argument (§4: "there is no Labs switch"): `-STMFreeformCapture YES`.
    static let launchArgument = "STMFreeformCapture"
    /// Our sample's minimum (`AppDataModel.minNumImages`); Apple sets none.
    static let minimumShots = 10

    private(set) var step: Step = .ready

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: launchArgument)
    }

    /// Record is offered only while Apple's session is `.ready` and tracking is normal: otherwise Apple's coaching
    /// overlay has the screen ("the app may need to hide its UI at this time").
    func canRecord(sessionReady: Bool, trackingNormal: Bool) -> Bool { step == .ready && sessionReady && trackingNormal }

    /// Done appears after ten shots while tracking is normal and the session isn't paused. There are no segments in
    /// freeform, so one pass is enough.
    func canFinish(shots: Int, trackingNormal: Bool) -> Bool {
        step == .capturing && trackingNormal && shots >= Self.minimumShots
    }

    mutating func record(sessionReady: Bool, trackingNormal: Bool) -> SessionCall? {
        guard canRecord(sessionReady: sessionReady, trackingNormal: trackingNormal) else { return nil }
        step = .capturing
        return .startCapturing
    }

    mutating func done(shots: Int, trackingNormal: Bool) -> SessionCall? {
        guard canFinish(shots: shots, trackingNormal: trackingNormal) else { return nil }
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
