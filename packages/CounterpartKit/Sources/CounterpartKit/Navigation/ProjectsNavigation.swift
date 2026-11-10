import Foundation

/// What the paired app shows on iPhone, iPad and Duo: which project (and whether its Printing screen is on top),
/// which column a collapsed split shows, and the one sheet that may be up. A plain value with one method per thing
/// that can happen, so a fold, an unfold, an iPad resize and a notification's route are checked by unit tests
/// (`ProjectsNavigationTests`) and not only on a hinge.
///
/// It replaces seven separate `@State` values in `ProjectsRoot`. Those could say two sheets at once, or a Printing
/// page for a project that wasn't selected, and each fix was a patch in a view callback (Nov 8–9: a starter added
/// from the sidebar landed on the old project's Printing screen; the iPad dropped a notification's push).
public struct ProjectsNavigation: Equatable, Sendable {
    /// A project's own page, or its Printing screen pushed on top of it.
    public enum Page: Equatable, Sendable { case project, printing }
    public struct Detail: Equatable, Sendable {
        public var project: String
        public var page: Page
    }
    /// The column a collapsed split shows: Home, or the project.
    public enum Column: Equatable, Sendable { case sidebar, detail }
    public enum Sheet: Equatable, Sendable {
        /// New project, with the job's raw value when Home asked for one ("fit", "copy").
        case new(job: String?)
        /// The print sheet for a project.
        case print(String)
        case settings
        case printers
    }
    /// A sheet on screen. Each presentation has its own id, so presenting New again is a new sheet.
    public struct Presented: Equatable, Identifiable, Sendable {
        public let sheet: Sheet
        public let id: Int
    }

    public private(set) var detail: Detail?
    public private(set) var column: Column = .sidebar
    public private(set) var presented: Presented?
    private var presentations = 0

    public init() {}

    public var sheet: Sheet? { presented?.sheet }
    /// The open project. The detail's navigation stack is keyed by it, so a route that opens a project with its
    /// Printing screen builds a new stack with that page already pushed.
    public var project: String? { detail?.project }

    // MARK: What can happen

    /// A project opens on its own page. Pages pushed for the previous project go with it.
    public mutating func open(_ id: String) {
        detail = Detail(project: id, page: .project)
        column = .detail
    }

    /// A project opens with its Printing screen on top (Watch the Print, a print notification, a Live Activity).
    public mutating func openPrinting(_ id: String) {
        detail = Detail(project: id, page: .printing)
        column = .detail
    }

    /// The project closes: Home on a phone, the start pane beside the sidebar.
    public mutating func close() {
        detail = nil
        column = .sidebar
    }

    /// The sidebar's list changed its selection. It clears its selection to nil when the split collapses (a fold, an
    /// iPad resize); that must not close the project the detail shows.
    public mutating func select(_ id: String?) {
        if let id { open(id) }
    }

    /// The split view moved between its columns by itself (the system Back button in a collapsed split).
    public mutating func show(_ column: Column) { self.column = column }

    /// After the column changed. Back in a collapsed split returns Home and closes the project, so unfolding
    /// afterwards shows the start pane and not the project that was left. At regular width both columns show and
    /// nothing closes.
    public mutating func columnChanged(compact: Bool) {
        if compact, column == .sidebar { close() }
    }

    public mutating func present(_ sheet: Sheet) {
        presentations += 1
        presented = Presented(sheet: sheet, id: presentations)
    }

    public mutating func dismissSheet() { presented = nil }

    /// New and Print hold what the person is in the middle of: a finished scan with its description and fit choices,
    /// or spools chosen and a slice computed. Settings and Printers hold nothing.
    public var sheetHoldsWork: Bool {
        switch sheet {
        case .new, .print: true
        case .settings, .printers, nil: false
        }
    }

    /// A notification, widget, Live Activity or link (`AppRoute`). Its navigation always happens. Its sheet, if it
    /// has one, replaces Settings or Printers but never a New or Print sheet that is up: a tapped notification must
    /// not throw away an unsent draft or a prepared print. That route's own sheet is dropped, not queued.
    public mutating func apply(_ route: AppRoute) {
        switch route {
        case .project(let id), .camera(let id): open(id)
        case .printing(let id): openPrinting(id)
        case .print(let id): open(id); routed(.print(id))
        case .newProject: routed(.new(job: nil))
        case .printers: routed(.printers)
        case .home, .pair: close()
        }
    }

    private mutating func routed(_ sheet: Sheet) {
        if !sheetHoldsWork { present(sheet) }
    }

    // MARK: The detail's navigation stack

    /// The pages pushed on the open project's stack, as `NavigationStack` path values. Popping the Printing screen
    /// (Back, or a swipe) sets it empty.
    public var path: [String] {
        get { detail.map { $0.page == .printing ? [Self.printingValue($0.project)] : [] } ?? [] }
        set {
            guard var detail else { return }
            detail.page = newValue.contains { Self.printingProject($0) == detail.project } ? .printing : .project
            self.detail = detail
        }
    }

    /// Navigation values are strings: a project id, or `printing:<id>` for its Printing screen.
    public static func printingValue(_ id: String) -> String { "printing:" + id }
    public static func printingProject(_ value: String) -> String? {
        value.hasPrefix("printing:") ? String(value.dropFirst("printing:".count)) : nil
    }
}
