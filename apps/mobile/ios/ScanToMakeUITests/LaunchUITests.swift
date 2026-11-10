import XCTest
import UIKit

/// The app opens same-account discovery with an explicit code fallback when no Mac is paired.
final class LaunchUITests: XCTestCase {
    func testFirstLaunchOpensFindYourMac() throws {
        let app = XCUIApplication()
        app.launch()
        // First run starts with Welcome; Continue goes on to same-account discovery.
        let welcome = app.buttons["welcome-continue"]
        if welcome.waitForExistence(timeout: 20) { welcome.tap() }
        let codeFallback = app.buttons["Use Your Mac's Code"]
        if codeFallback.waitForExistence(timeout: 20) {
            XCTAssertTrue(app.staticTexts["Connect to your Mac"].exists)
            XCTAssertTrue(codeFallback.isEnabled, "an unavailable iCloud account keeps code pairing available")
            XCTAssertTrue(app.descendants(matching: .any)["get-counterpart-mac"].exists,
                          "a tester who doesn't have the Mac app yet can get it from here (F14)")
        } else {
            XCTAssertTrue(app.buttons["new-project"].exists, "an already paired app opens its projects")
        }
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
        // Inline in one compact row (§5.1), and never under the floating New button (F13). A blind swipe could
        // carry the card under the navigation bar instead, so scroll only until the answers can be tapped.
        let camera = app.buttons["Camera"], photos = app.buttons["Photos"], guess = app.buttons["Best guess"]
        XCTAssertTrue(reach(app, camera) && photos.isHittable && guess.isHittable, "every answer can be tapped")
        let new = app.buttons["new-project"].frame
        for answer in [camera, photos, guess] { XCTAssertFalse(answer.frame.intersects(new), "\(answer.label) is under New") }
        XCTAssertEqual(camera.frame.minY, photos.frame.minY, accuracy: 2, "Camera and Photos share one row")
        // The Mac's real name and what its printer is doing, never "0 printers ready" while one prints.
        XCTAssertTrue(app.staticTexts["Mac mini connected · Bambu Lab P1S printing"].exists)
    }

