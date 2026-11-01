#if DEBUG
import AppKit

/// Design QA only (Debug builds): checks that a window never changes size on its own once it has
/// settled, while the pointer moves over it. A window whose frame, minimum size or scroll content keeps
/// changing under a still or hovering pointer is a resize loop: on screen it shakes.
///
/// The pointer is simulated inside this process only: mouse-moved events go straight to the window with
/// `sendEvent`, and every tracking area's owner gets entered, moved and exited calls directly. Nothing is
/// posted to the system, the real cursor never moves, and the window keeps ignoring real mouse events.
@MainActor enum DesignStability {
    struct Result { let name: String; let steady: Bool; let detail: String }

    /// Settles the window, then hovers and relayouts it for `ticks` rounds. Run once with the system's
    /// scrollers and once with legacy (always-shown) scrollers, as on a Mac with a mouse connected.
    static func check(_ window: NSWindow, name: String, ticks: Int = 48, styles: [Bool] = [false, true]) async -> [Result] {
        var results: [Result] = []
        for legacy in styles {
            // Both styles explicitly: the system's own choice depends on what's plugged into this Mac.
            for scroll in scrollViews(in:window) { scroll.scrollerStyle = legacy ? .legacy : .overlay }
            try? await Task.sleep(for:.milliseconds(ticks < 20 ? 250 : 700)) // settle
            let settled = snapshot(window)
            var seen: [String] = [settled.key]
            var changes: [String] = []
            let content = window.contentView!
            let points = grid(in:content.bounds, columns:6, rows:4)
            for tick in 0..<ticks {
                let point = points[tick % points.count]
                hover(window, at:point, tick:tick)
                content.needsLayout = true
                content.layoutSubtreeIfNeeded()
                try? await Task.sleep(for:.milliseconds(25))
                let now = snapshot(window)
                if now.key != seen.last! {
                    seen.append(now.key)
                    if changes.count < 4 { changes.append("tick \(tick): \(now.text)") }
                }
            }
            leave(window)
            let distinct = Set(seen).count
            let steady = distinct == 1
            let label = name + (legacy ? " (legacy scrollers)" : "")
            let detail = steady ? settled.text : "settled \(settled.text); \(distinct) states; " + changes.joined(separator:" | ")
            results.append(Result(name:label, steady:steady, detail:detail))
        }
        return results
    }

    /// What must not move: the window, its minimum size, each scroll view's visible width and document
    /// size, and whether its vertical scroller is showing.
    private static func snapshot(_ window: NSWindow) -> (key: String, text: String) {
        var parts = ["frame \(Int(window.frame.width))×\(Int(window.frame.height))@\(Int(window.frame.minX)),\(Int(window.frame.minY))",
                     "min \(Int(window.contentMinSize.width))×\(Int(window.contentMinSize.height))"]
        for (index, scroll) in scrollViews(in:window).enumerated() {
            let document = scroll.documentView?.frame.size ?? .zero
            let shown = scroll.hasVerticalScroller && scroll.verticalScroller?.isHidden == false && scroll.scrollerStyle == .legacy
            parts.append("scroll\(index) clip \(Int(scroll.contentView.frame.width)) doc \(Int(document.width))×\(Int(document.height))\(shown ? " bar" : "")")
        }
        let text = parts.joined(separator:", ")
        return (text, text)
    }

    private static func grid(in rect: NSRect, columns: Int, rows: Int) -> [NSPoint] {
        var points: [NSPoint] = []
        for row in 0..<rows { for column in 0..<columns {
            points.append(NSPoint(x:rect.minX + rect.width * (CGFloat(column) + 0.5) / CGFloat(columns),
                                  y:rect.minY + rect.height * (CGFloat(row) + 0.5) / CGFloat(rows)))
        } }
        return points
    }

