import Foundation
import simd

/// What `removeSupport` took away: the surface the object stood on, found as the dominant plane at the bottom.
public struct SupportCut: Equatable {
    /// How far the support plane leaned from the model's up axis before the model was turned to stand on it.
    public var tiltDegrees: Double
    /// Area of the support plane's own upward faces, in mm².
    public var supportAreaMm2: Double
    /// Triangles before and after (after includes the cap).
    public var trianglesBefore: Int
    public var trianglesAfter: Int
    /// Triangles added to close the cut: the object's new flat bottom, made from the cut's own corners.
    public var capTriangles: Int = 0
    /// Edges still open after the cap (0 when the model was closed before the cut): openings the cut didn't make.
    public var openEdges: Int = 0
}

/// Removes whatever an Object Capture scan stood on that Apple's object masking kept: a table, a desk, the floor, a
/// plate or any platform. Nothing here knows what it was; the surface is found from the mesh alone (David's Nov 9
/// rescan kept about half of a round plate as a curved shell under the sign).
///
/// `corners` are triangles three at a time, in millimetres, Z up. Deterministic, in this order:
/// 1. The support plane: the plane through the most upward-facing area in the bottom half of the model, refined by a
///    weighted least-squares fit of the faces within `band` mm of it. It may lean up to `maximumTilt` degrees.
/// 2. Everything on or below the plane plus `clearance` mm goes; triangles crossing that height are clipped to it.
/// 3. What stands on the plane is kept: the largest connected part touching the cut, and any other touching part at
///    least a tenth its size that overlaps it from above. Loose scraps of the support are dropped, and so are its
///    upward faces left within 2 mm above the cut outside the footprint of anything taller than 5 mm.
/// 4. It is only a support if it reaches well beyond what stands on it: at least half its area, and at least
///    `minimumOutsideArea` mm², lies outside the kept part's footprint. Otherwise (an object's own step, such as the
///    top of a sign's plank) nothing is cut and this returns nil.
/// 5. The cut is closed (`capCut`): each opening it left on the plane is filled flat, from the opening's own corners,
///    so a model that was watertight before the cut is watertight after it and its kept triangles are unchanged.
///    (Apple's own `Request.Geometry` box can't do this: on David's DAD sign, a box whose floor sat just above the plate
///    clipped the model at the floor and left it open, 3,302 open edges, and kept the plate's scraps above the floor.)
/// The result is turned so the plane is level and moved so the cut is at z = 0: the object stands where it stood.
public func removeSupport(_ corners: [SIMD3<Float>], clearance: Double = 0.5, band: Double = 2,
                          maximumTilt: Double = 15, minimumOutsideArea: Double = 5000) -> (corners: [SIMD3<Float>], cut: SupportCut)? {
    let count = corners.count / 3
    guard count > 0 else { return nil }
    let points = corners.map { SIMD3<Double>(Double($0.x), Double($0.y), Double($0.z)) }
    var normals = [SIMD3<Double>](repeating: .zero, count: count), areas = [Double](repeating: 0, count: count)
    var centroids = [SIMD3<Double>](repeating: .zero, count: count)
    var low = Double.infinity, high = -Double.infinity
    for t in 0..<count {
        let a = points[3 * t], b = points[3 * t + 1], c = points[3 * t + 2]
        let cross = simd_cross(b - a, c - a), length = simd_length(cross)
        areas[t] = length / 2
        normals[t] = length > 0 ? cross / length : .zero
        centroids[t] = (a + b + c) / 3
        low = min(low, a.z, b.z, c.z); high = max(high, a.z, b.z, c.z)
    }
    guard high > low else { return nil }

    // 1. Upward faces in the bottom half; each in turn (a fixed stride, so runs agree) proposes its own plane.
    let upward = cos(25 * Double.pi / 180), agree = cos(15 * Double.pi / 180)
    let candidates = (0..<count).filter { areas[$0] > 0 && normals[$0].z >= upward && centroids[$0].z <= low + (high - low) / 2 }
    guard !candidates.isEmpty else { return nil }
    let step = max(1, candidates.count / 400)
    var best: (score: Double, point: SIMD3<Double>, normal: SIMD3<Double>)?
    for i in stride(from: 0, to: candidates.count, by: step) {
        let p0 = centroids[candidates[i]], n0 = normals[candidates[i]]
        var score = 0.0
        for t in candidates where abs(simd_dot(centroids[t] - p0, n0)) < band && simd_dot(normals[t], n0) > agree { score += areas[t] }
        if best == nil || score > best!.score { best = (score, p0, n0) }
    }
    guard var (_, point, normal) = best else { return nil }
    // Refine: z = a·x + b·y + c over the faces within the band, weighted by area.
    var support = 0.0
    for _ in 0..<5 {
        var m = simd_double3x3(0), r = SIMD3<Double>.zero
        support = 0
        for t in candidates where abs(simd_dot(centroids[t] - point, normal)) < band {
            let p = centroids[t], w = areas[t], v = SIMD3<Double>(p.x, p.y, 1)
            m += simd_double3x3(columns: (v * v.x * w, v * v.y * w, v * w))
            r += v * p.z * w
            support += w
        }
        guard support > 0, abs(m.determinant) > 1e-9 else { return nil }
        let fit = m.inverse * r
        normal = simd_normalize(SIMD3<Double>(-fit.x, -fit.y, 1))
        point = SIMD3<Double>(0, 0, fit.z)
    }
    let tilt = acos(min(1, normal.z)) * 180 / .pi
    guard tilt <= maximumTilt else { return nil }

    // 2. Clip at the plane plus the clearance. Each crossing edge's point is computed from its two ends in a fixed
    // order, so neighbouring triangles share it exactly and stay joined.
    func height(_ p: SIMD3<Double>) -> Double { simd_dot(p - point, normal) - clearance }
    func crossing(_ p: SIMD3<Double>, _ q: SIMD3<Double>) -> SIMD3<Double> {
        let (a, b) = (p.x, p.y, p.z) < (q.x, q.y, q.z) ? (p, q) : (q, p)
        let ha = height(a), hb = height(b)
        return a + (b - a) * (ha / (ha - hb))
    }
    var kept: [SIMD3<Double>] = []
    kept.reserveCapacity(points.count)
    for t in 0..<count {
        let tri = [points[3 * t], points[3 * t + 1], points[3 * t + 2]]
        let h = tri.map(height)
        if h.allSatisfy({ $0 >= 0 }) { kept += tri; continue }
        if h.allSatisfy({ $0 < 0 }) { continue }
        var polygon: [SIMD3<Double>] = []
        for i in 0..<3 {
            let j = (i + 1) % 3
            if h[i] >= 0 { polygon.append(tri[i]) }
            if (h[i] >= 0) != (h[j] >= 0) { polygon.append(crossing(tri[i], tri[j])) }
        }
        for k in stride(from: 1, to: polygon.count - 1, by: 1) { kept += [polygon[0], polygon[k], polygon[k + 1]] }
    }
    let keptCount = kept.count / 3
    guard keptCount > 0 else { return nil }

    // The plane's own axes, for footprints seen from above it.
    let across = simd_normalize(simd_cross(abs(normal.x) < 0.9 ? SIMD3<Double>(1, 0, 0) : SIMD3<Double>(0, 1, 0), normal))
    let along = simd_cross(normal, across)
    let cell = 2.0
    func key(_ p: SIMD3<Double>) -> SIMD2<Int> { SIMD2(Int((simd_dot(p, across) / cell).rounded(.down)), Int((simd_dot(p, along) / cell).rounded(.down))) }
    func triangle(_ t: Int) -> [SIMD3<Double>] { [kept[3 * t], kept[3 * t + 1], kept[3 * t + 2]] }
    func footprint(of triangles: [Int], where include: (SIMD3<Double>) -> Bool = { _ in true }) -> Set<SIMD2<Int>> {
        var cells = Set<SIMD2<Int>>()
        for t in triangles {
            let c = triangle(t)
            for p in [c[0], c[1], c[2], (c[0] + c[1]) / 2, (c[1] + c[2]) / 2, (c[2] + c[0]) / 2, (c[0] + c[1] + c[2]) / 3] where include(p) { cells.insert(key(p)) }
        }
        var grown = cells
        for k in cells { for dx in -2...2 { for dy in -2...2 { grown.insert(k &+ SIMD2(dx, dy)) } } }
        return grown
    }

    // 3. Parts: triangles joined through shared corners (exact positions; −0 and +0 are the same corner). What stands
    // on the plane is the largest part touching the cut, and any other touching part a tenth its size overlapping it.
    func standing(_ triangles: [Int]) -> [Int] {
        var ids: [SIMD3<UInt64>: Int] = [:]
        var parent: [Int: Int] = [:]
        for t in triangles { parent[t] = t }
        func root(_ x: Int) -> Int { var x = x; while parent[x]! != x { parent[x] = parent[parent[x]!]!; x = parent[x]! }; return x }
        for t in triangles {
            for corner in triangle(t) {
                let key = SIMD3<UInt64>((corner.x + 0).bitPattern, (corner.y + 0).bitPattern, (corner.z + 0).bitPattern)
                if let other = ids[key] { let a = root(other), b = root(t); if a != b { parent[a] = b } } else { ids[key] = t }
            }
        }
        struct Part { var area = 0.0; var lowest = Double.infinity; var low = SIMD2<Double>(repeating: .infinity); var high = SIMD2<Double>(repeating: -.infinity) }
        var parts: [Int: Part] = [:]
        for t in triangles {
            let c = triangle(t)
            var part = parts[root(t)] ?? Part()
            part.area += simd_length(simd_cross(c[1] - c[0], c[2] - c[0])) / 2
            for p in c {
                part.lowest = min(part.lowest, height(p))
                let flat = SIMD2<Double>(simd_dot(p, across), simd_dot(p, along))
                part.low = simd_min(part.low, flat); part.high = simd_max(part.high, flat)
            }
            parts[root(t)] = part
        }
        let touching = parts.filter { $0.value.lowest <= band }
        guard let main = touching.max(by: { $0.value.area < $1.value.area }) else { return [] }
        let margin = 5.0
        let keep = Set(touching.filter { id, part in
            id == main.key || (part.area >= main.value.area / 10
                && part.low.x <= main.value.high.x + margin && part.high.x >= main.value.low.x - margin
                && part.low.y <= main.value.high.y + margin && part.high.y >= main.value.low.y - margin)
        }.keys)
        return triangles.filter { keep.contains(root($0)) }
    }
    var object = standing(Array(0..<keptCount))
    guard !object.isEmpty else { return nil }
    // Scraps of the support itself left just above the cut (a warped plate, a table's texture): faces within `skirt` mm
    // of the cut that face up, outside the footprint of anything taller than `tall` mm. Skipped when nothing is taller.
    let skirt = 2.0, tall = 5.0, upright = cos(30 * Double.pi / 180)
    let tallFootprint = footprint(of: object) { height($0) > tall }
    if !tallFootprint.isEmpty {
        let scraps = Set(object.filter { t in
            let c = triangle(t), cross = simd_cross(c[1] - c[0], c[2] - c[0]), length = simd_length(cross)
            return length > 0 && simd_dot(cross / length, normal) >= upright && c.allSatisfy { height($0) <= skirt }
                && !tallFootprint.contains(key((c[0] + c[1] + c[2]) / 3))
        })
        if !scraps.isEmpty { object = standing(object.filter { !scraps.contains($0) }) }
    }
    guard !object.isEmpty else { return nil }

    // 4. A support reaches well beyond what stands on it: its own faces outside the object's footprint (2 mm grid, grown
    // by 4 mm) must be at least half its area and at least `minimumOutsideArea`.
    let objectFootprint = footprint(of: object)
    var outside = 0.0
    for t in candidates where abs(simd_dot(centroids[t] - point, normal)) < band && !objectFootprint.contains(key(centroids[t])) { outside += areas[t] }
    guard outside >= minimumOutsideArea, outside >= support / 2 else { return nil }

    // Level the plane and stand the object on z = 0.
    let turn = simd_quatd(from: normal, to: SIMD3<Double>(0, 0, 1))
    let base = simd_dot(point, normal) + clearance
    func level(_ p: SIMD3<Double>) -> SIMD3<Float> {
        let q = turn.act(p - normal * base)
        return SIMD3<Float>(Float(q.x), Float(q.y), Float(max(0, q.z)))
    }
    var result: [SIMD3<Float>] = []
    result.reserveCapacity(kept.count)
    for t in object { for p in triangle(t) { result.append(level(p)) } }
    // Turn it about z so its longest side runs along x (principal axis of its footprint): its size reads along the object,
    // and the project picture sees its face. Measured on the object alone, before the cap.
    var mean = SIMD2<Double>.zero
    for p in result { mean += SIMD2(Double(p.x), Double(p.y)) }
    mean /= Double(result.count)
    var sxx = 0.0, syy = 0.0, sxy = 0.0
    for p in result { let d = SIMD2(Double(p.x), Double(p.y)) - mean; sxx += d.x * d.x; syy += d.y * d.y; sxy += d.x * d.y }
    let yaw = Float(0.5 * atan2(2 * sxy, sxx - syy))
    // 5. Close the cut. Its corners are the kept corners themselves, levelled the same way, so the two meet exactly.
    let cap = capCut(object.flatMap(triangle), down: -normal, onCut: { abs(height($0)) < 1e-3 },
                     flat: { SIMD2(simd_dot($0, across), simd_dot($0, along)) })
    result += cap.map(level)
    let (c, s) = (cos(-yaw), sin(-yaw))
    result = result.map { SIMD3($0.x * c - $0.y * s, $0.x * s + $0.y * c, $0.z) }
    return (result, SupportCut(tiltDegrees: tilt, supportAreaMm2: support, trianglesBefore: count, trianglesAfter: result.count / 3,
                               capTriangles: cap.count / 3, openEdges: openEdges(result)))
}

/// Edges used by exactly one triangle, corners matched by exact position: 0 for a closed mesh.
public func openEdges(_ corners: [SIMD3<Float>]) -> Int {
    var ids: [SIMD3<UInt32>: Int] = [:]
    func id(_ p: SIMD3<Float>) -> Int {
        let key = SIMD3<UInt32>((p.x + 0).bitPattern, (p.y + 0).bitPattern, (p.z + 0).bitPattern)
        if let i = ids[key] { return i }
        ids[key] = ids.count; return ids.count - 1
    }
    var uses: [SIMD2<Int>: Int] = [:]
    for t in 0..<corners.count / 3 {
        let v = [id(corners[3 * t]), id(corners[3 * t + 1]), id(corners[3 * t + 2])]
        for k in 0..<3 where v[k] != v[(k + 1) % 3] { uses[SIMD2(min(v[k], v[(k + 1) % 3]), max(v[k], v[(k + 1) % 3])), default: 0] += 1 }
    }
    return uses.values.filter { $0 == 1 }.count
}
