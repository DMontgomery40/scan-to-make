import SwiftUI
import AppKit

// The iPhone app icon: the mockups' Counterpart mark, full bleed (iOS rounds the corners itself).
// Usage: swift apps/mobile/scripts/render-app-icon.swift apps/mobile/ios/ScanToMake/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png
let filament = Color(red: 1.0, green: 0.45, blue: 0.18)
struct Mark: View {
    let size: CGFloat
    var body: some View {
        ZStack {
            Rectangle().fill(LinearGradient(colors: [filament, Color(red: 0.85, green: 0.2, blue: 0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.08).fill(.white).frame(width: size * 0.34, height: size * 0.5).offset(x: -size * 0.1)
                RoundedRectangle(cornerRadius: size * 0.08).strokeBorder(.white, lineWidth: size * 0.07).frame(width: size * 0.34, height: size * 0.5).offset(x: size * 0.1, y: size * 0.06)
            }
        }
        .frame(width: size, height: size)
    }
}
@MainActor func render() {
    let renderer = ImageRenderer(content: Mark(size: 1024))
    renderer.scale = 1
    guard let cg = renderer.cgImage else { fatalError("no image") }
    // No alpha: iOS app icons are opaque.
    let ctx = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
}
MainActor.assumeIsolated { render() }
