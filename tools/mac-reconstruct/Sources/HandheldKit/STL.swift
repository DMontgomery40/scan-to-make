import Foundation
import ModelIO
import simd

/// What `writeSTL` wrote: the triangle count and the size of the model's box in millimetres.
public struct STLSummary: Equatable {
    public var triangles: Int
    public var vertices: Int
    public var sizeMm: SIMD3<Double>
    /// The surface it stood on, when `removeSupport` was asked for and found one (see `removeSupport(_:)`).
    public var support: SupportCut? = nil
}

/// A triangle list's indices three at a time. A triangle with any index outside the mesh is skipped whole, so one
/// bad index can never shift the corners of every triangle after it.
public func wholeTriangles(_ indices: [Int], vertexCount: Int) -> [[Int]] {
    stride(from: 0, to: indices.count / 3 * 3, by: 3).compactMap { start in
        let triangle = Array(indices[start..<start + 3])
        return triangle.allSatisfy { $0 >= 0 && $0 < vertexCount } ? triangle : nil
    }
}

/// Writes every triangle of a model (USDZ, USD, OBJ) as a binary STL the way a project's models are kept: millimetres,
/// Z up, centred on the origin and resting on z = 0, as the touch-up's Blender export leaves them.
///
/// PhotogrammetrySession writes its models in metres (`metersPerUnit = 1`) with Y up, and an STL has no units:
/// slicers and the printer MCPs read millimetres with Z up. Y-up becomes Z-up by turning (x, y, z) into (x, −z, y), a
/// rotation, so faces keep their winding. Each mesh is placed with its full composed transform first, so the STL is
/// what the model shows. Textures are dropped; a printer only needs the shape.
///
/// With `removeSupport`, the surface the object stood on (a rig's plate, a patch of table) is cut away first and the
/// object stands on where it stood (`removeSupport(_:)`); when there is no such surface the model is kept as it is.
@discardableResult
public func writeSTL(model: URL, to output: URL, metresPerUnit: Double = 1, removeSupport cutSupport: Bool = false) throws -> STLSummary {
    let asset = MDLAsset(url: model)
    var corners: [SIMD3<Float>] = []
    var vertices = 0
    func visit(_ object: MDLObject) {
        if let mesh = object as? MDLMesh {
            let world = MDLTransform.globalTransform(with: object, atTime: 0)
            if let positions = mesh.vertexAttributeData(forAttributeNamed: MDLVertexAttributePosition, as: .float3) {
                vertices += mesh.vertexCount
                func position(_ index: Int) -> SIMD3<Float> {
                    let p = positions.dataStart.advanced(by: index * positions.stride).assumingMemoryBound(to: Float.self)
                    let v = world * SIMD4<Float>(p[0], p[1], p[2], 1)
                    return SIMD3(v.x, v.y, v.z)
                }
                for case let submesh as MDLSubmesh in mesh.submeshes ?? [] where submesh.geometryType == .triangles {
                    let bytes = submesh.indexBuffer.map().bytes
                    let indices = (0..<submesh.indexCount).map { i -> Int in
                        switch submesh.indexType {
                        case .uInt8: return Int(bytes.load(fromByteOffset: i, as: UInt8.self))
                        case .uInt16: return Int(bytes.load(fromByteOffset: i * 2, as: UInt16.self))
                        default: return Int(bytes.load(fromByteOffset: i * 4, as: UInt32.self))
                        }
                    }
                    for triangle in wholeTriangles(indices, vertexCount: mesh.vertexCount) { corners += triangle.map(position) }
                }
            }
        }
        for child in object.children.objects { visit(child) }
    }
    for index in 0..<asset.count { visit(asset.object(at: index)) }
    guard corners.count / 3 > 0 else { throw HandheldError.io("\(model.lastPathComponent) has no triangles") }

    let scale = Float(metresPerUnit * 1000)
    // Only an asset that says Z is up stays as it is; Apple's USDZ (and a file with no up axis) is Y up.
    let yUp = abs(asset.upAxis.z) < 0.5
    for i in corners.indices {
        let p = corners[i] * scale
        corners[i] = yUp ? SIMD3(p.x, -p.z, p.y) : p
    }
    var support: SupportCut?
    if cutSupport, let cut = removeSupport(corners) { corners = cut.corners; support = cut.cut }
    let triangles = corners.count / 3
    var low = SIMD3<Float>(repeating: .infinity), high = SIMD3<Float>(repeating: -.infinity)
    for corner in corners { low = simd_min(low, corner); high = simd_max(high, corner) }
    let offset = SIMD3<Float>(-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z)
    var data = Data(count: 80)
    var count = UInt32(triangles).littleEndian
    data.append(Data(bytes: &count, count: 4))
    data.reserveCapacity(84 + triangles * 50)
    for t in 0..<triangles {
        let a = corners[t * 3] + offset, b = corners[t * 3 + 1] + offset, c = corners[t * 3 + 2] + offset
        let cross = simd_cross(b - a, c - a), length = simd_length(cross)
        let normal = length > 0 ? cross / length : SIMD3<Float>(0, 0, 0)
        var floats = [normal.x, normal.y, normal.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].map { $0.bitPattern.littleEndian }
        data.append(Data(bytes: &floats, count: 48))
        data.append(contentsOf: [0, 0])
    }
    try data.write(to: output, options: .atomic)
    let size = high - low
    return STLSummary(triangles: triangles, vertices: vertices, sizeMm: SIMD3(Double(size.x), Double(size.y), Double(size.z)), support: support)
}
