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

// The app's own shutter: a photo each 5° the camera's view turns, at most 3 a second.
typealias Pacer = FreeformCaptureFlow.ShotPacer
typealias Direction = Pacer.Direction
/// The camera looking level at `azimuth`° round the object, `down`° down.
func look(_ azimuth: Double, down: Double = 5) -> Direction {
    let a = azimuth * .pi / 180, e = -down * .pi / 180
    return Direction(x: cos(e) * cos(a), y: cos(e) * sin(a), z: sin(e))
}
var pacer = Pacer()
check("the first photo is due at once", pacer.isDue(look(0), at: 0))
pacer.requested(look(0), at: 0); pacer.shotTaken(at: 0.1)
check("not again before the view turns", !pacer.isDue(look(4.9), at: 5))
check("due after 5°", pacer.isDue(look(5.1), at: 5))
check("not faster than 3 a second, however far it turned", !pacer.isDue(look(40), at: 0.3))
check("due a third of a second later", pacer.isDue(look(40), at: 0.34))
check("going higher counts too", pacer.isDue(look(0, down: 11), at: 1))
check("holding still takes nothing", !pacer.isDue(look(0.5, down: 5.5), at: 60))
// One steady turn in 30 s, sampled at 30 Hz the way the app polls: about 72 photos; three turns about 216.
func photos(turns: Double, seconds: Double) -> Int {
    var p = Pacer(), taken = 0
    let samples = Int(seconds * 30)
    for i in 0...samples {
        let t = Double(i) / 30, direction = look(360 * turns * t / seconds)
        if p.isDue(direction, at: t) { p.requested(direction, at: t); p.shotTaken(at: t); taken += 1 }
    }
    return taken
}
let oneTurn = photos(turns: 1, seconds: 30), threeTurns = photos(turns: 3, seconds: 90)
check("one turn ≈ 70 photos (\(oneTurn))", (65...75).contains(oneTurn))
check("three turns ≈ 200 photos (\(threeTurns))", (195...220).contains(threeTurns))
check("a fast turn (10 s) is held to 3 a second (\(photos(turns: 1, seconds: 10)))", photos(turns: 1, seconds: 10) <= 31)

// A request Apple drops is asked again a third of a second later, without waiting for another 5° turn.
var dropped = Pacer()
dropped.requested(look(0), at: 0); dropped.shotTaken(at: 0)
dropped.requested(look(6), at: 1)                       // Apple didn't take this one
check("a dropped request is asked again", dropped.isDue(look(6), at: 1.34) && !dropped.isDue(look(6), at: 1.2))
check("a dropped request alone doesn't give up on the app's shutter", !dropped.needsAutoCapture(at: 1.34))
// Apple ignoring every request (a dim room, a busy session): after 3 unanswered requests over 5 s, Apple's
// auto-capture takes over rather than the scan ending with no photos.
var ignored = Pacer()
for i in 0..<16 { let t = Double(i) / 3; if ignored.isDue(look(Double(i) * 6), at: t) { ignored.requested(look(Double(i) * 6), at: t) } }
check("ignored for 5 s: hand back to Apple's auto-capture", ignored.needsAutoCapture(at: 5.1) && ignored.unanswered >= 3)
check("not before 5 s", !ignored.needsAutoCapture(at: 4.9))
ignored.shotTaken(at: 5.2)
check("a photo resets it", !ignored.needsAutoCapture(at: 5.3) && ignored.unanswered == 0)
// Holding still for a minute and then moving on doesn't count the stillness against Apple.
var still = Pacer()
still.requested(look(0), at: 0); still.shotTaken(at: 0)
still.requested(look(10), at: 60)
check("a fresh request after a long still spell is not a fallback", !still.needsAutoCapture(at: 60.4))

// The camera's direction from Core Motion's attitude matrix, whichever way round the matrix carries the frames.
// The phone held upright facing +x in the reference frame (z up): device x → reference −y, device y → reference z,
// device z → reference −x, so the back camera (device −z) looks along +x and gravity in the device frame is (0, −1, 0).
let deviceToReference: [Double] = [0, 0, -1,  -1, 0, 0,  0, 1, 0]   // columns are the device axes in the reference frame
let referenceToDevice: [Double] = [0, -1, 0,  0, 0, 1,  -1, 0, 0]   // its transpose
let upright = Direction(x: 0, y: -1, z: 0)
func same(_ a: Direction, _ b: Direction) -> Bool { Pacer.angle(a, b) < 0.01 }
check("camera direction, matrix reference → device", same(Pacer.cameraDirection(rotation: referenceToDevice, gravity: upright), Direction(x: 1, y: 0, z: 0)))
check("camera direction, matrix device → reference", same(Pacer.cameraDirection(rotation: deviceToReference, gravity: upright), Direction(x: 1, y: 0, z: 0)))

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("All freeform capture checks passed")
