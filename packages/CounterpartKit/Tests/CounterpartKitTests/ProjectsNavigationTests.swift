import XCTest
@testable import CounterpartKit

/// What the phone, the Duo and the iPad show after a fold, an unfold, a resize, a route or a sheet. These are the
/// cases the two resize UI tests described (they could not be driven under XCTest and were skipped in #431); the
/// hinge itself is still looked at on the Duo simulator.
final class ProjectsNavigationTests: XCTestCase {
    private let ring = "6f1c1b6e", bracket = "9a51"

    /// A fold or an iPad resize is a width change alone: nothing in the navigation is told, and nothing moves.
    func testAnOpenProjectIsKeptThroughFoldAndUnfold() {
        var nav = ProjectsNavigation()
        nav.select(ring)
        XCTAssertEqual(nav.project, ring)
        XCTAssertEqual(nav.column, .detail, "folded, the project covers Home")
        // Collapsing, the sidebar list clears its own selection.
        nav.select(nil)
        nav.columnChanged(compact: true)
        XCTAssertEqual(nav.project, ring, "fold keeps the project")
        nav.columnChanged(compact: false)
        XCTAssertEqual(nav.project, ring, "unfold keeps the project")
    }

    func testBackWhileFoldedClosesTheProjectSoUnfoldingShowsTheStartPane() {
        var nav = ProjectsNavigation()
        nav.open(ring)
        nav.show(.sidebar)
        nav.columnChanged(compact: true)
        XCTAssertNil(nav.detail, "Back to Home clears the old selection")
        nav.columnChanged(compact: false)
        XCTAssertNil(nav.detail)
        XCTAssertEqual(nav.column, .sidebar)
    }

    func testAtRegularWidthShowingTheSidebarClosesNothing() {
        var nav = ProjectsNavigation()
        nav.open(ring)
        nav.show(.sidebar)
        nav.columnChanged(compact: false)
        XCTAssertEqual(nav.project, ring)
    }

    func testThePrintSheetAndItsProjectSurviveResizesAndCancelReturnsToTheProject() {
        var nav = ProjectsNavigation()
        nav.open(ring)
        nav.present(.print(ring))
        nav.select(nil)
        nav.columnChanged(compact: true)
        XCTAssertEqual(nav.sheet, .print(ring))
        nav.columnChanged(compact: false)
        XCTAssertEqual(nav.sheet, .print(ring))
        nav.columnChanged(compact: true)
        nav.dismissSheet()
        XCTAssertNil(nav.sheet)
        XCTAssertEqual(nav.detail, .init(project: ring, page: .project), "Cancel returns to the same project, not Home")
    }

    /// The detail stack is keyed by the project, and the path is set with it: a print notification opens Printing
    /// on top of its project (with only the root keyed, the iPad dropped that push).
    func testAPrintingRouteOpensTheProjectWithPrintingOnTop() {
        var nav = ProjectsNavigation()
        nav.open(bracket)
        nav.apply(.printing(ring))
        XCTAssertEqual(nav.project, ring)
        XCTAssertEqual(nav.path, [ProjectsNavigation.printingValue(ring)])
        XCTAssertEqual(nav.column, .detail)
        // Back from Printing is the project's own page.
        nav.path = []
        XCTAssertEqual(nav.detail, .init(project: ring, page: .project))
    }

    /// A starter added from the sidebar once landed on the old project's Printing screen.
    func testOpeningAnotherProjectDropsThePagesPushedForTheLastOne() {
        var nav = ProjectsNavigation()
        nav.openPrinting(ring)
        nav.select(bracket)
        XCTAssertEqual(nav.detail, .init(project: bracket, page: .project))
        XCTAssertEqual(nav.path, [])
    }

    func testAPathCanOnlyShowTheOpenProjectsPrinting() {
        var nav = ProjectsNavigation()
        nav.open(ring)
        nav.path = [ProjectsNavigation.printingValue(bracket)]
        XCTAssertEqual(nav.detail, .init(project: ring, page: .project))
        nav.path = [ProjectsNavigation.printingValue(ring)]
        XCTAssertEqual(nav.detail?.page, .printing)
        var empty = ProjectsNavigation()
        empty.path = [ProjectsNavigation.printingValue(ring)]
        XCTAssertNil(empty.detail, "no project, no pushed page")
    }

    func testOnlyOneSheetIsEverUp() {
        var nav = ProjectsNavigation()
        nav.present(.settings)
        nav.apply(.print(ring))
        XCTAssertEqual(nav.sheet, .print(ring), "the route's sheet replaces Settings")
        XCTAssertEqual(nav.project, ring)
        nav.dismissSheet()
        nav.present(.printers)
        nav.apply(.newProject)
        XCTAssertEqual(nav.sheet, .new(job: nil), "and Printers")
        let first = nav.presented?.id
        nav.dismissSheet()
        nav.present(.new(job: "fit"))
        XCTAssertNotEqual(nav.presented?.id, first, "New presented again is a new sheet")
        XCTAssertEqual(nav.sheet, .new(job: "fit"))
    }

    /// A tapped notification or link must not throw away an unsent New draft or a prepared Print sheet. Its
    /// navigation still happens underneath; its own sheet, if it has one, is dropped.
    func testARouteNeverReplacesANewOrPrintSheetThatIsUp() {
        let routes: [AppRoute] = [.home, .project(bracket), .print(bracket), .camera(bracket), .printing(bracket), .printers, .newProject, .pair("scantomake://pair")]
        for held in [ProjectsNavigation.Sheet.new(job: "fit"), .print(ring)] {
            for route in routes {
                var nav = ProjectsNavigation()
                nav.open(ring)
                nav.present(held)
                let up = nav.presented
                nav.apply(route)
                XCTAssertEqual(nav.presented, up, "\(held) stays up through \(route): the same sheet, not a new one")
                // What the route navigates to is there when the sheet is closed.
                switch route {
                case .project, .print, .camera: XCTAssertEqual(nav.detail, .init(project: bracket, page: .project), "\(route)")
                case .printing: XCTAssertEqual(nav.detail, .init(project: bracket, page: .printing), "\(route)")
                case .home, .pair: XCTAssertNil(nav.detail, "\(route)")
                case .printers, .newProject: XCTAssertEqual(nav.project, ring, "\(route)")
                }
            }
        }
        // Settings and Printers hold nothing, so a route's sheet takes their place.
        for light in [ProjectsNavigation.Sheet.settings, .printers] {
            var nav = ProjectsNavigation()
            nav.present(light)
            XCTAssertFalse(nav.sheetHoldsWork)
            nav.apply(.print(ring))
            XCTAssertEqual(nav.sheet, .print(ring))
        }
    }

    func testRoutesOpenWhatTheyName() {
        var nav = ProjectsNavigation()
        nav.apply(.camera(ring))
        XCTAssertEqual(nav.detail, .init(project: ring, page: .project))
        nav.apply(.project(bracket))
        XCTAssertEqual(nav.project, bracket)
        // A sheet that routes to a project (Printers → a printing project) dismisses itself; the route leaves sheets alone.
        nav.present(.printers)
        nav.apply(.project(ring))
        XCTAssertEqual(nav.sheet, .printers)
        nav.apply(.home)
        XCTAssertNil(nav.detail)
        XCTAssertEqual(nav.column, .sidebar)
        nav.apply(.pair("scantomake://pair"))
        XCTAssertNil(nav.detail)
    }
}
