import Foundation
import simd

/// A triangle mesh read from an STL: exactly what will print. STL is Z-up millimetres (as slicers see
/// it); RealityKit is Y-up metres, so every point is stood upright and scaled. Binary and ASCII STL both
/// read; anything else (USDZ scans) goes to RealityKit's own loader.
struct ModelMesh: Sendable, Equatable {
    var positions: [SIMD3<Float>]
    var normals: [SIMD3<Float>]
    var triangleCount: Int { positions.count / 3 }

    /// The axis-aligned box around every point, in RealityKit coordinates.
    var bounds: (min: SIMD3<Float>, max: SIMD3<Float>) {
        guard var low = positions.first else { return (.zero, .zero) }
        var high = low
        for p in positions { low = simd_min(low, p); high = simd_max(high, p) }
        return (low, high)
    }

    /// Nil when the data isn't an STL with at least one whole triangle.
    static func stl(_ data: Data) -> ModelMesh? {
        if let binary = binary(data) { return binary }
        return ascii(data)
    }

    static func read(_ url: URL) -> ModelMesh? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        return stl(data)
    }

    private static func upright(_ p: SIMD3<Float>) -> SIMD3<Float> { SIMD3(p.x, p.z, -p.y) * 0.001 }

    private static func add(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, to mesh: inout ModelMesh) {
        let pa = upright(a), pb = upright(b), pc = upright(c)
        let cross = simd_cross(pb - pa, pc - pa)
        let length = simd_length(cross)
        guard length.isFinite, length > 0 else { return } // degenerate: nothing to draw
        let n = cross / length
        mesh.positions += [pa, pb, pc]
        mesh.normals += [n, n, n]
    }

    /// 80-byte header, a triangle count, then 50 bytes per triangle. Its size must match the count exactly,
    /// which is also how an ASCII file that happens to start with "solid" is told apart.
    private static func binary(_ data: Data) -> ModelMesh? {
        guard data.count >= 84 else { return nil }
        let count = Int(data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 80, as: UInt32.self) }.littleEndian)
        guard count > 0, data.count == 84 + count * 50 else { return nil }
        var mesh = ModelMesh(positions: [], normals: [])
        mesh.positions.reserveCapacity(count * 3)
        mesh.normals.reserveCapacity(count * 3)
        data.withUnsafeBytes { raw in
            func v(_ offset: Int) -> SIMD3<Float> {
                SIMD3(Float(bitPattern: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian),
                      Float(bitPattern: raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self).littleEndian),
                      Float(bitPattern: raw.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self).littleEndian))
            }
            for i in 0..<count {
                let base = 84 + i * 50
                add(v(base + 12), v(base + 24), v(base + 36), to: &mesh)
            }
        }
        return mesh.positions.isEmpty ? nil : mesh
    }

    private static func ascii(_ data: Data) -> ModelMesh? {
        guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1),
              text.drop(while: { $0.isWhitespace }).lowercased().hasPrefix("solid") else { return nil }
        var mesh = ModelMesh(positions: [], normals: [])
        var corner: [SIMD3<Float>] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let words = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard words.first?.lowercased() == "vertex", words.count >= 4,
                  let x = Float(words[1]), let y = Float(words[2]), let z = Float(words[3]) else { continue }
            corner.append(SIMD3(x, y, z))
            if corner.count == 3 { add(corner[0], corner[1], corner[2], to: &mesh); corner.removeAll(keepingCapacity: true) }
        }
        return mesh.positions.isEmpty ? nil : mesh
    }
}