    private static func hover(_ window: NSWindow, at point: NSPoint, tick: Int) {
        let time = ProcessInfo.processInfo.systemUptime
        let location = window.contentView!.convert(point, to:nil)
        if let moved = NSEvent.mouseEvent(with:.mouseMoved, location:location, modifierFlags:[], timestamp:time,
                                          windowNumber:window.windowNumber, context:nil, eventNumber:tick, clickCount:0, pressure:0) {
            window.sendEvent(moved)
        }
        // Tracking areas (hover effects, tooltips, cursor rects): enter, move inside, and on odd ticks exit.
        for view in allViews(window.contentView!.superview ?? window.contentView!) {
            for area in view.trackingAreas {
                guard let owner = area.owner as? NSResponder else { continue }
                let rect = area.options.contains(.inVisibleRect) ? view.visibleRect : area.rect
                guard rect.width > 0, rect.height > 0 else { continue }
                let inside = view.convert(NSPoint(x:rect.midX, y:rect.midY), to:nil)
                if let entered = NSEvent.enterExitEvent(with:.mouseEntered, location:inside, modifierFlags:[], timestamp:time,
                                                        windowNumber:window.windowNumber, context:nil, eventNumber:tick, trackingNumber:0, userData:nil) {
                    owner.mouseEntered(with:entered)
                }
                if let moved = NSEvent.mouseEvent(with:.mouseMoved, location:inside, modifierFlags:[], timestamp:time,
                                                  windowNumber:window.windowNumber, context:nil, eventNumber:tick, clickCount:0, pressure:0) {
                    owner.mouseMoved(with:moved)
                }
                if tick % 2 == 1, let exited = NSEvent.enterExitEvent(with:.mouseExited, location:inside, modifierFlags:[], timestamp:time,
                                                                      windowNumber:window.windowNumber, context:nil, eventNumber:tick, trackingNumber:0, userData:nil) {
                    owner.mouseExited(with:exited)
                }
            }
        }
    }

    private static func leave(_ window: NSWindow) {
        let time = ProcessInfo.processInfo.systemUptime
        for view in allViews(window.contentView!.superview ?? window.contentView!) {
            for area in view.trackingAreas {
                guard let owner = area.owner as? NSResponder,
                      let exited = NSEvent.enterExitEvent(with:.mouseExited, location:.zero, modifierFlags:[], timestamp:time,
                                                          windowNumber:window.windowNumber, context:nil, eventNumber:0, trackingNumber:0, userData:nil) else { continue }
                owner.mouseExited(with:exited)
            }
        }
    }

    static func scrollViews(in window: NSWindow) -> [NSScrollView] {
        allViews(window.contentView!).compactMap { $0 as? NSScrollView }
    }

    static func allViews(_ root: NSView) -> [NSView] {
        [root] + root.subviews.flatMap(allViews)
    }

    /// Resizes the window across a grid of sizes and runs a short hover check at each: a loop may only
    /// appear near the minimum size or where the content just fits.
    static func sweep(_ window: NSWindow, name: String) async -> [Result] {
        var results: [Result] = []
        let areas = allViews(window.contentView!.superview!).flatMap { view in view.trackingAreas.map { "\(type(of:view))/\(type(of:$0.owner as Any))" } }
        FileHandle.standardError.write(Data("tracking areas in \(name): \(areas.count) \(Set(areas).sorted().prefix(8))\n".utf8))
        for width in stride(from:760, through:1100, by:34) {
            for height in stride(from:500, through:760, by:20) {
                window.setContentSize(NSSize(width:width, height:height))
                let checked = await check(window, name:"\(name) \(width)×\(height)", ticks:12, styles:[true])
                results += checked.filter { !$0.steady }
            }
        }
        if results.isEmpty { results.append(Result(name:name + " sweep", steady:true, detail:"every size")) }
        return results
    }

