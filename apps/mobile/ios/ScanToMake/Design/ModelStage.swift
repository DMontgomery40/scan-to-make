import SwiftUI
import RealityKit
import simd

/// A real model on the dark stage (PRD §2.1): the project's `model.stl` (or a USDZ scan), rendered by
/// RealityKit and turned by dragging. Ported from the mockups' ModelStage.
struct ModelStage: View {
    /// A local STL or USDZ file; nil shows the empty stage.
    var url: URL?
    var yaw: Float = 0.6
    var pitch: Float = -0.35
    var interactive = true
    /// The model's longest side, in metres on the stage.
    var fit: Float = 0.24
    /// One filament colour for the whole model; nil for the default printed look.
    var tint: UIColor? = nil
    var backdrop: Color? = nil
    /// Two-tone like a two-colour AMS print: the upper part in a warm tone (the mic-mount mockup).
    var twoTone = false

    @State private var holder = PivotHolder()
    @State private var turn: CGSize = .zero
    @State private var settled: CGSize = .zero

    var body: some View {
        RealityView { content in
            let root = Entity()
            let pivot = Entity()
            holder.pivot = pivot
            if let url, let model = await Self.load(url, tint: tint, twoTone: twoTone) {
                let bounds = model.visualBounds(relativeTo: nil)
                let size = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
                let s = fit / max(size, 0.0001)
                model.scale = SIMD3(repeating: s)
                model.position = -bounds.center * s
                pivot.addChild(model)
            }
            pivot.orientation = orientation
            root.addChild(pivot)
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
            let camera = PerspectiveCamera()
            camera.camera.fieldOfViewInDegrees = 34
            camera.look(at: [0, 0.01, 0], from: [0, 0.05, 0.58], relativeTo: nil)
            root.addChild(camera)
            content.add(root)
        } update: { _ in
            holder.pivot?.orientation = orientation
        }
        .id(url)
        .background { if let backdrop { backdrop } else { StageBackground() } }
        .gesture(DragGesture(minimumDistance: 4)
            .onChanged { turn = CGSize(width: settled.width + $0.translation.width, height: settled.height + $0.translation.height) }
            .onEnded { _ in settled = turn }, isEnabled: interactive)
        .allowsHitTesting(interactive)
        .accessibilityElement()
        .accessibilityLabel(url == nil ? "No model yet" : "3D model. Drag to turn it.")
        .accessibilityAddTraits(.isImage)
    }

    private var orientation: simd_quatf {
        let y = yaw + Float(turn.width) * 0.01
        let p = max(-1.4, min(1.0, pitch + Float(turn.height) * 0.008))
        return simd_quatf(angle: p, axis: [1, 0, 0]) * simd_quatf(angle: y, axis: [0, 1, 0])
    }

    @MainActor static func load(_ url: URL, tint: UIColor?, twoTone: Bool) async -> Entity? {
        switch url.pathExtension.lowercased() {
        case "usdz", "usd", "usdc", "reality": return try? await Entity(contentsOf: url)
        default: return stl(url, tint: tint, twoTone: twoTone)
        }
    }

    /// STL (binary or ASCII) to a RealityKit mesh. STL is Z-up millimetres; RealityKit is Y-up metres.
    @MainActor static func stl(_ url: URL, tint: UIColor?, twoTone: Bool) -> Entity? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count > 84 else { return nil }
        let triangles = STLMesh.triangles(data)
        guard !triangles.isEmpty else { return nil }
        var positions: [SIMD3<Float>] = []
        var normals: [SIMD3<Float>] = []
        positions.reserveCapacity(triangles.count * 3)
        normals.reserveCapacity(triangles.count * 3)
        func yUp(_ p: SIMD3<Float>) -> SIMD3<Float> { SIMD3(p.x, p.z, -p.y) * 0.001 }
        for t in triangles {
            let a = yUp(t.0), b = yUp(t.1), c = yUp(t.2)
            let cross = simd_cross(b - a, c - a)
            let n = simd_length(cross) > 0 ? simd_normalize(cross) : SIMD3<Float>(0, 1, 0)
            positions += [a, b, c]
            normals += [n, n, n]
        }
        func part(_ indices: [UInt32], _ color: UIColor) -> ModelEntity? {
            guard !indices.isEmpty else { return nil }
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
        let entity = Entity()
        if twoTone && tint == nil {
            // Split by height: the upper part in the accent tone, the base in dark grey.
            let ys = positions.map(\.y)
            let low = ys.min() ?? 0, high = ys.max() ?? 0
            let cut = (low + high) * 0.5 + (high - low) * 0.08
            var lowI: [UInt32] = [], highI: [UInt32] = []
            for t in 0..<(positions.count / 3) {
                let cy = (positions[t * 3].y + positions[t * 3 + 1].y + positions[t * 3 + 2].y) / 3
                let idx = [UInt32(t * 3), UInt32(t * 3 + 1), UInt32(t * 3 + 2)]
                if cy > cut { highI += idx } else { lowI += idx }
            }
            if let lo = part(lowI, UIColor(white: 0.16, alpha: 1)) { entity.addChild(lo) }
            if let hi = part(highI, UIColor(red: 0.80, green: 0.62, blue: 0.36, alpha: 1)) { entity.addChild(hi) }
        } else if let one = part(Array(0..<UInt32(positions.count)), tint ?? UIColor(red: 0.80, green: 0.62, blue: 0.36, alpha: 1)) {
            entity.addChild(one)
        }
        return entity
    }
}

/// Keeps the pivot between RealityView's make and update closures.
private final class PivotHolder { var pivot: Entity? }

/// STL triangles from binary or ASCII data.
enum STLMesh {
    static func triangles(_ data: Data) -> [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)] {
        let count = Int(data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 80, as: UInt32.self) })
        if data.count == 84 + count * 50 { return binary(data, count: count) }
        if let text = String(data: data.prefix(min(data.count, 64 << 20)), encoding: .ascii), text.hasPrefix("solid") {
            let ascii = self.ascii(text)
            if !ascii.isEmpty { return ascii }
        }
        return binary(data, count: min(count, (data.count - 84) / 50))
    }

    static func binary(_ data: Data, count: Int) -> [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)] {
        var out: [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)] = []
        out.reserveCapacity(count)
        data.withUnsafeBytes { raw in
            for i in 0..<count {
                let base = 84 + i * 50
                guard base + 50 <= raw.count else { break }
                func v(_ o: Int) -> SIMD3<Float> {
                    SIMD3(raw.loadUnaligned(fromByteOffset: base + o, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: base + o + 4, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: base + o + 8, as: Float.self))
                }
                out.append((v(12), v(24), v(36)))
            }
        }
        return out
    }

    static func ascii(_ text: String) -> [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)] {
        var vertices: [SIMD3<Float>] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.first == "vertex", parts.count == 4, let x = Float(parts[1]), let y = Float(parts[2]), let z = Float(parts[3]) else { continue }
            vertices.append(SIMD3(x, y, z))
        }
        return stride(from: 0, to: vertices.count - vertices.count % 3, by: 3).map { (vertices[$0], vertices[$0 + 1], vertices[$0 + 2]) }
    }
}
