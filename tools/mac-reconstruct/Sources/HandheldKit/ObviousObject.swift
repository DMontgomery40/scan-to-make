import Foundation
import CoreVideo
import RealityKit
import Vision

/// One thing Vision's foreground instance segmentation found in a photo, measured for choosing.
public struct FoundInstance: Equatable {
    public var label: Int
    /// Share of the frame it covers.
    public var area: Double
    /// Its centre as a fraction of the stored image, top-left origin.
    public var u: Double, v: Double
    /// How many frame edges it runs into (a table, a wall or an arm runs off the frame; the object usually doesn't).
    public var edges: Int
    /// Its median LiDAR depth in metres, when the photo carries depth.
    public var depth: Float?
    public init(label: Int, area: Double, u: Double, v: Double, edges: Int, depth: Float?) {
        self.label = label; self.area = area; self.u = u; self.v = v; self.edges = edges; self.depth = depth
    }
}

/// The obvious object in a walk-around photo, where the object stays still (on a table or a scan rig) and the phone
/// moves round it. No capture box: Vision finds the separate things in front of the background
/// (`VNGenerateForegroundInstanceMaskRequest`, macOS 14), and common sense picks the one being scanned.
public final class ObviousObjectMasker {
    public struct Result {
        /// Full resolution, 255 where the object is. Nil when Vision found nothing: RealityKit masks that photo itself.
        public var mask: GrayImage?
        public var instances: Int
        public var chosen: FoundInstance?
    }

    /// Metres behind the chosen instance's nearest surface that still count as the object: a person or the room
    /// behind it, merged into one foreground instance by Vision, is cut away.
    public var depthBand: Float = 0.30
    private var last: FoundInstance?
    public init() {}

    /// Picks the instance the person is scanning:
    /// - near the middle of the frame, because the phone is pointed at it;
    /// - nearest the camera, where the photo carries depth: in front of the backdrop and the room;
    /// - not running off the frame;
    /// - not a speck (under 2% of the frame counts for less);
    /// - the same thing as in the previous photo (photos arrive in capture order, a little apart).
    public static func choose(_ instances: [FoundInstance], last: FoundInstance?) -> FoundInstance? {
        let candidates = instances.filter { $0.area >= 0.002 }
        let nearest = candidates.compactMap(\.depth).min()
        func score(_ i: FoundInstance) -> Double {
            var s = exp(-3 * hypot(i.u - 0.5, i.v - 0.5))
            if let d = i.depth, let nearest { s *= exp(-Double(d - nearest) / 0.25) }
            if i.edges >= 2 { s *= 0.3 }
            s *= min(1, i.area / 0.02)
            if let last {
                if hypot(i.u - last.u, i.v - last.v) < 0.2 { s *= 1.5 }
                if let d = i.depth, let previous = last.depth, abs(d - previous) < 0.15 { s *= 1.5 }
            }
            return s
        }
        return candidates.max { score($0) < score($1) }
    }

    public func mask(image: CVPixelBuffer, depth: DepthImage?) throws -> Result {
        // The stored pixels, as PhotogrammetrySample.image has them, so the mask lines up with the image it masks.
        let handler = VNImageRequestHandler(cvPixelBuffer: image, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([request])
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            return Result(mask: nil, instances: 0, chosen: nil)
        }
        let labels = GrayImage(buffer: observation.instanceMask)
        let w = labels.width, h = labels.height
        var count = [Int](repeating: 0, count: 256), su = [Double](repeating: 0, count: 256), sv = [Double](repeating: 0, count: 256)
        var minX = [Int](repeating: .max, count: 256), maxX = [Int](repeating: -1, count: 256)
        var minY = [Int](repeating: .max, count: 256), maxY = [Int](repeating: -1, count: 256)
        var depths = [[Float]](repeating: [], count: 256)
        let step = max(1, min(w, h) / 96)
        for y in 0..<h { for x in 0..<w {
            let l = Int(labels.pixels[y * w + x])
            guard l != 0 else { continue }
            count[l] += 1; su[l] += Double(x); sv[l] += Double(y)
            minX[l] = min(minX[l], x); maxX[l] = max(maxX[l], x); minY[l] = min(minY[l], y); maxY[l] = max(maxY[l], y)
            if let depth, x % step == 0, y % step == 0 {
                let d = depth.at(u: (Double(x) + 0.5) / Double(w), v: (Double(y) + 0.5) / Double(h))
                if d > 0.05 { depths[l].append(d) }
            }
        } }
        var near: [Int: Float] = [:]
        let found = observation.allInstances.compactMap { label -> FoundInstance? in
            guard label < 256, count[label] > 0 else { return nil }
            let n = Double(count[label])
            let edges = [minX[label] == 0, maxX[label] == w - 1, minY[label] == 0, maxY[label] == h - 1].filter { $0 }.count
            let sorted = depths[label].sorted()
            if sorted.count >= 20 { near[label] = sorted[sorted.count / 50] }   // a robust nearest: 2nd percentile
            return FoundInstance(label: label, area: n / Double(w * h), u: (su[label] / n + 0.5) / Double(w), v: (sv[label] / n + 0.5) / Double(h),
                                 edges: edges, depth: sorted.isEmpty ? nil : sorted[sorted.count / 2])
        }
        guard let chosen = Self.choose(found, last: last) else { return Result(mask: nil, instances: found.count, chosen: nil) }
        last = chosen
        // Vision's mask at the photo's own size; its soft edge counts as object, so the object's rim isn't cut.
        let scaled = try observation.generateScaledMaskForImage(forInstances: IndexSet(integer: chosen.label), from: handler)
        var mask = GrayImage(buffer: scaled)
        for i in mask.pixels.indices { mask.pixels[i] = mask.pixels[i] >= 64 ? 255 : 0 }
        // Vision often returns the object, what it stands on and whoever is behind it as one instance: keep only what
        // is within `depthBand` of its nearest surface.
        if let depth, let nearest = near[chosen.label] {
            let limit = nearest + depthBand, mw = mask.width, mh = mask.height
            for y in 0..<mh { for x in 0..<mw where mask.pixels[y * mw + x] != 0 {
                let d = depth.at(u: (Double(x) + 0.5) / Double(mw), v: (Double(y) + 0.5) / Double(mh))
                if d > limit { mask.pixels[y * mw + x] = 0 }
            } }
        }
        return Result(mask: mask.onCount > 0 ? mask : nil, instances: found.count, chosen: chosen)
    }
}

/// One walk-around photo as Apple wrote it: pixels, LiDAR depth, gravity, camera and metadata. Unlike a handheld
/// photo, gravity stays: the object is still and the phone moves, so gravity says which way is up.
public func loadWalkAroundSample(_ url: URL) throws -> PhotogrammetrySample {
    var sample = try PhotogrammetrySample(contentsOf: url)
    if sample.depthDataMap == nil, let depth = embeddedDepth(in: url) { sample.depthDataMap = depth.pixelBuffer() }
    return sample
}
