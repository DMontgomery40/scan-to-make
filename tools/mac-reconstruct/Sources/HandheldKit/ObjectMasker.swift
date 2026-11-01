import Foundation
import CoreVideo
import Vision

/// Cuts the held object out of a handheld photo: the object, without the hand holding it or the room behind it.
///
/// Measured on real photos (KAN-210): Vision's foreground-instance mask returns hand and object as one instance
/// when the hand touches the object, and person segmentation counts a held object as part of the person, so
/// "foreground minus person" deletes the object. Instead this seeds Vision's promptable segmentation
/// (`GenerateIterativeSegmentationRequest`, macOS/iOS 27) with a point inside the object and the hand's
/// joints as excluded points, then drops anything beyond the object's depth.
public final class ObjectMasker {
    public struct Result {
        public var mask: GrayImage
        /// Seed inside the object, as a fraction of the image (top-left origin).
        public var seed: (u: Double, v: Double)?
        public var handJoints: Int
        public var method: String
        public var excludedPoints: Int = 0
    }

    /// Metres behind the nearest surface in the frame that still count as the held object.
    public var depthBand: Float = 0.20
    private var lastSeed: (u: Double, v: Double)?

    public init() {}

    public func mask(image original: CVPixelBuffer, depth: DepthImage?) async throws -> Result {
        let image = try ioSurfaceBacked(original)   // for the Metal-backed promptable request
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        let handler = VNImageRequestHandler(cvPixelBuffer: original, options: [:])
        let foreground = VNGenerateForegroundInstanceMaskRequest()
        let hands = VNDetectHumanHandPoseRequest(); hands.maximumHandCount = 2
        let person = VNGeneratePersonSegmentationRequest(); person.qualityLevel = .balanced
        try handler.perform([hands])
        try handler.perform([foreground])
        try handler.perform([person])

        var candidate: GrayImage
        if let observation = foreground.results?.first {
            candidate = GrayImage(buffer: observation.instanceMask)
            for i in candidate.pixels.indices { candidate.pixels[i] = candidate.pixels[i] != 0 ? 255 : 0 }
        } else {
            candidate = GrayImage(width: max(1, width / 8), height: max(1, height / 8))
        }
        let cw = candidate.width, ch = candidate.height

        // 1. Where to look for hands: knuckles from hand pose, plus the person-segmented pixels nearest the frame
        //    edge, which is where an arm comes in (hand pose scores a close-up hand cut off by the frame near zero). Person segmentation alone can't be subtracted: it counts a held object
        //    as part of the person.
        var handSeeds: [(u: Double, v: Double)] = []
        var wrists: [(u: Double, v: Double)] = []
        var jointCount = 0
        for hand in hands.results ?? [] {
            let points = try hand.recognizedPoints(.all)
            jointCount += points.values.filter { $0.confidence > 0.3 }.count
            if let wrist = points[.wrist], wrist.confidence > 0.3 { wrists.append((Double(wrist.location.x), 1 - Double(wrist.location.y))) }
            let knuckles: [VNHumanHandPoseObservation.JointName] = [.indexPIP, .middlePIP, .ringPIP, .thumbIP, .middleMCP]
            handSeeds += knuckles.compactMap { name -> (u: Double, v: Double, c: Float)? in
                guard let point = points[name], point.confidence > 0.3 else { return nil }
                return (Double(point.location.x), 1 - Double(point.location.y), point.confidence)
            }.sorted { $0.c > $1.c }.prefix(2).map { (u: $0.u, v: $0.v) }
        }
        var personMask: GrayImage? = nil
        if let buffer = person.results?.first?.pixelBuffer {
            personMask = GrayImage(buffer: buffer).thresholded().resized(width: cw, height: ch)
        }
        if let personMask { handSeeds += edgeSeeds(of: personMask, count: 2) }

        var hand = GrayImage(width: width, height: height)
        var handSegments: [GrayImage] = []
        if #available(macOS 27.0, iOS 27.0, *) {
            for point in handSeeds {
                if let segment = await segment(image, point: NormalizedPoint(x: point.u, y: 1 - point.v)) {
                    handSegments.append(segment.resized(width: width, height: height))
                }
            }
        }
        for segment in handSegments { for i in segment.pixels.indices where segment.pixels[i] > 127 { hand.pixels[i] = 255 } }

