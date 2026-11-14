import Foundation
import CoreVideo
import CoreImage
import Vision

/// A scan rig's coloured backdrop, keyed out of each photo before the rebuild.
///
/// David's rig carries a lime panel on the arm, opposite the phone, so it stays behind the object in every photo.
/// Apple's own object masking kept it: on the Nov 8 and Nov 14 DAD scans the panel filled the letters' counters and
/// the D–A / A–D slots, and the model came back with green surface fused between the letters. The point of a
/// backdrop is that it can be removed, so it is removed here, by colour, and only where depth says it is behind.
///
/// The colour test is saturated yellow-green to green with almost no blue. Measured on the Nov 14 photos: the panel
/// at RGB ≈ (160,147,31) under warm light to (202,211,67) in daylight; the wood base (152,119,82), the black letters
/// (≈35,27,18) and the grey plate (166,139,116) all fail it. A classic green screen (0,255,0) passes.
public enum BackdropKey {
    @inline(__always)
    public static func isBackdrop(r: Int, g: Int, b: Int) -> Bool {
        g > 60 && g * 100 > r * 82 && b * 100 < g * 42
    }

    /// How far behind the nearest surface in the frame the keyed colour must sit to count as a backdrop (metres).
    /// A yellow or green object is at the object's own depth and is never keyed; the rig's panel sits ~0.4 m behind.
    public static let minimumGap: Float = 0.12
    /// Below this share of the frame the colour is a stray (a tape measure, a label), not a backdrop.
    public static let minimumShare = 0.02

    public struct Frame {
        /// 255 = keep (object or anything that isn't the backdrop), 0 = backdrop. Same size as the photo.
        public var keep: GrayImage
        /// Share of the photo in the backdrop colour.
        public var share: Double
        /// Median depth of the backdrop-coloured pixels, and of the nearest surface (5th percentile), in metres.
        public var backdropDepth: Float?
        public var nearestDepth: Float?
        /// Whether this photo shows a backdrop: enough of the colour, and behind the nearest surface.
        public var isBackdrop: Bool {
            guard share >= BackdropKey.minimumShare else { return false }
            guard let backdropDepth, let nearestDepth else { return false }
            return backdropDepth - nearestDepth >= BackdropKey.minimumGap
        }
    }

