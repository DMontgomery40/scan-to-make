import XCTest

final class CaptureFlowUITests: XCTestCase {
    @MainActor func testDismissRetainsCancellationAndExplicitReadyHandoff() {
        let app = XCUIApplication(); app.launch()
        let scan = app.buttons["Scan object"]
        XCTAssertTrue(scan.waitForExistence(timeout: 10)); scan.tap()
        XCTAssertTrue(app.staticTexts["Isolated camera fixture"].waitForExistence(timeout: 3))
        app.buttons["Stop capture"].tap()
        XCTAssertTrue(app.staticTexts["Stopping scan"].waitForExistence(timeout: 3))
        save(app, "native-stopping")
        app.buttons["Keep for later"].tap()
        XCTAssertTrue(scan.waitForExistence(timeout: 3)); XCTAssertFalse(scan.isEnabled)
        save(app, "project-blocked-until-terminal")
        app.buttons["Deliver terminal event"].tap()
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: scan)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 3), .completed)
        scan.tap(); app.buttons["Finish fixture scan"].tap()
        XCTAssertTrue(app.staticTexts["Scan ready"].waitForExistence(timeout: 5))
        save(app, "native-ready")
        app.buttons["Add to this project"].tap()
        XCTAssertTrue(app.staticTexts["Explicit add requested"].waitForExistence(timeout: 3))
        save(app, "explicit-handoff")
        app.terminate(); app.launch()
        app.buttons["Reload retained drafts"].tap()
        XCTAssertTrue(app.staticTexts["Local drafts: 2"].exists)
        save(app, "drafts-after-relaunch")
    }
    #if PRODUCT_FIXTURE
    @MainActor func testOrdinaryAppNativeBridgeAndFilesFallback() {
        let app = XCUIApplication(bundleIdentifier: "org.reactjs.native.example.ScanToMake")
        app.launch()
        let describe = app.buttons["Describe a project"].firstMatch
        XCTAssertTrue(describe.waitForExistence(timeout: 15)); describe.tap()
        let object = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "What are you working with?")).firstMatch
        XCTAssertTrue(object.waitForExistence(timeout: 5)); object.tap(); object.typeText("Synthetic capture fixture")
        app.swipeUp()
        let saveDraft = app.buttons["Save draft"].firstMatch
        if !saveDraft.isHittable { app.swipeUp() }
        XCTAssertTrue(saveDraft.waitForExistence(timeout: 3)); saveDraft.tap()
        XCTAssertTrue(app.staticTexts["Saved on this device"].firstMatch.waitForExistence(timeout: 5))
        let back = app.buttons["Back"].firstMatch
        if !back.isHittable { app.swipeDown() }
        back.tap()
        let projects = app.buttons["Your saved projects"].firstMatch
        if !projects.isHittable { app.swipeUp() }
        XCTAssertTrue(projects.waitForExistence(timeout: 5)); projects.tap()
        let captures = app.buttons["Project captures"].firstMatch
        XCTAssertTrue(captures.waitForExistence(timeout: 5)); captures.tap()
        let scan = app.buttons["Scan object"].firstMatch
        XCTAssertTrue(scan.waitForExistence(timeout: 5)); XCTAssertFalse(scan.isEnabled)
        // Refresh exists only when the real Swift module is available through NativeModules.
        XCTAssertTrue(app.buttons["Refresh local scans"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Scanning is unavailable on this device. Choose a USDZ file to keep a scan with this project."].exists)
        save(app, "ordinary-project-native-fallback")
        let choose = app.buttons["Choose USDZ capture"].firstMatch
        if !choose.isHittable { app.swipeUp() }
        XCTAssertTrue(choose.isEnabled); choose.tap()
        XCTAssertTrue(app.buttons["Cancel"].firstMatch.waitForExistence(timeout: 5))
        save(app, "ordinary-files-picker")
        app.buttons["Cancel"].firstMatch.tap()
    }
    #endif
    @MainActor private func save(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name
        attachment.lifetime = .keepAlways; add(attachment)
    }
}