        // 2. Seed: candidates are Vision's foreground minus the hands, minus anything well behind the nearest surfaces.
        //    Each blob is scored by how deep a point it has inside, how near the middle of the frame it is (the phone
        //    asks for the object there), whether it runs into a wrist, and whether it continues the last photo's object.
        let handSmall = hand.resized(width: cw, height: ch)
        for i in candidate.pixels.indices where handSmall.pixels[i] > 127 { candidate.pixels[i] = 0 }
        // The held object is the nearest thing in front of the camera (with the hand): keep what's within
        // `depthBand` of the nearest surfaces in the whole frame.
        let nearest = depth.flatMap(nearestSurface)
        if let depth, let nearest { cut(&candidate, depth: depth, beyond: nearest + depthBand) }
        var seed: (u: Double, v: Double)? = nil
        var seedBox: CGRect? = nil   // fractions of the image, top-left origin
        var bestScore = 0.0
        let minimumArea = Int(Double(cw * ch) * 0.002)
        let radius = Double(min(cw, ch)) * 0.03
        for component in candidate.components() where component.onCount >= minimumArea {
            guard let point = component.deepestInteriorPoint() else { continue }
            let u = (Double(point.x) + 0.5) / Double(cw), v = (Double(point.y) + 0.5) / Double(ch)
            var score = Double(point.depth) * exp(-3 * hypot(u - 0.5, v - 0.5))
            if wrists.contains(where: { component.touches(u: $0.u, v: $0.v, radius: radius * 2) }) { score *= 0.25 }
            if let last = lastSeed, component.touches(u: last.u, v: last.v, radius: radius) { score *= 2 }
            if score > bestScore { bestScore = score; seed = (u, v); seedBox = component.bounds(scaledTo: (cw, ch), grownBy: 0.15) }
        }
        if seed == nil { seed = lastSeed ?? (0.5, 0.5) }
        lastSeed = seed

