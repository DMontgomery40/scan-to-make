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
        // The Mac's real name and what its printer is doing, never "0 printers ready" while one prints.
        XCTAssertTrue(app.staticTexts["Mac mini connected · Bambu Lab P1S printing"].exists)
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

    /// KAN-217: a print that stopped offers Print Again, which opens the print sheet, and never Try Again (that would
    /// design it again from scratch). The printer's own words are the message (PRD §5.5).
    func testAFailedPrintOffersPrintAgain() {
        let app = launch("failed-print")
        XCTAssertTrue(app.staticTexts["The print didn't finish"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["The printer stopped: The front cover of the toolhead fell off."].exists)
        XCTAssertFalse(app.buttons["try-again"].exists, "no Try Again for a print")
        let again = app.buttons["print-again"]
        XCTAssertTrue(again.exists)
        // On a 17e the card's buttons start half under the bottom bar (isHittable doesn't see the bar's glass):
        // scroll them up, as a person would.
        app.swipeUp()
        XCTAssertEqual(again.label, "Print Again")
        again.tap()
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10), "Print Again opens the print sheet")
    }

    /// A change that failed after the print: Try Again sends the same change again (the canned Mac starts a pass only
    /// for a correction carrying it), and the model it changes can still print.
    func testAFailedChangeSendsTheSameChangeAgain() {
        let app = launch("failed-change")
        XCTAssertTrue(app.staticTexts["Your Mac couldn't finish"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons["print-again"].label, "Print", "the last model prints; it isn't a failed print")
        let tryAgain = app.buttons["try-again"]
        XCTAssertTrue(tryAgain.exists)
        app.swipeUp()
        tryAgain.tap()
        XCTAssertTrue(app.staticTexts["Your Mac is working on it"].waitForExistence(timeout: 10), "the same change is running again")
        XCTAssertFalse(app.buttons["try-again"].exists)
    }

    /// PRD §5.4: a finished print asks "Did it fit?"; It Works makes it Done: Print Another, and Home's Done section.
    func testItWorksMovesAPrintedProjectToDone() {
        let app = launch("printed")
        let works = app.buttons["it-works"]
        XCTAssertTrue(works.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Did it fit?"].exists)
        XCTAssertTrue(app.buttons["needs-changes"].exists)
        works.tap()
        XCTAssertTrue(app.buttons["Print Another"].waitForExistence(timeout: 10), "Done keeps Print, as Print Another")
        XCTAssertTrue(app.staticTexts["Done"].exists, "the Done capsule")
        XCTAssertFalse(app.buttons["it-works"].exists, "answered: the card goes")
        app.navigationBars.buttons.firstMatch.tap()
        let done = app.staticTexts["Done"]
        XCTAssertTrue(reach(app, done), "Home has a Done section")
        XCTAssertTrue(reach(app, app.staticTexts["Potato, first try"]))
    }

    /// KAN-214 #237: a print getting ready on the printer (layer 0) shows the Mac's words, no percent, and opens the
    /// Printing screen, where the camera and Stop are.
    func testAPrintGettingReadyOpensPrinting() {
        let app = launch("preparing")
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Getting ready · Heating")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the Mac's own words on the Now card")
        XCTAssertFalse(card.label.contains("%"), "no percent while it gets ready")
        card.tap()
        XCTAssertTrue(app.buttons["Stop"].waitForExistence(timeout: 10), "Printing, with Stop, not the project page")
    }

    /// David's mic mount is Ready, not Printed: the status capsule makes it Done in one tap from the page.
    func testTheStatusCapsuleMarksAReadyProjectDone() {
        let app = launch("ready")
        let capsule = app.buttons["status-menu"]
        XCTAssertTrue(capsule.waitForExistence(timeout: 20))
        capsule.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "the choices are right on the capsule")
        XCTAssertTrue(app.buttons["Hide from Home"].exists, "Hide from Home is there too, apart")
        done.tap()
        XCTAssertTrue(app.buttons["Print Another"].waitForExistence(timeout: 10), "Done, and still printable")
    }

    /// Needs Changes says so on the Mac and starts the change in Ask for changes.
    func testNeedsChangesStartsAskForChanges() {
        let app = launch("printed")
        let changes = app.buttons["needs-changes"]
        XCTAssertTrue(changes.waitForExistence(timeout: 20))
        changes.tap()
        let field = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "After printing: ")
        XCTAssertTrue(gone(app.buttons["it-works"]), "answered: the card goes")
    }

    /// ••• → Status lists Not printed, Printed, Done, Needs changes; Hide from Home is apart, and the Archived list
    /// at the bottom of Home brings it back with Unarchive.
    func testHideFromHomeAndUnarchive() {
        let app = launch("printed")
        XCTAssertTrue(app.buttons["it-works"].waitForExistence(timeout: 20))
        app.buttons["More"].tap()
        app.buttons["Status"].tap()
        for label in ["Not printed", "Printed", "Done", "Needs changes"] { XCTAssertTrue(app.buttons[label].exists, label) }
        XCTAssertFalse(app.buttons["Archived"].exists, "archive isn't a status")
        app.buttons["Printed"].tap()
        app.buttons["More"].tap()
        let hide = app.buttons["Hide from Home"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        hide.tap()
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        let archived = app.buttons["show-archived"]
        XCTAssertTrue(reach(app, archived))
        XCTAssertFalse(app.staticTexts["Potato, first try"].exists, "off Home until shown")
        archived.tap()
        let unarchive = app.buttons["unarchive"]
        XCTAssertTrue(reach(app, unarchive))
        XCTAssertTrue(app.staticTexts["Potato, first try"].exists)
        unarchive.tap()
        XCTAssertTrue(gone(app.buttons["show-archived"]), "nothing archived any more")
        // Back in All projects, above where the Archived list was: scroll back to the top first.
        for _ in 0..<4 { app.swipeDown() }
        XCTAssertTrue(reach(app, app.staticTexts["Potato, first try"]), "back in Projects")
    }

    /// Scrolls down until `element` is on screen.
    private func reach(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists
    }

    /// Waits for `element` to go, after an answer the Mac has to accept first.
    private func gone(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)], timeout: timeout) == .completed
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
        XCTAssertTrue(app.descendants(matching: .any)["copies"].exists, "bambu-printer-mcp makes copies: the stepper is offered")
    }

    func testAPrinterWithoutAnAMSUsesTheLoadedFilament() {
        let app = launch("print-noams")
        XCTAssertTrue(app.staticTexts["No AMS"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["copies"].exists, "an MCP that would slice one copy isn't offered Copies")
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
        XCTAssertTrue(app.staticTexts["Start a checked print on P1S?"].exists, "the MCP's own question")
        XCTAssertFalse(app.staticTexts["Check at the printer"].exists, "no checklist of the app's own")
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
        XCTAssertTrue(footer.waitForExistence(timeout: 20))
        // At rest, before any scrolling: the note sits above Pause and Stop, never under them.
        XCTAssertLessThanOrEqual(footer.frame.maxY, app.buttons["Pause"].frame.minY + 1, "the note is under the controls at rest")
        let speed = app.staticTexts["Speed"]
        assertLastControlClearsTheBar(app, last: speed, bar: footer, "printing")
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
        let mac = app.descendants(matching: .any)["mac-status"]
        XCTAssertTrue(mac.waitForExistence(timeout: 20))
        XCTAssertTrue(mac.label.contains("Connected now"), mac.label)
        XCTAssertTrue(app.buttons["Check Connection"].exists)
        XCTAssertTrue(app.buttons["Connect a Different Mac"].exists)
        XCTAssertTrue(reach(app, app.staticTexts["Print the scan rig"]))
    }

    func testNotificationsForThisIPhoneAndTheMac() {
        let app = launch("notifications")
        // This iPhone's switches come from the Mac's settings for this device: "Print started" is off there.
        let started = app.switches["Print started"].firstMatch
        XCTAssertTrue(started.waitForExistence(timeout: 20))
        XCTAssertEqual(started.value as? String, "0")
        XCTAssertTrue(app.switches["Ready to print"].firstMatch.exists)
        XCTAssertFalse(app.switches.matching(NSPredicate(format: "label CONTAINS[c] 'plate'")).firstMatch.exists, "no plate notification")
    }

    func testEveryMacSettingIsHere() {
        let app = launch("settings")
        XCTAssertTrue(app.descendants(matching: .any)["mac-status"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "1.2.9 → 1.2.22")).firstMatch.waitForExistence(timeout: 10),
                      "the printer MCP that's behind offers its update")
        XCTAssertTrue(reach(app, app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Set Up installs the Fusion add-in")).firstMatch))
        XCTAssertTrue(reach(app, app.staticTexts["David's iPad"]))
        XCTAssertTrue(reach(app, app.switches["Keep the Mac awake while working"]))
    }

    /// Scrolls down until `element` is on screen.
    private func reach(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists
    }

    func testAboutCreditsTheRigAndListsNotices() {
        let app = launch("about")
        XCTAssertTrue(app.buttons["Open-source notices"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Scan rig"].exists, "Kass 3D's rig is credited")
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

