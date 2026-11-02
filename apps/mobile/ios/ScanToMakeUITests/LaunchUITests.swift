import XCTest

/// The app launches as a SwiftUI app and, with no Mac paired, opens on Find your Mac.
final class LaunchUITests: XCTestCase {
    func testFirstLaunchOpensFindYourMac() throws {
        let app = XCUIApplication()
        app.launch()
        // First run starts with Welcome; Continue goes on to Find your Mac.
        let welcome = app.buttons["welcome-continue"]
        if welcome.waitForExistence(timeout: 20) { welcome.tap() }
        XCTAssertTrue(app.staticTexts["Find your Mac"].waitForExistence(timeout: 20) || app.staticTexts["Your Mac"].exists
                      || app.buttons["new-project"].exists, "the app shows pairing or, when already paired, the projects")
    }
}

/// Home, New and the project page against the debug build's canned Mac (`-CounterpartFixtures`). The images
/// stay out of Git, so these check words, sections and actions; the screenshots against
/// docs/design/overhaul/screens check the look.
final class ProjectScreensUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ screen: String? = nil, set: String = "all") -> XCUIApplication {
        let app = XCUIApplication()
        // No asset folder in CI: the canned Mac answers, and its pictures fall back to placeholders.
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", set]
        if let screen { app.launchArguments += ["-CounterpartScreen", screen] }
        app.launch()
        return app
    }

    func testHomeShowsNowNeedsYouAndTheNewButton() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Now"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Cable clip"].exists, "the print is in Now")
        XCTAssertTrue(app.staticTexts["Crochet potato"].exists, "the running pass is in Now")
        XCTAssertTrue(app.staticTexts["Needs you"].exists)
        XCTAssertTrue(app.buttons["Camera"].exists && app.buttons["Best guess"].exists, "the ask card answers in place")
        XCTAssertTrue(app.buttons["new-project"].exists)
    }

    func testEmptyHomeOffersTheFirstProject() {
        let app = launch(set: "empty")
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Cable clip"].exists)
    }

    func testAReadyProjectOffersPrintAndChanges() {
        let app = launch("ready")
        XCTAssertTrue(app.staticTexts["Mic mount"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Ready to print"].exists)
        XCTAssertTrue(app.buttons["print"].exists)
        XCTAssertTrue(app.staticTexts["What changed"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["ask-for-changes"].exists)
    }

    func testAWorkingProjectSaysSo() {
        let app = launch("working")
        XCTAssertTrue(app.staticTexts["Crochet potato"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Your Mac is working on it"].exists)
        XCTAssertFalse(app.buttons["print"].exists, "nothing to print while the Mac works")
    }

    func testAFailedProjectExplainsAndOffersTryAgain() {
        let app = launch("failed")
        XCTAssertTrue(app.staticTexts["Couldn't finish"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Try Again"].exists)
    }

    func testNewSaysWhatTheMacNeedsBeforeSending() {
        let app = launch("new")
        let send = app.buttons["send"]
        XCTAssertTrue(send.waitForExistence(timeout: 20))
        send.tap()
        XCTAssertTrue(app.staticTexts["Describe what to make, or add a scan."].waitForExistence(timeout: 5),
                      "an empty project explains itself instead of failing on the Mac")
    }
}

/// The print screens against the canned Mac: the sheet's variants, the printer's own question, Printing and the printers.
final class PrintScreensUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartScreen", screen]
        app.launch()
        return app
    }

    func testThePrintSheetPicksAReportedSpool() {
        let app = launch("print-one")
        XCTAssertTrue(app.staticTexts["Color"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["AMS · 4 slots"].exists)
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["print-now"].isEnabled, "the suggested spool is preselected")
    }

    func testAPrinterWithoutAnAMSUsesTheLoadedFilament() {
        let app = launch("print-noams")
        XCTAssertTrue(app.staticTexts["No AMS"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Uses the loaded filament: PLA Galaxy Black"].exists)
    }

    func testAPrinterThatDoesntSayAsksWhatsLoaded() {
        let app = launch("print-loaded")
        XCTAssertTrue(app.staticTexts["What's loaded?"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["print-now"].isEnabled, "it prints with its profile's material")
        XCTAssertFalse(app.segmentedControls["Quality"].exists, "an MCP without quality arguments gets the preset, said so")
    }

    func testThePrintersOwnQuestionNeedsTheSwitch() {
        let app = launch("confirm")
        let start = app.buttons["start-print"]
        XCTAssertTrue(start.waitForExistence(timeout: 20))
        XCTAssertFalse(start.isEnabled, "nothing goes to the printer until the switch is on")
        XCTAssertTrue(app.staticTexts["The build plate is clear"].exists)
        app.switches.firstMatch.tap()
        XCTAssertTrue(start.isEnabled)
    }

    func testAPrintersChoiceAndNumberAreAnsweredHere() {
        let app = launch("confirm-generic")
        let start = app.buttons["start-print"]
        XCTAssertTrue(start.waitForExistence(timeout: 20))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Standard' OR value == 'Standard'")).firstMatch.exists,
                      "the choice shows its default by name")
        XCTAssertTrue(app.staticTexts["Between 40 and 110"].exists, "the number says its limits")
        app.swipeUp()
        app.switches.firstMatch.tap()
        XCTAssertTrue(start.isEnabled, "the default answers the choice; the number is optional")
    }

    func testAQuestionThisAppCantShowCanBeStopped() {
        let app = launch("confirm-mac")
        XCTAssertTrue(app.buttons["Don't Print"].waitForExistence(timeout: 20), "the way on is to stop this print")
        XCTAssertTrue(app.buttons["Not Now"].exists)
    }

    func testWhenTheMacAnswersAnyQuestionItsOffered() {
        let app = launch("confirm-mac-answers")
        XCTAssertTrue(app.buttons["Answer on your Mac"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Don't Print"].exists)
    }

    func testPrintingShowsProgressAndAsksBeforeStopping() {
        let app = launch("printing")
        XCTAssertTrue(app.staticTexts["Layer 84 of 212"].waitForExistence(timeout: 20))
        let stop = app.buttons["Stop"]
        XCTAssertTrue(stop.exists)
        stop.tap()
        XCTAssertTrue(app.buttons["Stop Print"].waitForExistence(timeout: 5), "Stop asks first")
    }

    /// Scrolls to the bottom and checks that `last` ends above the bottom bar's top (`bar`), so the bar
    /// never covers the screen's last control.
    private func assertLastControlClearsTheBar(_ app: XCUIApplication, last: XCUIElement, bar: XCUIElement, _ screen: String) {
        XCTAssertTrue(bar.waitForExistence(timeout: 20), screen)
        for _ in 0..<6 { app.swipeUp() }
        XCTAssertTrue(last.waitForExistence(timeout: 5), "\(screen): the last control exists")
        XCTAssertTrue(last.isHittable, "\(screen): the last control can be reached")
        XCTAssertLessThanOrEqual(last.frame.maxY, bar.frame.minY + 1, "\(screen): the bottom bar covers the last control")
    }

    func testThePrintSheetsLastControlClearsPrint() {
        let app = launch("print-one")
        assertLastControlClearsTheBar(app, last: app.buttons["Max"], bar: app.buttons["print-now"], "print")
    }

    func testThePresetNoteClearsPrint() {
        let app = launch("print-loaded")
        let note = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'preset is used'")).firstMatch
        assertLastControlClearsTheBar(app, last: note, bar: app.buttons["print-now"], "print-loaded")
    }

    func testTheLastQuestionClearsStartPrint() {
        let app = launch("confirm-generic")
        assertLastControlClearsTheBar(app, last: app.switches.firstMatch, bar: app.buttons["start-print"], "confirm-generic")
        XCTAssertLessThanOrEqual(app.textFields["Bed temperature (°C)"].frame.maxY, app.buttons["start-print"].frame.minY + 1)
    }

    func testThePrintingFooterClearsPauseAndStop() {
        let app = launch("printing")
        let footer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "a notification when it's done")).firstMatch
        assertLastControlClearsTheBar(app, last: footer, bar: app.buttons["Pause"], "printing")
    }

    func testAPrinterNamesTheUpdateItsMCPNeeds() {
        let app = launch("printer-update")
        XCTAssertTrue(app.staticTexts["Update mcp-3D-printer-server to see progress and camera"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Copy"].exists)
    }
}

/// Settings, About and the first-run steps (PRD §5.9, §5.10).
final class SettingsAndFirstRunUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartScreen", screen]
        app.launch()
        return app
    }

    func testSettingsShowsTheMacHelpAndAbout() {
        let app = launch("settings")
        XCTAssertTrue(app.staticTexts["Connected now"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Check Connection"].exists)
        XCTAssertTrue(app.buttons["Connect a Different Mac"].exists)
        XCTAssertTrue(app.staticTexts["Print the scan rig"].exists)
    }

    func testNotificationsHaveASwitchEachAndTheMilestones() {
        let app = launch("notifications")
        XCTAssertTrue(app.switches["Ready to print"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.switches["Something's on the plate"].exists, "no plate check (ac44431)")
        XCTAssertTrue(app.buttons["Progress"].exists || app.staticTexts["Progress"].exists)
    }

    func testAboutCreditsTheRigAndListsNotices() {
        let app = launch("about")
        XCTAssertTrue(app.staticTexts["Counterpart"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Open-source notices"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Kass 3D'")).firstMatch.exists)
    }

    func testWelcomeShowsTheTwoJobs() {
        let app = launch("welcome")
        XCTAssertTrue(app.staticTexts["Make something that fits"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Copy something"].exists)
        XCTAssertTrue(app.buttons["welcome-continue"].exists)
    }

    func testNotificationsAreAskedWithTheirReason() {
        let app = launch("notify")
        XCTAssertTrue(app.staticTexts["Know when it's ready"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Turn On Notifications"].exists)
        app.buttons["Not Now"].tap()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20), "Not Now goes on to the projects")
    }
}

