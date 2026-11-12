import XCTest
import UIKit
import ModelIO

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
        // The main action keeps its whole label beside the ask field ("Print Ano…", lead review Nov 10): the field gives way.
        let another = app.buttons["Print Another"], ask = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertGreaterThanOrEqual(another.frame.width, 150, "Print Another is not cut off")
        if ask.exists { XCTAssertLessThanOrEqual(ask.frame.maxX, another.frame.minX + 1, "the field never runs under the button") }
        XCTAssertLessThanOrEqual(another.frame.maxX, app.windows.firstMatch.frame.maxX, "the button is on screen")
        // And the narrowed field's placeholder fits whole: a shorter phrase beside Print Another on the phone, never "Ask for cha…".
        if UIDevice.current.userInterfaceIdiom == .phone, ask.exists {
            XCTAssertNotEqual(ask.placeholderValue, "Ask for changes…", "beside Print Another the phone's field takes the shorter placeholder")
        }
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
        // New keeps its words between openings; another test's typing must not fill this one (an empty draft, as launched).
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all",
                               "-CounterpartScreen", "new", "-CounterpartNewDraft", ""]
        app.launch()
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

    /// Scrolls the project page until `element` is on screen, dragging from the page's lower edge. `app.swipeUp()` drags
    /// through the app's middle, which on the iPad in landscape is the scan stage: the drag turns the model and the page
    /// stays put. The lower edge is below the stage and below the tab picker, so the drag never changes the tab either.
    private func scrollProjectPage(_ app: XCUIApplication, until element: XCUIElement) {
        let page = app.scrollViews.containing(NSPredicate(format: "label == %@", "Activity")).firstMatch
        for _ in 0..<6 where !element.isHittable {
            page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
                .press(forDuration: 0.05, thenDragTo: page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
        }
    }

    /// Design §3.3, David on his Leatherman "replica" (Nov 10): "if i don't see a fucking option here of what to do with
    /// this on the next build, that will confirm the root problem(s) are not solved". A copy whose scan is really the thing
    /// a case must fit: the page offers Make something else from this scan without scrolling, New opens holding that scan
    /// and asks first what it becomes, and Send lands on a new fit project made from the same scan. The source stays.
    func testMadeFromAnotherProjectShowsItsRequestUnderFromWithProjectsPresent() {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "inherited-history",
                               "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02", "-CounterpartSection", "inputs"]
        app.launch()
        let tab = app.buttons["What you sent"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        scrollProjectPage(app, until: tab)
        tab.tap()
        let from = app.buttons["From “Forester phone mount”"]
        scrollProjectPage(app, until: from)
        XCTAssertTrue(from.waitForExistence(timeout: 5))
        let request = app.staticTexts["A mount for my phone."]
        scrollProjectPage(app, until: request)
        XCTAssertTrue(request.exists, app.debugDescription)
        XCTAssertLessThan(from.frame.minY, request.frame.minY)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "What you sent — inherited history"; shot.lifetime = .keepAlways
        add(shot)
    }

    /// #616, David (Nov 11): "my airpods max hanger was printed and done and nothing changed that. and then i modified it
    /// and now it's no longer a thing that was done". With projects present, the changed-but-printed project's page shows
    /// its printed design under What you have; opening it puts that design on the stage with a bar back to the newest,
    /// and the main actions wait until the newest is shown again. A one-design project's page has no sections at all.
    func testAChangedButPrintedProjectStillShowsItsPrintedDesignWithProjectsPresent() {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "design-history",
                               "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02"]
        app.launch()
        let history = app.descendants(matching: .any).matching(identifier: "design-history").firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 20), app.debugDescription)
        let printed = app.buttons["design-10000000-0000-4000-8000-000000000001"]
        scrollProjectPage(app, until: printed)
        XCTAssertTrue(printed.isHittable, app.debugDescription)
        XCTAssertTrue(printed.label.contains("Printed Nov"), printed.label)
        XCTAssertTrue(printed.label.contains("It works"), printed.label)
        XCTAssertTrue(app.buttons["design-10000000-0000-4000-8000-000000000002"].exists, "the unprinted earlier design is listed too")
        XCTAssertFalse(app.buttons["design-10000000-0000-4000-8000-000000000003"].exists, "the newest is the page itself, not a row")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Design history — what you have"; shot.lifetime = .keepAlways; add(shot)
        printed.tap()
        let bar = app.descendants(matching: .any).matching(identifier: "viewing-earlier-design").firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["status-menu"].exists, "the project's status waits until the newest design is shown again")
        let viewing = XCTAttachment(screenshot: app.screenshot()); viewing.name = "Design history — the printed design on the stage"; viewing.lifetime = .keepAlways; add(viewing)
        let newest = app.buttons["Show the newest"]
        scrollProjectPage(app, until: newest)
        newest.tap()
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: bar)], timeout: 5) == .completed)

        let other = XCUIApplication()
        other.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "design-history",
                                 "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a03"]
        other.launch()
        let title = other.buttons["project-title"]
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Mic mount"), object: title)], timeout: 20) == .completed)
        XCTAssertFalse(other.descendants(matching: .any).matching(identifier: "design-history").firstMatch.exists, "one design: the page is today's page")
    }

    /// #769, David (Nov 12): "Already printed items no longer have explore in 3D or AR, some do actually but some don't".
    /// Shaped like his Pink snap-lid box: the newest design is a multi-part `current/model.3mf` (its merged `current/model.stl`
    /// beside it) and the printed earlier one is `versions/<id>/touched.stl`. Each, on the stage, offers Explore in 3D and an
    /// AR chip that becomes ready. (The #616 tests used `model.stl` names and no model file, so neither was ever drawn.)
    func testEveryPrintedDesignOffersExploreIn3DAndARWithProjectsPresent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Self.boxSTL().write(to: folder.appendingPathComponent("mic.stl"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "design-history",
                               "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a05"]
        app.launch()
        func offers3DAndAR(_ when: String) {
            XCTAssertTrue(app.buttons["Explore in 3D"].waitForExistence(timeout: 20), "\(when): Explore in 3D. \(app.debugDescription)")
            let ar = app.buttons["gallery-ar"]
            XCTAssertTrue(ar.waitForExistence(timeout: 10), "\(when): the AR chip")
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "ready"), object: ar)
            XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 20), .completed, "\(when): AR \(String(describing: ar.value))")
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "769 \(when)"; shot.lifetime = .keepAlways; add(shot)
        }
        offers3DAndAR("the newest, a multi-part 3MF")
        let printed = app.buttons["design-40000000-0000-4000-8000-000000000001"]
        scrollProjectPage(app, until: printed)
        printed.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "viewing-earlier-design").firstMatch.waitForExistence(timeout: 5))
        app.swipeDown(); app.swipeDown()
        offers3DAndAR("the printed earlier design, touched.stl")
    }

    /// Review of #770: the same multi-part design when the Mac lists no merged mesh beside its 3MF (none was written, or an
    /// older Mac that doesn't say) is its picture alone, as before #769: no Explore in 3D, no AR chip, no line or Try Again
    /// for a model that can't come.
    func testAMultiPartDesignWithNoMergedMeshShowsOnlyItsPictureWithProjectsPresent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Self.boxSTL().write(to: folder.appendingPathComponent("mic.stl"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "design-history",
                               "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a06"]
        app.launch()
        let title = app.buttons["project-title"]
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Caliper card logo"), object: title)], timeout: 20) == .completed)
        XCTAssertTrue(app.images["gallery-stage-picture"].waitForExistence(timeout: 10), "its picture on the stage: \(app.debugDescription)")
        // Long enough for a model fetch to have started, refused and said so, had one been asked for.
        RunLoop.current.run(until: Date().addingTimeInterval(4))
        XCTAssertFalse(app.buttons["Explore in 3D"].exists, "no 3D to turn")
        XCTAssertFalse(app.buttons["gallery-ar"].exists, "no AR from a picture")
        XCTAssertFalse(app.descendants(matching: .any)["gallery-model-unavailable"].exists, "no line for a model that can't come")
        XCTAssertFalse(app.buttons["gallery-model-retry"].exists, "no Try Again that can't succeed")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "770 multi-part, no merged mesh"; shot.lifetime = .keepAlways; add(shot)
    }

    /// #616 follow-up: the page's cards and Status act on the newest design, so with an earlier design on the stage they
    /// wait for Show the newest, as the Mac's and Android's do. Did it fit? here would answer for the newest print.
    func testAnEarlierDesignOnTheStageLeavesTheNewestsCardsAndStatusAloneWithProjectsPresent() {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "design-history",
                               "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04"]
        app.launch()
        let works = app.buttons["it-works"], changes = app.buttons["needs-changes"]
        XCTAssertTrue(works.waitForExistence(timeout: 20), "the newest design's print asks Did it fit?")
        XCTAssertTrue(works.isEnabled)
        let earlier = app.buttons["design-30000000-0000-4000-8000-000000000001"]
        scrollProjectPage(app, until: earlier)
        earlier.tap()
        let bar = app.descendants(matching: .any).matching(identifier: "viewing-earlier-design").firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertFalse(works.exists && works.isEnabled, "It works would answer for the newest design, not the one shown")
        XCTAssertFalse(changes.exists && changes.isEnabled, "Needs changes would answer for the newest design, not the one shown")
        app.buttons["More"].tap()
        let status = app.buttons["Status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertFalse(status.isEnabled, "the project's status waits until the newest design is shown again")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "Earlier design — the newest's status waits"; shot.lifetime = .keepAlways; add(shot)
        // Close the menu without choosing anything: a tap left of it, on the page's plain text. On an iPhone the top 8% is
        // the status bar, where a tap doesn't dismiss a menu (train 12c).
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.37)).tap()
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: status)], timeout: 5) == .completed)
        let newest = app.buttons["Show the newest"]
        scrollProjectPage(app, until: newest)
        newest.tap()
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: bar)], timeout: 5) == .completed)
        XCTAssertTrue(works.waitForExistence(timeout: 5))
        XCTAssertTrue(works.isEnabled, "the newest design on the stage: its card answers again")
    }

    func testACopysScanMakesAFitFromItsPageWithoutScanningAgainWithProjectsPresent() {
        let source = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "scan-stage",
                               "-CounterpartOpen", "counterpart://project/\(source)"]
        app.launch()
        let title = app.buttons["project-title"]
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Bottle copy"), object: title)], timeout: 20) == .completed)
        let action = app.buttons["make-from-scan"]
        XCTAssertTrue(action.waitForExistence(timeout: 10), "the action is on the page under What you scanned, not only in •••")
        XCTAssertEqual(action.label, "Make something else from this scan")
        XCTAssertTrue(action.isHittable, "on the screen as the page opens, without scrolling")
        action.tap()

        // New, already holding the scan: the question first, the scan named, nothing to scan or send from this phone.
        let question = app.staticTexts["scan-use-question"]
        XCTAssertTrue(question.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["scan-use-source"].label.hasPrefix("Bottle copy"), app.staticTexts["scan-use-source"].label)
        XCTAssertFalse(app.buttons["scan-object"].exists, "no rescan")
        XCTAssertFalse(app.buttons["scan-use-later"].exists, "the scan is already saved, on its project")
        XCTAssertFalse(app.buttons["send"].isEnabled, "it asks what the scan becomes before anything else")
        XCTAssertEqual(app.buttons["scan-use-fit"].label.components(separatedBy: ",").first, "Make something that fits this")
        app.buttons["scan-use-fit"].tap()
        // The kept scan is what the new part must fit: its exact size starts from the scan, not a lookup (review of #570).
        let sizeSource = app.segmentedControls["fit-dimension-source"]
        XCTAssertTrue(sizeSource.waitForExistence(timeout: 5))
        XCTAssertTrue(sizeSource.buttons["Use scan"].isSelected, "a fit from a kept scan starts on Use scan")
        XCTAssertFalse(sizeSource.buttons["Look up"].isSelected)
        let describe = app.descendants(matching: .any).matching(identifier: "describe").firstMatch
        XCTAssertTrue(describe.waitForExistence(timeout: 5))
        describe.tap()
        describe.typeText("A belt case for it")
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let send = app.buttons["send"]
        XCTAssertTrue(send.isEnabled)
        _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: send)], timeout: 5)
        sleep(1) // the bar settles where the keyboard was
        send.tap()
        let problem = app.staticTexts["new-problem"]
        XCTAssertFalse(problem.waitForExistence(timeout: 3), "Send failed: \(problem.exists ? problem.label : "")")

        // The new project opens: a fit, made from the same scan, saying where it came from.
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "A belt case for it"), object: title)], timeout: 15) == .completed,
                      "landed on the new project, not \(title.label)")
        let from = app.buttons["scan-from"]
        XCTAssertTrue(from.waitForExistence(timeout: 10))
        XCTAssertEqual(from.label, "Uses the scan from “Bottle copy”")
        XCTAssertTrue(app.images["gallery-stage-picture"].waitForExistence(timeout: 10), "What you scanned shows the scan, not an empty stage")
        XCTAssertTrue(app.buttons["make-from-scan"].exists, "the new project's scan can make something else too")

        // The source is still there and says what was made from its scan.
        if regular {
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Bottle copy")).firstMatch.exists,
                          "the source is still in the sidebar")
        }
        from.tap()
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Bottle copy"), object: title)], timeout: 10) == .completed)
        let made = app.buttons["scan-made"]
        XCTAssertTrue(made.waitForExistence(timeout: 10))
        XCTAssertEqual(made.label, "Also made from this scan: “A belt case for it”")
    }

    /// The same, from New (design §3.3): "Use a scan you already have" offers the scans the Mac keeps, by picture and name.
    func testNewOffersAScanYouAlreadyHaveWithProjectsPresent() {
        let app = launch(set: "scan-stage", screen: "new")
        let offered = app.buttons["existing-scan-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"]
        let sheet = app.scrollViews.firstMatch
        XCTAssertTrue(sheet.waitForExistence(timeout: 20))
        for _ in 0..<4 where !offered.isHittable { sheet.swipeUp() }
        XCTAssertTrue(offered.isHittable, "Use a scan you already have lists the Bottle copy's scan")
        XCTAssertTrue(app.staticTexts["Use a scan you already have"].exists)
        offered.tap()
        XCTAssertTrue(app.staticTexts["scan-use-question"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["scan-use-copy"].exists && app.buttons["scan-use-fit"].exists)
        XCTAssertFalse(app.buttons["scan-object"].exists)
        app.buttons["scan-use-fit"].tap()
        let sizeSource = app.segmentedControls["fit-dimension-source"]
        XCTAssertTrue(sizeSource.buttons["Use scan"].isSelected, "choosing an existing scan also defaults to its size")
        sizeSource.buttons["Look up"].tap()
        app.buttons["scan-use-remove"].tap()
        XCTAssertFalse(app.staticTexts["scan-use-question"].exists, "Remove goes back to New as it was")
        for _ in 0..<4 where !offered.isHittable { sheet.swipeUp() }
        offered.tap()
        app.buttons["scan-use-fit"].tap()
        XCTAssertTrue(sizeSource.buttons["Use scan"].isSelected, "another selection starts from that scan again")
    }

    /// PRD §5.4 One main action (board U17), the pair seen with real projects on Nov 10: a pass stopped on a project
    /// that already had a result, and the page showed Try Again, Print Again and a floating Print at once. Try Again
    /// leads; the earlier result prints from the card, once, under its true name; the bar keeps Ask for changes.
    func testAStoppedPassWithAnEarlierResultHasOneMainActionWithProjectsPresent() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/capped-projects.json"))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let selected = rows.filter { ($0["name"] as? String) == "limit-inactivity" }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "limit-stops"]
        app.launchEnvironment["COUNTERPART_LIMIT_FIXTURES"] = String(data: try JSONSerialization.data(withJSONObject: selected), encoding: .utf8)
        app.launch()
        let listed = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "limit-inactivity")).firstMatch
        XCTAssertTrue(listed.waitForExistence(timeout: 20))
        listed.tap()
        XCTAssertTrue(app.buttons["failed-retry"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["failed-print"].label, "Print the last version")
        XCTAssertTrue(app.staticTexts["failed-print-note"].exists)
        XCTAssertFalse(app.buttons["print"].exists, "no second Print in the bar")
        XCTAssertFalse(app.buttons["Print Again"].exists, "nothing says this version was printed")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label MATCHES %@", "Print( .*)?")).count, 1, "printing is offered once")
        XCTAssertTrue(app.descendants(matching: .any)["ask-for-changes"].exists, "the bar keeps Ask for changes")
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

    /// First look U5 (Nov 10, iPad): New after a scan opened already scrolled, its own tiles cut off under the header,
    /// and its orange button read "Choose what to make" with nothing chosen. It opens on the question with the three
    /// answers whole; the button is greyed out and says what to do, then names the chosen answer's action.
    func testNewAfterAScanOpensOnItsQuestionAndNamesTheChosenAction() {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all",
                               "-CounterpartScreen", "new", "-CounterpartNewScan", "walk-around", "-CounterpartNewDraft", ""]
        app.launch()
        let question = app.staticTexts["scan-use-question"]
        XCTAssertTrue(question.waitForExistence(timeout: 20), app.debugDescription)
        let send = app.buttons["send"], copy = app.buttons["scan-use-copy"], fit = app.buttons["scan-use-fit"], later = app.buttons["scan-use-later"]
        // The sheet's own scroll: swipes go to it (the screen's middle can be outside the sheet), and only its content is read
        // (Home stays in the accessibility tree behind the sheet).
        let sheet = app.scrollViews.containing(.staticText, identifier: "scan-use-question").firstMatch
        // The scan attaches after the sheet opens and the sheet then scrolls (animated): measure once it has settled. The
        // first run of this test measured before that scroll and passed while the screenshot showed the question under the header.
        Thread.sleep(forTimeInterval: 2)
        let bar = app.navigationBars["New Project"].frame
        XCTAssertGreaterThanOrEqual(question.frame.minY, bar.maxY - 1, "the question isn't under the header: \(question.frame) \(bar)")
        // The glass header's Close button is the header's real bottom: the question and the first answer sit below it.
        let close = app.navigationBars["New Project"].buttons.firstMatch.frame
        XCTAssertGreaterThanOrEqual(question.frame.minY, close.maxY, "the question is below the header's Close: \(question.frame) \(close)")
        XCTAssertGreaterThanOrEqual(copy.frame.minY, question.frame.maxY, "the first answer is whole, below its question")
        // The scan being decided about sits beside the question (lead, Nov 10), with all three answers on screen with it.
        let scan = app.descendants(matching: .any)["scan-use-scan"]
        XCTAssertTrue(scan.exists, "the scan is next to its question")
        XCTAssertGreaterThanOrEqual(scan.frame.minY, close.maxY, "the scan is below the header: \(scan.frame)")
        XCTAssertLessThanOrEqual(scan.frame.maxY, copy.frame.minY + 1, "the scan is above the answers")
        XCTAssertLessThanOrEqual(later.frame.maxY, send.frame.minY + 1, "all three answers fit with it, above the button")
        // The bottom action sits on a bar below the scroll (lead, Nov 10): checked below, and by eye on the screenshot.
        // Kept with the result, so a review can look at the settled sheet on each device (taken before the check below).
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "new-after-a-scan"; shot.lifetime = .keepAlways
        add(shot)
        // Review F7: scrolled to the end, where the most content sits against the bar, nothing of the scrolling content is
        // inside the button's frame at all (the scroll ends where the bar begins), then back to the top for the rest.
        func nothingInsideTheButton(_ state: String) {
            for _ in 0..<6 { sheet.swipeUp() }
            let own = Set(send.descendants(matching: .any).allElementsBoundByIndex.map { NSCoder.string(for: $0.frame) })
            let inside = (sheet.staticTexts.allElementsBoundByIndex + sheet.buttons.allElementsBoundByIndex + sheet.textFields.allElementsBoundByIndex).filter {
                $0.identifier != "send" && !own.contains(NSCoder.string(for: $0.frame)) && $0.frame.intersects(send.frame)
            }
            XCTAssertTrue(inside.isEmpty, "\(state): \(inside.map { "\($0.identifier) '\($0.label)' \($0.frame)" }) inside the button at \(send.frame)")
            // Back to the top, only as far as needed: a swipe down at the top would dismiss the sheet.
            for _ in 0..<8 where !(question.shown(in: sheet) && copy.shown(in: sheet)) { sheet.swipeDown(velocity: .slow) }
        }
        let describe = app.staticTexts["What do you need?"]
        XCTAssertTrue(!describe.exists || describe.frame.minY > question.frame.maxY, "the question comes first")
        for row in [copy, fit, later] {
            XCTAssertTrue(row.isHittable, "\(row.identifier) can be tapped without scrolling")
            XCTAssertLessThanOrEqual(row.frame.maxY, send.frame.minY + 1, "\(row.identifier) is clear of the button")
        }
        XCTAssertFalse(send.isEnabled, "nothing chosen: greyed out")
        nothingInsideTheButton("nothing chosen")
        XCTAssertEqual(send.label, "Choose what this scan becomes")
        copy.tap()
        XCTAssertTrue(send.isEnabled)
        XCTAssertEqual(send.label, "Copy this object")
        let chosen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        chosen.name = "new-after-a-scan-copy-chosen"; chosen.lifetime = .keepAlways
        add(chosen)
        nothingInsideTheButton("copy chosen")
        fit.tap()
        XCTAssertEqual(send.label, "Continue", "a fit asks for its words first")
        for _ in 0..<4 where !later.isHittable { sheet.swipeUp() }
        later.tap()
        XCTAssertEqual(send.label, "Save this scan")
    }

    /// Board X80, from #513's phone captures: the floating bar sat over the "Did it fit?" card's buttons until the page was
    /// scrolled. The stage takes the height the page has left, so both answers are whole, inside the page and above the
    /// bar, as it opens, on every iPhone (the gate's and the smallest) and on the iPad.
    func testDidItFitsAnswersAreWholeAboveTheBarWithoutScrolling() {
        let app = launch(screen: "printed")
        let works = app.buttons["it-works"], changes = app.buttons["needs-changes"]
        XCTAssertTrue(works.waitForExistence(timeout: 20), app.debugDescription)
        let ask = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "the bar's Ask for changes")
        let page = app.scrollViews.containing(NSPredicate(format: "label == %@", "Activity")).firstMatch
        // The stage settles once the page has measured itself: give it a moment, without scrolling.
        let settled = Date().addingTimeInterval(3)
        while Date() < settled, changes.frame.maxY > ask.frame.minY { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "did-it-fit-with-the-bar"; shot.lifetime = .keepAlways
        add(shot)
        for answer in [works, changes] {
            XCTAssertTrue(answer.isHittable, "\(answer.label) can be pressed: \(answer.frame)")
            XCTAssertLessThanOrEqual(answer.frame.maxY, ask.frame.minY, "\(answer.label) \(answer.frame) is above the bar \(ask.frame)")
            if page.exists {
                XCTAssertLessThanOrEqual(answer.frame.maxY, page.frame.maxY + 1, "\(answer.label) \(answer.frame) is whole in the page \(page.frame)")
            }
        }
    }

    /// Lead, Nov 10, on X80's short stage: with "Did it fit?" to answer the stage can be 160 to 210 points tall, and its
    /// Try Again sat under the size chip. The stage's words lay out above its chips (the symbol shrinks or goes first), so
    /// Try Again never touches the size chip or AR, while the picture can't be had and while it is coming; on every iPhone.
    func testTheShortStagesWordsAndTryAgainNeverSitUnderItsChips() {
        for (state, extra) in [("not available", [String]()), ("loading", ["-CounterpartSlowPictures", "60"])] {
            let app = XCUIApplication()
            app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all",
                                   "-CounterpartScreen", "printed"] + extra
            app.launch()
            XCTAssertTrue(app.buttons["it-works"].waitForExistence(timeout: 20), "the Did it fit? card is on the page")
            let picture = app.images["gallery-stage-picture"]
            XCTAssertTrue(picture.waitForExistence(timeout: 10))
            XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", state), object: picture)], timeout: 15), .completed,
                           "\(state): \(String(describing: picture.value))")
            RunLoop.current.run(until: Date().addingTimeInterval(2))  // the stage settles to the page's height
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "short-stage-\(state)"; shot.lifetime = .keepAlways; add(shot)
            let stage = picture.frame
            XCTAssertGreaterThanOrEqual(stage.height, 159, "the stage keeps its 160-point floor: \(stage)")
            let chips = [app.descendants(matching: .any)["gallery-size"], app.buttons["gallery-ar"]].filter(\.exists)
            XCTAssertFalse(chips.isEmpty, "the size chip is on the stage")
            for chip in chips {
                // The words lay out above the stage's controls band; the chips must sit inside that band.
                XCTAssertGreaterThanOrEqual(chip.frame.minY, stage.maxY - 58 - 1, "\(chip.identifier) \(chip.frame) is in the controls band of \(stage)")
            }
            if state == "not available" {
                // Board X100: the canned Mac has no picture here (its part model comes): one line for what failed, naming
                // the part, never "too detailed" or "scan", and one Try Again.
                XCTAssertTrue(["Your part. The picture didn’t come from your Mac.", "Your part. Your Mac didn’t send the picture or 3D model of this part."].contains(picture.label), picture.label)
                XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier IN %@", ["gallery-model-retry", "gallery-stage-retry"])).count, 1)
                XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "too detailed", "scan is")).firstMatch.exists)
                let retry = app.buttons["gallery-stage-retry"]
                XCTAssertTrue(retry.exists, "Try Again where trying again can help")
                XCTAssertTrue(retry.isHittable, "Try Again can be pressed: \(retry.frame)")
                for chip in chips {
                    XCTAssertFalse(retry.frame.intersects(chip.frame), "Try Again \(retry.frame) clear of \(chip.identifier) \(chip.frame)")
                    XCTAssertLessThanOrEqual(retry.frame.maxY, chip.frame.minY, "Try Again sits above \(chip.identifier)")
                }
            }
            app.terminate()
        }
    }

    /// Review of #527 part 4, B1: with the Mac away, nothing a person can tap fails after the tap, and nothing kept from
    /// before is shown as live: on the project page (each state's lead actions), Printing and Home. The canned Mac answers
    /// the list once and then stops (`away-after-list`, the screenshot tool's `away`).
    /// One test per project state: as one test it launched the app five times and ran past XCTest's 2-minute allowance on
    /// the iPad (131 s on train 11a's gate, the away line each time within a second of launch), so the time was the test's.
    func testWithTheMacAwayNothingFailsAfterATapOnAPrintedProject() throws { try checkTheMacAway("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a05") }
    func testWithTheMacAwayNothingFailsAfterATapOnAFailedProject() throws { try checkTheMacAway("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a07") }
    func testWithTheMacAwayNothingFailsAfterATapOnAWorkingProject() throws { try checkTheMacAway("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02") }
    func testWithTheMacAwayNothingFailsAfterATapOnAProjectWithAQuestion() throws { try checkTheMacAway("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04") }
    func testWithTheMacAwayNothingFailsAfterATapOnAPrintingProjectPrintingAndHome() throws { try checkTheMacAway("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a03") }

    private func checkTheMacAway(_ id: String) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        try Data().write(to: folder.appendingPathComponent("away-after-list"))
        func open(_ id: String) -> XCUIApplication {
            let app = XCUIApplication()
            app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all", "-CounterpartOpen", "counterpart://project/\(id)"]
            app.launch()
            return app
        }
        // A tap that failed shows the page's own failure line (its identifier), not words: the failed pass's own text says
        // "then try again" too. Print is checked by its identifier below; its label would also match "Printers".
        let macActions = ["Make something else from this scan", "It Works", "Needs Changes", "Send to your Mac", "Scan", "Make Your Best Guess", "Send Answer", "Review", "Don’t Print"]
        func checkNothingFails(_ app: XCUIApplication, _ page: String) {
            XCTAssertEqual(app.alerts.count, 0, "\(page): no error alert")
            for line in ["project-problem", "printing-problem"] {
                let failure = app.descendants(matching: .any)[line]
                XCTAssertFalse(failure.exists, "\(page): no failure line after a tap: \(failure.exists ? failure.label : "")")
            }
        }
        do {
            let app = open(id)
            let away = app.descendants(matching: .any)["project-away"]
            XCTAssertTrue(away.waitForExistence(timeout: 20), "\(id): the one line: \(app.debugDescription)")
            let awayLine = away.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Your Mac isn’t answering, so anything that needs it waits.")).firstMatch
            XCTAssertTrue(awayLine.exists, "\(id): the away line says why: \(away.debugDescription)")
            let make = app.buttons["make-from-scan"]
            if make.exists {
                XCTAssertFalse(make.isEnabled, "making from the scan waits for the Mac")
                XCTAssertTrue(app.staticTexts["make-from-scan-away"].exists, "the disabled scan action explains why it waits")
            }
            // Ask for the Mac's actions only, instead of reading every button's label one query at a time.
            let macAction = NSCompoundPredicate(orPredicateWithSubpredicates: macActions.map { NSPredicate(format: "label BEGINSWITH %@", $0) })
            for button in app.buttons.matching(macAction).allElementsBoundByIndex where button.exists {
                XCTAssertFalse(button.isEnabled, "\(id): \(button.label) waits for the Mac")
                button.tap()
                checkNothingFails(app, "\(id) after \(button.label)")
                XCTAssertTrue(away.exists)
            }
            for lead in ["it-works", "needs-changes", "failed-retry", "failed-print", "print", "draft.send", "attach-photos", "status-menu", "project-title"] {
                let button = app.buttons[lead]
                guard button.exists else { continue }
                XCTAssertFalse(button.isEnabled, "\(id): \(lead) waits for the Mac")
                button.tap()
                checkNothingFails(app, "\(id) after \(lead)")
            }
            if id.hasSuffix("03") {
                // Printing, from the restored project: the same line, its numbers "as of", and Pause and Stop waiting.
                let watch = app.buttons.matching(NSPredicate(format: "label == %@", "Watch the Print")).firstMatch
                XCTAssertTrue(watch.waitForExistence(timeout: 5) && watch.isEnabled, "Printing still opens")
                watch.tap()
                XCTAssertTrue(app.descendants(matching: .any)["printing-away"].waitForExistence(timeout: 10), app.debugDescription)
                for label in ["Pause", "Resume", "Stop"] {
                    let control = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
                    guard control.exists else { continue }
                    XCTAssertFalse(control.isEnabled, "\(label) is not offered as if it would work")
                    control.tap()
                }
                XCTAssertFalse(app.buttons["Stop Print"].exists, "no Stop confirmation for a printer that can't be reached")
                checkNothingFails(app, "Printing")
                let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "away-printing"; shot.lifetime = .keepAlways; add(shot)
                // Home: once, plainly, that the Mac isn't answering and when the list is from.
                for _ in 0..<3 where !app.descendants(matching: .any)["connection-line"].exists {
                    let back = app.navigationBars.buttons.firstMatch
                    if back.exists { back.tap() } else { break }
                }
                let line = app.descendants(matching: .any)["connection-line"]
                XCTAssertTrue(line.waitForExistence(timeout: 10), app.debugDescription)
                XCTAssertTrue(line.label.hasPrefix("Your Mac isn’t answering") && line.label.contains("This is what your phone had at"), line.label)
                app.buttons["connection-try-again"].tap()
                checkNothingFails(app, "Home after Try Again")
                let home = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); home.name = "away-home"; home.lifetime = .keepAlways; add(home)
            }
            app.terminate()
        }
    }

    /// Review of #527 part 4, S5: at the largest text sizes even the shortest stage leaves "Did it fit?" under the bar, so
    /// the page opens scrolled to it: both answers whole above the bar, without the person scrolling.
    func testAtLargeTextThePageOpensScrolledToDidItFit() {
        let app = launch(largeText: true, screen: "printed")
        let works = app.buttons["it-works"], changes = app.buttons["needs-changes"]
        XCTAssertTrue(works.waitForExistence(timeout: 20), app.debugDescription)
        let ask = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        let settled = Date().addingTimeInterval(4)
        while Date() < settled, changes.frame.maxY > ask.frame.minY || !changes.isHittable { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "did-it-fit-large-text"; shot.lifetime = .keepAlways; add(shot)
        for answer in [works, changes] {
            XCTAssertTrue(answer.isHittable, "\(answer.label) can be pressed: \(answer.frame)")
            XCTAssertLessThanOrEqual(answer.frame.maxY, ask.frame.minY + 1, "\(answer.label) \(answer.frame) is above the bar \(ask.frame)")
        }
    }

    /// Review S5: how real pictures read on the short stage, for choosing `ProjectView.recognisable`. Runs only with
    /// `TEST_RUNNER_STM_REAL_PICTURES=<folder of the Mac's own part pictures>`; the gate has none and skips it.
    func testRealPicturesOnTheShortStage() throws {
        guard let source = ProcessInfo.processInfo.environment["STM_REAL_PICTURES"] else { throw XCTSkip("no real pictures given") }
        let pictures = try FileManager.default.contentsOfDirectory(atPath: source).filter { $0.hasSuffix(".png") }.sorted()
        for name in pictures {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            try FileManager.default.copyItem(atPath: source + "/" + name, toPath: folder.appendingPathComponent("thumb-potato.png").path)
            for height in [160, 200, 240, 280] {
                let app = XCUIApplication()
                app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all", "-CounterpartScreen", "printed",
                                       "-CounterpartStageHeight", "\(height)"]
                app.launch()
                XCTAssertTrue(app.buttons["it-works"].waitForExistence(timeout: 20))
                let picture = app.images["gallery-stage-picture"]
                _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "shown"), object: picture)], timeout: 10)
                RunLoop.current.run(until: Date().addingTimeInterval(1))
                let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                shot.name = "real-\(name.replacingOccurrences(of: ".png", with: ""))-\(height)"; shot.lifetime = .keepAlways; add(shot)
                app.terminate()
            }
        }
    }

    /// First look U9 (Nov 10, iPad): a ready scan's Result showed two "—" cards for print time and filament and a third
    /// that said only "Bambu printer". Before slicing, one row names the printer and says when the numbers come.
    /// Review F7: what this proves is the app's half: the row shows the name the printer list gives (the fixture Mac's
    /// "P1S"), and no time or filament tile exists before slicing. How that name is made is the companion's, tested in
    /// `printer-directory.test.mjs` (the MCP's display name, exactly; "Your printer" when it can't be asked, never an address).
    func testAResultBeforeSlicingShowsTheListedPrinterNameAndNoTimeOrFilamentTiles() {
        let app = launch(screen: "printed")
        let row = app.descendants(matching: .any)["result-printer"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription)
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.label.hasPrefix("P1S"), "the listed name, as given: \(row.label)")
        XCTAssertTrue(row.label.contains("once it’s sliced for printing"), row.label)
        XCTAssertFalse(app.staticTexts["Print time"].exists, "no time tile")
        XCTAssertFalse(app.staticTexts["Filament"].exists, "no filament tile")
    }

    /// First look U14 (Nov 10, iPhone): Welcome's second starter was cut off at the margin. Both starters show whole,
    /// side by side, inside the margins, on the iPhone and the iPad.
    func testWelcomeShowsBothStartersWhole() {
        let app = launch(screen: "welcome")
        let first = app.buttons["starter-scan-platform"], second = app.buttons["starter-long-vernier-caliper"]
        XCTAssertTrue(first.waitForExistence(timeout: 20))
        let window = app.windows.firstMatch.frame
        XCTAssertEqual(first.frame.minY, second.frame.minY, accuracy: 2, "one row")
        XCTAssertGreaterThanOrEqual(first.frame.minX, window.minX + 15, "\(first.frame)")
        XCTAssertLessThanOrEqual(second.frame.maxX, window.maxX - 15, "the second starter is whole: \(second.frame) in \(window)")
        let continueButton = app.buttons["welcome-continue"]
        XCTAssertTrue(continueButton.isHittable)
        // Review F8: the scroll ends where Continue's bar begins, so no card is sliced behind it.
        let scroll = app.scrollViews.allElementsBoundByIndex.max { $0.frame.height < $1.frame.height }!
        XCTAssertLessThanOrEqual(scroll.frame.maxY, continueButton.frame.minY, "the scroll \(scroll.frame) ends above Continue \(continueButton.frame)")
    }

    /// First look U10 (Nov 10, iPad): "holder" listed projects with no hint why. A result whose title lacks the word says
    /// where it matched, on iPhone Home and in the iPad sidebar.
    /// The train's iPad gate, Nov 10: New Project steps aside while a search is typed (it covered the results above the
    /// keyboard). ⌘N comes from a hidden button then; it must still open New with the search field focused.
    func testCommandNOpensNewWhileTheSearchFieldHasFocusOnTheIPad() throws {
        guard regular else { throw XCTSkip("the iPad sidebar's New Project bar; iPhone Home's New floats and stays") }
        let app = launch()
        let field = app.textFields["project-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("clip")
        XCTAssertTrue(app.buttons["new-project"].waitForNonExistence(timeout: 5), "New Project steps aside while searching")
        app.typeKey("n", modifierFlags: .command)
        XCTAssertTrue(app.navigationBars["New Project"].waitForExistence(timeout: 10), "⌘N opens New with the search field focused")
    }

    func testASearchResultSaysWhereItMatched() {
        let app = launch()
        let field = app.textFields["project-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("bigger")
        // Review F7: the reason itself, by its identifier, and its emphasis as VoiceOver hears it.
        let reason = app.descendants(matching: .any).matching(identifier: "search-reason").firstMatch
        XCTAssertTrue(reason.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(reason.label, "Found “bigger” in: Copy this clip, 20% bigger.")
        XCTAssertTrue(reason.isHittable, "the reason is on screen")
    }

    /// Lead, Nov 10 (iPad, Stove gap filler, Activity): the page's red and grey lines read through and around "Ask for
    /// changes…" and Print. The page's content ends where its bottom bar begins, on every tab, scrolled to the end, and with
    /// the keyboard up; the bar keeps Print's whole label beside the field (the project-picture work's rule).
    func testTheProjectPagesContentEndsAtItsBottomBarOnEveryTab() {
        let app = launch(screen: "ready")
        let print = app.buttons["print"], ask = app.descendants(matching: .any)["ask-for-changes"]
        XCTAssertTrue(print.waitForExistence(timeout: 20), app.debugDescription)
        func nothingReachesTheBar(_ state: String) {
            // The bar is what's shown of the ask field and Print (Print gives way while typing).
            let bar = [print, ask].filter(\.exists).map(\.frame).reduce(CGRect.null) { $0.union($1) }
            // The bar must be there: with neither part on screen the check below would pass on nothing (review).
            XCTAssertTrue(ask.exists, "\(state): the bar's ask field is on screen")
            XCTAssertFalse(bar.isNull, "\(state): the bar is on screen")
            // The page's scroll ends where the bar begins, so nothing it draws (it clips) can sit under or around the bar.
            // Accessibility frames are unclipped, so the scroll view's own frame is what proves it; an overlay bar fails here.
            let page = app.scrollViews.containing(NSPredicate(format: "label == %@", "Activity")).firstMatch
            XCTAssertTrue(page.exists, "\(state): the page's scroll view")
            XCTAssertLessThanOrEqual(page.frame.maxY, bar.minY, "\(state): the page \(page.frame) ends above the bar \(bar)")
        }
        for tab in ["Result", "What you sent", "Activity"] {
            let button = app.buttons[tab]
            for _ in 0..<6 where !button.isHittable { app.swipeDown() }
            button.tap()
            for _ in 0..<8 { app.swipeUp() }
            nothingReachesTheBar("\(tab), scrolled to the end")
            if tab == "Activity" {
                let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                shot.name = "project-activity-end"; shot.lifetime = .keepAlways
                add(shot)
            }
        }
        ask.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "the keyboard is up")
        nothingReachesTheBar("keyboard up")
        let typing = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        typing.name = "project-keyboard-up"; typing.lifetime = .keepAlways
        add(typing)
    }

    /// Review F4: a fit with words and "I measured" but no measurement: Send takes you to the measurement fields, focuses the
    /// first, and says there what's missing, instead of seeming to do nothing. X86: on an iPad with a hardware keyboard the
    /// number pad floats beside the focused field, and it covered the line; the test sets that keyboard itself.
    func testSendOnAFitMissingItsMeasurementGoesToTheFields() {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "all",
                               "-CounterpartScreen", "new", "-CounterpartNewScan", "walk-around", "-CounterpartFreshDraft", "YES"]
        app.launch()
        let fit = app.buttons["scan-use-fit"]
        XCTAssertTrue(fit.waitForExistence(timeout: 20))
        // Swipes go to the sheet's own scroll, never past its top (a swipe down there would dismiss the sheet).
        let sheet = app.scrollViews.containing(.staticText, identifier: "scan-use-question").firstMatch
        fit.tap()
        let describe = app.descendants(matching: .any).matching(identifier: "describe").firstMatch
        for _ in 0..<4 where !describe.isHittable { sheet.swipeUp() }
        let fitShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        fitShot.name = "new-fit-chosen"; fitShot.lifetime = .keepAlways
        add(fitShot)
        describe.tap()
        // The keyboard this test means (X86), set here rather than left to whatever ran before: on the iPad, a hardware
        // keyboard, as on an iPad with its keyboard attached, where the number pad floats beside the focused field. A key
        // pressed on it puts the simulator in that mode (in the gate an earlier test's ⌘N did it, and this test passed alone
        // and failed there), so the iPad types the last letter on it. Not an arrow: with the simulator already in that mode
        // an arrow moves the iPad's keyboard focus and the app never settled. The iPhone keeps the on-screen keyboard: no
        // iPhone test presses a hardware key.
        if regular {
            describe.typeText("A wall holder for i")
            describe.typeKey("t", modifierFlags: [])
        } else {
            describe.typeText("A wall holder for it")
        }
        let keyboardShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        keyboardShot.name = "new-fit-keyboard-up"; keyboardShot.lifetime = .keepAlways
        add(keyboardShot)
        // Put the keyboard away first, or the next tap only dismisses it.
        app.navigationBars["New Project"].buttons["Done"].tap()
        let measured = app.buttons["I measured"]
        // Below the navigation bar, not just hittable: XCTest counts a control under the translucent bar as hittable, and
        // in the gate (Nov 11) both taps on I measured landed on the bar, with the picker scrolled up under it.
        let bar = app.navigationBars["New Project"]
        for _ in 0..<6 where !(measured.exists && measured.isHittable && measured.frame.minY >= bar.frame.maxY) { sheet.swipeDown(velocity: .slow) }
        measured.tap()
        let chosen = NSPredicate(format: "isSelected == true")
        if XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: chosen, object: measured)], timeout: 3) != .completed { measured.tap() }
        XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: chosen, object: measured)], timeout: 3) == .completed, "I measured is chosen")
        // Scroll back down so Send is pressed from where a person would be, below the fields.
        for _ in 0..<3 { sheet.swipeUp() }
        let send = app.buttons["send"]
        XCTAssertTrue(send.label.hasPrefix("Send to"), send.label)
        send.tap()
        let missing = app.staticTexts["fit-size-missing"]
        XCTAssertTrue(missing.waitForExistence(timeout: 5), "it says what's missing")
        XCTAssertEqual(missing.label, "Enter at least one measurement in millimetres.")
        // The field's identifier is on its column, which SwiftUI gives to the field itself; look in both places.
        let longest = app.textFields["fit-size-longest"].exists ? app.textFields["fit-size-longest"]
            : app.descendants(matching: .any)["fit-size-longest"].textFields.firstMatch
        XCTAssertTrue(longest.waitForExistence(timeout: 5))
        // Send's work ends with Longest focused and the keyboard up; the sheet shrinks and scrolls the fields into the room
        // left. The line is judged once that has happened, not while the sheet is still moving (the gate's slow iPad).
        let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: longest)
        XCTAssertEqual(XCTWaiter().wait(for: [focused], timeout: 5), .completed, "the first measurement is focused")
        // Where the number pad is. Docked: the keyboard. On the iPad with a hardware keyboard: the floating pad, found by
        // its keys, because `app.keyboards` then still reports the docked keyboard parked below the screen.
        // Each key exists twice then (the floating pad's and the parked keyboard's): take the one on screen.
        XCTAssertTrue(app.keys["1"].firstMatch.waitForExistence(timeout: 5), "the number pad is up")
        let screen = app.windows.firstMatch.frame
        let keys = ["1", "3", "0"].compactMap { name in
            app.keys.matching(identifier: name).allElementsBoundByIndex.first { screen.intersects($0.frame) }?.frame
        }
        XCTAssertEqual(keys.count, 3, "the pad's 1, 3 and 0 are on screen")
        let pad = regular ? keys.reduce(CGRect.null) { $0.union($1) } : app.keyboards.firstMatch.frame
        XCTAssertTrue(app.windows.firstMatch.frame.intersects(pad), "the pad \(pad) is on screen")
        let detail = "line \(missing.frame), field \(longest.frame), pad \(pad), sheet \(sheet.frame)"
        if regular {
            // Hit-testing can't judge the line here: with the floating pad up, the line reported not hittable while the
            // run's recording showed it whole and clear of the pad (iPad Air, Nov 10). The frames can: below the title bar, above its
            // bottom, and clear of the pad, which sits beside the field it belongs to, not where the field was before
            // the sheet moved (X86: focused first and scrolled after, the pad stayed put and covered the line).
            XCTAssertGreaterThanOrEqual(missing.frame.minY, app.navigationBars["New Project"].frame.maxY, "under the title bar: \(detail)")
            XCTAssertLessThanOrEqual(missing.frame.maxY, sheet.frame.maxY, "inside the sheet: \(detail)")
            XCTAssertLessThan(min(abs(pad.minY - longest.frame.maxY), abs(longest.frame.minY - pad.maxY)), 40,
                              "the floating pad sits beside the field: \(detail)")
        } else {
            let onScreen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: missing)
            XCTAssertEqual(XCTWaiter().wait(for: [onScreen], timeout: 5), .completed, "on screen, by the fields: \(detail)")
        }
        XCTAssertFalse(missing.frame.intersects(pad), "the pad covers the line: \(detail)")
        XCTAssertFalse(longest.frame.intersects(pad), "the pad covers the field: \(detail)")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = regular ? "new-fit-measurement-missing-hardware-keyboard" : "new-fit-measurement-missing"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Review F3 (train 2026-11-10e): the Result's printer row is never empty. While the printer list is on its way it says so;
    /// if the Mac won't give it, it says that with Try Again; with no printers at all, "No printer set up yet." (test above).
    func testAResultPrinterRowSaysItIsWaitingOrThatTheMacWontSay() {
        let waiting = launch(set: "printers-slow", screen: "ready")
        let loading = waiting.staticTexts["result-printers-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 20), waiting.debugDescription)
        scrollProjectPage(waiting, until: loading)
        XCTAssertTrue(loading.isHittable, "on screen: \(loading.frame)")
        XCTAssertEqual(loading.label, "Asking your Mac about its printers…")

        let refused = launch(set: "printers-refused", screen: "ready")
        let problem = refused.staticTexts["result-printers-problem"]
        XCTAssertTrue(problem.waitForExistence(timeout: 20), refused.debugDescription)
        let retry = refused.buttons["result-printers-retry"]
        scrollProjectPage(refused, until: retry)
        XCTAssertEqual(problem.label, "Couldn't read the printers configured on your Mac.")
        XCTAssertTrue(problem.isHittable, "on screen: \(problem.frame)")
        XCTAssertTrue(retry.isHittable, "the way to try again: \(retry.frame)")
        retry.tap()
        XCTAssertTrue(problem.waitForExistence(timeout: 10), "still says so after another refusal")
    }

    /// Review F3: a project whose chosen printer is no longer on the Mac says so (not "No printer chosen yet."), and Choose
    /// a Printer opens this project's print sheet, where its printer is chosen. With no printers at all, Add a Printer.
    func testAResultWhosePrinterIsGoneSaysSoAndChoosesOneForThisProject() {
        let app = launch(set: "stale-printer", screen: "ready")
        let words = app.staticTexts["result-no-printer"]
        XCTAssertTrue(words.waitForExistence(timeout: 20), app.debugDescription)
        scrollProjectPage(app, until: words)
        XCTAssertEqual(words.label, "The printer chosen for this project isn’t on your Mac anymore.")
        let choose = app.buttons["result-choose-printer"]
        XCTAssertEqual(choose.label, "Choose a Printer")
        choose.tap()
        XCTAssertTrue(app.buttons["print-now"].waitForExistence(timeout: 10), "this project's print sheet, with its printer picker")

        let empty = launch(set: "no-printers", screen: "ready")
        let none = empty.staticTexts["result-no-printer"]
        XCTAssertTrue(none.waitForExistence(timeout: 20))
        scrollProjectPage(empty, until: none)
        XCTAssertEqual(none.label, "No printer set up yet.")
        XCTAssertEqual(empty.buttons["result-choose-printer"].label, "Add a Printer")
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

    /// Board X100: David's phone reaches his Mac through a tunnel from cellular, so the link drops after the list has
    /// loaded. Opening a project then shows what the phone already has (its title, its state, the stage's picture) with one
    /// line that the Mac isn't answering and Try Again, never "Couldn't load project"; Print waits; the Mac coming back
    /// clears the line. With projects present, on the iPhone and the iPad.
    func testAProjectOpensFromWhatThePhoneHasWhenTheMacStopsAnsweringWithProjectsPresent() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all"]
        app.launch()
        let mic = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Mic mount")).firstMatch
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "the list has loaded")
        let offline = folder.appendingPathComponent("offline")
        try Data().write(to: offline)
        mic.tap()
        let away = app.descendants(matching: .any)["project-away"]
        XCTAssertTrue(away.waitForExistence(timeout: 20), "one line says the Mac isn't answering: \(app.debugDescription)")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Your Mac isn’t answering, so anything that needs it waits. This is what your phone had at")).firstMatch.exists,
                      "and when what is shown was true")
        XCTAssertFalse(app.staticTexts["Couldn't load project"].exists, "the page is not replaced")
        let title = app.buttons["project-title"]
        XCTAssertTrue(title.exists && title.label.contains("Mic mount"), "the title the phone had: \(title.label)")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR identifier == %@", "Status", "status-menu")).firstMatch.exists
                      || app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Ready", "Done", "Working", "Needs you", "Printing", "Failed"])).firstMatch.exists, "its state")
        let picture = app.images["gallery-stage-picture"]
        XCTAssertTrue(picture.waitForExistence(timeout: 10), "the stage keeps its picture, not a blank: \(String(describing: picture.value))")
        XCTAssertNotEqual(picture.value as? String, "", "the picture says what it is")
        let print = app.buttons["print"]
        if print.exists { XCTAssertFalse(print.isEnabled, "Print waits for the Mac rather than failing after a tap") }
        try FileManager.default.removeItem(at: offline)
        app.buttons["project-away-retry"].tap()
        XCTAssertTrue(away.waitForNonExistence(timeout: 15), "the Mac answered, so the line goes")
        if print.exists { XCTAssertTrue(print.isEnabled) }
    }

    // A fold, an unfold and an iPad resize with a project or the print sheet open are unit tests of the navigation
    // value now (CounterpartKit `ProjectsNavigationTests`): XCTest has no hinge API and could not drive them here.
    // The hinge itself is looked at on the iPhone Duo simulator with `agent-device fold open|closed`, and
    // `scantomake://fixture-width/<compact|regular>` (with `-CounterpartLayoutTesting YES`) still resizes a fixture run.

    /// David's iPad, Nov 10: every row under Needs you began "Needs you · " and was cut off before the question. The
    /// row shows the Mac's own detail for it, whole, and never its section's heading again.
    func testASidebarRowSaysItsQuestionNotItsHeadingWithProjectsPresent() throws {
        try XCTSkipUnless(regular, "the phone's Home has cards, not a sidebar grouped by phase")
        let app = launch()
        // A selectable list row, not a button.
        let row = app.descendants(matching: .any)["sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        XCTAssertTrue(row.label.contains("Plush, underside"), row.label)
        XCTAssertTrue(row.label.contains("Can you send a close-up of the underside? The scan never saw the bottom."), row.label)
        XCTAssertFalse(row.label.contains("Needs you"), row.label)
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

    /// PRD §5.4 One main action: on a finished print's project page It Works leads; printing another is in the bar,
    /// once, and (drawn from the same decision) not the filled one.
    func testAFinishedPrintsProjectPageOffersPrintingOnceBesideDidItFitWithProjectsPresent() throws {
        try XCTSkipIf(regular, "on the iPad the Printing screen sits beside the project page and has the same card")
        let app = launch(screen: "print-finished")
        let open = app.buttons["open-project"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        open.tap()
        XCTAssertTrue(app.buttons["it-works"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["needs-changes"].exists)
        let print = app.buttons["print"]
        XCTAssertTrue(print.exists)
        XCTAssertEqual(print.label, "Print Another")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label MATCHES %@", "Print( .*)?")).count, 1, "printing is offered once")
        // On a phone's width a plain Print Another was as large as It Works and the card started under the bar
        // (captures, Nov 10). Not the main action: the symbol alone, still named for VoiceOver. And the page opens
        // with the card that holds the main action in view, its button ready to press.
        XCTAssertLessThan(print.frame.width, 80, "the bar's Print is the symbol alone when it does not lead")
        XCTAssertTrue(app.buttons["it-works"].isHittable, "the page opens with the main action in view")
        XCTAssertGreaterThan(app.buttons["it-works"].frame.width, print.frame.width * 2, "the main action is the larger control")
    }

    /// Nov 11, David: "we now have 'ar' AND 'see it in your space' so there are TWO options". One AR control, on the stage,
    /// for whichever entry is shown; none on Together or a plate; and with the part shown it opens AR Quick Look (or says
    /// it is preparing), never nothing. The canned Mac serves `mic.stl` from the assets folder as the part.
    func testTheProjectPageHasOneARControlAndItOpensThePart() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Self.boxSTL().write(to: folder.appendingPathComponent("mic.stl"))
        let layer = folder.appendingPathComponent("scan.usda")
        try """
        #usda 1.0
        (
            defaultPrim = "Scan"
            metersPerUnit = 1
            upAxis = "Y"
        )
        def Mesh "Scan" {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (0.1, 0, 0), (0, 0.1, 0)]
            uniform token subdivisionScheme = "none"
        }
        """.write(to: layer, atomically: true, encoding: .utf8)
        MDLUtility.convert(toUSDZ: layer, writeTo: folder.appendingPathComponent("scan.usdz"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "ar-stage", "-CounterpartScreen", "printed"]
        app.launch()
        let result = app.buttons["gallery-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["project-prepare-ar"].exists, "the second AR button is gone")
        let ar = app.buttons["gallery-ar"]
        let entries = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND NOT (identifier IN %@)", "gallery-",
                                                       ["gallery-ar", "gallery-photos", "gallery-locate", "gallery-model-retry", "gallery-stage-retry"]))
        let ids = (0..<entries.count).map { entries.element(boundBy: $0).identifier }
        XCTAssertTrue(ids.contains("gallery-result"), "\(ids)")
        for id in ids {
            app.buttons[id].tap()
            RunLoop.current.run(until: Date().addingTimeInterval(1))
            if id == "gallery-scan" { XCTAssertTrue(ar.waitForExistence(timeout: 10), "the scan demand starts too, even when the gallery opens before scene activation") }
            XCTAssertLessThanOrEqual(app.buttons.matching(identifier: "gallery-ar").count, 1, "one AR control on \(id)")
            XCTAssertLessThanOrEqual(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "in your space")).count, 0)
            if id == "gallery-together" || id.hasPrefix("gallery-plate-") { XCTAssertFalse(ar.exists, "no AR on \(id)") }
        }
        result.tap()
        XCTAssertTrue(ar.waitForExistence(timeout: 30), "the part's AR chip is there")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "ready"), object: ar)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 30), .completed, "the part's model came, so AR opens: \(String(describing: ar.value))")
        ar.tap()
        // A device opens Quick Look; a simulator without a previewer must keep a visible retry.
        #if targetEnvironment(simulator)
        // This simulator's Quick Look reports canPreview == false for a valid USDZ (also checked by ARModelTests).
        // Exercise the real tap anyway: it must open or visibly offer retry, never silently return to ready.
        let opened = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !ar.exists || !ar.isHittable || (ar.value as? String == "failed" && ar.label == "AR didn’t open. Try Again")
        }, object: nil)
        #else
        let opened = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !ar.exists || !ar.isHittable }, object: nil)
        #endif
        XCTAssertEqual(XCTWaiter().wait(for: [opened], timeout: 40), .completed, "AR opens or explains its failure: \(String(describing: ar.value))")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "part-ar-result"; shot.lifetime = .keepAlways; add(shot)
        #if !targetEnvironment(simulator)
        XCTAssertNotEqual(ar.exists ? ar.value as? String : nil, "failed")
        #endif
    }

    /// #606: on a slow link the part's AR chip is there while its model comes, saying so, and becomes AR once it is here.
    func testThePartsARChipSaysItIsComingWhileTheModelDownloads() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Self.boxSTL().write(to: folder.appendingPathComponent("mic.stl"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "ar-stage", "-CounterpartScreen", "printed",
                               "-CounterpartSlowModel", "12"]
        app.launch()
        XCTAssertTrue(app.buttons["gallery-result"].waitForExistence(timeout: 20))
        app.buttons["gallery-result"].tap()
        let ar = app.buttons["gallery-ar"]
        XCTAssertTrue(ar.waitForExistence(timeout: 8), "the AR chip is there while the model comes")
        XCTAssertEqual(ar.value as? String, "loading")
        XCTAssertFalse(ar.isEnabled, "nothing to open yet")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "ar-chip-loading"; shot.lifetime = .keepAlways; add(shot)
        let arrived = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "ready"), object: ar)
        XCTAssertEqual(XCTWaiter().wait(for: [arrived], timeout: 40), .completed, "AR once the model is here: \(String(describing: ar.value))")
    }

    /// #606, David, Nov 11: "you can't rotate the thing and zoom in on the 3d thing anymore". On the iPhone and the iPad a
    /// drag on the part's stage opens it in 3D (`model-stage` reads "live" once RealityKit has drawn it), with the
    /// off-screen still drawn or not: #539 let 3D start only after that still had rendered, so a phone whose still failed
    /// kept a picture that never turned.
    func testADragOnTheStageTurnsThePartInThreeD() throws { try checkDragTurnsThePart(posterFails: false) }
    func testADragOnTheStageTurnsThePartInThreeDWhenItsStillFails() throws { try checkDragTurnsThePart(posterFails: true) }

    private func checkDragTurnsThePart(posterFails: Bool) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Self.boxSTL().write(to: folder.appendingPathComponent("mic.stl"))
        let app = XCUIApplication()
        // The stage stays live 30 s after a touch here (3 s for a person), so the test reads it after XCUITest's drag returns.
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "ar-stage", "-CounterpartScreen", "printed",
                               "-CounterpartStageIdle", "30"] + (posterFails ? ["-CounterpartFailPoster", "YES"] : [])
        app.launch()
        let result = app.buttons["gallery-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 20))
        result.tap()
        let stage = app.descendants(matching: .any)["model-stage"]
        XCTAssertTrue(stage.waitForExistence(timeout: 30), "the part's stage is a model stage once its model came")
        // The model is here and checked (its still drawn or not): the stage shows its still and a drag can turn it.
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value IN %@", ["still", "failed"]), object: stage)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 40), .completed, "the model loaded: \(String(describing: stage.value))")
        XCTAssertEqual(stage.value as? String, "still", "a model that loaded is never called failed because its off-screen still failed")
        let area = stage.frame
        XCTAssertGreaterThan(area.height, 100, "\(area)")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let from = origin.withOffset(CGVector(dx: area.midX - area.width * 0.2, dy: area.midY - area.height * 0.1))
        let to = origin.withOffset(CGVector(dx: area.midX + area.width * 0.2, dy: area.midY))
        from.press(forDuration: 0.05, thenDragTo: to)
        let live = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "live"), object: stage)
        XCTAssertEqual(XCTWaiter().wait(for: [live], timeout: 40), .completed, "a drag opens the model in 3D: \(String(describing: stage.value))")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = posterFails ? "stage-live-still-failed" : "stage-live"; shot.lifetime = .keepAlways; add(shot)
    }

    static func boxSTL() -> Data {
        let size = SIMD3<Float>(146, 40, 20)
        let c: [SIMD3<Float>] = (0..<8).map { i in SIMD3(Float(i & 1), Float((i >> 1) & 1), Float((i >> 2) & 1)) * size }
        let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
        let triangles = faces.flatMap { f in [[c[f[0]], c[f[1]], c[f[2]]], [c[f[0]], c[f[2]], c[f[3]]]] }
        var data = Data(count: 80)
        withUnsafeBytes(of: UInt32(triangles.count).littleEndian) { data.append(contentsOf: $0) }
        for t in triangles {
            for v in [SIMD3<Float>(0, 0, 0)] + t { for x in [v.x, v.y, v.z] { withUnsafeBytes(of: x.bitPattern.littleEndian) { data.append(contentsOf: $0) } } }
            data.append(contentsOf: [0, 0])
        }
        return data
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
    /// PRD §5.4 Pictures (David, Nov 9: "i am no longer allowed to see the scanned object, anywhere, ever"; Nov 10: "now
    /// you're beyond the hardcoded three things"). The project page shows each thing that will print and what was scanned,
    /// chosen with labels under the stage; a designer's six plates are six labels in a row that scrolls.
    func testTheProjectGalleryShowsEachThingAndTheProjectPictureIsTheObject() throws {
        let app = launch(screen: "printed")
        let result = app.buttons["gallery-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 20), "the thing that will print is the first picture")
        let scan = app.buttons["gallery-scan-0"]
        XCTAssertTrue(scan.exists, "what was scanned stays reachable once there is a result")
        XCTAssertTrue(result.isSelected)
        scan.tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: scan)
        XCTAssertEqual(XCTWaiter().wait(for: [selected], timeout: 5), .completed)
        app.terminate()

        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let rig = try String(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/six-plate-unconfirmed.json"), encoding: .utf8)
        let plates = XCUIApplication()
        plates.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "plates-unconfirmed",
                                  "-CounterpartScreen", "ready"]
        plates.launchEnvironment["COUNTERPART_RIG_FIXTURE"] = rig
        plates.launch()
        let labels = plates.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gallery-plate-"))
        XCTAssertTrue(labels.firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(labels.count, 6, "one label per plate")
        let last = labels.element(boundBy: 5)
        // A plate off the edge has no hit point: swipe the row on a label that is on screen until the last one is.
        let window = plates.windows.firstMatch.frame
        // This project's answer card (the print didn't finish) sits below six plates, so the page opens scrolled to it
        // (ProjectView: the page opens on its main action) and the labels sit under the bar or above the screen: scroll
        // the page back to the top first. Dragged low on the page, never on the stage, whose drag turns the model.
        let page = plates.scrollViews.firstMatch
        for _ in 0..<3 { page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).press(forDuration: 0.05, thenDragTo: page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))) }
        for _ in 0..<5 where !window.contains(last.frame) {
            guard let shown = (0..<6).map({ labels.element(boundBy: $0) }).first(where: { window.contains($0.frame) }) else { break }
            shown.swipeLeft()
        }
        XCTAssertTrue(window.contains(last.frame), "the row scrolls to the last plate")
        last.tap()
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: last)
        XCTAssertEqual(XCTWaiter().wait(for: [chosen], timeout: 5), .completed, "the last plate's picture is shown")
        plates.terminate()

        // Photos sent and no model yet: the page shows the subject the Mac cut out of the photo, not a bare symbol.
        let photos = XCUIApplication()
        photos.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "photo-only",
                                  "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"]
        photos.launch()
        let subject = photos.images["gallery-stage-picture"]
        XCTAssertTrue(subject.waitForExistence(timeout: 20), "a photo-only project shows its photo's subject")
        XCTAssertEqual(subject.label, "Your photo. The picture didn’t come from your Mac.", "this folder has no pictures, and the stage says so")
    }

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
        // Only the fields its MCP declares for this kind (bambu-printer-mcp's has no port); the fixture companion refuses a
        // Check or Add that sends anything else, or lacks a required field.
        XCTAssertFalse(app.textFields["add-printer-port"].exists, "no port: the MCP declares none for this kind")
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
        // OctoPrint's own fields: a port, and no serial number or model (the fixture companion refuses either).
        XCTAssertEqual(app.textFields["add-printer-port"].value as? String, "80", "the port discovery found")
        XCTAssertFalse(app.textFields["add-printer-serial"].exists)
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

    /// PRD §8.10 on the iPhone and iPad: the Mac answered "waiting" and its finishing event never came (the canned Mac
    /// serves no events, as after a companion restart). The Move asked the companion for that install, said it waits,
    /// and after the clock ran out says so and offers the Move again, rather than staying disabled forever.
    func testAMoveThatNeverHearsBackSaysSoAndCanBePressedAgain() throws {
        let folder = try copyFixtures(["mcp-profile-copies.json", "mcp-update-waiting.json"])
        defer { try? FileManager.default.removeItem(at: folder) }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all"]
        app.launchEnvironment["COUNTERPART_MCP_WAIT_SECONDS"] = "3"
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 20), "with projects present")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Printers")).firstMatch.tap()
        let move = app.buttons["mcp-move-mcp-0000000000000002"]
        XCTAssertTrue(move.waitForExistence(timeout: 5), app.debugDescription)
        reveal(move, in: app.collectionViews.firstMatch)
        move.tap()
        let waiting = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "finishes its work on this printer")).firstMatch
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertFalse(move.isEnabled, "no second Move while the first one waits")
        let requests = try String(contentsOf: folder.appendingPathComponent("mcp-update-requests.log"), encoding: .utf8)
        XCTAssertTrue(requests.hasPrefix("/v1/printers/mcp/mcp-0000000000000002/update "), requests)
        XCTAssertTrue(requests.contains("\"fresh\":true"), "a Move asks for Counterpart's copy: \(requests)")
        XCTAssertTrue(app.staticTexts["Counterpart didn’t say whether this updated. Try Update again."].waitForExistence(timeout: 10))
        XCTAssertFalse(waiting.exists, "the wait no longer claims to be waiting")
        XCTAssertTrue(move.isEnabled, "the Move can be pressed again")
    }

    private func copyFixtures(_ names: [String]) throws -> URL {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for name in names {
            try FileManager.default.copyItem(at: root.appendingPathComponent("packages/contracts/fixtures/" + name), to: folder.appendingPathComponent(name))
        }
        return folder
    }

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
            // The sidebar scrolls under New's bar (U11): both rows can be reached, the last one above the bar.
            let row = app.buttons["sidebar-starter-scan-platform"]
            reveal(app.buttons["sidebar-starter-long-vernier-caliper"], in: projectList(app))
            reveal(row, in: projectList(app))
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

    /// On-device library (docs/design/overhaul/on-device-library.md), PRD §6.1: Settings → Keep on this iPhone (iPad) is
    /// reachable with projects present, offers the three choices, and says how much space it uses with Clear beside it.
    func testKeepOnThisDeviceIsInSettingsWithProjectsPresent() {
        let app = launch(screen: "settings")
        XCTAssertTrue(app.descendants(matching: .any)["mac-status"].waitForExistence(timeout: 20))
        let keep = app.descendants(matching: .any)["library-keep"]
        for _ in 0..<12 where !(keep.exists && keep.isHittable) { app.swipeUp() }
        XCTAssertTrue(keep.isHittable, "Keep on this \(regular ? "iPad" : "iPhone") is reachable")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Uses ")).firstMatch.exists, "how much space it uses")
        XCTAssertTrue(app.buttons["library-clear"].exists, "and Clear")
        keep.tap()
        for choice in ["Pictures only", "Pictures and 3D models", "Everything, scans included"] {
            XCTAssertTrue(app.buttons[choice].waitForExistence(timeout: 5) || app.staticTexts[choice].exists, "offers \(choice)")
        }
    }

    /// Q9, PRD §6.1: "Keep printer software up to date" sits in Settings → Printer software, above the MCP copies and
    /// their Update buttons, with projects present, on the iPhone and the iPad; on, as the companion sends it, and it
    /// says what it does. `STM_SHOTS` (`TEST_RUNNER_STM_SHOTS` to xcodebuild) saves a screenshot of it there.
    func testKeepPrinterSoftwareUpToDateIsBesideThePrinterSoftwareWithProjects() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // The companion's copies of both MCPs, so the switch is shown beside what it updates.
        try FileManager.default.copyItem(at: root.appendingPathComponent("packages/contracts/fixtures/mcp-profile-copies.json"),
                                         to: folder.appendingPathComponent("mcp-profile-copies.json"))
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all", "-CounterpartScreen", "settings"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["mac-status"].waitForExistence(timeout: 20))
        let toggle = app.switches["auto-update-mcps"]
        let words = app.staticTexts["auto-update-mcps-words"]
        for _ in 0..<12 where !(toggle.exists && toggle.isHittable && words.exists && words.isHittable) { app.swipeUp() }
        XCTAssertTrue(toggle.isHittable, "the switch is reachable with projects present")
        XCTAssertEqual(toggle.label, "Keep printer software up to date")
        XCTAssertEqual(toggle.value as? String, "1", "on, as the companion sends it")
        XCTAssertTrue(words.isHittable)
        XCTAssertEqual(words.label, "Counterpart updates its printer software by itself when nothing is printing or being designed, and tells you afterwards.", "one sentence")
        XCTAssertLessThan(toggle.frame.minY, app.staticTexts["Counterpart’s copy 1.2.45"].frame.minY, "above the MCP copies it updates")
        if let folder = ProcessInfo.processInfo.environment["STM_SHOTS"], !folder.isEmpty {
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent(regular ? "ipad.png" : "iphone.png"))
        }
    }

    func testNewNeverCoversARow() {
        let app = launch(largeText: true)
        let new = app.buttons["new-project"]
        XCTAssertTrue(new.waitForExistence(timeout: 20))
        let list = projectList(app)
        if regular {
            // First look U11 (Nov 10): New is a bottom bar the list scrolls under, behind a hard edge, so the list's
            // scroll is evident; scrolled to the end, the last row ends above New, and New stays tappable.
            XCTAssertTrue(new.isHittable)
            for _ in 0..<12 { list.swipeUp() }
            let last = app.buttons["sidebar-starter-long-vernier-caliper"]
            XCTAssertTrue(last.exists)
            XCTAssertLessThanOrEqual(last.frame.maxY, new.frame.minY + 1, "New \(new.frame) covers the last row \(last.frame)")
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
    private func launchBottle(noPhoto: Bool = false, askFileMissing: Bool = false, sizes: Bool = false, kind: String? = nil) throws -> (XCUIApplication, URL) {
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
        // The project's picture as the Mac draws it (#451): the object alone on the dark stage, square.
        try UIGraphicsImageRenderer(size: CGSize(width: 720, height: 720), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).pngData { context in
            UIColor(red: 0.13, green: 0.14, blue: 0.17, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 720, height: 720))
            UIColor.white.setFill(); context.fill(CGRect(x: 290, y: 150, width: 140, height: 420))
        }.write(to: folder.appendingPathComponent("bottle-picture.png"))
        let frame = picture(CGSize(width: 240, height: 320), .darkGray)
        for i in 1...130 { try frame.write(to: folder.appendingPathComponent(String(format: "bottle-capture/%04d.heic", i))) }
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "ask-bottle", "-CounterpartScreen", "ask"]
        if noPhoto { app.launchEnvironment["COUNTERPART_ASK_NO_PHOTO"] = "1" }
        if sizes { app.launchEnvironment["COUNTERPART_ASK_SIZES"] = "1" }
        if let kind { app.launchEnvironment["COUNTERPART_ASK_KIND"] = kind }
        app.launch()
        return (app, folder)
    }

    /// Scan frames the canned Mac has served so far, each counted once.
    private func servedFrames(_ folder: URL) -> Set<String> {
        let log = (try? String(contentsOf: folder.appendingPathComponent("served.log"), encoding: .utf8)) ?? ""
        return Set(log.split(separator: "\n").compactMap { $0.split(separator: " ").first.map(String.init) }.filter { $0.contains("/capture/") })
    }

    /// A size question is number fields, not a camera (David answered one in a paragraph of caliper readings, Nov 10):
    /// one field per size the Mac asked about, in its words and prefilled, with Confirm as the obvious action; words
    /// and a caliper photo stay for what the numbers don't say.
    /// Train #499 review, F6: a question of a kind this build doesn't know said "update" above live answer buttons,
    /// so it could be consumed with a guess or a photo. It shows the question and the sentence, and nothing to press.
    func testAQuestionOfAnUnknownKindOffersNoAnswerWithProjectsPresent() throws {
        let (app, _) = try launchBottle(kind: "colour")
        let update = app.staticTexts["ask-update"]
        XCTAssertTrue(update.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Your Mac has a question"].exists)
        for label in ["Camera", "Photos", "Best guess", "Caliper photo", "Send answer"] { XCTAssertFalse(app.buttons[label].exists, label) }
        XCTAssertFalse(app.descendants(matching: .any)["ask-text"].exists)
        XCTAssertFalse(app.buttons["ask-sizes-confirm"].exists)
    }

    func testASizeQuestionShowsItsNumbersPrefilledWithConfirmWithProjectsPresent() throws {
        let (app, _) = try launchBottle(sizes: true)
        let confirm = app.buttons["ask-sizes-confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 20), app.debugDescription)
        for _ in 0..<8 where !confirm.isHittable { app.swipeUp() }
        XCTAssertEqual(confirm.label, "Confirm These Sizes")
        XCTAssertTrue(confirm.isEnabled)
        let values = ["size-1": "64", "size-2": "53.5", "size-3": "32", "size-4": "107"]
        for (id, value) in values {
            let field = app.textFields["ask-size-\(id)"]
            XCTAssertTrue(field.exists, id)
            XCTAssertEqual(field.value as? String, value, id)
        }
        XCTAssertTrue(app.staticTexts["Width at the waist"].exists, "the Mac's own label for each size")
        // #622: each number says where it came from, and the Mac's guess is never called a scan reading.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Read from your scan")).count, 3)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "The Mac's estimate, not measured")).count, 1)
        XCTAssertFalse(app.buttons["Best guess"].exists, "a size is confirmed or measured, never guessed")
        XCTAssertFalse(app.buttons["Photos"].exists)
        XCTAssertTrue(app.buttons["Caliper photo"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["ask-text"].exists, "words for what the numbers don't say")
        // Changing a number changes what the button says it will do; a field that isn't a number sends nothing.
        let waist = app.textFields["ask-size-size-2"]
        // Tapping a number selects it, so typing replaces the Mac's figure.
        waist.tap()
        waist.typeText("53")
        XCTAssertEqual(waist.value as? String, "53")
        XCTAssertEqual(confirm.label, "Send These Sizes")
        XCTAssertTrue(confirm.isEnabled)
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

    /// Nov 10: every "What you scanned" on David's phone was blank. With projects present: a scan the Mac lists but can't
    /// send says so in one line with Try Again; a scan too large for a phone says so. The stage itself is never empty: here
    /// the Mac's picture can't be had either (an empty folder), so it shows the project's symbol and says that too.
    func testAScanThatCantBeHadSaysWhyAndTheStageIsNeverEmptyWithProjectsPresent() {
        if regular { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch(set: "scan-stage")
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Bottle copy")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "projects are present")
        app.terminate()
        // Board X100: the line comes from the actual reason. The canned Mac has no file for 01 (404): it would not send it,
        // and with the picture missing too, the stage says both in one line with one Try Again. 02 is too large: said so.
        for (id, line) in [("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", "Your Mac didn’t send"),
                           ("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02", "your scan’s 3D model is too large a file to show on a phone.")] {
            let page = XCUIApplication()
            page.launchArguments = ["-CounterpartFixtures", NSTemporaryDirectory() + "no-assets", "-CounterpartFixtureSet", "scan-stage",
                                    "-CounterpartOpen", "counterpart://project/\(id)"]
            page.launch()
            let picture = page.images["gallery-stage-picture"]
            XCTAssertTrue(picture.waitForExistence(timeout: 20), "What you scanned has its stage picture, not an empty stage")
            XCTAssertGreaterThan(picture.frame.height, 150, "the picture fills the stage: \(picture.frame)")
            // No pictures in this folder: the picture can't be had, so the stage draws the project's symbol, not a backdrop.
            XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "not available"), object: picture)], timeout: 15) == .completed,
                          "the symbol, not an empty stage: \(String(describing: picture.value))")
            let said = page.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", line)).firstMatch
            XCTAssertTrue(said.waitForExistence(timeout: 15), "one plain line says why: \(line)")
            XCTAssertFalse(page.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "too detailed")).firstMatch.exists)
            let retries = page.buttons.matching(NSPredicate(format: "identifier IN %@", ["gallery-model-retry", "gallery-stage-retry"])).count
            XCTAssertEqual(retries, 1, "one line, one Try Again (the picture's; for 01 the model's too)")
            if id.hasSuffix("02") { XCTAssertFalse(page.buttons["gallery-model-retry"].exists, "too large: trying again won't change it") }
            page.terminate()
        }
    }

    /// Review F4 on #525: the stage's picture is itself never a bare backdrop. Its accessibility value is "shown" only
    /// once a picture is decoded, "loading" while it comes (a progress mark, or the list's picture), "not available"
    /// when it can't be had (the project's symbol). One page in each, with projects present.
    func testTheStagePictureIsDrawnLoadingOrSaysItIsNotAvailable() throws {
        if regular { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        let assets = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: assets) }
        try UIGraphicsImageRenderer(size: CGSize(width: 600, height: 600), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).pngData { context in
            UIColor(red: 0.13, green: 0.14, blue: 0.17, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
            UIColor(red: 0.85, green: 0.65, blue: 0.4, alpha: 1).setFill(); context.fill(CGRect(x: 150, y: 180, width: 300, height: 240))
        }.write(to: assets.appendingPathComponent("thumb-potato.png"))
        for (folder, slow, value) in [(assets.path, nil, "shown"), (assets.path, "60", "loading"), (NSTemporaryDirectory() + "no-assets", nil, "not available")] as [(String, String?, String)] {
            let page = XCUIApplication()
            page.launchArguments = ["-CounterpartFixtures", folder, "-CounterpartFixtureSet", "scan-stage",
                                    "-CounterpartOpen", "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"]
            if let slow { page.launchArguments += ["-CounterpartSlowPictures", slow] }
            page.launch()
            let picture = page.images["gallery-stage-picture"]
            XCTAssertTrue(picture.waitForExistence(timeout: 20))
            let state = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: picture)
            XCTAssertEqual(XCTWaiter().wait(for: [state], timeout: 15), .completed, "\(value): \(String(describing: picture.value))")
            page.terminate()
        }
    }

    /// Review B1/B2 on #539: a 3MF's stage is a picture (`.picture`), and it was a bare backdrop while that picture came.
    /// With projects present, one page in each state: shown; loading (a slow Mac: a progress mark and what is coming);
    /// not available after a failed fetch (with Try Again); waiting while the Mac draws it; not available when the Mac
    /// couldn't draw it (no Try Again: it would not help). The stage is never only the backdrop.
    func testAPictureStageIsShownLoadingWaitingOrSaysItIsNotAvailable() throws {
        if regular { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        let assets = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: assets) }
        try UIGraphicsImageRenderer(size: CGSize(width: 600, height: 600), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).pngData { context in
            UIColor(red: 0.13, green: 0.14, blue: 0.17, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
            UIColor(red: 0.85, green: 0.65, blue: 0.4, alpha: 1).setFill(); context.fill(CGRect(x: 150, y: 180, width: 300, height: 240))
        }.write(to: assets.appendingPathComponent("thumb-potato.png"))
        let none = NSTemporaryDirectory() + "no-assets"
        let shown = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", drawing = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02", failed = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a06"
        let pages: [(name: String, folder: String, slow: String?, id: String, value: String, label: String, retry: Bool)] = [
            ("shown", assets.path, nil, shown, "shown", "Model, as your Mac drew it", false),
            ("loading", assets.path, "60", shown, "loading", "Model: coming from your Mac", false),
            ("fetch-failed", none, nil, shown, "not available", "Model. The picture didn’t come from your Mac.", true),
            ("drawing", assets.path, nil, drawing, "loading", "Model: coming from your Mac", false),
            ("not-drawable", assets.path, nil, failed, "not available", "Model. Your Mac couldn’t draw a picture of this.", false),
        ]
        for page in pages {
            let app = XCUIApplication()
            app.launchArguments = ["-CounterpartFixtures", page.folder, "-CounterpartFixtureSet", "picture-stage", "-CounterpartOpen", "counterpart://project/\(page.id)"]
            if let slow = page.slow { app.launchArguments += ["-CounterpartSlowPictures", slow] }
            app.launch()
            let picture = app.images["gallery-stage-picture"]
            XCTAssertTrue(picture.waitForExistence(timeout: 20), "\(page.name): the stage has its picture element")
            let state = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ AND label == %@", page.value, page.label), object: picture)
            XCTAssertEqual(XCTWaiter().wait(for: [state], timeout: 15), .completed, "\(page.name): \(picture.label) / \(String(describing: picture.value))")
            // What is drawn, not only what is said: a bare stage is all dark (its gradient stays near #22-#30); the
            // picture, the line, the progress mark and the symbol are bright.
            let bright = Self.brightPixels(picture.screenshot().image)
            XCTAssertGreaterThan(bright, 300, "\(page.name): something is drawn on the stage, not only its backdrop (\(bright) bright pixels)")
            XCTAssertEqual(app.buttons["gallery-stage-retry"].exists, page.retry, "\(page.name): Try Again only where it can help")
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "picture-stage-\(page.name)-\(regular ? "ipad" : "iphone")"; shot.lifetime = .keepAlways; add(shot)
            if let folder = ProcessInfo.processInfo.environment["STAGE_SHOTS"] {
                try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(shot.name!).png"))
            }
            app.terminate()
        }
    }

    /// Pixels with any channel above half: what a picture, a line or a symbol puts on the dark stage.
    static func brightPixels(_ image: UIImage) -> Int {
        guard let cg = image.cgImage else { return 0 }
        let width = cg.width, height = cg.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: data.count, by: 4).reduce(0) { $0 + (max(data[$1], data[$1 + 1], data[$1 + 2]) > 128 ? 1 : 0) }
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

