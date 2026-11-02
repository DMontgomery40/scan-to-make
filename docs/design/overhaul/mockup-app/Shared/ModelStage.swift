import SwiftUI
import RealityKit

/// A real RealityKit render of a real model: the mic-mount STL or an Object Capture USDZ.
struct ModelStage: View {
    let thumb: Thumb
    var yaw: Float = 0.6
    var pitch: Float = -0.35
    var interactive = true
    var fit: Float = 0.24
    var backdrop: Color? = nil
    /// One filament colour for the whole model (the one-colour print, PRD §5.5 v1).
    var mono: PlatformColor? = nil

    var body: some View {
        RealityView { content in
            let root = Entity()
            if let model = await Self.load(thumb, mono: mono) {
                let bounds = model.visualBounds(relativeTo: nil)
                let size = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
                let s = fit / max(size, 0.0001)
                model.scale = SIMD3(repeating: s)
                model.position = -bounds.center * s
                let pivot = Entity()
                pivot.addChild(model)
                pivot.orientation = simd_quatf(angle: pitch, axis: [1, 0, 0]) * simd_quatf(angle: yaw, axis: [0, 1, 0])
                root.addChild(pivot)
            }
            let key = DirectionalLight()
            key.light.intensity = 4200
            key.look(at: .zero, from: [0.4, 0.6, 0.5], relativeTo: nil)
            let fill = DirectionalLight()
            fill.light.intensity = 1600
            fill.look(at: .zero, from: [-0.5, 0.1, 0.3], relativeTo: nil)
            let rim = DirectionalLight()
            rim.light.intensity = 2200
            rim.look(at: .zero, from: [0, 0.3, -0.6], relativeTo: nil)
            root.addChild(key); root.addChild(fill); root.addChild(rim)
            let cam = PerspectiveCamera()
            cam.camera.fieldOfViewInDegrees = 34
            cam.look(at: [0, 0.01, 0], from: [0, 0.05, 0.58], relativeTo: nil)
            root.addChild(cam)
            content.add(root)
        }
        .background { if let backdrop { backdrop } else { StageBackground() } }
        .allowsHitTesting(interactive)
    }

    @MainActor
    static func load(_ thumb: Thumb, mono: PlatformColor? = nil) async -> Entity? {
        switch thumb {
        case .scanA: return await usdz("scanA")
        case .scanB: return await usdz("scanB")
        case .mic: return stl(mono: mono)
        }
    }

    @MainActor
    static func usdz(_ name: String) async -> Entity? {
        guard let url = assetURL(name, "usdz") else { return nil }
        return try? await Entity(contentsOf: url)
    }

    /// Binary STL to a RealityKit mesh, two-tone like a two-colour AMS print.
    @MainActor
    static func stl(mono: PlatformColor? = nil) -> Entity? {
        guard let url = assetURL("mic", "stl"), let data = try? Data(contentsOf: url), data.count > 84 else { return nil }
        let count = Int(data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 80, as: UInt32.self) })
        var positions: [SIMD3<Float>] = []
        var normals: [SIMD3<Float>] = []
        positions.reserveCapacity(count * 3)
        data.withUnsafeBytes { raw in
            for i in 0..<count {
                let base = 84 + i * 50
                guard base + 50 <= raw.count else { break }
                func v(_ o: Int) -> SIMD3<Float> {
                    SIMD3(raw.loadUnaligned(fromByteOffset: base + o, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: base + o + 4, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: base + o + 8, as: Float.self))
                }
                let a = v(12), b = v(24), c = v(36)
                // STL is Z-up millimetres; RealityKit is Y-up.
                func yUp(_ p: SIMD3<Float>) -> SIMD3<Float> { SIMD3(p.x, p.z, -p.y) * 0.001 }
                let pa = yUp(a), pb = yUp(b), pc = yUp(c)
                let n = simd_normalize(simd_cross(pb - pa, pc - pa))
                positions += [pa, pb, pc]
                normals += [n, n, n]
            }
        }
        // Split by height: the cradle in the accent colour, the cup in dark grey.
        let ys = positions.map(\.y)
        let cut = (ys.min()! + ys.max()!) * 0.5 + (ys.max()! - ys.min()!) * 0.08
        var lowI: [UInt32] = [], highI: [UInt32] = []
        for t in 0..<(positions.count / 3) {
            let cy = (positions[t*3].y + positions[t*3+1].y + positions[t*3+2].y) / 3
            let idx = [UInt32(t*3), UInt32(t*3+1), UInt32(t*3+2)]
            if cy > cut { highI += idx } else { lowI += idx }
        }
        func part(_ indices: [UInt32], _ color: PlatformColor) -> ModelEntity? {
            var d = MeshDescriptor()
            d.positions = MeshBuffers.Positions(positions)
            d.normals = MeshBuffers.Normals(normals)
            d.primitives = .triangles(indices)
            guard let mesh = try? MeshResource.generate(from: [d]) else { return nil }
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: color)
            m.roughness = 0.55
            m.metallic = 0.0
            return ModelEntity(mesh: mesh, materials: [m])
        }
        let e = Entity()
        if let lo = part(lowI, mono ?? PlatformColor(white: 0.16, alpha: 1)) { e.addChild(lo) }
        if let hi = part(highI, mono ?? PlatformColor(red: 0.80, green: 0.62, blue: 0.36, alpha: 1)) { e.addChild(hi) }
        return e
    }
}

#if os(iOS)
typealias PlatformColor = UIColor
#else
typealias PlatformColor = NSColor
#endif
