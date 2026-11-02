import Foundation
import simd
import RealityKit

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

    /// Feed RealityKit the exact preview triangles without its general-purpose
    /// MeshDescriptor conversion retaining additional copies of a large scan.
    @MainActor func resource() async -> MeshResource? {
        let count = positions.count
        guard count > 0, count.isMultiple(of: 3), count == normals.count, count <= Int(UInt32.max) else { return nil }
        let prepared = await Task.detached(priority: .userInitiated) {
            var vertices: [Float] = []
            vertices.reserveCapacity(count * 6)
            for i in 0..<count {
                let p = positions[i], n = normals[i]
                vertices.append(contentsOf: [p.x, p.y, p.z, n.x, n.y, n.z])
            }
            return (vertices, bounds)
        }.value
        guard !Task.isCancelled else { return nil }
        let descriptor = LowLevelMesh.Descriptor(vertexCapacity: count,
            vertexAttributes: [.init(semantic: .position, format: .float3, offset: 0), .init(semantic: .normal, format: .float3, offset: 12)],
            vertexLayouts: [.init(bufferIndex: 0, bufferStride: 24)], indexCapacity: count, indexType: .uint32)
        guard let mesh = try? LowLevelMesh(descriptor: descriptor) else { return nil }
        mesh.withUnsafeMutableBytes(bufferIndex: 0) { destination in
            prepared.0.withUnsafeBytes { destination.copyMemory(from: $0) }
        }
        mesh.withUnsafeMutableIndices { bytes in
            let indices = bytes.bindMemory(to: UInt32.self)
            for i in 0..<count { indices[i] = UInt32(i) }
        }
        mesh.parts.replaceAll([.init(indexCount: count, bounds: .init(min: prepared.1.min, max: prepared.1.max))])
        return try? await MeshResource(from: mesh)
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
