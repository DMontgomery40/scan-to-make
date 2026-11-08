import SwiftUI

/// The Counterpart mark (docs/brand/counterpart-mark.svg): an object, solid, and its counterpart, outlined,
/// overlapping. The app icon draws the same two pieces in white on orange. As a shape it is drawn at
/// whatever size a surface needs and takes the surface's own colour and rendering mode (tinted, accented,
/// Always-On), which a bitmap of the icon can't.
///
/// The frame is the mark's own bounds (54 × 56 of the SVG's 100 units), so a 20 pt frame is a 20 pt mark.
/// Where the outline passes behind the solid piece it is cut back, as on the app icon, so the two read
/// as two pieces in a single colour.
public struct CounterpartMark: Shape {
    public init() {}

    /// The SVG's drawing, in its own units.
    static let bounds = CGRect(x: 23, y: 25, width: 54, height: 56)

    public func path(in rect: CGRect) -> Path {
        let bounds = Self.bounds
        let scale = min(rect.width / bounds.width, rect.height / bounds.height)
        let origin = CGPoint(x: rect.midX - bounds.width * scale / 2, y: rect.midY - bounds.height * scale / 2)
        func box(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
            CGRect(x: origin.x + (x - bounds.minX) * scale, y: origin.y + (y - bounds.minY) * scale, width: width * scale, height: height * scale)
        }
        let gap: CGFloat = 3.5
        let solid = Path(roundedRect: box(23, 25, 34, 50), cornerRadius: 8 * scale, style: .continuous)
        let outline = Path(roundedRect: box(46.5, 34.5, 27, 43), cornerRadius: 5 * scale, style: .continuous)
            .strokedPath(StrokeStyle(lineWidth: 7 * scale))
        let clearance = Path(roundedRect: box(23 - gap, 25 - gap, 34 + gap * 2, 50 + gap * 2), cornerRadius: (8 + gap) * scale, style: .continuous)
        var mark = solid
        mark.addPath(outline.subtracting(clearance))
        return mark
    }
}

/// Counterpart's colours outside the app target (widgets, the Live Activity): the same "filament orange"
/// as the app's accent, the app icon and Android's notification colour (#FF732E, PRD §10).
public enum CounterpartBrand {
    public static let orange = Color(red: 1.0, green: 0.45, blue: 0.18)
}
