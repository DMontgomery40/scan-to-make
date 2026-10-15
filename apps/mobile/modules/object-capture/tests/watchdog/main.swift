// Compile with ../../GuidedCaptureSample/GuidedCaptureSample/CaptureWatchdog.swift; see run_watchdog_checks.sh.
import Foundation

var failures = 0

func check(_ name: String, _ condition: Bool) {
    print((condition ? "PASS " : "FAIL ") + name)
    if !condition { failures += 1 }
}

// Feeds one observation per second and returns the first stop reason with its time.
func run(seconds: Int, paused: (Int) -> Bool = { _ in false }, shots: (Int) -> Int = { _ in 0 },
         thermalCritical: (Int) -> Bool = { _ in false },
         tracking: (Int) -> CaptureWatchdog.Tracking) -> (CaptureWatchdog.StopReason, Int)? {
    var watchdog = CaptureWatchdog()
    for second in 0...seconds {
        if let reason = watchdog.observe(tracking: tracking(second), paused: paused(second), shots: shots(second),
                                         thermalCritical: thermalCritical(second), at: TimeInterval(second)) {
            return (reason, second)
        }
    }
    return nil
}

let noImages = run(seconds: 3600) { _ in .notAvailable }
check("black feed stops after 15s", noImages?.0 == .noCameraImages && noImages?.1 == 15)

let lateDeath = run(seconds: 3600, shots: { $0 }) { $0 < 60 ? .normal : .notAvailable }
check("feed lost mid-capture stops 15s later", lateDeath?.0 == .noCameraImages && lateDeath?.1 == 75)

let initializing = run(seconds: 3600) { _ in .limited }
check("tracking never normal stops after 90s",
      initializing?.0 == .trackingNotRecovering && initializing?.1 == 90)

let flapping = run(seconds: 3600, shots: { $0 }) { $0 % 20 < 10 ? .limited : .normal }
check("intermittent normal tracking with progress keeps running", flapping == nil)

let recovered = run(seconds: 3600, shots: { $0 }) { $0 < 89 ? .limited : .normal }
check("tracking that recovers before 90s keeps running", recovered == nil)

let shortGap = run(seconds: 3600, shots: { $0 }) { $0 % 60 < 14 ? .notAvailable : .normal }
check("feed gaps under 15s keep running", shortGap == nil)

let help = run(seconds: 3600, paused: { $0 >= 10 && $0 < 250 }, shots: { $0 < 10 || $0 >= 250 ? $0 : 10 }) {
    $0 >= 10 && $0 < 260 ? .notAvailable : .normal
}
check("paused help sheet does not count as a dead feed", help == nil)

let pausedForever = run(seconds: 3600, paused: { $0 >= 10 }) { _ in .notAvailable }
check("session paused for 5 minutes stops", pausedForever?.0 == .pausedTooLong && pausedForever?.1 == 310)

let idle = run(seconds: 3600, shots: { min($0, 30) }) { _ in .normal }
check("no new shots for 5 minutes stops", idle?.0 == .unattended && idle?.1 == 330)

let steady = run(seconds: 3600, shots: { $0 / 10 }) { _ in .normal }
check("steady capture progress keeps running", steady == nil)

let hot = run(seconds: 3600, shots: { $0 }, thermalCritical: { $0 >= 42 }) { _ in .normal }
check("critical thermal state stops immediately", hot?.0 == .deviceTooHot && hot?.1 == 42)

let reasons: [CaptureWatchdog.StopReason] = [.noCameraImages, .trackingNotRecovering, .pausedTooLong, .unattended, .deviceTooHot]
check("every stop reason has a message and diagnostic detail",
      reasons.allSatisfy { !$0.message.isEmpty && $0.detail.hasPrefix("Watchdog: ") })

if failures > 0 {
    print("\(failures) watchdog check(s) failed")
    exit(1)
}
print("All watchdog checks passed")