/// The phone's own library (docs/design/overhaul/on-device-library.md). David, Nov 11: "Never seen app in my life, since
/// 2009 or so, struggle showing images it just had, 10 minutes later, because of a dependency on some Mac mini". The list
/// loads, the library fills by itself, the link drops completely, the app is relaunched: every project's picture is still
/// there, on Home and on its page, where the stage shows it ("shown", never "loading" or a symbol).
final class OnDeviceLibraryUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// A picture that is not one flat colour (the blank check flags those), as PNG.
    private func picture(_ hue: CGFloat) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 320, height: 240), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).pngData { context in
            UIColor(hue: hue, saturation: 0.5, brightness: 0.4, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 240))
            UIColor.white.setFill(); context.cgContext.fillEllipse(in: CGRect(x: 90, y: 50, width: 140, height: 140))
        }
    }

    /// A binary STL of `triangles` small triangles: a model of a known size.
    private func model(triangles: Int) -> Data {
        var data = Data(count: 80)
        var count = UInt32(triangles).littleEndian
        data.append(Data(bytes: &count, count: 4))
        for index in 0..<triangles {
            var floats: [Float32] = [0, 0, 1, Float32(index), 0, 0, Float32(index) + 1, 0, 0, Float32(index), 1, 0]
            data.append(Data(bytes: &floats, count: 48)); data.append(Data(count: 2))
        }
        return data
    }

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        try picture(0.1).write(to: folder.appendingPathComponent("thumb-mic.png"))
        try picture(0.6).write(to: folder.appendingPathComponent("thumb-potato.png"))
        try picture(0.3).write(to: folder.appendingPathComponent("bed.jpg"))
        try picture(0.8).write(to: folder.appendingPathComponent("render-live.png"))
        try model(triangles: 4_000).write(to: folder.appendingPathComponent("mic.stl"))
        return folder
    }

    private func launch(_ folder: URL, _ more: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CounterpartFixtures", folder.path, "-CounterpartFixtureSet", "all", "-CounterpartFixtureKeepsLibrary", "YES"] + more
        app.launch()
        return app
    }

    /// What the app's library index says it holds (the app writes it into the test's fixture folder).
    private struct Entry: Decodable { var project: String; var name: String; var kind: String; var bytes: Int64 }
    private func entries(_ folder: URL) -> [Entry] {
        let library = folder.appendingPathComponent("library")
        guard let mac = try? FileManager.default.contentsOfDirectory(atPath: library.path).first(where: { !$0.hasPrefix(".") }),
              let data = try? Data(contentsOf: library.appendingPathComponent(mac).appendingPathComponent("index.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = object["entries"] as? [String: Any] else { return [] }
        return rows.values.compactMap { try? JSONDecoder().decode(Entry.self, from: JSONSerialization.data(withJSONObject: $0)) }
    }

    private func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end { if condition() { return true }; RunLoop.current.run(until: Date().addingTimeInterval(0.5)) }
        return condition()
    }

    func testEveryProjectsPictureShowsAfterARelaunchWithTheMacAwayWithProjectsPresent() throws {
        let folder = try folder()
        var app = launch(folder)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Mic mount")).firstMatch.waitForExistence(timeout: 20), "the list has loaded")
        // The library fills by itself: nobody opened a page.
        XCTAssertTrue(waitFor(30) { Set(entries(folder).filter { $0.kind == "picture" }.map(\.project)).count >= 4 },
                      "every project's picture comes without a page asking: \(entries(folder).map { "\($0.project.suffix(2)) \($0.name)" })")
        // The pages to check: projects the phone keeps a picture the Mac drew for (`pictures/`, `renders/`), which is what
        // a stage shows. A project whose only kept picture is its question's photo (the plush) has no Mac picture of its
        // scan yet, so its stage honestly says the picture is coming.
        let kept = Set(entries(folder).filter { $0.kind == "picture" && ($0.name.hasPrefix("pictures/") || $0.name.hasPrefix("renders/")) }.map(\.project))
        XCTAssertGreaterThanOrEqual(kept.count, 4, "the Mac's pictures of every project that has one")
        // The saved list is written a moment after the list arrives (ProjectsStore.saveKnownSoon, 2 s): wait for it, as a
        // person's phone does, before the app goes.
        XCTAssertTrue(waitFor(10) { FileManager.default.fileExists(atPath: folder.appendingPathComponent("known-projects.json").path) }, "the saved list is written")
        app.terminate()

        // The link drops completely, and the app starts again.
        try Data().write(to: folder.appendingPathComponent("offline"))
        app = launch(folder)
        XCTAssertTrue(app.buttons["connection-try-again"].waitForExistence(timeout: 20), "the Mac isn't answering")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Mic mount")).firstMatch.waitForExistence(timeout: 10),
                      "Home has the projects it had: \(app.debugDescription)")
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "home-away"; home.lifetime = .keepAlways; add(home)
        app.terminate()

        // Every project the library holds a picture for: its page, the Mac away, shows the Mac's picture on the stage.
        for id in kept.sorted() {
            app = launch(folder, ["-CounterpartOpen", "counterpart://project/\(id)"])
            // The stage shows the Mac's picture the phone keeps ("shown"), or, for a recent project whose model the phone
            // also keeps, that model drawn (its Explore in 3D control). Never "loading", "not available" or a bare stage.
            let stage = app.images["gallery-stage-picture"], model = app.buttons["Explore in 3D"]
            XCTAssertTrue(waitFor(20) { (stage.exists && stage.value as? String == "shown") || model.exists },
                          "\(id): the stage shows what the phone keeps, not \(stage.exists ? String(describing: stage.value) : "nothing"): \(app.debugDescription)")
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "page-away-\(id.suffix(2))"; shot.lifetime = .keepAlways; add(shot)
            app.terminate()
        }
    }

    /// Issue #720. David, Nov 11: "if i just saw it 2 seconds ago, how is it having to come from my mac again?" A project
    /// opened once, left, and opened again: with the Mac answering, then with it not answering at all, then after a
    /// relaunch still away. Each time its model is on the stage from the phone (a drag turns it live, `model-stage`) and
    /// nothing says it is coming from the Mac.
    func testAProjectSeenOnceDrawsFromThePhoneWhenTheMacIsAwayWithProjectsPresent() throws {
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        }
        let folder = try folder()
        // A model the stage can draw (a 40 mm cube), so the 3D path is checked too, not only the picture.
        try cube(40).write(to: folder.appendingPathComponent("mic.stl"))
        let mic = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
        var app = launch(folder, ["-CounterpartOpen", "counterpart://project/\(mic)", "-CounterpartStageIdle", "30"])
        assertTurnsFromThePhone(app, "first visit, Mac answering")
        XCTAssertTrue(waitFor(20) { entries(folder).contains { $0.project == mic && $0.kind == "model" } }, "and the phone keeps it")
        XCTAssertTrue(waitFor(10) { FileManager.default.fileExists(atPath: folder.appendingPathComponent("known-projects.json").path) }, "the saved list is written")

        // Leave the page and come back with the Mac answering...
        leaveAndComeBack(app)
        assertTurnsFromThePhone(app, "back on the page, Mac answering")
        // ...then the Mac stops answering entirely, and again.
        try Data().write(to: folder.appendingPathComponent("offline"))
        if app.collectionViews["Sidebar"].exists {
            // The iPad: every project the phone had stays in the sidebar while the Mac is away, reachable by scrolling it
            // (#720: the away banner, pinned above the list, left four rows and hid Mic mount below them).
            let sidebar = app.collectionViews["Sidebar"], row = app.descendants(matching: .any)["sidebar-project-\(mic)"]
            XCTAssertTrue(app.descendants(matching: .any)["connection-try-again"].waitForExistence(timeout: 20), "the Mac isn't answering")
            for _ in 0..<8 where !(row.exists && row.isHittable) { sidebar.swipeUp() }
            XCTAssertTrue(row.exists && row.isHittable, "Mic mount is in the sidebar with the Mac away: \(app.debugDescription)")
            for _ in 0..<8 { sidebar.swipeDown() }
        }
        leaveAndComeBack(app)
        assertTurnsFromThePhone(app, "back on the page, Mac away")
        let again = XCTAttachment(screenshot: app.screenshot()); again.name = "720-page-again-away"; again.lifetime = .keepAlways; add(again)
        app.terminate()

        // A relaunch, the Mac still away: the same page draws the same way.
        app = launch(folder, ["-CounterpartOpen", "counterpart://project/\(mic)", "-CounterpartStageIdle", "30"])
        assertTurnsFromThePhone(app, "after a relaunch, Mac away")
        let relaunched = XCTAttachment(screenshot: app.screenshot()); relaunched.name = "720-page-relaunch-away"; relaunched.lifetime = .keepAlways; add(relaunched)
        app.terminate()
    }

    /// #769, David's phone trace (Nov 12, build 202611121212): Wall holder, Crochet potato, AirPods hanger, BAG CLIP and
    /// others, opened from Home, logged one `page.model-published file=false`, their stage appeared and disappeared within
    /// 4 ms, and `model.published ready=true` 40 ms later never reached the page: no Explore in 3D, no AR. The page's model
    /// came from `@State` that a one-shot task set. Here the model reaches the phone just after the page is pushed from
    /// Home's own row (not a launch link), and the stage must still offer Explore in 3D and AR.
    ///
    /// The trace after #770 (build 202611122043, Stacking letter toy): the model reached the page's `body`, and a drag's
    /// live view loaded it, but the stage that stayed on screen never ran its `.task` (`stage.appear` and
    /// `stage.disappear` in the same millisecond, no `stage.begin`): no still, no size. So the stage must also reach its
    /// still ("still"), which only its load gives. Explore in 3D alone shows on a stage whose load never ran. Twice: the
    /// model 1.5 s after the push, and 70 ms after it, as on the phone. The simulator has not yet reproduced the instant
    /// disappear; this guards the path either way.
    func testAModelThatArrivesJustAfterThePageOpensIsOnTheStageWithProjectsPresent() throws {
        for delay in ["1.5", "0.07"] { try openWithTheModelLate(delay) }
    }

    private func openWithTheModelLate(_ delay: String) throws {
        let folder = try folder()
        try cube(40).write(to: folder.appendingPathComponent("mic.stl"))
        let app = launch(folder, ["-CounterpartSlowModel", delay, "-CounterpartStageIdle", "30"])
        defer { app.terminate() }
        let search = app.textFields["project-search"]
        if app.collectionViews["Sidebar"].exists, search.waitForExistence(timeout: 20) {
            pick(app, search, "Mic mount", "sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", file: #filePath, line: #line)
        } else {
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT (label BEGINSWITH %@)", "Mic mount", "Mic mount v")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription)
            for _ in 0..<6 where !row.isHittable { app.swipeUp() }
            row.tap()
        }
        XCTAssertTrue(app.buttons["project-title"].waitForExistence(timeout: 10), app.debugDescription)
        let explore = app.buttons["Explore in 3D"]
        XCTAssertTrue(explore.waitForExistence(timeout: 20), "the model came after the page opened, and the stage has it: \(app.debugDescription)")
        let ar = app.buttons["gallery-ar"]
        XCTAssertTrue(ar.waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "ready"), object: ar)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 20), .completed, "AR for the model that came: \(String(describing: ar.value))")
        let stage = app.descendants(matching: .any)["model-stage"]
        let still = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "still"), object: stage)
        XCTAssertEqual(XCTWaiter().wait(for: [still], timeout: 20), .completed,
                       "the stage loaded the model that came \(delay) s after the push: \(String(describing: stage.value))")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "769-model-after-open-\(delay)"; shot.lifetime = .keepAlways; add(shot)
    }

    /// Back to Home and into Mic mount again (iPhone), or to another project and back by the sidebar (iPad). The iPad finds
    /// each row with the sidebar's own search, which also says how many projects the list holds: a project missing from
    /// the list while the Mac is away is told apart from a row scrolled out of view.
    private func leaveAndComeBack(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let search = app.textFields["project-search"]
        if app.collectionViews["Sidebar"].exists, search.exists {
            pick(app, search, "Crochet potato", "sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02", file: file, line: line)
            pick(app, search, "Mic mount", "sidebar-project-6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", file: file, line: line)
        } else {
            let back = app.navigationBars.buttons.firstMatch
            XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription, file: file, line: line)
            back.tap()
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT (label BEGINSWITH %@)", "Mic mount", "Mic mount v")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription, file: file, line: line)
            for _ in 0..<6 where !row.isHittable { app.swipeUp() }
            row.tap()
        }
        XCTAssertTrue(app.buttons["project-title"].waitForExistence(timeout: 10), app.debugDescription, file: file, line: line)
        XCTAssertEqual(app.buttons["project-title"].label, "Mic mount", file: file, line: line)
    }

    /// Types `query` into the sidebar's search and taps the row `identifier`; the search's summary goes into the failure.
    private func pick(_ app: XCUIApplication, _ search: XCUIElement, _ query: String, _ identifier: String, file: StaticString, line: UInt) {
        search.tap()
        let old = (search.value as? String) ?? ""
        if !old.isEmpty && old != search.placeholderValue { search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count)) }
        search.typeText(query)
        let row = app.descendants(matching: .any)[identifier]
        let found = row.waitForExistence(timeout: 10)
        let summary = app.descendants(matching: .any)["project-search-summary"]
        let said = summary.exists ? summary.label : "no summary"
        let note = XCTAttachment(string: "search \(query): \(said)"); note.name = "sidebar search: \(query)"; note.lifetime = .keepAlways; add(note)
        XCTAssertTrue(found, "\(query) is in the sidebar's list (search says: \(said)): \(app.debugDescription)", file: file, line: line)
        row.tap()
    }

    /// The stage has the model from the phone (its still, "still") within a few seconds, a drag turns it live, and nothing
    /// says "coming from your Mac" meanwhile.
    private func assertTurnsFromThePhone(_ app: XCUIApplication, _ when: String, file: StaticString = #filePath, line: UInt = #line) {
        let coming = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "coming from your Mac"))
        let stage = app.descendants(matching: .any)["model-stage"]
        let end = Date().addingTimeInterval(20)
        var ready = false
        while Date() < end {
            XCTAssertEqual(coming.count, 0, "\(when): \(coming.firstMatch.exists ? coming.firstMatch.label : "")", file: file, line: line)
            if stage.exists, ["still", "failed"].contains(stage.value as? String ?? "") { ready = true; break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        if !ready || stage.value as? String != "still" {
            let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "not-drawn: \(when)"; shot.lifetime = .keepAlways; add(shot)
            let tree = XCTAttachment(string: app.debugDescription); tree.name = "not-drawn tree: \(when)"; tree.lifetime = .keepAlways; add(tree)
        }
        XCTAssertEqual(stage.value as? String, "still", "\(when): the model is on the stage from the phone (\(stage.exists ? String(describing: stage.value) : "no model stage"))", file: file, line: line)
        let area = stage.frame
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: area.midX - area.width * 0.2, dy: area.midY - area.height * 0.1))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: area.midX + area.width * 0.2, dy: area.midY)))
        let live = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "live"), object: stage)
        XCTAssertEqual(XCTWaiter().wait(for: [live], timeout: 40), .completed, "\(when): a drag turns it: \(String(describing: stage.value))", file: file, line: line)
        XCTAssertEqual(coming.count, 0, when, file: file, line: line)
    }

    /// A binary STL cube of `size` mm: 12 triangles.
    private func cube(_ size: Float32) -> Data {
        let v: [[Float32]] = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].map { $0.map { $0 * size } }
        let faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
        var data = Data(count: 80)
        var count = UInt32(faces.count).littleEndian
        data.append(Data(bytes: &count, count: 4))
        for face in faces {
            var floats: [Float32] = [0, 0, 0] + face.flatMap { v[$0] }
            data.append(Data(bytes: &floats, count: 48)); data.append(Data(count: 2))
        }
        return data
    }

    /// Past the ceiling, models go before pictures: the library keeps every project's picture and lets the models go.
    func testFillingPastTheCeilingEvictsModelsBeforePicturesWithProjectsPresent() throws {
        let folder = try folder()
        var app = launch(folder)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Mic mount")).firstMatch.waitForExistence(timeout: 20))
        // With no ceiling to speak of, every picture and the recent projects' models (200 KB each) come by themselves.
        XCTAssertTrue(waitFor(30) { Set(entries(folder).filter { $0.kind == "picture" }.map(\.project)).count >= 4 && entries(folder).contains { $0.kind == "model" } },
                      "pictures and models came: \(entries(folder).map(\.name))")
        app.terminate()
        let pictures = Set(entries(folder).filter { $0.kind == "picture" }.map(\.project))
        // A ceiling with room for the pictures and not for one model.
        let ceiling = entries(folder).filter { $0.kind == "picture" }.reduce(0) { $0 + $1.bytes } * 2 + 20_000
        XCTAssertLessThan(ceiling, 200_000)
        app = launch(folder, ["-CounterpartLibraryCeiling", String(ceiling)])
        XCTAssertTrue(waitFor(30) { !entries(folder).contains { $0.kind == "model" } }, "models are evicted first: \(entries(folder).map(\.name))")
        XCTAssertEqual(Set(entries(folder).filter { $0.kind == "picture" }.map(\.project)), pictures, "every project's picture stays")
        XCTAssertLessThanOrEqual(entries(folder).reduce(0) { $0 + $1.bytes }, ceiling)
        app.terminate()
    }
}

extension XCUIElement {
    /// Whether the element's middle is inside `container`, read from frames alone. `isHittable` on a row scrolled out of an
    /// iPad sheet can throw "Activation point invalid and no suggested hit points" instead of answering false (the gate,
    /// Nov 11, in a loop that scrolls back to the top), so a scroll loop asks this and leaves `isHittable` to the asserts.
    func shown(in container: XCUIElement) -> Bool {
        guard exists else { return false }
        let own = frame
        return !own.isEmpty && container.frame.contains(CGPoint(x: own.midX, y: own.midY))
    }
}