    /// Keys one photo. `edge` pixels of backdrop next to anything else are kept, so dark object edges with green
    /// spill stay on the object rather than being eaten by the key.
    public static func key(image: CVPixelBuffer, depth: DepthImage?, edge: Int = 2) throws -> Frame {
        let bgra = try bgraCopy(of: image)
        CVPixelBufferLockBaseAddress(bgra, .readOnly); defer { CVPixelBufferUnlockBaseAddress(bgra, .readOnly) }
        let width = CVPixelBufferGetWidth(bgra), height = CVPixelBufferGetHeight(bgra)
        let rowBytes = CVPixelBufferGetBytesPerRow(bgra)
        let base = CVPixelBufferGetBaseAddress(bgra)!.assumingMemoryBound(to: UInt8.self)
        var keyed = GrayImage(width: width, height: height)
        var count = 0
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes)
            for x in 0..<width {
                let p = row.advanced(by: x * 4)
                if isBackdrop(r: Int(p[2]), g: Int(p[1]), b: Int(p[0])) { keyed.pixels[y * width + x] = 255; count += 1 }
            }
        }
        return frame(keyed: keyed, count: count, depth: depth, edge: edge)
    }

    /// The decision and the keep mask from a keyed (255 = backdrop colour) image; split out so tests can drive it.
    public static func frame(keyed: GrayImage, count: Int, depth: DepthImage?, edge: Int) -> Frame {
        let width = keyed.width, height = keyed.height
        var backdropDepth: Float? = nil, nearestDepth: Float? = nil
        if let depth, depth.width > 0, depth.height > 0 {
            var behind: [Float] = [], all: [Float] = []
            let cellW = max(1, width / depth.width), cellH = max(1, height / depth.height)
            for dy in 0..<depth.height {
                for dx in 0..<depth.width {
                    let d = depth.metres[dy * depth.width + dx]
                    guard d > 0, d.isFinite else { continue }
                    all.append(d)
                    // A depth cell counts as backdrop when most of its photo pixels are backdrop-coloured.
                    let x0 = dx * width / depth.width, y0 = dy * height / depth.height
                    var on = 0, n = 0
                    for y in stride(from: y0, to: min(height, y0 + cellH), by: 2) {
                        for x in stride(from: x0, to: min(width, x0 + cellW), by: 2) { n += 1; if keyed.pixels[y * width + x] > 127 { on += 1 } }
                    }
                    if n > 0 && on * 4 >= n * 3 { behind.append(d) }
                }
            }
            if behind.count >= 8 { behind.sort(); backdropDepth = behind[behind.count / 2] }
            if !all.isEmpty { all.sort(); nearestDepth = all[all.count / 20] }
        }
        var result = Frame(keep: GrayImage(width: width, height: height, fill: 255),
                           share: Double(count) / Double(max(1, width * height)),
                           backdropDepth: backdropDepth, nearestDepth: nearestDepth)
        guard result.isBackdrop else { return result }
        // Keep = not backdrop, grown by `edge` so the key stops short of the object's edge.
        var notKeyed = keyed
        for i in notKeyed.pixels.indices { notKeyed.pixels[i] = keyed.pixels[i] > 127 ? 0 : 255 }
        result.keep = edge > 0 ? notKeyed.dilated(by: edge) : notKeyed
        return result
    }

    /// The object mask for a keyed photo: Vision's foreground (every instance it finds) minus the backdrop.
    /// Supplying a mask switches off Apple's own object masking for that photo, so the mask must also leave out the
    /// room, the table and the rig's stand, not just the panel (on Nov 14, the key alone brought all three in).
    /// Nil when Vision finds no foreground; the photo then keeps Apple's own masking.
    public static func objectMask(image: CVPixelBuffer, frame: Frame) throws -> GrayImage? {
        guard frame.isBackdrop else { return nil }
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: image, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else { return nil }
        let scaled = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
        let foreground = GrayImage(buffer: scaled).resized(width: frame.keep.width, height: frame.keep.height).thresholded()
        var mask = frame.keep
        for i in mask.pixels.indices where foreground.pixels[i] < 128 { mask.pixels[i] = 0 }
        // An opening drops what the key leaves as thin lines and specks (the panel's rim, glare on it) and keeps
        // anything thicker than `cleanup` pixels, which every part of the object is at 4032 × 3024.
        mask = opened(mask, by: cleanup)
        return mask.onCount > 0 ? mask : nil
    }

    /// Radius of the opening that cleans a mask (pixels).
    public static let cleanup = 4

    static func opened(_ mask: GrayImage, by radius: Int) -> GrayImage {
        guard radius > 0 else { return mask }
        var inverse = mask
        for i in inverse.pixels.indices { inverse.pixels[i] = mask.pixels[i] > 127 ? 0 : 255 }
        var eroded = inverse.dilated(by: radius)
        for i in eroded.pixels.indices { eroded.pixels[i] = eroded.pixels[i] > 127 ? 0 : 255 }
        return eroded.dilated(by: radius)
    }

    /// A 32BGRA copy of any photo buffer (Object Capture HEICs decode as YCbCr).
    static func bgraCopy(of buffer: CVPixelBuffer) throws -> CVPixelBuffer {
        if CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA { return buffer }
        var out: CVPixelBuffer?
        CVPixelBufferCreate(nil, CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
        guard let copy = out else { throw HandheldError.io("can't allocate a BGRA buffer") }
        context.render(CIImage(cvPixelBuffer: buffer), to: copy, bounds: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)),
                       colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        return copy
    }
    private static let context = CIContext(options: [.workingColorSpace: NSNull()])
}
