import Foundation
import simd

/// Closes the openings a plane cut leaves in a mesh, so what is left is watertight and prints.
///
/// `corners` are triangles three at a time; corners at the same position are the same vertex (exact positions, −0 and
/// +0 alike). Every opening whose corners all lie on the cut (`onCut`) is filled with triangles that face `down`, made
/// only from the opening's own corners, so the cap meets the mesh edge for edge and no existing triangle moves.
/// Openings inside openings (a hollow foot, a ring) are holes: only the material between them is filled.
/// `flat` maps a point to its position on the cut plane, seen from above. Returns the cap's corners, three at a time.
public func capCut(_ corners: [SIMD3<Double>], down: SIMD3<Double>, onCut: (SIMD3<Double>) -> Bool,
                   flat: (SIMD3<Double>) -> SIMD2<Double>) -> [SIMD3<Double>] {
    // Vertices by exact position, and the mesh's directed edges.
    var ids: [SIMD3<UInt64>: Int] = [:], points: [SIMD3<Double>] = []
    func id(_ p: SIMD3<Double>) -> Int {
        let key = SIMD3<UInt64>((p.x + 0).bitPattern, (p.y + 0).bitPattern, (p.z + 0).bitPattern)
        if let i = ids[key] { return i }
        ids[key] = points.count; points.append(p); return points.count - 1
    }
    var edges: [SIMD2<Int>] = []
    var present = Set<SIMD2<Int>>()
    for t in 0..<corners.count / 3 {
        let v = [id(corners[3 * t]), id(corners[3 * t + 1]), id(corners[3 * t + 2])]
        guard v[0] != v[1], v[1] != v[2], v[2] != v[0] else { continue }
        for k in 0..<3 { let e = SIMD2(v[k], v[(k + 1) % 3]); edges.append(e); present.insert(e) }
    }
    // An open edge has no partner running the other way. Chain them into loops.
    var outgoing: [Int: [Int]] = [:]
    for e in edges where !present.contains(SIMD2(e.y, e.x)) { outgoing[e.x, default: []].append(e.y) }
    var loops: [[Int]] = []
    for start in outgoing.keys.sorted() {
        while let first = outgoing[start]?.popLast() {
            var loop = [start], at = first
            while at != start, let next = outgoing[at]?.popLast() { loop.append(at); at = next }
            if at == start, loop.count >= 3, loop.allSatisfy({ onCut(points[$0]) }) { loops.append(loop) }
        }
    }
    guard !loops.isEmpty else { return [] }

    // Seen from above, an outer opening runs one way and a hole the other: the mesh's edges around a hole run opposite
    // to those around its outline. Which way is outer follows from `down`, so it is measured, not assumed: the larger
    // of the two senses by total area is the outline's.
    func area(_ loop: [Int]) -> Double {
        var sum = 0.0
        for k in loop.indices { let a = flat(points[loop[k]]), b = flat(points[loop[(k + 1) % loop.count]]); sum += a.x * b.y - b.x * a.y }
        return sum / 2
    }
    let areas = loops.map(area)
    let positive = areas.filter { $0 > 0 }.reduce(0, +), negative = -areas.filter { $0 < 0 }.reduce(0, +)
    let outerSign: Double = positive >= negative ? 1 : -1
    func inside(_ p: SIMD2<Double>, _ loop: [Int]) -> Bool {
        var result = false
        for k in loop.indices {
            let a = flat(points[loop[k]]), b = flat(points[loop[(k + 1) % loop.count]])
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { result.toggle() }
        }
        return result
    }
    let outers = loops.indices.filter { areas[$0] * outerSign > 0 }
    var holes: [Int: [Int]] = [:]
    for h in loops.indices where areas[h] * outerSign < 0 {
        // A hole belongs to the smallest outline around it; a hole with no outline around it is left as it is.
        let probe = flat(points[loops[h][0]])
        if let owner = outers.filter({ inside(probe, loops[$0]) }).min(by: { abs(areas[$0]) < abs(areas[$1]) }) { holes[owner, default: []].append(h) }
    }

    var cap: [SIMD3<Double>] = []
    for o in outers {
        let rings = [loops[o]] + (holes[o] ?? []).map { loops[$0] }, flatIDs = rings.flatMap { $0 }
        for triangle in earcut(rings.map { $0.map { flat(points[$0]) } }) {
            var a = points[flatIDs[triangle.0]], b = points[flatIDs[triangle.1]], c = points[flatIDs[triangle.2]]
            if simd_dot(simd_cross(b - a, c - a), down) < 0 { swap(&b, &c) }
            cap += [a, b, c]
        }
    }
    return cap
}

