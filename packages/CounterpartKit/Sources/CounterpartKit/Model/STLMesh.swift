import Foundation
import simd

/// STL triangles from binary or ASCII data, for the stage (`ModelStage`) and the part's AR file (`PartUSDZ`), in the STL
/// frame (millimetres, Z up). Any bytes at all are read without stopping the app (#840): a file that is too short, says
/// it holds more triangles than it does, is another format under the STL's name (a 3MF zip), or has corners that aren't
/// finite numbers gives the whole triangles it has, or none; the caller shows nothing, or its one sentence.
public enum STLMesh {
    public typealias Triangle = (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)

    public static func triangles(_ data: Data) -> [Triangle] {
        if data.count >= 84 {
            let count = data.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 80, as: UInt32.self))) }
            if data.count == 84 + count * 50 { return binary(data, count: count) }
        }
        if let text = String(data: data.prefix(64 << 20), encoding: .ascii), text.hasPrefix("solid") {
            let ascii = self.ascii(text)
            if !ascii.isEmpty { return ascii }
        }
        guard data.count >= 84 else { return [] }
        let count = data.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 80, as: UInt32.self))) }
        return binary(data, count: min(count, (data.count - 84) / 50))
    }

    /// A triangle's unit normal, or nil when it has none: a point, a line, or a corner that isn't a finite number.
    /// Worked in `Double` (#840): a sliver from a pass's merged mesh (three nearly collinear corners, a cross product
    /// near 1e-20) has a subnormal squared length in `Float`, where `simd_normalize` overflowed to `(nan, nan, ±inf)` and
    /// writing that normal into the AR file trapped. The stage's normals and the AR file's come from here.
    public static func faceNormal(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) -> SIMD3<Float>? {
        let a = SIMD3<Double>(a), b = SIMD3<Double>(b), c = SIMD3<Double>(c)
        let cross = simd_cross(b - a, c - a)
        let length = simd_length(cross)
        guard length.isFinite, length > 0 else { return nil }
        let n = SIMD3<Float>(cross / length)
        guard n.x.isFinite, n.y.isFinite, n.z.isFinite, abs(simd_length(n) - 1) < 0.001 else { return nil }
        return n
    }

    static func finite(_ p: SIMD3<Float>) -> Bool { p.x.isFinite && p.y.isFinite && p.z.isFinite }

    static func binary(_ data: Data, count: Int) -> [Triangle] {
        guard count > 0 else { return [] }
        var out: [Triangle] = []
        out.reserveCapacity(count)
        data.withUnsafeBytes { raw in
            for i in 0..<count {
                let base = 84 + i * 50
                guard base + 50 <= raw.count else { break }
                func v(_ o: Int) -> SIMD3<Float> {
                    SIMD3(Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: base + o, as: UInt32.self))),
                          Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: base + o + 4, as: UInt32.self))),
                          Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: base + o + 8, as: UInt32.self))))
                }
                let t = (v(12), v(24), v(36))
                if finite(t.0), finite(t.1), finite(t.2) { out.append(t) }
            }
        }
        return out
    }

    static func ascii(_ text: String) -> [Triangle] {
        var vertices: [SIMD3<Float>] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard parts.first == "vertex", parts.count == 4, let x = Float(parts[1]), let y = Float(parts[2]), let z = Float(parts[3]) else { continue }
            vertices.append(SIMD3(x, y, z))
        }
        return stride(from: 0, to: vertices.count - vertices.count % 3, by: 3).compactMap { i in
            let t = (vertices[i], vertices[i + 1], vertices[i + 2])
            return finite(t.0) && finite(t.1) && finite(t.2) ? t : nil
        }
    }
}
