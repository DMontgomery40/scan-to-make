import AppKit

// Scan to Make mark: a viewfinder (scan) framing an isometric cube (make), white on cobalt.
func draw(size: Int, rounded: Bool, to path: String) {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes:nil, pixelsWide:size, pixelsHigh:size, bitsPerSample:8, samplesPerPixel:4,
                               hasAlpha:true, isPlanar:false, colorSpaceName:.deviceRGB, bytesPerRow:0, bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let cobalt = CGColor(red:0x24/255, green:0x48/255, blue:0xD8/255, alpha:1)
    let deep = CGColor(red:0x1B/255, green:0x37/255, blue:0xA8/255, alpha:1)
    let rect = CGRect(x:0, y:0, width:s, height:s)
    if rounded { ctx.addPath(CGPath(roundedRect:rect, cornerWidth:s * 0.225, cornerHeight:s * 0.225, transform:nil)); ctx.clip() }
    // A quiet vertical gradient so it isn't a flat swatch.
    let gradient = CGGradient(colorsSpace:CGColorSpaceCreateDeviceRGB(), colors:[cobalt, deep] as CFArray, locations:[0, 1])!
    ctx.drawLinearGradient(gradient, start:CGPoint(x:0, y:s), end:CGPoint(x:0, y:0), options:[])
    ctx.setStrokeColor(CGColor(gray:1, alpha:1))
    ctx.setLineCap(.round); ctx.setLineJoin(.round)
    // Viewfinder corners.
    let inset = s * 0.18, arm = s * 0.15, w = s * 0.055
    ctx.setLineWidth(w)
    for (cx, cy, dx, dy) in [(inset, inset, 1.0, 1.0), (s - inset, inset, -1.0, 1.0), (inset, s - inset, 1.0, -1.0), (s - inset, s - inset, -1.0, -1.0)] {
        ctx.move(to:CGPoint(x:cx, y:cy + dy * arm)); ctx.addLine(to:CGPoint(x:cx, y:cy)); ctx.addLine(to:CGPoint(x:cx + dx * arm, y:cy))
        ctx.strokePath()
    }
    // Isometric cube, centred.
    let c = CGPoint(x:s / 2, y:s / 2 - s * 0.01), r = s * 0.2
    let cos30 = CGFloat(0.8660254)
    let top = CGPoint(x:c.x, y:c.y + r), bottom = CGPoint(x:c.x, y:c.y - r)
    let ul = CGPoint(x:c.x - r * cos30, y:c.y + r / 2), ur = CGPoint(x:c.x + r * cos30, y:c.y + r / 2)
    let ll = CGPoint(x:c.x - r * cos30, y:c.y - r / 2), lr = CGPoint(x:c.x + r * cos30, y:c.y - r / 2)
    // Top face filled lightly, so it reads as a solid printed part.
    ctx.setFillColor(CGColor(gray:1, alpha:0.28))
    ctx.move(to:top); ctx.addLine(to:ur); ctx.addLine(to:c); ctx.addLine(to:ul); ctx.closePath(); ctx.fillPath()
    ctx.setLineWidth(s * 0.045)
    ctx.move(to:top); ctx.addLine(to:ur); ctx.addLine(to:lr); ctx.addLine(to:bottom); ctx.addLine(to:ll); ctx.addLine(to:ul); ctx.closePath()
    ctx.move(to:ul); ctx.addLine(to:c); ctx.addLine(to:ur)
    ctx.move(to:c); ctx.addLine(to:bottom)
    ctx.strokePath()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using:.png, properties:[:])!.write(to:URL(fileURLWithPath:path))
}
let out = CommandLine.arguments[1]
draw(size:1024, rounded:false, to:out + "/AppIcon-1024.png")
for (scale, px) in [(1, 44), (2, 88), (3, 132)] { draw(size:px, rounded:true, to:out + "/logo" + (scale == 1 ? "" : "@\(scale)x") + ".png") }
draw(size:512, rounded:true, to:out + "/preview.png")
