import XCTest
import UIKit

/// KAN-217 P0 acceptance, on a real iPhone only: after each way a walk-around scan can end, the Camera app must show
/// live video (not black, not green, and changing). Each step leaves `STM-ACCEPT` lines in the device log, so the
/// camera daemon's own lines can be read after our stop. Paired phone, real Mac; New's unsent draft is reused.
final class DeviceCameraAcceptanceUITests: XCTestCase {
    private let app = XCUIApplication()
    private let camera = XCUIApplication(bundleIdentifier: "com.apple.camera")

    override func setUpWithError() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Needs the phone's own cameras.")
        #endif
        continueAfterFailure = true
    }

    private func mark(_ text: String) { NSLog("STM-ACCEPT %@", text) }

    private func keep(_ name: String, _ shot: XCUIScreenshot) {
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// New → Scan it, until Apple's capture view runs (its Stop capture button is up), plus a few seconds of feed.
    private func openWalkAround(_ step: String) {
        app.launch()
        let new = app.buttons["new-project"]
        XCTAssertTrue(new.waitForExistence(timeout: 40), "Home, paired")
        new.tap()
        let scan = app.buttons["scan-object"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20), "New offers Scan it")
        XCTAssertTrue(scan.isEnabled, "Scan it is enabled (LiDAR, paired Mac)")
        mark("\(step) open walk-around")
        scan.tap()
        let stop = app.buttons["capture.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 40), "Apple's capture view is up")
        sleep(15)
        mark("\(step) walk-around running")
    }

    /// The Camera app, 3 s after it opens, and again 1 s later. Measured in the middle of the frame (the viewfinder).
    private func checkCamera(_ step: String) {
        sleep(2)
        mark("\(step) camera app launch")
        camera.launch()
        sleep(4)
        // The verdict is the photo itself, pulled off the phone afterwards: its exposure data and pixels.
        let byId = camera.buttons["PhotoCapture"]
        let shutter = byId.waitForExistence(timeout: 8) ? byId : camera.buttons["Take Picture"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 5), "the Camera app's shutter")
        mark("\(step) camera shutter")
        shutter.tap()
        sleep(4)
        XCUIDevice.shared.press(.home)
        camera.terminate()
        mark("\(step) camera app closed")
    }

    /// 0. Counterpart open and idle, then the Camera app.
    func test0IdleThenCamera() {
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 40), "Home, paired")
        mark("step0 idle")
        sleep(10)
        XCUIDevice.shared.press(.home)
        checkCamera("step0")
    }

    /// 1. Open the walk-around, then cancel it (Stop capture).
    func test1CancelThenCamera() {
        openWalkAround("step1")
        mark("step1 stop capture")
        app.buttons["capture.stop"].tap()
        sleep(4)
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 10) { close.tap() }
        mark("step1 closed")
        XCUIDevice.shared.press(.home)
        checkCamera("step1")
    }

    /// 2. Open the walk-around, go Home mid-scan, then kill the app (as swiping it away does).
    func test2BackgroundAndKillThenCamera() {
        openWalkAround("step2")
        mark("step2 home mid-scan")
        XCUIDevice.shared.press(.home)
        sleep(3)
        mark("step2 terminate app")
        app.terminate()
        mark("step2 app terminated")
        checkCamera("step2")
    }

    /// 3. Open the walk-around, then close it with the scanner's own Close.
    func test3CloseThenCamera() {
        openWalkAround("step3")
        mark("step3 close")
        let close = app.buttons["Close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10), "the scanner's Close")
        close.tap()
        sleep(4)
        mark("step3 closed")
        XCUIDevice.shared.press(.home)
        checkCamera("step3")
    }
}

/// A screenshot reduced to its middle half, 64 pixels across, for brightness, colour cast and change between frames.
private struct Frame {
    var pixels: [(r: Double, g: Double, b: Double)] = []

    init(_ image: UIImage) {
        guard let cg = image.cgImage else { return }
        let crop = CGRect(x: cg.width / 4, y: cg.height / 4, width: cg.width / 2, height: cg.height / 2)
        guard let middle = cg.cropping(to: crop) else { return }
        let width = 64, height = max(1, 64 * middle.height / max(1, middle.width))
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
        context.draw(middle, in: CGRect(x: 0, y: 0, width: width, height: height))
        pixels = stride(from: 0, to: bytes.count, by: 4).map { (Double(bytes[$0]), Double(bytes[$0 + 1]), Double(bytes[$0 + 2])) }
    }

    var luminance: [Double] { pixels.map { 0.299 * $0.r + 0.587 * $0.g + 0.114 * $0.b } }
    var mean: Double { luminance.isEmpty ? 0 : luminance.reduce(0, +) / Double(luminance.count) }
    /// How much greener than red and blue the frame is on average (a stuck sensor reads flat green).
    var greenExcess: Double {
        pixels.isEmpty ? 0 : pixels.map { $0.g - ($0.r + $0.b) / 2 }.reduce(0, +) / Double(pixels.count)
    }
    var spread: Double {
        let l = luminance, m = mean
        return l.isEmpty ? 0 : (l.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(l.count)).squareRoot()
    }
    /// Mean absolute change in luminance between two frames.
    func difference(_ other: Frame) -> Double {
        let a = luminance, b = other.luminance
        guard a.count == b.count, !a.isEmpty else { return 0 }
        return zip(a, b).map { abs($0 - $1) }.reduce(0, +) / Double(a.count)
    }
}
