// Compile with ../../GuidedCaptureSample/GuidedCaptureSample/FreeformCaptureFlow.swift; see run_freeform_checks.sh.
// The quick scan's steps (quick-sweep-capture.md §3.1): ready → capturing → review (paused) → finish, or resume.
import Foundation

var failures = 0

func check(_ name: String, _ condition: Bool) {
    print((condition ? "PASS " : "FAIL ") + name)
    if !condition { failures += 1 }
}

typealias Flow = FreeformCaptureFlow
typealias Coverage = FreeformCaptureFlow.Coverage

/// `n` photos split between low (5° down) and high (40° down).
func coverage(low: Int, high: Int, heightsKnown: Bool = true) -> Coverage {
    Coverage(shots: low + high, lookDowns: Array(repeating: 5, count: low) + Array(repeating: 40, count: high), heightsKnown: heightsKnown)
}
let enough = coverage(low: 30, high: 30)

// Ready: Record only once Apple's session is .ready and tracking is normal, and it calls startCapturing
// (never startDetecting).
var flow = Flow()
check("starts ready", flow.step == .ready)
check("Record waits for the session to be ready", flow.record(sessionReady: false, trackingNormal: true) == nil && flow.step == .ready)
check("Record waits for normal tracking", !flow.canRecord(sessionReady: true, trackingNormal: false)
      && flow.record(sessionReady: true, trackingNormal: false) == nil && flow.step == .ready)
check("Done isn't offered before Record", flow.done(coverage: enough, trackingNormal: true) == nil && flow.step == .ready)
check("Use scan isn't offered before review", flow.useScan() == nil && flow.step == .ready)
check("Keep scanning isn't offered before review", flow.keepScanning() == nil && flow.step == .ready)
check("Stop from review isn't offered before review", !flow.stop() && flow.step == .ready)
check("Record calls startCapturing from ready", flow.record(sessionReady: true, trackingNormal: true) == .startCapturing && flow.step == .capturing)
check("Record can't start twice", flow.record(sessionReady: true, trackingNormal: true) == nil && flow.step == .capturing)

// Capturing: Done only once the photos are enough to rebuild (60, from two heights), while tracking is normal;
// it pauses for review.
check("Done hidden at 59 photos from two heights", !flow.canFinish(coverage: coverage(low: 30, high: 29), trackingNormal: true)
      && flow.done(coverage: coverage(low: 30, high: 29), trackingNormal: true) == nil && flow.step == .capturing)
check("Done hidden at 100 photos from one height", !flow.canFinish(coverage: coverage(low: 100, high: 0), trackingNormal: true))
check("Done hidden at 100 photos all from above", !flow.canFinish(coverage: coverage(low: 0, high: 100), trackingNormal: true))
check("Done hidden with 14 from above", !flow.canFinish(coverage: coverage(low: 60, high: 14), trackingNormal: true))
check("Done hidden while tracking isn't normal", !flow.canFinish(coverage: enough, trackingNormal: false)
      && flow.done(coverage: enough, trackingNormal: false) == nil && flow.step == .capturing)
check("Done shown at 60 photos, 15 at each height", flow.canFinish(coverage: coverage(low: 45, high: 15), trackingNormal: true))
check("Done shown on the count alone when heights aren't known",
      flow.canFinish(coverage: coverage(low: 60, high: 0, heightsKnown: false), trackingNormal: true)
      && !flow.canFinish(coverage: coverage(low: 59, high: 0, heightsKnown: false), trackingNormal: true))
check("Done pauses for review", flow.done(coverage: enough, trackingNormal: true) == .pause && flow.step == .review && flow.isReviewing)
check("Done can't pause twice", flow.done(coverage: enough, trackingNormal: true) == nil && flow.step == .review)
check("Done isn't offered while reviewing", !flow.canFinish(coverage: coverage(low: 100, high: 100), trackingNormal: true))

// Review → Keep scanning resumes into the same capture; Done can be pressed again later.
check("Keep scanning resumes", flow.keepScanning() == .resume && flow.step == .capturing && !flow.isReviewing)
check("Keep scanning only once", flow.keepScanning() == nil && flow.step == .capturing)
check("Use scan needs review first", flow.useScan() == nil && flow.step == .capturing)
check("Stop needs review first", !flow.stop() && flow.step == .capturing)
check("Done again after more photos", flow.done(coverage: coverage(low: 40, high: 40), trackingNormal: true) == .pause && flow.step == .review)

// Review → Use scan finishes; nothing else happens after it.
var stopping = flow
check("Use scan finishes", flow.useScan() == .finish && flow.step == .finishing && !flow.isReviewing)
check("Use scan only once", flow.useScan() == nil)
check("no resume after finish", flow.keepScanning() == nil)
check("no Stop after finish", !flow.stop() && flow.step == .finishing)
check("no Done after finish", flow.done(coverage: enough, trackingNormal: true) == nil && flow.step == .finishing)
check("no Record after finish", flow.record(sessionReady: true, trackingNormal: true) == nil && flow.step == .finishing)