// The ear clipping below is adapted from earcut by Mapbox (https://github.com/mapbox/earcut): its linked-list polygon,
// hole bridging, ear test and fallback passes, ported to Swift. See tools/mac-reconstruct/THIRD_PARTY.md. Its licence:
//
// ISC License
//
// Copyright (c) 2026, Mapbox
//
// Permission to use, copy, modify, and/or distribute this software for any purpose
// with or without fee is hereby granted, provided that the above copyright notice
// and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
// REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
// FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
// INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
// OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
// TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
// THIS SOFTWARE.

/// Ear clipping of a polygon with holes (adapted from Mapbox's earcut, without its z-order hash): `rings[0]` is the outline,
/// the rest are holes. Returns index triples into the rings' points taken in order. Unlike earcut, points in a straight
/// run are kept: each is a corner of the mesh the cap must meet, so dropping one would leave a gap beside it.
func earcut(_ rings: [[SIMD2<Double>]]) -> [(Int, Int, Int)] {
    final class Node {
        let i: Int, p: SIMD2<Double>
        var prev: Node! = nil
        var next: Node! = nil
        init(_ i: Int, _ p: SIMD2<Double>) { self.i = i; self.p = p }
    }
    var all: [Node] = []   // every node, so their links can be broken at the end
    func insert(_ i: Int, _ p: SIMD2<Double>, _ last: Node?) -> Node {
        let n = Node(i, p); all.append(n)
        if let last { n.next = last.next; n.prev = last; last.next.prev = n; last.next = n } else { n.prev = n; n.next = n }
        return n
    }
    func remove(_ n: Node) { n.next.prev = n.prev; n.prev.next = n.next }
    func area(_ p: Node, _ q: Node, _ r: Node) -> Double { (q.p.y - p.p.y) * (r.p.x - q.p.x) - (q.p.x - p.p.x) * (r.p.y - q.p.y) }
    func equal(_ a: Node, _ b: Node) -> Bool { a.p == b.p }
    func signedArea(_ ring: [SIMD2<Double>]) -> Double {
        var sum = 0.0, j = ring.count - 1
        for i in ring.indices { sum += (ring[j].x - ring[i].x) * (ring[i].y + ring[j].y); j = i }
        return sum
    }
    func list(_ ring: [SIMD2<Double>], offset: Int, clockwise: Bool) -> Node? {
        var last: Node?
        if clockwise == (signedArea(ring) > 0) { for k in ring.indices { last = insert(offset + k, ring[k], last) } }
        else { for k in ring.indices.reversed() { last = insert(offset + k, ring[k], last) } }
        if let l = last, equal(l, l.next) { remove(l); last = l.next }
        return last
    }
    // Only exact repeats go; a point in a straight run stays (see above).
    func filter(_ start: Node?, _ end: Node? = nil) -> Node? {
        guard let start else { return nil }
        var end = end ?? start, p = start, again = false
        repeat {
            again = false
            if equal(p, p.next) {
                remove(p); p = p.prev; end = p
                if p === p.next { break }
                again = true
            } else { p = p.next }
        } while again || p !== end
        return end
    }
    func inTriangle(_ a: SIMD2<Double>, _ b: SIMD2<Double>, _ c: SIMD2<Double>, _ p: SIMD2<Double>) -> Bool {
        (c.x - p.x) * (a.y - p.y) >= (a.x - p.x) * (c.y - p.y) && (a.x - p.x) * (b.y - p.y) >= (b.x - p.x) * (a.y - p.y)
            && (b.x - p.x) * (c.y - p.y) >= (c.x - p.x) * (b.y - p.y)
    }
    func isEar(_ ear: Node) -> Bool {
        let a = ear.prev!, b = ear, c = ear.next!
        if area(a, b, c) >= 0 { return false }
        let low = simd_min(a.p, simd_min(b.p, c.p)), high = simd_max(a.p, simd_max(b.p, c.p))
        var p = c.next!
        while p !== a {
            if p.p.x >= low.x, p.p.x <= high.x, p.p.y >= low.y, p.p.y <= high.y, !equal(p, a), !equal(p, b), !equal(p, c),
               inTriangle(a.p, b.p, c.p, p.p), area(p.prev, p, p.next) >= 0 { return false }
            p = p.next
        }
        return true
    }
    func sign(_ x: Double) -> Int { x > 0 ? 1 : x < 0 ? -1 : 0 }
    func onSegment(_ p: Node, _ q: Node, _ r: Node) -> Bool {
        q.p.x <= max(p.p.x, r.p.x) && q.p.x >= min(p.p.x, r.p.x) && q.p.y <= max(p.p.y, r.p.y) && q.p.y >= min(p.p.y, r.p.y)
    }
    func intersects(_ p1: Node, _ q1: Node, _ p2: Node, _ q2: Node) -> Bool {
        let o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1))
        if o1 != o2 && o3 != o4 { return true }
        return (o1 == 0 && onSegment(p1, p2, q1)) || (o2 == 0 && onSegment(p1, q2, q1))
            || (o3 == 0 && onSegment(p2, p1, q2)) || (o4 == 0 && onSegment(p2, q1, q2))
    }
    func intersectsPolygon(_ a: Node, _ b: Node) -> Bool {
        var p = a
        repeat {
            if p.i != a.i, p.next.i != a.i, p.i != b.i, p.next.i != b.i, intersects(p, p.next, a, b) { return true }
            p = p.next
        } while p !== a
        return false
    }
    func locallyInside(_ a: Node, _ b: Node) -> Bool {
        area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0
    }
    func middleInside(_ a: Node, _ b: Node) -> Bool {
        var p = a, inside = false
        let m = (a.p + b.p) / 2
        repeat {
            if (p.p.y > m.y) != (p.next.p.y > m.y), p.next.p.y != p.p.y,
               m.x < (p.next.p.x - p.p.x) * (m.y - p.p.y) / (p.next.p.y - p.p.y) + p.p.x { inside.toggle() }
            p = p.next
        } while p !== a
        return inside
    }
    func validDiagonal(_ a: Node, _ b: Node) -> Bool {
        a.next.i != b.i && a.prev.i != b.i && !intersectsPolygon(a, b)
            && ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) != 0 || area(a, b.prev, b) != 0))
                || (equal(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
    }
    func split(_ a: Node, _ b: Node) -> Node {
        let a2 = Node(a.i, a.p), b2 = Node(b.i, b.p); all += [a2, b2]
        let an = a.next!, bp = b.prev!
        a.next = b; b.prev = a
        a2.next = an; an.prev = a2
        b2.next = a2; a2.prev = b2
        bp.next = b2; b2.prev = bp
        return b2
    }
    var triangles: [(Int, Int, Int)] = []
    func cureLocalIntersections(_ start: Node) -> Node? {
        var start = start, p = start
        repeat {
            let a = p.prev!, b = p.next.next!
            if !equal(a, b), intersects(a, p, p.next, b), locallyInside(a, b), locallyInside(b, a) {
                triangles.append((a.i, p.i, b.i))
                remove(p); remove(p.next)
                p = b; start = b
            }
            p = p.next
        } while p !== start
        return filter(p)
    }
    func splitEarcut(_ start: Node) {
        var a = start
        repeat {
            var b = a.next.next!
            while b !== a.prev {
                if a.i != b.i, validDiagonal(a, b) {
                    var c: Node? = split(a, b)
                    let first = filter(a, a.next); c = filter(c, c!.next)
                    earcutLinked(first, 0); earcutLinked(c, 0)
                    return
                }
                b = b.next
            }
            a = a.next
        } while a !== start
    }
    func earcutLinked(_ ear: Node?, _ pass: Int) {
        guard var ear else { return }
        var stop = ear
        while ear.prev !== ear.next {
            let prev = ear.prev!, next = ear.next!
            if isEar(ear) {
                triangles.append((prev.i, ear.i, next.i))
                remove(ear)
                ear = next.next; stop = next.next
                continue
            }
            ear = next
            if ear === stop {
                if pass == 0 { earcutLinked(filter(ear), 1) }
                else if pass == 1, let cured = cureLocalIntersections(filter(ear)!) { earcutLinked(cured, 2) }
                else if pass == 2 { splitEarcut(ear) }
                break
            }
        }
    }
    // Holes join the outline through a bridge from each hole's leftmost point, leftmost hole first.
    func findBridge(_ hole: Node, _ outer: Node) -> Node? {
        var p = outer, qx = -Double.infinity, m: Node?
        let h = hole.p
        repeat {
            if h.y <= p.p.y, h.y >= p.next.p.y, p.next.p.y != p.p.y {
                let x = p.p.x + (h.y - p.p.y) * (p.next.p.x - p.p.x) / (p.next.p.y - p.p.y)
                if x <= h.x, x > qx {
                    qx = x; m = p.p.x < p.next.p.x ? p : p.next
                    if x == h.x { return m }
                }
            }
            p = p.next
        } while p !== outer
        guard var best = m else { return nil }
        let stop = best, mp = best.p
        var tanMin = Double.infinity
        p = best
        repeat {
            if h.x >= p.p.x, p.p.x >= mp.x, h.x != p.p.x,
               inTriangle(SIMD2(h.y < mp.y ? h.x : qx, h.y), mp, SIMD2(h.y < mp.y ? qx : h.x, h.y), p.p) {
                let tan = abs(h.y - p.p.y) / (h.x - p.p.x)
                if locallyInside(p, hole), tan < tanMin || (tan == tanMin && (p.p.x > best.p.x
                    || (p.p.x == best.p.x && area(best.prev, best, p.prev) < 0 && area(p.next, best, best.next) < 0))) {
                    best = p; tanMin = tan
                }
            }
            p = p.next
        } while p !== stop
        return best
    }
    guard let first = rings.first, first.count >= 3, var outer = list(first, offset: 0, clockwise: true), outer.next !== outer.prev else { return [] }
    var offset = first.count, leftmost: [Node] = []
    for ring in rings.dropFirst() {
        defer { offset += ring.count }
        guard ring.count >= 3, let start = list(ring, offset: offset, clockwise: false) else { continue }
        var left = start, p = start
        repeat { if p.p.x < left.p.x || (p.p.x == left.p.x && p.p.y < left.p.y) { left = p }; p = p.next } while p !== start
        leftmost.append(left)
    }
    for hole in leftmost.sorted(by: { $0.p.x < $1.p.x }) {
        guard let bridge = findBridge(hole, outer) else { continue }
        let reverse = split(bridge, hole)
        _ = filter(reverse, reverse.next)
        outer = filter(bridge, bridge.next) ?? outer
    }
    earcutLinked(outer, 0)
    for n in all { n.prev = nil; n.next = nil }
    return triangles
}
