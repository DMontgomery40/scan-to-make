/* See LICENSE.txt for the Apple sample license. */
import Foundation

// A capture holds the camera and LiDAR and disables auto-lock, so a session that gets no
// images, never tracks or is left unattended must end itself instead of waiting for Stop.
// Kept free of RealityKit so the policy can be compiled and checked off-device.
struct CaptureWatchdog {
    enum Tracking: Equatable {
        case notAvailable
        case limited
        case normal
    }

    enum StopReason: Equatable {
        case noCameraImages
        case trackingNotRecovering
        case pausedTooLong
        case unattended
        case deviceTooHot

        var detail: String {
            switch self {
                case .noCameraImages: return "Watchdog: camera tracking unavailable for \(Int(CaptureWatchdog.noImagesLimit))s"
                case .trackingNotRecovering: return "Watchdog: tracking not normal for \(Int(CaptureWatchdog.abnormalTrackingLimit))s"
                case .pausedTooLong: return "Watchdog: session paused for \(Int(CaptureWatchdog.pausedLimit))s"
                case .unattended: return "Watchdog: no new shots for \(Int(CaptureWatchdog.unattendedLimit))s"
                case .deviceTooHot: return "Watchdog: thermal state critical"
            }
        }

        var message: String {
            switch self {
                case .noCameraImages:
                    return "The camera sent no images, so capture stopped. If the Camera app is also black, restart iPhone before trying again."
                case .trackingNotRecovering:
                    return "Tracking didn't start, so capture stopped. Try a well-lit, textured surface and move iPhone slowly."
                case .pausedTooLong:
                    return "Capture was paused for 5 minutes, so it stopped."
                case .unattended:
                    return "No new photos for 5 minutes, so capture stopped."
                case .deviceTooHot:
                    return "iPhone is too hot, so capture stopped. Let it cool before trying again."
            }
        }
    }

    static let noImagesLimit: TimeInterval = 15
    static let abnormalTrackingLimit: TimeInterval = 90
    static let pausedLimit: TimeInterval = 300
    static let unattendedLimit: TimeInterval = 300

    private var notAvailableSince: TimeInterval?
    private var abnormalSince: TimeInterval?
    private var pausedSince: TimeInterval?
    private var progressSince: TimeInterval?
    private var lastShots: Int?

    // Paused time never counts toward the tracking or progress limits; resuming restarts them.
    mutating func observe(tracking: Tracking, paused: Bool, shots: Int, thermalCritical: Bool,
                          at now: TimeInterval) -> StopReason? {
        if thermalCritical { return .deviceTooHot }

        if paused {
            notAvailableSince = nil
            abnormalSince = nil
            progressSince = nil
            let since = pausedSince ?? now
            pausedSince = since
            return now - since >= Self.pausedLimit ? .pausedTooLong : nil
        }
        pausedSince = nil

        if progressSince == nil || shots != lastShots {
            progressSince = now
            lastShots = shots
        }

        switch tracking {
            case .normal:
                notAvailableSince = nil
                abnormalSince = nil
            case .limited:
                notAvailableSince = nil
                abnormalSince = abnormalSince ?? now
            case .notAvailable:
                notAvailableSince = notAvailableSince ?? now
                abnormalSince = abnormalSince ?? now
        }

        if let since = notAvailableSince, now - since >= Self.noImagesLimit { return .noCameraImages }
        if let since = abnormalSince, now - since >= Self.abnormalTrackingLimit { return .trackingNotRecovering }
        if let since = progressSince, now - since >= Self.unattendedLimit { return .unattended }
        return nil
    }
}
