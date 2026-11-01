import Foundation
import SceneKit
import ModelIO
import SceneKit.ModelIO
import simd

// Lines a rebuilt model up with a reference model and says how well they agree, whatever way each is oriented.
// Usage: model-compare <reference> <candidate>
// Both are rigidly aligned (principal axes, then iterative closest point; no scaling, so a wrong size shows).
// Prints {"referenceSizeMm":[x,y,z],"candidateSizeMm":[x,y,z],"meanMm":…,"p95Mm":…,"maxMm":…}: the candidate's
// box in the reference's own axes, and its surface distance to the reference (candidate vertices to the nearest
// reference vertex, after alignment).

func vertices(_ path: String) -> [SIMD3<Double>] {
    let url = URL(fileURLWithPath: path)
    let scene = SCNScene(mdlAsset: MDLAsset(url: url))
    let scale: Double = url.pathExtension.lowercased() == "usdz" ? 1000 : 1   // USDZ in metres, STL/OBJ in mm
    var out: [SIMD3<Double>] = []
    scene.rootNode.enumerateHierarchy { node, _ in
        guard let source = node.geometry?.sources(for: .vertex).first else { return }
        let world = node.simdWorldTransform
        source.data.withUnsafeBytes { raw in
            for i in 0..<source.vectorCount {
                let p = raw.baseAddress!.advanced(by: source.dataOffset + i * source.dataStride).assumingMemoryBound(to: Float.self)
                let v = world * SIMD4<Float>(p[0], p[1], p[2], 1)
                out.append(SIMD3(Double(v.x), Double(v.y), Double(v.z)) * scale)
            }
        }
    }
    return out
}

func principalAxes(_ points: [SIMD3<Double>]) -> (mean: SIMD3<Double>, axes: simd_double3x3) {
    let mean = points.reduce(SIMD3<Double>(repeating: 0), +) / Double(points.count)
    var a = simd_double3x3()
    for p in points { let d = p - mean; a += simd_double3x3(rows: [d * d.x, d * d.y, d * d.z]) }
    var vectors = matrix_identity_double3x3
    for _ in 0..<50 {
        var (p, q) = (0, 1)
        for (i, j) in [(0, 1), (0, 2), (1, 2)] where abs(a[j][i]) > abs(a[q][p]) { (p, q) = (i, j) }
        if abs(a[q][p]) < 1e-18 { break }
        let theta = (a[q][q] - a[p][p]) / (2 * a[q][p])
        let t = (theta >= 0 ? 1 : -1) / (abs(theta) + (theta * theta + 1).squareRoot())
        let c = 1 / (t * t + 1).squareRoot(), s = t * c
        var r = matrix_identity_double3x3
        r[p][p] = c; r[q][q] = c; r[q][p] = s; r[p][q] = -s
        a = r.transpose * a * r; vectors = vectors * r
    }
    let sorted = (0..<3).map { (a[$0][$0], vectors[$0]) }.sorted { $0.0 > $1.0 }.map { $0.1 }
    return (mean, simd_double3x3(columns: (sorted[0], sorted[1], simd_cross(sorted[0], sorted[1]))))
}

/// Nearest reference vertex by a uniform grid.
struct Grid {
    let points: [SIMD3<Double>], cell: Double
    var buckets: [SIMD3<Int32>: [Int]] = [:]
    init(_ points: [SIMD3<Double>], cell: Double) {
        self.points = points; self.cell = cell
        for (i, p) in points.enumerated() { buckets[key(p), default: []].append(i) }
    }
    func key(_ p: SIMD3<Double>) -> SIMD3<Int32> { SIMD3(Int32(floor(p.x / cell)), Int32(floor(p.y / cell)), Int32(floor(p.z / cell))) }
    func nearest(_ p: SIMD3<Double>) -> (SIMD3<Double>, Double) {
        let k = key(p)
        var best = (points[0], Double.infinity)
        for ring in 1...6 {
            for dx in -ring...ring { for dy in -ring...ring { for dz in -ring...ring {
                guard let list = buckets[k &+ SIMD3(Int32(dx), Int32(dy), Int32(dz))] else { continue }
                for i in list { let d = simd_distance(points[i], p); if d < best.1 { best = (points[i], d) } }
            } } }
            if best.1 <= Double(ring) * cell { return best }
        }
        if best.1.isFinite { return best }
        // Far from everything (a badly wrong candidate): search all of it.
        for q in points { let d = simd_distance(q, p); if d < best.1 { best = (q, d) } }
        return best
    }
}

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: model-compare <reference> <candidate>\n".utf8)); exit(2) }
let reference = vertices(args[1]), candidateAll = vertices(args[2])
guard !reference.isEmpty, !candidateAll.isEmpty else { print("{\"error\":\"no geometry\"}"); exit(1) }
let stride = max(1, candidateAll.count / 4000)
let candidate = Swift.stride(from: 0, to: candidateAll.count, by: stride).map { candidateAll[$0] }
let grid = Grid(reference, cell: 2)
let (refMean, refAxes) = principalAxes(reference)
let (candMean, candAxes) = principalAxes(candidateAll)