        // 3. The object: a box around the chosen blob asks for the whole object (a point alone often returns a part).
        //    Excluded points in the same request make it fail now and then (status 14), so hands are subtracted after.
        var mask: GrayImage
        var method = "foreground"
        var object: GrayImage? = nil
        if #available(macOS 27.0, iOS 27.0, *), let seed {
            if let box = seedBox {
                object = await segment(image, box: NormalizedRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height))
                method = "promptable-box"
            }
            // A box that takes in a finger can come back as the hand; then ask with the point inside the object.
            func mostlyHand(_ m: GrayImage) -> Bool {
                let r = m.resized(width: width, height: height)
                var inHand = 0
                for i in r.pixels.indices where r.pixels[i] > 127 && hand.pixels[i] > 127 { inHand += 1 }
                return Double(inHand) > 0.5 * Double(max(1, r.onCount))
            }
            if object == nil || object!.onCount == 0 || mostlyHand(object!) {
                object = await segment(image, point: NormalizedPoint(x: seed.u, y: 1 - seed.v))
                method = "promptable-point"
            }
        }
        mask = (object ?? candidate).resized(width: width, height: height)

        if let dir = ProcessInfo.processInfo.environment["MASK_DEBUG_DIR"] {
            let url = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            for (i, segment) in handSegments.enumerated() { try? segment.writePNG(to: url.appendingPathComponent("hand\(i).png")) }
            try? candidate.writePNG(to: url.appendingPathComponent("candidate.png"))
            if let personMask { try? personMask.writePNG(to: url.appendingPathComponent("person.png")) }
            FileHandle.standardError.write(Data("handSeeds \(handSeeds) seed \(String(describing: seed)) box \(String(describing: seedBox)) segments \(handSegments.map { $0.onCount })\n".utf8))
        }
        // 4. Subtract each hand segment unless it is mostly the object (a knuckle hidden behind the object can seed it).
        let objectArea = max(1, mask.onCount)
        var subtracted = 0
        var removed = GrayImage(width: width, height: height)
        for segment in handSegments {
            var overlap = 0
            for i in segment.pixels.indices where segment.pixels[i] > 127 && mask.pixels[i] > 127 { overlap += 1 }
            if Double(overlap) > 0.6 * Double(objectArea) { continue }
            for i in segment.pixels.indices where segment.pixels[i] > 127 { removed.pixels[i] = 255 }
            subtracted += 1
        }
        if subtracted > 0 {
            let grown = removed.dilated(by: max(2, width / 400))
            for i in mask.pixels.indices where grown.pixels[i] > 127 { mask.pixels[i] = 0 }
            method += "-minus-hand"
        }
        mask = mask.thresholded()
        if let depth, let nearest { cut(&mask, depth: depth, beyond: nearest + depthBand) }
        if let seed { mask = mask.keepingComponent(containing: (Int(seed.u * Double(width)), Int(seed.v * Double(height)))) }
        return Result(mask: mask, seed: seed, handJoints: jointCount, method: method, excludedPoints: subtracted)
    }

    /// Up to `count` mask pixels nearest the frame edge, from different sides of the frame.
    private func edgeSeeds(of mask: GrayImage, count: Int) -> [(u: Double, v: Double)] {
        var bySide: [Int: (distance: Int, x: Int, y: Int)] = [:]
        for y in 0..<mask.height { for x in 0..<mask.width where mask[x, y] > 127 {
            let distances = [x, mask.width - 1 - x, y, mask.height - 1 - y]
            let side = distances.indices.min { distances[$0] < distances[$1] }!
            // Step a little inside so the seed sits on the arm, not its anti-aliased rim.
            if bySide[side] == nil || distances[side] < bySide[side]!.distance { bySide[side] = (distances[side], x, y) }
        } }
        guard mask.onCount > mask.width * mask.height / 200 else { return [] }
        return bySide.values.sorted { $0.distance < $1.distance }.prefix(count).compactMap { found in
            // Move to the deepest nearby interior point of the person mask so the seed isn't on an edge.
            var best = (x: found.x, y: found.y), bestScore = -1
            let r = max(2, min(mask.width, mask.height) / 20)
            for y in max(0, found.y - r)...min(mask.height - 1, found.y + r) { for x in max(0, found.x - r)...min(mask.width - 1, found.x + r) where mask[x, y] > 127 {
                var score = 0
                for d in 1...r { if x - d >= 0, x + d < mask.width, y - d >= 0, y + d < mask.height,
                                    mask[x - d, y] > 127, mask[x + d, y] > 127, mask[x, y - d] > 127, mask[x, y + d] > 127 { score = d } else { break } }
                if score > bestScore { bestScore = score; best = (x, y) }
            } }
            return ((Double(best.x) + 0.5) / Double(mask.width), (Double(best.y) + 0.5) / Double(mask.height))
        }
    }

    @available(macOS 27.0, iOS 27.0, *)
    private func segment(_ image: CVPixelBuffer, point: NormalizedPoint? = nil, box: NormalizedRect? = nil) async -> GrayImage? {
        let request: GenerateIterativeSegmentationRequest
        if let box { request = GenerateIterativeSegmentationRequest(seedBox: box) }
        else if let point { request = GenerateIterativeSegmentationRequest(seedPoint: point) }
        else { return nil }
        if case .ready = await request.assetStatus {} else { try? await request.downloadAssets() }
        request.qualityLevel = .accurate
        guard let observation = try? await request.perform(on: image, orientation: nil) else { return nil }
        return observation.pixelBuffer.withUnsafeBuffer { GrayImage(buffer: $0) }.thresholded()
    }

    private func erase(_ mask: inout GrayImage, from a: (Double, Double), to b: (Double, Double), radius: Double) {
        let minX = max(0, Int(min(a.0, b.0) - radius)), maxX = min(mask.width - 1, Int(max(a.0, b.0) + radius))
        let minY = max(0, Int(min(a.1, b.1) - radius)), maxY = min(mask.height - 1, Int(max(a.1, b.1) + radius))
        guard minX <= maxX, minY <= maxY else { return }
        let dx = b.0 - a.0, dy = b.1 - a.1, length2 = max(1e-9, dx * dx + dy * dy)
        for y in minY...maxY { for x in minX...maxX {
            let px = Double(x) + 0.5, py = Double(y) + 0.5
            let t = max(0, min(1, ((px - a.0) * dx + (py - a.1) * dy) / length2))
            if hypot(px - (a.0 + t * dx), py - (a.1 + t * dy)) <= radius { mask[x, y] = 0 }
        } }
    }

    /// A robust nearest depth: the 2nd percentile of all readings (a few noisy near pixels don't count).
    private func nearestSurface(_ depth: DepthImage) -> Float? {
        let values = depth.metres.filter { $0 > 0.05 }.sorted()
        guard values.count > 100 else { return nil }
        return values[values.count / 50]
    }

    private func cut(_ mask: inout GrayImage, depth: DepthImage, beyond limit: Float) {
        for y in 0..<mask.height { for x in 0..<mask.width where mask[x, y] > 127 {
            let d = depth.at(u: (Double(x) + 0.5) / Double(mask.width), v: (Double(y) + 0.5) / Double(mask.height))
            if d > limit { mask[x, y] = 0 }
        } }
    }
}
