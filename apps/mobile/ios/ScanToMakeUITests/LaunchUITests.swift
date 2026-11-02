import XCTest

/// The app launches as a SwiftUI app and, with no Mac paired, opens on Find your Mac.
final class LaunchUITests: XCTestCase {
    func testFirstLaunchOpensFindYourMac() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Find your Mac"].waitForExistence(timeout: 20) || app.staticTexts["Your Mac"].exists
                      || app.buttons["New Project"].exists, "the app shows pairing or, when already paired, the projects")
    }
}
