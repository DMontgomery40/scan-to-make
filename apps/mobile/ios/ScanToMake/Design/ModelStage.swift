import SwiftUI
import RealityKit
import simd
import CounterpartKit

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
    /// The light stage, for a part that would be a silhouette on the dark one (CounterpartKit `StageContrast`).
    var lightStage = false
    /// Two-tone like a two-colour AMS print: the upper part in a warm tone (the mic-mount mockup).
    var twoTone = false
    /// Together (docs/protocols/seats.md): a scan drawn in its own colours at each seat (row-major 4×4, the part's
    /// millimetre frame), turned and framed with the part as one.
    var object: URL? = nil
    var seats: [[Double]] = []
    /// The size of what is drawn, in millimetres (width, depth, height), once it is loaded: the size chip's numbers.
    var measured: (([Double]) -> Void)? = nil

    @State private var holder = PivotHolder()
    @State private var turn: CGSize = .zero
    @State private var settled: CGSize = .zero
    @State private var zoom: Float = 1
    @State private var settledZoom: Float = 1

    @Environment(\.scenePhase) private var scenePhase
    @State private var poster: CGImage?
    @State private var live = false
    @State private var lastTouch = Date.distantPast
    @State private var failed = false

    private var identity: String { "\(url?.absoluteString ?? "empty")#\(tint?.description ?? "default")#\(twoTone)#\(yaw)#\(pitch)#\(fit)#\(object?.absoluteString ?? "")#\(seats.count)" }

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else if lightStage { LightStageBackground() } else { StageBackground() }
            if live && scenePhase == .active && interactive {
                realityView
            } else if let poster {
                Image(decorative: poster, scale: 1).resizable().scaledToFit()
            } else if failed {
                Text("This model couldn't be shown.").font(.footnote).foregroundStyle(.secondary)
            } else if url != nil { ProgressView() }
            if interactive && url != nil && !live {
                VStack { HStack { Spacer(); Button("Explore in 3D", systemImage: "rotate.3d") { touch() }.stageButton(light: lightStage) }; Spacer() }.padding(16)
            }
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 4)
            .onChanged { value in touch(); turn = CGSize(width: settled.width + value.translation.width, height: settled.height + value.translation.height) }
            .onEnded { _ in settled = turn; touch() }, isEnabled: interactive)
        .simultaneousGesture(MagnifyGesture()
            .onChanged { value in
                guard interactive && scenePhase == .active else { return }
                touch()
                zoom = min(3, max(0.5, settledZoom * Float(value.magnification)))
            }
            .onEnded { _ in
                guard interactive && scenePhase == .active else { return }
                settledZoom = zoom; touch()
            }, isEnabled: interactive)
        .task(id: "\(identity)#\(scenePhase)") {
            guard scenePhase == .active else { return }
            live = false; poster = nil; failed = false
            turn = .zero; settled = .zero; zoom = 1; settledZoom = 1
            guard let url, scenePhase == .active else { return }
            let loaded = await Self.load(url, tint: tint, twoTone: twoTone, object: object, seats: seats)
            guard !Task.isCancelled else { return }
            guard let entity = loaded else { failed = true; return }
            let e = entity.visualBounds(relativeTo: nil).extents
            measured?([Double(e.x), Double(e.z), Double(e.y)].map { ($0 * 10_000).rounded() / 10 })
            let image = await ModelPoster.image(key: identity, model: entity, yaw: yaw, pitch: pitch, fit: fit)
            guard !Task.isCancelled else { return }
            poster = image; failed = image == nil
        }
        .task(id: lastTouch) {
            guard live else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            live = false
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { live = false; holder.pivot = nil } }
        .onDisappear { live = false; holder.pivot = nil }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(url == nil ? "No model yet" : "3D model. Drag to turn it, pinch to zoom.")
    }

    private func touch() {
        guard interactive && scenePhase == .active else { return }
        live = true; lastTouch = Date()
    }

    private var realityView: some View {
        RealityView { content in
            content.camera = .virtual
            if let url {
                let loaded = await Self.load(url, tint: tint, twoTone: twoTone, object: object, seats: seats)
                guard !Task.isCancelled, live, scenePhase == .active else { return }
                guard let model = loaded else { failed = true; return }
                let scene = ModelPoster.scene(model: model, yaw: yaw, pitch: pitch, fit: fit)
                holder.pivot = scene.pivot
                holder.pivot?.orientation = orientation
                holder.pivot?.scale = SIMD3(repeating: zoom)
                content.add(scene.root)
            }
        } update: { _ in
            holder.pivot?.orientation = orientation
            holder.pivot?.scale = SIMD3(repeating: zoom)
        }
        .id(identity)
        .onDisappear { holder.pivot = nil }
    }

    private var orientation: simd_quatf {
        let y = yaw + Float(turn.width) * 0.01
        let p = max(-1.4, min(1.0, pitch + Float(turn.height) * 0.008))
        return simd_quatf(angle: p, axis: [1, 0, 0]) * simd_quatf(angle: y, axis: [0, 1, 0])
    }

    /// The gallery turns between a part, its scan and the two together: keep those three loaded, not one.
    @MainActor private static let cache = ModelEntityCache(limit: 3)
    @MainActor static func load(_ url: URL, tint: UIColor?, twoTone: Bool, object: URL? = nil, seats: [[Double]] = []) async -> Entity? {
        let key = "\(url.absoluteString)#\(tint?.description ?? "default")#\(twoTone)#\(object?.absoluteString ?? "")#\(seats.map { $0.map { String($0) }.joined(separator: ",") }.joined(separator: ";"))"
        return await cache.load(key: key) {
            let model: Entity?
            switch url.pathExtension.lowercased() {
            case "usdz", "usd", "usdc", "reality": model = try? await Entity(contentsOf: url)
            case "stl": model = await stl(url, tint: tint, twoTone: twoTone)
            default: model = nil
            }
            guard let model, let object, !seats.isEmpty, let scan = try? await Entity(contentsOf: object) else { return model }
            // Together: the scan (metres, Y up) into the seat frame (millimetres, Z up), placed by each seat in the part's
            // frame, then back to the stage (metres, Y up), where the part already is (docs/protocols/seats.md).
            let toSeat = simd_float4x4(rows: [SIMD4(1000, 0, 0, 0), SIMD4(0, 0, -1000, 0), SIMD4(0, 1000, 0, 0), SIMD4(0, 0, 0, 1)])
            let toStage = simd_float4x4(rows: [SIMD4(0.001, 0, 0, 0), SIMD4(0, 0, 0.001, 0), SIMD4(0, -0.001, 0, 0), SIMD4(0, 0, 0, 1)])
            let together = Entity()
            together.addChild(model)
            for seat in seats where seat.count == 16 {
                let m = simd_float4x4(rows: (0..<4).map { r in SIMD4<Float>((0..<4).map { Float(seat[r * 4 + $0]) }) })
                let placed = scan.clone(recursive: true)
                placed.transform = Transform(matrix: toStage * m * toSeat)
                together.addChild(placed)
            }
            return together
        }
    }

    /// The material every layout draws a model in before a spool is chosen (the Mac's and the companion's pictures').
    static let neutral = UIColor(red: 0.58, green: 0.58, blue: 0.60, alpha: 1)

    /// STL (binary or ASCII) to a RealityKit mesh. STL is Z-up millimetres; RealityKit is Y-up metres.
    @MainActor static func stl(_ url: URL, tint: UIColor?, twoTone: Bool) async -> Entity? {
        let triangles = await Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count > 84 else { return [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)]() }
            return STLMesh.triangles(data)
        }.value
        guard !triangles.isEmpty else { return nil }
        let (positions, normals) = await Task.detached(priority: .userInitiated) {
            Self.geometry(triangles)
        }.value
        func part(_ indices: [UInt32], _ color: UIColor) async -> ModelEntity? {
            guard !indices.isEmpty else { return nil }
            var d = MeshDescriptor()
            d.positions = MeshBuffers.Positions(positions)
            d.normals = MeshBuffers.Normals(normals)
            d.primitives = .triangles(indices)
            guard let mesh = try? await MeshResource(from: [d]) else { return nil }
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
            if let lo = await part(lowI, UIColor(white: 0.16, alpha: 1)) { entity.addChild(lo) }
            if let hi = await part(highI, UIColor(red: 0.80, green: 0.62, blue: 0.36, alpha: 1)) { entity.addChild(hi) }
        } else if let one = await part(Array(0..<UInt32(positions.count)), tint ?? neutral) {
            entity.addChild(one)
        }
        return entity
    }
    nonisolated private static func geometry(_ triangles: [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)]) -> ([SIMD3<Float>], [SIMD3<Float>]) {
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
        return (positions, normals)
    }

}

/// What floats on the stage stays readable on both stages (lead review, Nov 10: orange on glass over the light stage
/// was nearly invisible): clear glass on the dark stage; on the light stage a dark backing with white words.
extension View {
    @ViewBuilder func stageButton(light: Bool) -> some View {
        if light { self.buttonStyle(.glassProminent).tint(Color.black.opacity(0.62)).foregroundStyle(.white) }
        else { self.buttonStyle(.glass) }
    }
    func stageChip(light: Bool) -> some View {
        self.foregroundStyle(light ? Color.white : Color.primary)
            .glassEffect(light ? .regular.tint(Color.black.opacity(0.62)) : .regular, in: .capsule)
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