func transformAll(_ points: [SIMD3<Double>], _ r: simd_double3x3, _ t: SIMD3<Double>) -> [SIMD3<Double>] { points.map { r * $0 + t } }
func meanDistance(_ points: [SIMD3<Double>]) -> Double { points.reduce(0) { $0 + grid.nearest($1).1 } / Double(points.count) }

/// Eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (cyclic Jacobi).
func largestEigenvector(_ m: simd_double4x4) -> SIMD4<Double> {
    var a = (0..<4).map { c in (0..<4).map { r in m[c][r] } }
    var v = (0..<4).map { c in (0..<4).map { r in c == r ? 1.0 : 0.0 } }
    for _ in 0..<30 {
        var off = 0.0
        for p in 0..<4 { for q in (p + 1)..<4 { off += a[p][q] * a[p][q] } }
        if off < 1e-20 { break }
        for p in 0..<4 { for q in (p + 1)..<4 where abs(a[p][q]) > 1e-30 {
            let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
            let t = (theta >= 0 ? 1 : -1) / (abs(theta) + (theta * theta + 1).squareRoot())
            let c = 1 / (t * t + 1).squareRoot(), s = t * c
            for k in 0..<4 {   // columns p, q
                let akp = a[k][p], akq = a[k][q]
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq
            }
            for k in 0..<4 {   // rows p, q
                let apk = a[p][k], aqk = a[q][k]
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk
            }
            for k in 0..<4 {
                let vkp = v[k][p], vkq = v[k][q]
                v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq
            }
        } }
    }
    let i = (0..<4).max { a[$0][$0] < a[$1][$1] }!
    return simd_normalize(SIMD4(v[0][i], v[1][i], v[2][i], v[3][i]))
}

/// Point-to-point ICP (Kabsch each step), starting from `r`, `t`.
func icp(_ r0: simd_double3x3, _ t0: SIMD3<Double>) -> (simd_double3x3, SIMD3<Double>, Double) {
    var r = r0, t = t0
    for _ in 0..<40 {
        let moved = transformAll(candidate, r, t)
        let pairs = moved.map { ($0, grid.nearest($0).0) }
        let mc = pairs.reduce(SIMD3<Double>(repeating: 0)) { $0 + $1.0 } / Double(pairs.count)
        let mr = pairs.reduce(SIMD3<Double>(repeating: 0)) { $0 + $1.1 } / Double(pairs.count)
        var h = simd_double3x3()
        for (c, q) in pairs { let a = c - mc, b = q - mr; h += simd_double3x3(rows: [a * b.x, a * b.y, a * b.z]).transpose }
        // Rotation from the cross-covariance via a quaternion (Horn's method).
        let s = h.transpose
        let n = simd_double4x4(rows: [
            SIMD4(s[0][0] + s[1][1] + s[2][2], s[1][2] - s[2][1], s[2][0] - s[0][2], s[0][1] - s[1][0]),
            SIMD4(s[1][2] - s[2][1], s[0][0] - s[1][1] - s[2][2], s[0][1] + s[1][0], s[2][0] + s[0][2]),
            SIMD4(s[2][0] - s[0][2], s[0][1] + s[1][0], -s[0][0] + s[1][1] - s[2][2], s[1][2] + s[2][1]),
            SIMD4(s[0][1] - s[1][0], s[2][0] + s[0][2], s[1][2] + s[2][1], -s[0][0] - s[1][1] + s[2][2]),
        ])
        let q = largestEigenvector(n)
        let step = simd_double3x3(simd_quatd(ix: q.y, iy: q.z, iz: q.w, r: q.x))
        r = step * r; t = step * (t - mc) + mr
    }
    return (r, t, meanDistance(transformAll(candidate, r, t)))
}

// Try the four proper sign choices of the principal axes and keep the best fit.
var best: (simd_double3x3, SIMD3<Double>, Double)? = nil
for (sx, sy) in [(1.0, 1.0), (1, -1), (-1, 1), (-1, -1)] {
    let flip = simd_double3x3(diagonal: SIMD3(sx, sy, sx * sy))
    let r = refAxes * flip * candAxes.transpose
    let result = icp(r, refMean - r * candMean)
    if best == nil || result.2 < best!.2 { best = result }
}
let (r, t, _) = best!
let aligned = transformAll(candidateAll, r, t)
let distances = Swift.stride(from: 0, to: aligned.count, by: max(1, aligned.count / 20000)).map { grid.nearest(aligned[$0]).1 }.sorted()
func box(_ points: [SIMD3<Double>]) -> [Double] {
    let lo = points.reduce(SIMD3<Double>(repeating: .infinity)) { simd_min($0, $1) }
    let hi = points.reduce(SIMD3<Double>(repeating: -.infinity)) { simd_max($0, $1) }
    return (0..<3).map { ((hi[$0] - lo[$0]) * 10).rounded() / 10 }
}
func r1(_ x: Double) -> Double { (x * 100).rounded() / 100 }
let json = try JSONSerialization.data(withJSONObject: [
    "referenceSizeMm": box(reference), "candidateSizeMm": box(aligned),
    "meanMm": r1(distances.reduce(0, +) / Double(distances.count)),
    "p95Mm": r1(distances[Int(Double(distances.count - 1) * 0.95)]), "maxMm": r1(distances.last!),
], options: [.sortedKeys])
print(String(data: json, encoding: .utf8)!)