// Review → Stop: the capture stops, files kept; nothing else happens after it.
check("Stop from review stops", stopping.stop() && stopping.step == .stopped && !stopping.isReviewing)
check("Stop only once", !stopping.stop())
check("no Use scan after Stop", stopping.useScan() == nil && stopping.step == .stopped)
check("no resume after Stop", stopping.keepScanning() == nil && stopping.step == .stopped)

// A fresh flow is a fresh capture.
check("a new flow starts ready", Flow().step == .ready)

// The one line of progress: the count and the next thing to do.
check("line: start", coverage(low: 3, high: 0).line == "3 photos · keep going round it")
check("line: one photo", coverage(low: 1, high: 0).line == "1 photo · keep going round it")
check("line: low done, go higher", coverage(low: 42, high: 0).line == "42 photos · now go higher and look down")
check("line: high done, go lower", coverage(low: 2, high: 20).line == "22 photos · now go lower, level with it")
check("line: both heights, more photos", coverage(low: 20, high: 20).line == "40 photos · keep going, 20 more")
check("line: enough", enough.line == "60 photos · ready when you are")
check("line: no heights", coverage(low: 12, high: 0, heightsKnown: false).line == "12 photos · keep going, 48 more")

// How far the camera looks down, from the device's gravity (in g, device frame; the back camera looks along −z).
func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.5 }
check("upright portrait is level", near(Flow.lookDownDegrees(gravityX: 0, y: -1, z: 0), 0))
check("upright landscape (iPad) is level", near(Flow.lookDownDegrees(gravityX: -1, y: 0, z: 0), 0))
check("flat, screen up, looks straight down", near(Flow.lookDownDegrees(gravityX: 0, y: 0, z: -1), 90))
check("tilted 40° down", near(Flow.lookDownDegrees(gravityX: 0, y: -cos(40 * .pi / 180), z: -sin(40 * .pi / 180)), 40))
check("tilted up is negative", Flow.lookDownDegrees(gravityX: 0, y: -0.9, z: 0.3) < 0)

// David's Nov 9 rescan (project 4df6eb64): the gravity Apple stored in each of the 28 HEICs (device frame, g).
// All from one low height, 5–8° down: Done stays off and the line asks for photos from above.
let rescan: [(Double, Double, Double)] = [
    (0.00, -1.00, -0.09), (-0.01, -0.99, -0.11), (0.02, -0.99, -0.12), (0.03, -0.99, -0.11), (0.01, -1.00, -0.09),
    (0.01, -1.00, -0.09), (0.00, -1.00, -0.08), (-0.00, -1.00, -0.08), (-0.00, -1.00, -0.09), (-0.01, -1.00, -0.10),
    (-0.01, -0.99, -0.11), (-0.00, -0.99, -0.12), (0.01, -0.99, -0.13), (0.02, -0.99, -0.12), (0.02, -0.99, -0.12),
    (0.03, -0.99, -0.12), (0.03, -0.99, -0.12), (0.03, -0.99, -0.11), (0.03, -0.99, -0.11), (0.02, -1.00, -0.09),
    (0.02, -0.99, -0.10), (0.01, -0.99, -0.13), (0.01, -0.99, -0.13), (0.02, -1.00, -0.09), (-0.01, -0.99, -0.10),
    (-0.01, -0.99, -0.12), (-0.01, -0.99, -0.12), (-0.00, -0.99, -0.13),
]
let rescanAngles = rescan.map { Flow.lookDownDegrees(gravityX: $0.0, y: $0.1, z: $0.2) }
check("rescan: every photo is low (under 10° down)", rescanAngles.allSatisfy { $0 > 0 && $0 < 10 })
let rescanCoverage = Coverage(shots: 28, lookDowns: rescanAngles)
check("rescan: 28 low, none from above", rescanCoverage.low == 28 && rescanCoverage.high == 0)
var rescanFlow = Flow()
_ = rescanFlow.record(sessionReady: true, trackingNormal: true)
check("rescan: Done stays off", !rescanFlow.canFinish(coverage: rescanCoverage, trackingNormal: true)
      && rescanFlow.done(coverage: rescanCoverage, trackingNormal: true) == nil)
check("rescan: the line asks for photos from above", rescanCoverage.line == "28 photos · now go higher and look down")
let rescanDoubled = Coverage(shots: 56, lookDowns: rescanAngles + rescanAngles)
check("rescan twice over at the same height: go higher", rescanDoubled.line == "56 photos · now go higher and look down"
      && !rescanFlow.canFinish(coverage: rescanDoubled, trackingNormal: true))

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("All freeform capture checks passed")