    /// Where the page only just fits: at a few widths, finds the height at which the page's scroll
    /// content and the window are the same height, and checks every height 1 pt apart around it. A
    /// page whose height depends on its width loops in this band when the scroller takes room.
    static func fit(_ window: NSWindow, name: String) async -> [Result] {
        var results: [Result] = []
        for width in [820, 900, 1020] {
            window.setContentSize(NSSize(width:width, height:600))
            try? await Task.sleep(for:.milliseconds(400))
            guard let page = scrollViews(in:window).max(by: { $0.frame.width < $1.frame.width }),
                  let document = page.documentView?.frame.height else { continue }
            // The window height at which the page would exactly fill its scroll view.
            let visible = page.contentView.frame.height - page.contentInsets.top - page.contentInsets.bottom
            let fits = 600 + Int(document - visible)
            FileHandle.standardError.write(Data("fit \(name) \(width): page \(Int(document)) in \(Int(visible)), fits at \(fits)\n".utf8))
            for height in stride(from:fits - 24, through:fits + 24, by:1) where CGFloat(height) >= window.contentMinSize.height {
                window.setContentSize(NSSize(width:width, height:height))
                let checked = await check(window, name:"\(name) fit \(width)×\(height)", ticks:8, styles:[true])
                results += checked.filter { !$0.steady }
            }
        }
        if results.isEmpty { results.append(Result(name:name + " fit", steady:true, detail:"every height near the fit")) }
        return results
    }

    /// Half of a scroller loop, checked without waiting on SwiftUI: with legacy scrollers, does the page
    /// get a different width when it fits than when it scrolls? AppKit hides an unneeded legacy scroller
    /// and gives its 15–17 pt back to the page; a page whose height depends on its width then flips
    /// between the two whenever the window is within that difference of fitting. A steady page keeps
    /// its width either way (the scroller stays, or the page never takes the scroller's room).
    static func scrollerFlip(_ window: NSWindow, name: String) -> Result {
        let label = name + " scroller flip"
        guard let page = scrollViews(in:window).filter({ $0.hasVerticalScroller && $0.documentView != nil })
                .max(by: { $0.frame.width < $1.frame.width }), let document = page.documentView else {
            return Result(name:label, steady:true, detail:"no scrolling page")
        }
        let start = window.frame
        page.scrollerStyle = .legacy
        var widths: [String: CGFloat] = [:]
        for (key, slack) in [("scrolls", -120.0), ("fits", 160.0)] {
            let height = max(document.frame.height + slack, window.contentMinSize.height)
            window.setContentSize(NSSize(width:window.contentLayoutRect.width, height:height))
            page.tile()
            window.contentView!.layoutSubtreeIfNeeded()
            widths[key] = page.contentView.frame.width
        }
        window.setFrame(start, display:false)
        let steady = widths["scrolls"] == widths["fits"]
        let probes = allViews(window.contentView!).filter { String(describing:type(of:$0)).contains("Probe") }
        let found = probes.map { $0.enclosingScrollView.map { $0 === page ? "page" : "other" } ?? "none" }
        return Result(name:label, steady:steady, detail:"page width \(Int(widths["scrolls"] ?? 0)) when it scrolls, \(Int(widths["fits"] ?? 0)) when it fits; autohides \(page.autohidesScrollers); probes \(found)")
    }

    /// The window's minimum size is the one `ObjectsWindow.make` gives it; the SwiftUI content must not
    /// move it (a minimum that follows the content's layout can push the window back and forth).
    static func minimumSize(_ window: NSWindow, name: String, expected: NSSize) -> Result {
        // What a person dragging the corner can reach: the window's own minimum, or the content's
        // fixed constraints, whichever is larger.
        let start = window.frame
        window.setContentSize(NSSize(width:1, height:1))
        window.contentView!.layoutSubtreeIfNeeded()
        let fitting = window.contentView!.fittingSize
        window.setFrame(start, display:false)
        let now = NSSize(width:max(window.contentMinSize.width, fitting.width), height:max(window.contentMinSize.height, fitting.height))
        return Result(name:name + " minimum size", steady:now == expected,
                      detail:"\(Int(now.width))×\(Int(now.height)) (window \(Int(window.contentMinSize.width))×\(Int(window.contentMinSize.height)), content \(Int(fitting.width))×\(Int(fitting.height))), set \(Int(expected.width))×\(Int(expected.height))")
    }

    /// One line per result, to stderr, and whether every one was steady.
    static func report(_ results: [Result]) -> Bool {
        for result in results {
            FileHandle.standardError.write(Data("stability \(result.name): \(result.steady ? "steady" : "UNSTABLE") \(result.detail)\n".utf8))
        }
        return results.allSatisfy(\.steady)
    }
}
#endif