    func testSearchExplainsHiddenProjectsAndShowAllRestoresThem() {
        let app = launch()
        let field = app.textFields["project-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("no-project-matches-this")
        let summary = app.staticTexts["project-search-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        XCTAssertTrue(summary.label.hasPrefix("0 of "))
        XCTAssertTrue(field.isHittable, "search stays above the list it filters")
        app.buttons["show-all-projects"].tap()
        XCTAssertFalse(summary.exists)
        XCTAssertTrue(app.staticTexts["Cable clip"].exists)
        field.tap()
        field.typeText("Cable")
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        // The iPad list occupies the sidebar; swipe the list itself, not the empty detail pane.
        let list = app.collectionViews.firstMatch.exists ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
        list.swipeUp()
        XCTAssertTrue(field.isHittable, "scrolling cannot hide the active search")
        app.buttons["show-all-projects"].tap()
    }

    func testEmptyHomeOffersTheFirstProject() {
        let app = launch(set: "empty")
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Cable clip"].exists)
    }

    func testEmptyHomeShowsCleanStarterDetails() {
        let app = launch(set: "empty")
        let card = app.buttons["starter-long-vernier-caliper"]
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["starter-scan-platform"].exists)
        XCTAssertFalse(app.buttons["starter-caliper-card"].exists, "no starter the app made up (Nov 5)")
        card.tap()
        XCTAssertTrue(app.buttons["starter-add"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Measure larger parts and depths"].exists)
        XCTAssertFalse(app.staticTexts["What changed"].exists)
    }

    func testSelectingAnotherPlateKeepsCompletionAndPrintsThatSelection() {
        let app = launch("ready", set: "plates")
        XCTAssertTrue(app.staticTexts["1 of 6 printed"].waitForExistence(timeout: 20))
        let second = app.buttons["select-plate-0-1"]
        XCTAssertTrue(second.exists)
        second.tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "selected"), object: second)
        XCTAssertEqual(XCTWaiter().wait(for: [selected], timeout: 5), .completed)
        XCTAssertTrue(app.staticTexts["1 of 6 printed"].exists)
        app.buttons["print"].tap()
        XCTAssertTrue(app.staticTexts["Plate 2"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["print-now"].exists)
    }

    /// Regression (Nov 4 one-trunk audit): the phone once said "Open Counterpart on your Mac" for a multi-colour
    /// 3MF. The print sheet keeps one spool row per part, nearest loaded colour preselected, on the phone.
    func testMultiColour3MFKeepsAPerPartSpoolRowOnThePhone() {
        let app = launch("ready", set: "plates")
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 20))
        app.buttons["print"].tap()
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Colors"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["body"].exists)
        XCTAssertTrue(app.staticTexts["letters"].exists)
        XCTAssertTrue(app.staticTexts["#FFD200 isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic."].exists,
                      "the printer MCP's own words for the loose yellow match")
        let lettersSpool = app.buttons["Spool for letters"]
        XCTAssertTrue(lettersSpool.exists)
        XCTAssertEqual(lettersSpool.value as? String, "A2 · Sunflower Yellow PLA Basic", "the MCP's label and spool name")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Open Counterpart on your Mac")).firstMatch.exists,
                       "no trip to the Mac to choose a spool for a colour")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["print-now"])], timeout: 10), .completed,
                       "every colour starts on its nearest loaded spool")
    }

    func testAReadyProjectOffersPrintAndChanges() {
        let app = launch("ready")
        XCTAssertTrue(app.buttons["project-title"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons["project-title"].label, "Mic mount")
        XCTAssertTrue(app.staticTexts["Ready to print"].exists)
        XCTAssertTrue(app.buttons["print"].exists)
        XCTAssertTrue(app.staticTexts["What changed"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["ask-for-changes"].exists)
    }

    /// Uses only the in-memory canned companion; no user's projects, pairing or printer is contacted.
    func testProjectSettingsSaveDefaultsAndReopenBeforePrinting() {
        let app = launch("ready")
        openProjectSettings(app)
        let quality = app.buttons["project-settings-quality"]
        XCTAssertTrue(quality.waitForExistence(timeout: 10))
        quality.tap()
        app.buttons["Fine"].tap()
        let copies = app.steppers["project-settings-copies"]
        XCTAssertTrue(copies.waitForExistence(timeout: 5))
        let increment = copies.buttons["project-settings-copies-Increment"]
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: increment)], timeout: 5), .completed)
        increment.tap()
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Copies: 2"), object: copies)], timeout: 5), .completed)
        app.buttons["project-settings-done"].tap()
        openProjectSettings(app)
        XCTAssertTrue(copies.label.contains("Copies: 2"), "the companion saved the default")
        XCTAssertTrue(quality.label.contains("Fine") || (quality.value as? String)?.contains("Fine") == true)
        app.buttons["project-settings-done"].tap()
        app.buttons["print"].tap()
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.segmentedControls.buttons["Fine"].isSelected, "Print consumes the saved default")
        XCTAssertTrue(app.steppers["copies"].label.contains("2"), "Print consumes the saved copy count")
    }

    func testProjectSettingsDuplicateOpensAnIndependentReadyProject() {
        let app = launch("ready")
        openProjectSettings(app)
        XCTAssertTrue(reach(app, app.buttons["Export Current model (STL)"]), "the model is available for export")
        let duplicate = app.buttons["project-settings-duplicate"]
        XCTAssertTrue(reach(app, duplicate))
        duplicate.tap()
        let title = app.buttons["project-title"]
        let copied = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Mic mount copy"), object: title)
        XCTAssertEqual(XCTWaiter().wait(for: [copied], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["print"].exists, "the copy is ready without a new design pass")
    }

    private func openProjectSettings(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["More"].waitForExistence(timeout: 20))
        app.buttons["More"].tap()
        let settings = app.buttons["Project Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.textFields["project-settings-name"].waitForExistence(timeout: 10))
    }

    func testAWorkingProjectSaysSo() {
        let app = launch("working")
        XCTAssertTrue(app.buttons["project-title"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons["project-title"].label, "Crochet potato")
        XCTAssertTrue(app.staticTexts["Your Mac is working on it"].exists)
        XCTAssertFalse(app.buttons["print"].exists, "nothing to print while the Mac works")
    }

    func testAFailedProjectExplainsAndOffersTryAgain() {
        let app = launch("failed")
        XCTAssertTrue(app.staticTexts["Couldn't finish"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Try Again"].exists)
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

    func testFinishedPrintRetiresControlsAndFutureNotificationPromise() {
        let app = launch("print-finished")
        XCTAssertTrue(app.staticTexts["The print finished"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["Pause"].exists)
        XCTAssertFalse(app.buttons["Resume"].exists)
        XCTAssertFalse(app.buttons["Stop"].exists)
        XCTAssertFalse(app.staticTexts["You'll get a notification when it's done, or if the printer stops."].exists)
        XCTAssertFalse(app.staticTexts["Getting a photo from P1S…"].exists)
    }

    func testPhoneOffersAPauseWithinTheSlicedLayers() {
        let app = launch("print-one")
        let add = app.buttons["add-pause"]
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 20))
        for _ in 0..<3 { app.swipeUp() }
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        XCTAssertTrue(add.isEnabled)
        add.tap()
        XCTAssertTrue(app.steppers["pause-0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Before layer", "212")).firstMatch.exists)
        XCTAssertTrue(app.buttons["print-now"].isEnabled)
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
        // The note is on the page now (F8); only Pause and Stop ride in the bar, and nothing scrolls under them.
        let bed = app.staticTexts["Bed"]
        assertLastControlClearsTheBar(app, last: bed, bar: app.buttons["Pause"], "printing")
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
        // Per-event switches for this iPhone aren't ready yet (F9): one sentence and the way to the
        // app's iOS notification settings at the top, never a list of disabled switches.
        XCTAssertTrue(app.buttons["open-notification-settings"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Counterpart sends every alert to this iPhone; turn them off in iOS Settings → Notifications."].exists)
        XCTAssertFalse(app.switches["Print started (Live Activity)"].exists, "no disabled iPhone switch list")
        // The Mac's own alert is a separate, working setting below.
        XCTAssertTrue(reach(app, app.switches["Ready to print"].firstMatch))
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


/// Every layout reaches the same things (PRD §6.1, "Every layout"). The mobile gate runs this class on an iPhone
/// and again on an iPad, so a feature that lands on one width and not the other fails here. David, Nov 5:
/// "where did the 'start with these things' thing go, to print the 3d scan rig and the calipers?"
final class LayoutParityUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        // The iPad's sidebar is always on screen in landscape, as on David's iPad.
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
    }

    private var regular: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func launch(set: String = "all", largeText: Bool = false, screen: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", set]
        // Larger text makes any list longer than the screen, as David's ten projects are.
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"] }
        if let screen { app.launchArguments += ["-CounterpartScreen", screen] }
        app.launch()
        return app
    }

    func testLimitStopNamesItsLimitOnHomeAndTheProject() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/capped-projects.json"))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let selected = rows.filter { ($0["name"] as? String) == "limit-inactivity" }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "limit-stops"]
        app.launchEnvironment["COUNTERPART_LIMIT_FIXTURES"] = String(data: try JSONSerialization.data(withJSONObject: selected), encoding: .utf8)
        app.launch()
        let words = NSPredicate(format: "label CONTAINS %@", "Stopped after 10 minutes without worker activity")
        let listed = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "limit-inactivity")).firstMatch
        XCTAssertTrue(listed.waitForExistence(timeout: 20))
        listed.tap()
        XCTAssertTrue(app.buttons["Try Again"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(words).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["cancelled"].exists)
    }

    /// David, Nov 9: New showed two scan tiles ("On a scan rig", "Scan it") that ran the same capture. One Scan it tile,
    /// with Kass 3D's rig link underneath it, on the iPhone and the iPad.
    func testNewOffersOneScanWithTheRigLink() throws {
        let app = launch()
        let new = app.buttons["new-project"]
        XCTAssertTrue(new.waitForExistence(timeout: 20))
        new.tap()
        XCTAssertTrue(app.buttons["scan-object"].waitForExistence(timeout: 10), "one Scan it tile")
        XCTAssertEqual(app.buttons.matching(identifier: "scan-object").count, 1)
        XCTAssertFalse(app.staticTexts["On a scan rig"].exists, "no second scan mode")
        XCTAssertTrue(app.buttons["scan-rig-link"].exists, "Kass 3D's rig is still linked")
    }

    /// David, Nov 9: "I SCANNED A PINK UNICORN TOO BUT THE APP IS TOO GLITCHY I DON'T EVEN KNOW WHERE IT IS". A scan
    /// stopped after it kept photos says so on Home and on its project, with Send to your Mac and Scan again.
    func testAStoppedScanThatKeptPhotosShowsOnHomeAndItsProject() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all"]
        app.launchEnvironment["COUNTERPART_STOPPED_SCAN"] = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a0b:9"
        app.launch()
        // Home's card (iPhone) or the sidebar row (iPad) carries the words.
        let words = NSPredicate(format: "label CONTAINS %@", "Scan stopped · 9 photos kept")
        let listed = app.descendants(matching: .any).matching(words).firstMatch
        XCTAssertTrue(listed.waitForExistence(timeout: 20), "the project list says which project holds the stopped scan")
        listed.tap()
        XCTAssertTrue(app.descendants(matching: .any)["stopped-scan"].waitForExistence(timeout: 10), "its project says so too")
        XCTAssertTrue(app.buttons["stopped-scan.send"].exists, "Send to your Mac")
    }

    /// A finished scan that never left this phone is invisible to the Mac's copy of its project, so its
    /// page must still offer Send instead of only Scan again (David, Nov 9).
    func testAFinishedScanStillOnThisPhoneOffersSendOnItsProject() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all"]
        app.launchEnvironment["COUNTERPART_READY_SCAN"] = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a0b"
        app.launch()
        let words = NSPredicate(format: "label CONTAINS %@", "Scan saved · send to your Mac")
        let listed = app.descendants(matching: .any).matching(words).firstMatch
        XCTAssertTrue(listed.waitForExistence(timeout: 20), "the project list says the scan is still on this phone")
        listed.tap()
        let send = app.buttons["draft.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "its project offers Send to your Mac")
        XCTAssertTrue(send.isEnabled)
    }

    /// Nov 8 walkthrough F6: "Your Mac isn't answering… then try again" carries Try Again and the way to another Mac,
    /// on iPhone Home and in the iPad sidebar. Try Again brings the Mac's projects back.
    func testTheOfflineBannerOffersTryAgainAndADifferentMac() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let offline = folder.appendingPathComponent("offline")
        try Data().write(to: offline)
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all"]
        app.launch()
        let retry = app.buttons["connection-try-again"]
        XCTAssertTrue(retry.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(app.buttons["connection-different-mac"].label, "Connect a Different Mac")
        try FileManager.default.removeItem(at: offline)
        retry.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: retry)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 15), .completed, "the Mac answered, so the banner goes")
        let mic = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Mic mount")).firstMatch
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "with its projects")
    }

    /// XCTest has no hinge API. These fixture-only links set the window scene's horizontal size class (UIKit
    /// `traitOverrides`), as a fold or an iPad resize does, without relaunching; agent-device gives the Duo hinge proof.
    private func resize(_ app: XCUIApplication, to width: String) {
        app.open(URL(string: "scantomake://fixture-width/\(width)")!)
    }

    /// Skipped until they can be driven reliably (Nov 9): an iPhone simulator can't widen into a side-by-side split,
    /// and on the iPad XCTest's URL open lands the link where the open project isn't (the same link through
    /// `agent-device open` collapses and expands the split with the project kept). The fold itself was checked on
    /// the iPhone Duo simulator with `agent-device fold open|closed`: open project kept both ways, Back while folded
    /// returns Home, and unfolding then shows the start pane, not a stale project.
    private func launchResizable() throws -> XCUIApplication {
        try XCTSkipIf(true, "fixture resize isn't reliable under XCTest; the Duo hinge is checked with agent-device")
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartLayoutTesting", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        resize(app, to: "regular")
        return app
    }

    func testOpenProjectSurvivesCompactAndRegularResizesWithoutStaleSelection() throws {
        let app = try launchResizable()
        let project = app.descendants(matching: .any)["sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"]
        XCTAssertTrue(project.waitForExistence(timeout: 10), app.debugDescription)
        project.tap()
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10))
        resize(app, to: "compact")
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10), "fold keeps the project\n\(app.debugDescription)")
        // The split really collapsed: Home sits under the project, not beside it.
        XCTAssertFalse(app.buttons["new-project"].isHittable, "folded, the project covers Home")
        resize(app, to: "regular")
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10), "unfold keeps the project")
        resize(app, to: "compact")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 10))
        resize(app, to: "regular")
        XCTAssertTrue(app.buttons["starter-scan-platform"].waitForExistence(timeout: 10), "Back to Home clears the old selection")
        XCTAssertFalse(app.buttons["print"].exists)
    }

    func testProjectAndPrintSheetSurviveCompactAndRegularResizes() throws {
        let app = try launchResizable()
        let project = app.descendants(matching: .any)["sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"]
        XCTAssertTrue(project.waitForExistence(timeout: 10), app.debugDescription)
        project.tap()
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10))
        app.buttons["print"].tap()
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        resize(app, to: "compact")
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        resize(app, to: "regular")
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        resize(app, to: "compact")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10), "Cancel returns to the same project, not Home")
    }

    func testPrinterAttentionAndPrintingSummaryAtBothWidths() {
        let app = launch()
        XCTAssertTrue(app.buttons["Printers, 1 needs attention"].waitForExistence(timeout: 20))
        if regular {
            let status = app.staticTexts["projects-status"]
            XCTAssertTrue(status.label.contains("Mac mini connected"), status.label)
            XCTAssertTrue(status.label.contains("Bambu Lab P1S printing"), status.label)
            XCTAssertTrue(app.staticTexts["Needs you"].exists)
            XCTAssertFalse(app.staticTexts["Other"].exists, "the failed project belongs to Needs you")
        }
    }

    /// UX walkthrough Nov 8, F1: the Live Activity and print notifications land on Printing, and a finished print's
    /// Printing screen was a dead end (100%, old temperatures, nothing to do). Now it asks "Did it fit?" there, and
    /// Open Project goes to the project, on the iPhone stack and in the iPad's detail.
    func testAFinishedPrintAsksDidItFitOnPrintingAndOpensTheProject() {
        let app = launch(screen: "print-finished")
        let works = app.buttons["it-works"]
        XCTAssertTrue(works.waitForExistence(timeout: 20), "Did it fit? on the finished Printing screen")
        // On the iPad the project page under Printing has the same card, so wait for Printing's own Open Project.
        XCTAssertTrue(app.buttons["open-project"].waitForExistence(timeout: 10), "the finished Printing screen")
        XCTAssertTrue(app.staticTexts["Did it fit?"].exists)
        XCTAssertFalse(app.staticTexts["Nozzle"].exists, "a finished print's temperatures aren't shown as live")
        XCTAssertFalse(app.buttons["Stop"].exists)
        works.tap()
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: works)], timeout: 10) == .completed,
                      "answered on the Mac: the card goes")
        let open = app.buttons["open-project"]
        XCTAssertTrue(open.exists, "the way on stays")
        open.tap()
        XCTAssertTrue(app.buttons["Print Another"].waitForExistence(timeout: 10), "the project page, Done, and still printable")
        XCTAssertFalse(app.buttons["open-project"].exists, "Printing is gone from the stack")
    }

    /// Needs Changes on the finished Printing screen starts the change on the project page, as the project's own card does.
    func testNeedsChangesOnAFinishedPrintStartsTheChangeOnTheProject() {
        let app = launch(screen: "print-finished")
        let changes = app.buttons["needs-changes"]
        XCTAssertTrue(changes.waitForExistence(timeout: 20))
        changes.tap()
        let field = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertEqual(field.value as? String, "After printing: ")
        XCTAssertFalse(app.buttons["open-project"].exists)
    }

    /// David, Nov 6, on his six-plate rig: "i can't select which plate to print in the app i can see them but i can't click
    /// on them". Plate 1's start couldn't be confirmed; on the iPhone and the iPad every plate stays choosable on the
    /// project and inside Print, and only plate 1 asks for the printer check again.
    func testEveryPlateStaysChoosableAfterAnUnconfirmedStartOnTheProjectAndInPrint() throws {
        // The shared fixture the companion's own tests check (packages/contracts/fixtures/six-plate-unconfirmed.json).
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let rig = try String(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/six-plate-unconfirmed.json"), encoding: .utf8)
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "plates-unconfirmed",
                               "-CounterpartScreen", "ready"]
        app.launchEnvironment["COUNTERPART_RIG_FIXTURE"] = rig
        app.launch()
        let second = app.buttons["select-plate-0-1"]
        XCTAssertTrue(second.waitForExistence(timeout: 20))
        XCTAssertTrue(second.isEnabled, "a plate stays a button you can press after an unconfirmed start")
        XCTAssertTrue(app.buttons["print-plate-0-0"].isEnabled)
        XCTAssertTrue(app.buttons["select-plate-0-0"].label.contains("Check print result"), "the doubt stays on Screws")
        second.tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "selected"), object: second)
        XCTAssertEqual(XCTWaiter().wait(for: [selected], timeout: 5), .completed)
        app.buttons["print"].tap()
        let picker = app.buttons["print-sheet-plate"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "Print names its plate and can change it")
        XCTAssertTrue(picker.isEnabled)
        XCTAssertTrue((picker.value as? String ?? picker.label).contains("Photography Platform"))
        let check = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "I checked")).firstMatch
        XCTAssertFalse(check.exists, "another plate prints without the check")
        picker.tap()
        app.buttons["Lifting Parts for Platform"].firstMatch.tap()
        let sixth = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", "Lifting Parts", "Lifting Parts"), object: picker)
        XCTAssertEqual(XCTWaiter().wait(for: [sixth], timeout: 5), .completed, "the sheet follows the plate chosen in it")
        picker.tap()
        app.buttons["Screws"].firstMatch.tap()
        XCTAssertTrue(check.waitForExistence(timeout: 5), "the plate that may have started asks for the printer check")
    }

    /// The project list: the iPad sidebar, or iPhone Home.
    private func projectList(_ app: XCUIApplication) -> XCUIElement {
        regular ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
    }

    private func reveal(_ element: XCUIElement, in list: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<12 where !(element.exists && element.isHittable) { list.swipeUp() }
        XCTAssertTrue(element.isHittable, "\(element) is reachable", file: file, line: line)
    }

    private func opensStarter(_ button: XCUIElement, _ app: XCUIApplication) {
        button.tap()
        XCTAssertTrue(app.buttons["starter-add"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["A steady orbit around your object"].exists, "the scan rig's own sheet")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["starter-add"].waitForNonExistence(timeout: 5))
    }

    /// David, Nov 6: "adding a printer is filling out a form that hsould be mostly autofilled by discovery". With projects
    /// present, Printers → Add Printer… lists what the MCPs found; a found P1S opens filled in, and only the access code is
    /// typed before Check and Add (the companion's printers.check and printers.add, as on the Mac).
    func testAddPrinterFillsAFoundPrinterAndAsksOnlyTheAccessCodeWithProjects() throws {
        let app = try openAddPrinter()
        let found = app.buttons["add-printer-found-ssdp:01P00A451601106"]
        XCTAssertTrue(found.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["add-printer-found-bonjour:octopi.local:80"].exists, "every printer the MCPs found is listed")
        found.tap()
        let host = app.textFields["add-printer-host"]
        XCTAssertTrue(host.waitForExistence(timeout: 5))
        XCTAssertEqual(host.value as? String, "192.168.1.42", "the address comes from discovery")
        XCTAssertEqual(app.textFields["add-printer-serial"].value as? String, "01P00A451601106", "so does the serial number")
        XCTAssertTrue(app.staticTexts["On the printer: Settings → Device"].exists || app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Settings → Device")).firstMatch.exists,
                      "the MCP's own hint")
        let add = app.buttons["add-printer-add"]
        XCTAssertFalse(add.isEnabled, "the access code is still needed")
        let secret = app.secureTextFields["add-printer-secret"]
        XCTAssertTrue(secret.exists)
        // Return puts the keyboard away, as a person would before checking.
        secret.tap(); secret.typeText("12345678\n")
        XCTAssertTrue(add.isEnabled)
        let check = app.buttons["add-printer-check"]
        // The sheet's own form (its rows are made as they scroll in): on the iPad the sidebar behind it is a list too.
        reveal(check, in: app.collectionViews["add-printer-form"])
        check.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Connected")).firstMatch.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertTrue(app.staticTexts["Added."].waitForExistence(timeout: 10), "the companion added it")
        app.buttons["add-printer-done"].tap()
        XCTAssertTrue(app.buttons["add-printer"].waitForExistence(timeout: 5), "back on Printers")
    }

    /// The MCP fetches the key for the person (`obtain`, "Approve in OctoPrint"): its button sits under the key, and the
    /// approved key fills the field, so Add needs nothing typed.
    func testAddPrinterApprovalFromTheMCPFillsTheKey() throws {
        let app = try openAddPrinter()
        let octo = app.buttons["add-printer-found-bonjour:octopi.local:80"]
        XCTAssertTrue(octo.waitForExistence(timeout: 10), app.debugDescription)
        octo.tap()
        let approve = app.buttons["add-printer-obtain"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        XCTAssertEqual(approve.label, "Approve in OctoPrint", "the MCP's words")
        let add = app.buttons["add-printer-add"]
        XCTAssertFalse(add.isEnabled)
        approve.tap()
        XCTAssertTrue(app.staticTexts["OctoPrint approved Counterpart."].waitForExistence(timeout: 10))
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: add)
        XCTAssertEqual(XCTWaiter().wait(for: [enabled], timeout: 5), .completed, "the approved key filled the field")
        add.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Added")).firstMatch.waitForExistence(timeout: 10))
    }

    private func openAddPrinter() throws -> XCUIApplication {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.copyItem(at: root.appendingPathComponent("packages/contracts/fixtures/printer-setup-phone.json"),
                                         to: folder.appendingPathComponent("printer-setup-phone.json"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all"]
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20), "with projects present")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printers")).firstMatch.tap()
        let add = app.buttons["add-printer"]
        XCTAssertTrue(add.waitForExistence(timeout: 10), app.debugDescription)
        reveal(add, in: app.collectionViews.containing(.button, identifier: "add-printer").firstMatch)
        add.tap()
        return app
    }

    func testPrinterCopiesAndExplicitMoveAreReachableWithProjects() throws { try checkCopyMove(completes: false) }

    func testCompletedPrinterMoveKeepsItsResultAfterItsButtonDisappears() throws { try checkCopyMove(completes: true) }

    func testPrinterMoveCompletionSurvivesDismissingPrinters() throws { try checkCopyMove(completes: true, reopen: true) }

    private func checkCopyMove(completes: Bool, reopen: Bool = false) throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let files = ["mcp-profile-copies.json", "mcp-update-waiting.json"] + (completes ? ["mcp-profile-copies-moved.json", "mcp-copy-update-events.json"] : [])
        for name in files {
            try FileManager.default.copyItem(at: root.appendingPathComponent("packages/contracts/fixtures/" + name), to: folder.appendingPathComponent(name))
        }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all"]
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printers")).firstMatch.tap()
        let move = app.buttons["mcp-move-mcp-0000000000000002"]
        XCTAssertTrue(move.waitForExistence(timeout: 5), app.debugDescription)
        let list = app.collectionViews.firstMatch
        reveal(move, in: list)
        XCTAssertTrue(app.staticTexts["Counterpart’s copy 1.2.45"].exists)
        XCTAssertTrue(app.staticTexts["Bambu Lab P1S uses your copy at /home/ada/mcp-3D-printer-server (1.2.25)."].exists)
        move.tap()
        if reopen {
            app.buttons["Done"].tap()
            XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 5))
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printers")).firstMatch.tap()
        }
        if completes {
            XCTAssertTrue(app.staticTexts["Bambu Lab P1S uses Counterpart’s copy (1.2.45)."].waitForExistence(timeout: 5))
            XCTAssertTrue(move.waitForNonExistence(timeout: 5), "the completed move is no longer offered")
            XCTAssertTrue(app.staticTexts["Updated to 1.2.45"].waitForExistence(timeout: 5), "completion remains under the original MCP ID")
        } else {
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "finishes its work on this printer")).firstMatch.waitForExistence(timeout: 5))
        }
    }

    func testStartersStayReachableWithProjects() {
        let app = launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        if regular {
            // Nothing selected: the detail offers the starters and the two jobs, never just "Choose a project".
            let card = app.buttons["starter-scan-platform"]
            XCTAssertTrue(card.waitForExistence(timeout: 10), "the iPad start pane lists the starters")
            opensStarter(card, app)
            // A project open: the sidebar still lists them.
            let project = projectList(app).descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Mic mount")).firstMatch
            XCTAssertTrue(project.waitForExistence(timeout: 5))
            project.tap()
            XCTAssertTrue(app.buttons["starter-scan-platform"].waitForNonExistence(timeout: 10), "the project replaced the start pane")
            let row = app.buttons["sidebar-starter-scan-platform"]
            reveal(row, in: projectList(app))
            XCTAssertTrue(app.buttons["sidebar-starter-long-vernier-caliper"].exists)
            opensStarter(row, app)
        } else {
            let card = app.buttons["starter-scan-platform"]
            reveal(card, in: projectList(app))
            XCTAssertTrue(app.buttons["starter-long-vernier-caliper"].exists)
            opensStarter(card, app)
        }
    }

    /// Nov 5, caliper card 1f1c5515: "It shouldn't have changed a single thing about the physical print". A designer's
    /// file opens its print sheet at Standard, saying it prints the designer's settings, on the iPhone and the iPad.
    func testADesignersFilePrintsWithItsOwnSettings() {
        let app = launch(set: "designer")
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        let project = projectList(app).descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Caliper card copy")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.tap()
        XCTAssertTrue(app.buttons["print"].waitForExistence(timeout: 10))
        app.buttons["print"].tap()
        let words = app.staticTexts["designer-settings"]
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10))
        for _ in 0..<6 where !(words.exists && words.isHittable) { app.swipeUp() }
        XCTAssertTrue(words.waitForExistence(timeout: 5), "the sheet says it prints the designer's settings")
        XCTAssertEqual(words.label, "Prints with the designer’s settings saved in this file.")
        XCTAssertTrue(app.segmentedControls.buttons["Standard"].firstMatch.isSelected, "never the saved Fine or Strong")
        XCTAssertFalse(app.segmentedControls.buttons["Strong"].isSelected)
        XCTAssertFalse(app.segmentedControls.buttons["Fine"].isSelected)
    }

    func testEmptyProjectsOfferStartersAndBothJobs() {
        let app = launch(set: "empty")
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["starter-scan-platform"].waitForExistence(timeout: 10))
        for job in ["Make something that fits", "Copy something"] {
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", job)).firstMatch.exists, job)
        }
    }

    /// iPad build 202611052142 (Nov 5): the round New button sat on top of a sidebar row. The list is longer than
    /// the screen (larger text), so some row always reaches the bottom edge, at rest and scrolled to the end.
    /// PRD §8.9, §6.1: the code design engine's row is in Settings with projects present, on the iPhone and the iPad,
    /// and Set Up asks the computer to set it up and shows its progress.
    func testTheCodeDesignEngineRowIsInSettingsAndSetUpShowsProgress() {
        let app = launch(screen: "settings")
        XCTAssertTrue(app.descendants(matching: .any)["mac-status"].waitForExistence(timeout: 20))
        let message = app.staticTexts["codeEngine.message"]
        for _ in 0..<12 where !(message.exists && message.isHittable) { app.swipeUp() }
        XCTAssertTrue(message.isHittable, "the code design engine row is reachable")
        XCTAssertEqual(message.label, "Not set up yet.")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Set Up downloads about 367 MB and uses about 1.6 GB")).firstMatch.exists, "what Set Up takes")
        let setUp = app.buttons["codeEngine.setUp"]
        XCTAssertTrue(setUp.exists)
        setUp.tap()
        XCTAssertTrue(app.staticTexts["Setting up… 0 s so far."].waitForExistence(timeout: 10))
    }

    func testNewNeverCoversARow() {
        let app = launch(largeText: true)
        let new = app.buttons["new-project"]
        XCTAssertTrue(new.waitForExistence(timeout: 20))
        let list = projectList(app)
        if regular {
            // The sidebar list ends where New's bar begins, so no row can be under it.
            XCTAssertLessThanOrEqual(list.frame.maxY, new.frame.minY + 1, "New \(new.frame) over the list \(list.frame)")
            for _ in 0..<12 { list.swipeUp() }
            XCTAssertLessThanOrEqual(list.frame.maxY, new.frame.minY + 1)
            XCTAssertTrue(new.isHittable)
        } else {
            // iPhone Home's New floats over the scroll view (PRD §5.1); the end of Home scrolls clear of it.
            for _ in 0..<12 { list.swipeUp() }
            let last = app.buttons["starter-scan-platform"]
            XCTAssertTrue(last.exists)
            XCTAssertFalse(last.frame.intersects(new.frame), "New \(new.frame) covers the last card \(last.frame)")
        }
    }

    /// David's Nov 9 bottle project (Mac 30a2a33c), with generated pictures in place of his photos. A 4:3 picture, so a
    /// square crop would show here as a wrong aspect ratio, and 130 scan frames, each logged when the canned Mac serves it.
    private func launchBottle(noPhoto: Bool = false, askFileMissing: Bool = false) throws -> (XCUIApplication, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("bottle-capture"), withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        func picture(_ size: CGSize, _ colour: UIColor) -> Data {
            UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).jpegData(withCompressionQuality: 0.7) { context in
                colour.setFill(); context.fill(CGRect(origin: .zero, size: size))
                UIColor.white.setFill(); context.fill(CGRect(x: size.width * 0.45, y: size.height * 0.32, width: size.width * 0.22, height: size.height * 0.3))
            }
        }
        if !askFileMissing { try picture(CGSize(width: 2048, height: 1536), .brown).write(to: folder.appendingPathComponent("ask-bottle.jpg")) }
        let frame = picture(CGSize(width: 240, height: 320), .darkGray)
        for i in 1...130 { try frame.write(to: folder.appendingPathComponent(String(format: "bottle-capture/%04d.heic", i))) }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "ask-bottle", "-CounterpartScreen", "ask"]
        if noPhoto { app.launchEnvironment["COUNTERPART_ASK_NO_PHOTO"] = "1" }
        app.launch()
        return (app, folder)
    }

    /// Scan frames the canned Mac has served so far, each counted once.
    private func servedFrames(_ folder: URL) -> Set<String> {
        let log = (try? String(contentsOf: folder.appendingPathComponent("served.log"), encoding: .utf8)) ?? ""
        return Set(log.split(separator: "\n").compactMap { $0.split(separator: " ").first.map(String.init) }.filter { $0.contains("/capture/") })
    }

    /// David, Nov 9, on his iPad: "the area it's highlighting is almost impossible to see, and this is on ipad, can't
    /// imagine on iphone". The question's picture spans the card at its own aspect ratio with a caption that is true for any
    /// question, and opens full screen, where it pinches to zoom.
    func testTheQuestionsPictureIsLargeTrueToEveryQuestionAndZoomsFullScreen() throws {
        let (app, _) = try launchBottle()
        let picture = app.descendants(matching: .any)["ask-picture"]
        XCTAssertTrue(picture.waitForExistence(timeout: 20), app.debugDescription)
        for _ in 0..<8 where !(picture.isHittable && picture.frame.maxY < app.windows.firstMatch.frame.maxY - 80) { app.swipeUp() }
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: picture)], timeout: 15) == .completed,
                      "the picture arrives")
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(picture.frame.width, regular ? 400 : window.width * 0.8, "never a thumbnail: \(picture.frame)")
        XCTAssertEqual(picture.frame.height / picture.frame.width, 0.75, accuracy: 0.05, "the whole 4:3 photo, not a square crop")
        XCTAssertEqual(picture.label, "The outlined part is what this question is about.")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "can't see")).firstMatch.exists, "it never says what the Mac can't see")
        picture.tap()
        let full = app.descendants(matching: .any)["ask-picture-full"]
        XCTAssertTrue(full.waitForExistence(timeout: 10), "full screen")
        XCTAssertEqual(full.value as? String, "Zoom 100 percent")
        full.pinch(withScale: 3, velocity: 2)
        XCTAssertNotEqual(full.value as? String, "Zoom 100 percent", "pinch zooms in")
        app.buttons["ask-picture-done"].tap()
        XCTAssertTrue(full.waitForNonExistence(timeout: 5))
    }

    /// Review F2 on #456: a question picture that can't be fetched (the Mac asleep, the file gone) draws nothing, not an
    /// empty box captioned "The outlined part is what this question is about."; the question and its answers stay.
    func testAQuestionPictureThatFailsToLoadDrawsNothing() throws {
        let (app, _) = try launchBottle(askFileMissing: true)
        let camera = app.buttons["Camera"]
        XCTAssertTrue(camera.waitForExistence(timeout: 20), "the question's answers are there")
        let picture = app.descendants(matching: .any)["ask-picture"]
        XCTAssertTrue(picture.waitForNonExistence(timeout: 10), "no box once the fetch has failed")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "The outlined part is what this question is about.")).firstMatch.exists)
    }

    /// A question that came without a picture shows the project's picture at the same size, and says so.
    func testAQuestionWithoutAPictureShowsTheProjectsPictureAndSaysSo() throws {
        let (app, _) = try launchBottle(noPhoto: true)
        let picture = app.descendants(matching: .any)["ask-picture"]
        XCTAssertTrue(picture.waitForExistence(timeout: 20))
        XCTAssertEqual(picture.label, "Your project’s picture. No picture came with this question.")
        for _ in 0..<8 where !picture.isHittable { app.swipeUp() }
        XCTAssertGreaterThanOrEqual(picture.frame.width, regular ? 300 : app.windows.firstMatch.frame.width * 0.6)
    }

    /// David, Nov 9: "highly unnecessary to show every single one of these (and thus load every single one of these)
    /// images". What you sent shows the scan as one strip with its count and fetches five frames; the full set opens on its
    /// own and fetches only what scrolls into view.
    func testWhatYouSentShowsTheScanAsOneStripAndFetchesOnlyWhatIsOnScreen() throws {
        let (app, folder) = try launchBottle()
        let tab = app.buttons["What you sent"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        for _ in 0..<8 where !tab.isHittable { app.swipeUp() }
        tab.tap()
        // The request bubble's identifier covers the strip's, so it is found by what it says.
        let strip = app.buttons.matching(NSPredicate(format: "label == %@", "Your scan, 130 photos")).firstMatch
        for _ in 0..<8 where !(strip.exists && strip.isHittable) { app.swipeUp() }
        XCTAssertTrue(strip.waitForExistence(timeout: 10), app.debugDescription)
        Thread.sleep(forTimeInterval: 3)
        let shown = servedFrames(folder)
        XCTAssertLessThanOrEqual(shown.count, 5, "only the strip's frames: \(shown.sorted())")
        strip.tap()
        let gallery = app.descendants(matching: .any)["scan-gallery"]
        XCTAssertTrue(gallery.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 3)
        let opened = servedFrames(folder).count
        XCTAssertGreaterThan(opened, shown.count, "the full set shows its frames")
        XCTAssertLessThan(opened, 90, "but only those on screen, not all 130 (\(opened))")
        app.buttons["Done"].tap()
    }

}
