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
    /// Two-tone like a two-colour AMS print: the upper part in a warm tone (the mic-mount mockup).
    var twoTone = false
    /// Together (docs/protocols/seats.md): a scan drawn in its own colours at each seat (row-major 4×4, the part's
    /// millimetre frame), turned and framed with the part as one.
    var object: URL? = nil
    var seats: [[Double]] = []
    /// The size of what is drawn, in millimetres (width, depth, height), once it is loaded: the size chip's numbers.
    var measured: (([Double]) -> Void)? = nil
    /// What the stage shows until the model is drawn, and if it can't be: the Mac's picture of it, never an empty stage.
    var placeholder: AnyView? = nil
    /// Told when the file is here but can't be drawn (review F7 on #525), so the page can say so under its picture.
    var undrawable: (() -> Void)? = nil
    /// Lets a gallery clear a previous failure after a retry succeeds.
    var drawn: (() -> Void)? = nil

    @State private var holder = PivotHolder()
    @State private var turn: CGSize = .zero
    @State private var settled: CGSize = .zero
    @State private var zoom: Float = 1
    @State private var settledZoom: Float = 1

    @Environment(\.scenePhase) private var scenePhase
    /// This phone's own still of the model. Optional (#606): the page already has the Mac's picture (`placeholder`), and
    /// a still that can't be rendered off screen never stops the model from turning.
    @State private var poster: CGImage?
    @State private var live = false
    @State private var lastTouch = Date.distantPast
    /// The model itself couldn't be loaded for this stage.
    @State private var failed = false
    @State private var posterIdentity: String?
    @State private var retryGeneration = 0
    /// A model for this identity is loaded and has geometry (`ModelEntityCache`): a drag, a pinch or Explore in 3D can open
    /// it live. It never waits for the still (#606; #539 had made 3D wait on it).
    @State private var meshReady = false
    /// The live view has drawn a frame with the model in it. Until then the stage keeps showing its still.
    @State private var liveDrawn = false
    /// The live view couldn't open (no model, or no frame within `openingDeadline`). Said and retried on its own: the next
    /// drag, pinch or Try 3D Again opens it again; the still's own state never decides it.
    @State private var liveFailed = false
    /// Each new try at the live view is a new RealityView.
    @State private var liveAttempt = 0

    private var identity: String { "\(url?.absoluteString ?? "empty")#\(tint?.description ?? "default")#\(twoTone)#\(yaw)#\(pitch)#\(fit)#\(object?.absoluteString ?? "")#\(seats.count)" }
    private var showsLive: Bool { live && url != nil && scenePhase == .active && interactive }

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else { StageBackground() }
            Color.clear.allowsHitTesting(false)
                .accessibilityElement().accessibilityLabel(url == nil ? "No model yet" : "3D model. Drag to turn it, pinch to zoom.")
                .accessibilityValue(stageState).accessibilityIdentifier("model-stage")
            // The live view opens under the still and replaces it once it has drawn the model, so the stage never goes
            // blank between the two (the Mac's picture stays until RealityKit has something to show).
            if showsLive { realityView }
            if !(showsLive && liveDrawn) {
                Group {
                    if let poster {
                        Image(decorative: poster, scale: 1).resizable().scaledToFit()
                    } else if let placeholder {
                        placeholder
                    } else if failed {
                        Text("This model couldn't be shown.").font(.footnote).foregroundStyle(.secondary)
                    } else if url != nil && !meshReady { ProgressView() }
                }
                .overlay(alignment: .topTrailing) {
                    if showsLive { ProgressView().tint(.white.opacity(0.6)).padding(14).accessibilityHidden(true) }
                }
            }
            // Where Explore in 3D sits (the two never show together): clear of the gallery's chips along the stage's bottom.
            if interactive && !live && (failed || liveFailed) && (placeholder != nil || liveFailed) {
                VStack { HStack { Spacer(); Button("Try 3D Again", systemImage: "rotate.3d") { if failed { retryGeneration += 1 } else { touch() } }.stageButton() }; Spacer() }.padding(16)
            }
            if interactive && url != nil && meshReady && !live && !failed && !liveFailed {
                VStack { HStack { Spacer(); Button("Explore in 3D", systemImage: "rotate.3d") { touch() }.stageButton() }; Spacer() }.padding(16)
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
        .task(id: "\(identity)#\(scenePhase)#\(retryGeneration)") {
            guard scenePhase == .active else { return }
            live = false; failed = false; meshReady = false; liveDrawn = false; liveFailed = false
            if posterIdentity != identity { poster = nil }
            turn = .zero; settled = .zero; zoom = 1; settledZoom = 1
            guard let url, scenePhase == .active else { return }
            await MediaTrace.$context.withValue(MediaTrace.Context(file: url, scene: String(describing: scenePhase))) {
                MediaTrace.record("stage.begin", ["scene": String(describing: scenePhase)])
                defer { MediaTrace.record(Task.isCancelled ? "stage.cancelled" : "stage.end", ["scene": String(describing: scenePhase)]) }
                let loaded = await Self.load(url, tint: tint, twoTone: twoTone, object: object, seats: seats)
                guard !Task.isCancelled, scenePhase == .active else { return }
                guard let entity = loaded else {
                    // A live view that opened meanwhile (a drag while this loaded) has its own answer.
                    if !(live && liveDrawn) { failed = true; undrawable?() }
                    return
                }
                ready(entity)
                var image = await ModelPoster.image(key: identity, model: entity, yaw: yaw, pitch: pitch, fit: fit)
                #if DEBUG
                // `-CounterpartFailPoster YES` (UI tests, #606): the off-screen still fails, as it can on a phone.
                if UserDefaults.standard.bool(forKey: "CounterpartFailPoster") { image = nil }
                #endif
                guard !Task.isCancelled, scenePhase == .active else { return }
                if let image { poster = image; posterIdentity = identity; drawn?() }
                // Without a still the stage keeps the Mac's picture and still turns (#606). A stage with neither (the
                // starters' turntables, which don't turn) says it couldn't be shown.
                if image == nil, placeholder == nil, !interactive { failed = true; undrawable?() }
                MediaTrace.record("stage.published", ["picture": String(image != nil)])
            }
        }
        // Back to the still a few seconds after the last touch, counted from when the live view has drawn: a slow first
        // frame never sends it back before it was ever seen.
        .task(id: "\(lastTouch)#\(liveDrawn)") {
            guard live, liveDrawn else { return }
            do { try await Task.sleep(for: .seconds(Self.idle)) } catch { return }
            live = false
        }
        // The live view has this long to draw (longer than the mesh work's own 20 s deadline, `ModelEntityCache`).
        .task(id: "\(live)#\(liveAttempt)") {
            guard live, !liveDrawn else { return }
            do { try await Task.sleep(for: Self.openingDeadline) } catch { return }
            guard live, !liveDrawn else { return }
            liveCouldNotOpen("deadline")
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { live = false; holder.pivot = nil; Self.cache.removeAll(); ModelPoster.deferPending() } }
        .onDisappear { live = false; holder.pivot = nil }
        .accessibilityElement(children: .contain)
    }

    /// The stage's state for VoiceOver and UI tests (`model-stage`): loading, still, opening (3D asked for, not drawn yet),
    /// live (3D drawn), failed.
    private var stageState: String {
        if url == nil { return "empty" }
        if showsLive { return liveDrawn ? "live" : "opening" }
        if failed || liveFailed { return "failed" }
        return meshReady ? "still" : "loading"
    }

    /// Seconds after the last touch before the stage goes back to its still.
    private static var idle: Double {
        #if DEBUG
        // `-CounterpartStageIdle <seconds>` (UI tests): long enough for a test to read the live state after its drag.
        let seconds = UserDefaults.standard.double(forKey: "CounterpartStageIdle")
        if seconds > 0 { return seconds }
        #endif
        return 3
    }
    static let openingDeadline: Duration = .seconds(25)

    /// A model with geometry is here: its size for the chip, and 3D can open.
    private func ready(_ entity: Entity) {
        meshReady = true; failed = false
        let e = entity.visualBounds(relativeTo: nil).extents
        measured?([Double(e.x), Double(e.z), Double(e.y)].map { ($0 * 10_000).rounded() / 10 })
    }

    private func touch() {
        guard interactive && scenePhase == .active, url != nil else { return }
        if !live {
            // A touch after a failure is a new try at the live view, never a dead still (audit 2026-11-11 §2).
            if failed || liveFailed {
                liveAttempt += 1
                if let url { MediaTrace.record("stage.live-retry", ["file": url.lastPathComponent]) }
            }
            liveFailed = false; liveDrawn = false
        }
        live = true; lastTouch = Date()
    }

    private func liveCouldNotOpen(_ reason: String) {
        if let url { MediaTrace.record("stage.live-failed", ["reason": reason, "file": url.lastPathComponent]) }
        live = false; liveDrawn = false; liveFailed = true
        undrawable?()
    }

    private var realityView: some View {
        RealityView { content in
            content.camera = .virtual
            if let url {
                let loaded = await Self.load(url, tint: tint, twoTone: twoTone, object: object, seats: seats)
                guard !Task.isCancelled, live, scenePhase == .active else { return }
                guard let model = loaded else { liveCouldNotOpen("no-model"); return }
                ready(model)
                let scene = ModelPoster.scene(model: model, yaw: yaw, pitch: pitch, fit: fit)
                holder.pivot = scene.pivot
                holder.pivot?.orientation = orientation
                holder.pivot?.scale = SIMD3(repeating: zoom)
                content.add(scene.root)
                // The first scene update with the model in it: from then the live view replaces the still.
                holder.firstFrame = content.subscribe(to: SceneEvents.Update.self) { _ in
                    holder.firstFrame?.cancel(); holder.firstFrame = nil
                    Task { @MainActor in
                        guard live else { return }
                        liveDrawn = true; liveFailed = false
                        MediaTrace.record("stage.live-drawn", ["file": url.lastPathComponent])
                        drawn?()
                    }
                }
            }
        } update: { _ in
            holder.pivot?.orientation = orientation
            holder.pivot?.scale = SIMD3(repeating: zoom)
        }
        .id("\(identity)#\(liveAttempt)")
        .onDisappear { holder.pivot = nil; holder.firstFrame?.cancel(); holder.firstFrame = nil; liveDrawn = false }
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
        MediaTrace.record("mesh.parse-end", ["triangles": String(triangles.count)])
        guard !Task.isCancelled, !triangles.isEmpty else { return nil }
        let (positions, normals) = await Task.detached(priority: .userInitiated) {
            Self.geometry(triangles)
        }.value
        func part(_ indices: [UInt32], _ color: UIColor) async -> ModelEntity? {
            guard !Task.isCancelled, !indices.isEmpty else { return nil }
            var d = MeshDescriptor()
            d.positions = MeshBuffers.Positions(positions)
            d.normals = MeshBuffers.Normals(normals)
            d.primitives = .triangles(indices)
            MediaTrace.record("mesh.resource-start")
            let mesh: MeshResource
            do { mesh = try await MeshResource(from: [d]) }
            catch { MediaTrace.record("mesh.resource-error", ["code": String((error as NSError).code)]); return nil }
            MediaTrace.record("mesh.resource-end")
            guard !Task.isCancelled else { return nil }
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
        return ModelEntityCache.hasGeometry(entity) ? entity : nil
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

/// What floats on the stage: clear glass, as on the dark stage everywhere.
extension View {
    func stageButton() -> some View { self.buttonStyle(.glass) }
    func stageChip() -> some View {
        self.foregroundStyle(Color.primary).glassEffect(.regular, in: .capsule)
    }
}

/// Keeps the pivot between RealityView's make and update closures.
private final class PivotHolder {
    var pivot: Entity?
    var firstFrame: EventSubscription?
}

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
