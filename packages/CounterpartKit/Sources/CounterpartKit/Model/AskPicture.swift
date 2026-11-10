import Foundation
import CoreGraphics
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// The picture under a question from the Mac: shown at its own aspect ratio, the rest of the photo dimmed and the asked-about
/// region outlined, so it reads at arm's length (David, Nov 9, on his iPad: "the area it's highlighting is almost impossible
/// to see"). An ask carries no kind, so the caption only says where the question points, never what the Mac can or can't see.
public enum AskPicture {
    /// The words under the picture, true for every question.
    public static func caption(hasPhoto: Bool, hasRegion: Bool) -> String {
        guard hasPhoto else { return "Your project’s picture. No picture came with this question." }
        return hasRegion ? "The outlined part is what this question is about." : "The picture that goes with this question."
    }

    /// The caption for a project's open question.
    public static func caption(_ ask: Project.Ask?) -> String {
        caption(hasPhoto: ask?.photo != nil, hasRegion: ask?.photo != nil && ask?.region?.clamped != nil)
    }

    /// How dark the rest of the photo goes, and the outline's colour.
    public static let dimming = 0.5
    public static let outline = CGColor(srgbRed: 1, green: 0.62, blue: 0.04, alpha: 1)

    /// The photo with its region marked into the pixels, at full size, for the full-screen and Quick Look views: zoomed in,
    /// the outline stays sharp and stays on the part. Nil only if the image can't be drawn.
    public static func marked(_ image: CGImage, region: Project.Region?) -> CGImage? {
        let width = image.width, height = image.height
        guard width > 0, height > 0,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let full = CGRect(x: 0, y: 0, width: width, height: height)
        context.draw(image, in: full)
        guard let region = region?.clamped else { return context.makeImage() }
        // Core Graphics counts y from the bottom; the region counts from the top.
        let box = CGRect(x: region.x * Double(width), y: (1 - region.y - region.height) * Double(height),
                         width: region.width * Double(width), height: region.height * Double(height))
        let line = max(4, Double(max(width, height)) * 0.006)
        let corner = min(line * 2.5, min(box.width, box.height) / 2)
        let shape = CGPath(roundedRect: box, cornerWidth: corner, cornerHeight: corner, transform: nil)
        context.addRect(full)
        context.addPath(shape)
        context.setFillColor(CGColor(gray: 0, alpha: dimming))
        context.fillPath(using: .evenOdd)
        context.addPath(shape)
        context.setStrokeColor(outline)
        context.setLineWidth(line)
        context.strokePath()
        return context.makeImage()
    }

    /// `marked` for a photo on disk, written as a JPEG beside nothing else: what Quick Look and the full-screen view open.
    public static func markedFile(from source: URL, region: Project.Region?, to target: URL) -> Bool {
        guard let input = CGImageSourceCreateWithURL(source as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(input, 0, nil),
              let marked = marked(image, region: region),
              let output = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(output, marked, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
        return CGImageDestinationFinalize(output)
    }
}

public extension Project.Region {
    /// Inside the picture, or nil when nothing of it is.
    var clamped: Project.Region? {
        let left = min(max(x, 0), 1), top = min(max(y, 0), 1)
        let right = min(max(x + width, 0), 1), bottom = min(max(y + height, 0), 1)
        guard right - left > 0.001, bottom - top > 0.001, [x, y, width, height].allSatisfy(\.isFinite) else { return nil }
        return Project.Region(x: left, y: top, width: right - left, height: bottom - top)
    }
}

/// The region drawn over a picture that fills this view at its own aspect ratio: the rest dimmed, the region outlined.
public struct AskRegionOverlay: View {
    let region: Project.Region?
    public init(region: Project.Region?) { self.region = region }
    public var body: some View {
        GeometryReader { g in
            if let r = region?.clamped {
                let box = CGRect(x: g.size.width * r.x, y: g.size.height * r.y, width: g.size.width * r.width, height: g.size.height * r.height)
                let corner = min(10, min(box.width, box.height) / 2)
                ZStack {
                    Path { path in
                        path.addRect(CGRect(origin: .zero, size: g.size))
                        path.addRoundedRect(in: box, cornerSize: CGSize(width: corner, height: corner))
                    }
                    .fill(Color.black.opacity(AskPicture.dimming), style: FillStyle(eoFill: true))
                    RoundedRectangle(cornerRadius: corner).strokeBorder(Color(cgColor: AskPicture.outline), lineWidth: 3)
                        .shadow(color: .black.opacity(0.45), radius: 3)
                        .frame(width: box.width, height: box.height)
                        .position(x: box.midX, y: box.midY)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
