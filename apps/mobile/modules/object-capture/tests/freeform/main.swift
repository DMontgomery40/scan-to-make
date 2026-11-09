// Compile with ../../GuidedCaptureSample/GuidedCaptureSample/FreeformCaptureFlow.swift; see run_freeform_checks.sh.
// The quick scan's steps (quick-sweep-capture.md §3.1): ready → capturing → review (paused) → finish, or resume.
import Foundation

var failures = 0

func check(_ name: String, _ condition: Bool) {
    print((condition ? "PASS " : "FAIL ") + name)
    if !condition { failures += 1 }
}

typealias Flow = FreeformCaptureFlow

// Ready: Record only once Apple's session is .ready, and it calls startCapturing (never startDetecting).
var flow = Flow()
check("starts ready", flow.step == .ready)
check("Record waits for the session to be ready", flow.record(sessionReady: false) == nil && flow.step == .ready)
check("Done isn't offered before Record", flow.done(shots: 50) == nil && flow.step == .ready)
check("Use scan isn't offered before review", flow.useScan() == nil && flow.step == .ready)
check("Keep scanning isn't offered before review", flow.keepScanning() == nil && flow.step == .ready)
check("Record calls startCapturing from ready", flow.record(sessionReady: true) == .startCapturing && flow.step == .capturing)
check("Record can't start twice", flow.record(sessionReady: true) == nil && flow.step == .capturing)

// Capturing: Done after ten photos, one pass is enough; it pauses for review.
check("Done hidden at 9 photos", !flow.canFinish(shots: 9) && flow.done(shots: 9) == nil && flow.step == .capturing)
check("Done shown at 10 photos", flow.canFinish(shots: Flow.minimumShots))
check("Done pauses for review", flow.done(shots: 10) == .pause && flow.step == .review && flow.isReviewing)
check("Done can't pause twice", flow.done(shots: 10) == nil && flow.step == .review)
check("Done isn't offered while reviewing", !flow.canFinish(shots: 100))

// Review → Keep scanning resumes into the same capture; Done can be pressed again later.
check("Keep scanning resumes", flow.keepScanning() == .resume && flow.step == .capturing && !flow.isReviewing)
check("Keep scanning only once", flow.keepScanning() == nil && flow.step == .capturing)
check("Use scan needs review first", flow.useScan() == nil && flow.step == .capturing)
check("Done again after more photos", flow.done(shots: 42) == .pause && flow.step == .review)

// Review → Use scan finishes; nothing else happens after it.
check("Use scan finishes", flow.useScan() == .finish && flow.step == .finishing && !flow.isReviewing)
check("Use scan only once", flow.useScan() == nil)
check("no resume after finish", flow.keepScanning() == nil)
check("no Done after finish", flow.done(shots: 100) == nil && flow.step == .finishing)
check("no Record after finish", flow.record(sessionReady: true) == nil && flow.step == .finishing)

// A fresh flow is a fresh capture.
check("a new flow starts ready", Flow().step == .ready)

// The launch argument: `-STMFreeformCapture YES` lands in UserDefaults' argument domain.
let suite = "freeform-checks-\(UUID().uuidString)"
let defaults = UserDefaults(suiteName: suite)!
check("off unless asked", !Flow.isEnabled(defaults))
defaults.set(true, forKey: "STMFreeformCapture")
check("on with -STMFreeformCapture YES", Flow.isEnabled(defaults))
defaults.removePersistentDomain(forName: suite)

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("All freeform capture checks passed")
