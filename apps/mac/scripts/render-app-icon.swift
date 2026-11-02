// The Counterpart mark from the mockups (docs/design/overhaul/mockup-app, `AppIconMac`): two interlocking pieces, an
// object and its counterpart, on the filament-orange accent (PRD §10). It stands in until the layered Icon Composer icon
// (PRD §10 "App icon") replaces it. Regenerate the icon set and AppMark with:
//   swiftc -O -o /tmp/render-app-icon apps/mac/scripts/render-app-icon.swift && /tmp/render-app-icon apps/mac/App/Assets.xcassets
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(colorSpace: srgb, components: [r, g, b, a])! }

/// `grid`: Apple's macOS icon grid (an 824 body on a 1024 canvas, with its shadow). Otherwise the mark fills the square.
func render(_ n: Int, grid: Bool) -> CGImage {
    let N = CGFloat(n)
    let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    let inset = grid ? N * 100 / 1024 : 0
    let body = N - 2 * inset
    let rect = CGRect(x: inset, y: inset, width: body, height: body)
    let radius = body * (grid ? 0.2237 : 0.23)
    let shape = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    if grid {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -N * 0.0098), blur: N * 0.0195, color: color(0, 0, 0, 0.3))
        ctx.addPath(shape); ctx.setFillColor(color(0.9, 0.3, 0.12)); ctx.fillPath()
        ctx.restoreGState()
    }
    // The accent, filament orange, to a deeper orange (PRD §10), top-leading to bottom-trailing.
    ctx.saveGState()
    ctx.addPath(shape); ctx.clip()
    let gradient = CGGradient(colorsSpace: srgb, colors: [color(1.0, 0.45, 0.18), color(0.85, 0.2, 0.1)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: rect.minX, y: rect.maxY), end: CGPoint(x: rect.maxX, y: rect.minY), options: [])
    ctx.restoreGState()
    // Two interlocking pieces: the object (filled) and its counterpart (outlined).
    let w = body * 0.34, h = body * 0.5, r = body * 0.08, line = body * 0.07
    let cx = rect.midX, cy = rect.midY
    let object = CGRect(x: cx - body * 0.1 - w / 2, y: cy - h / 2, width: w, height: h)
    ctx.addPath(CGPath(roundedRect: object, cornerWidth: r, cornerHeight: r, transform: nil))
    ctx.setFillColor(color(1, 1, 1)); ctx.fillPath()
    let counterpart = CGRect(x: cx + body * 0.1 - w / 2, y: cy - body * 0.06 - h / 2, width: w, height: h).insetBy(dx: line / 2, dy: line / 2)
    ctx.addPath(CGPath(roundedRect: counterpart, cornerWidth: r - line / 2, cornerHeight: r - line / 2, transform: nil))
    ctx.setStrokeColor(color(1, 1, 1)); ctx.setLineWidth(line); ctx.strokePath()
    return ctx.makeImage()!
}

func write(_ image: CGImage, _ url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    precondition(CGImageDestinationFinalize(dest))
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let icons = out.appendingPathComponent("AppIcon.appiconset"), mark = out.appendingPathComponent("AppMark.imageset")
for (name, size) in [("16x16", 16), ("32x32", 32), ("128x128", 128), ("256x256", 256), ("512x512", 512)] {
    write(render(size, grid: true), icons.appendingPathComponent("icon_\(name).png"))
    write(render(size * 2, grid: true), icons.appendingPathComponent("icon_\(name)@2x.png"))
}
write(render(512, grid: false), mark.appendingPathComponent("AppMark.png"))
print("ok")
