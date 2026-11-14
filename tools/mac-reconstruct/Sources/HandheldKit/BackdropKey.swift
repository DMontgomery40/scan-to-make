import Foundation
import CoreVideo
import CoreImage
import Vision

/// A deliberate coloured backdrop (a green screen, or the lime panel on David's scan rig), keyed out of each photo
/// before the rebuild. Any scan can have one; nothing here knows about the rig (David, Nov 9, PRD §5.2: "don't
/// hardcode the rig's existence").
///
/// Apple's own object masking keeps such a panel: on the Nov 8 and Nov 14 DAD scans the rig's panel filled the letters'
/// counters and the D–A / A–D slots, and the model came back with green surface fused between the letters. The point
/// of a backdrop is that it can be removed, so it is removed here, by colour, in photos that show one.
///
/// The colour test is saturated yellow-green to green with almost no blue. Measured on the Nov 14 photos: the panel
/// at RGB ≈ (160,147,31) under warm light to (202,211,67) in daylight; the wood base (152,119,82), the black letters
/// (≈35,27,18) and the grey plate (166,139,116) all fail it. A classic green screen (0,255,0) passes. So do grass,
/// foliage and a yellow-green wall, which is why a photo shows a backdrop only when its largest region of the colour
/// is one flat, uniform panel behind the object (`Frame.isBackdrop`), never textured, varied green.
public enum BackdropKey {
    @inline(__always)
    public static func isBackdrop(r: Int, g: Int, b: Int) -> Bool {
        g > 60 && g * 100 > r * 82 && b * 100 < g * 42
    }

    /// How far behind the nearest surface in the frame the panel must sit to count as a backdrop (metres).
    /// A yellow or green object is at the object's own depth and is never keyed; the rig's panel sits ~0.4 m behind.
    public static let minimumGap: Float = 0.12
    /// Below this share of the frame the colour is a stray (a tape measure, a label), not a backdrop.
    public static let minimumShare = 0.02
    /// The panel: its largest region of the colour (depth cells mostly that colour, 4-connected) covers at least this
    /// share of the photo, its cells are on average at least `minimumFill` that colour (flat, not broken up like grass
    /// or leaves), and the middle 80% of its cells' mean hues spans at most `maximumHueSpread` degrees (one paint, not
    /// many greens).
    public static let minimumPanelShare = 0.02
    public static let minimumFill = 0.9
    public static let maximumHueSpread: Float = 10
    /// A region of the colour this big (share of the photo) at the object's depth is part of the object and stays.
    /// Smaller ones, which the depth map can't measure (a letter's counter, the slot between letters), are backdrop.
    public static let objectRegionShare = 0.02

    public struct Frame {
        /// 255 = keep (object or anything that isn't the backdrop), 0 = backdrop. Same size as the photo.
        public var keep: GrayImage
        /// Share of the photo in the backdrop colour.
        public var share: Double
        /// The largest region of the colour: its share of the photo, how solidly its cells are that colour (0…1), the
        /// spread of its cells' hues (degrees), and its median depth; and the nearest surface (5th percentile), in metres.
        public var panelShare: Double = 0
        public var fill: Double = 0
        public var hueSpread: Float = .infinity
        public var backdropDepth: Float?
        public var nearestDepth: Float?
        /// Whether this photo shows a deliberate backdrop: a flat, uniform panel of the colour, behind the object.
        public var isBackdrop: Bool {
            guard share >= BackdropKey.minimumShare, panelShare >= BackdropKey.minimumPanelShare,
                  fill >= BackdropKey.minimumFill, hueSpread <= BackdropKey.maximumHueSpread else { return false }
            guard let backdropDepth, let nearestDepth else { return false }
            return backdropDepth - nearestDepth >= BackdropKey.minimumGap
        }
    }

    /// The hue of a pixel of the colour, in degrees (green is 120, yellow 60).
    @inline(__always)
    static func hue(r: Int, g: Int, b: Int) -> Float {
        let high = max(r, g, b), low = min(r, g, b)
        guard high > low else { return 0 }
        let span = Float(high - low)
        if high == g { return 60 * (Float(b - r) / span + 2) }
        if high == r { return (60 * Float(g - b) / span).truncatingRemainder(dividingBy: 360) }
        return 60 * (Float(r - g) / span + 4)
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
        // Per depth cell: how many pixels, how many of the colour, and the sum of their hues.
        let cw = max(1, depth?.width ?? 1), ch = max(1, depth?.height ?? 1)
        var total = [Int](repeating: 0, count: cw * ch), coloured = total, hues = [Float](repeating: 0, count: cw * ch)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes), cellRow = min(ch - 1, y * ch / height) * cw
            for x in 0..<width {
                let p = row.advanced(by: x * 4)
                let r = Int(p[2]), g = Int(p[1]), b = Int(p[0]), c = cellRow + min(cw - 1, x * cw / width)
                total[c] += 1
                if isBackdrop(r: r, g: g, b: b) {
                    keyed.pixels[y * width + x] = 255; count += 1
                    coloured[c] += 1; hues[c] += hue(r: r, g: g, b: b)
                }
            }
        }
        let cells = Cells(width: cw, height: ch,
                          fraction: zip(coloured, total).map { $1 > 0 ? Double($0) / Double($1) : 0 },
                          hue: zip(hues, coloured).map { $1 > 0 ? $0 / Float($1) : .nan })
        return frame(keyed: keyed, count: count, depth: depth, cells: cells, edge: edge)
    }

    /// The photo at the depth map's resolution: each cell's share of pixels in the colour, and their mean hue.
    public struct Cells {
        public var width: Int, height: Int
        public var fraction: [Double]
        public var hue: [Float]
        public init(width: Int, height: Int, fraction: [Double], hue: [Float]) {
            self.width = width; self.height = height; self.fraction = fraction; self.hue = hue
        }
    }

    /// The decision and the keep mask from a keyed (255 = backdrop colour) image; split out so tests can drive it.
    public static func frame(keyed: GrayImage, count: Int, depth: DepthImage?, cells: Cells, edge: Int) -> Frame {
        let width = keyed.width, height = keyed.height
        var result = Frame(keep: GrayImage(width: width, height: height, fill: 255),
                           share: Double(count) / Double(max(1, width * height)))
        guard let depth, depth.width == cells.width, depth.height == cells.height, depth.width > 0, depth.height > 0 else { return result }
        let all = depth.metres.filter { $0 > 0 && $0.isFinite }.sorted()
        guard !all.isEmpty else { return result }
        let nearestDepth = all[all.count / 20]
        result.nearestDepth = nearestDepth
        // Regions of the colour: depth cells mostly that colour, 4-connected.
        let total = cells.width * cells.height
        let colour = cells.fraction.map { $0 >= 0.5 }
        var seen = [Bool](repeating: false, count: total), regions: [[Int]] = []
        for start in 0..<total where colour[start] && !seen[start] {
            var region = [start], next = 0
            seen[start] = true
            while next < region.count {
                let c = region[next]; next += 1
                let cx = c % cells.width, cy = c / cells.width
                for (nx, ny) in [(cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)]
                where nx >= 0 && ny >= 0 && nx < cells.width && ny < cells.height {
                    let n = ny * cells.width + nx
                    if colour[n] && !seen[n] { seen[n] = true; region.append(n) }
                }
            }
            regions.append(region)
        }
        func medianDepth(_ region: [Int]) -> Float? {
            let readings = region.map { depth.metres[$0] }.filter { $0 > 0 && $0.isFinite }.sorted()
            return readings.isEmpty ? nil : readings[readings.count / 2]
        }
        // The panel: the largest region, if it is one flat, uniform piece of the colour behind the object.
        if let panel = regions.max(by: { $0.count < $1.count }) {
            result.panelShare = Double(panel.count) / Double(total)
            result.fill = panel.map { cells.fraction[$0] }.reduce(0, +) / Double(panel.count)
            let hues = panel.map { cells.hue[$0] }.filter { !$0.isNaN }.sorted()
            if !hues.isEmpty { result.hueSpread = hues[min(hues.count - 1, hues.count * 9 / 10)] - hues[hues.count / 10] }
            result.backdropDepth = medianDepth(panel)
        }
        guard result.isBackdrop else { return result }
        // Which regions of the colour are the object's own (review of #793): a green or yellow part of the object in the
        // same photo as the panel must stay. The LiDAR can say so only for a region big enough to measure: the depth
        // map is upsampled from far fewer points, so a letter's counter or the slot between two letters reads at the
        // letter's own depth even where the panel shows through (on David's Nov 8 scan, keying by depth per pixel
        // closed the A's counters again). So: regions of at least `objectRegionShare` of the photo whose median depth
        // sits within `minimumGap` of the nearest surface are the object's, with a cell round them for the blurred
        // edge; every other pixel of the colour is backdrop.
        var own = [Bool](repeating: false, count: total)
        for region in regions where Double(region.count) >= objectRegionShare * Double(total) {
            guard let median = medianDepth(region), median - nearestDepth < minimumGap else { continue }
            for c in region {
                let cx = c % cells.width, cy = c / cells.width
                for ny in max(0, cy - 1)...min(cells.height - 1, cy + 1) {
                    for nx in max(0, cx - 1)...min(cells.width - 1, cx + 1) { own[ny * cells.width + nx] = true }
                }
            }
        }
        // Keep = not backdrop, grown by `edge` so the key stops short of the object's edge.
        var notKeyed = keyed
        for y in 0..<height {
            let row = min(cells.height - 1, y * cells.height / height) * cells.width
            for x in 0..<width {
                let i = y * width + x
                notKeyed.pixels[i] = keyed.pixels[i] > 127 && !own[row + min(cells.width - 1, x * cells.width / width)] ? 0 : 255
            }
        }
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
