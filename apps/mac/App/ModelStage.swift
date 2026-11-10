import SwiftUI
import AppKit
import RealityKit
import CounterpartKit

/// The dark "stage" behind every model (PRD §2.1, §10): the object is the hero, glass floats over it.
/// The light stage (CounterpartKit `StageContrast`), for a part that would be a silhouette on the dark one.
struct LightStageBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.86, green: 0.87, blue: 0.89), Color(red: 0.70, green: 0.71, blue: 0.74)], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color.white.opacity(0.35), .clear], center: .init(x: 0.5, y: 0.62), startRadius: 4, endRadius: 220)
        }
    }
}

struct StageBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [.stageTop, .stageBottom], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color.white.opacity(0.10), .clear], center: .init(x: 0.5, y: 0.62), startRadius: 4, endRadius: 220)
        }
    }
}

/// The project's model on the dark stage (PRD §2.1, §10, §9.6). A still of it (the companion's render) shows by
/// default; RealityKit renders only while the person turns or zooms it, and goes back to the still about 3 s after the
/// last touch, or at once when the window is hidden, minimised or covered. One live view per window at most: the
/// print sheet's stage is always the still.
struct ModelStage: View {
    let url: URL
    /// Changes when the file is rewritten, so a new pass reloads the model.
    let version: Double
    var yaw: Float = 0.6
    var pitch: Float = -0.35
    var interactive = true
    /// The model's largest side, in metres, as framed by the camera.
    var fit: Float = 0.15
    var backdrop: Color? = nil
    /// The light stage, for a part that would be a silhouette on the dark one (CounterpartKit `StageContrast`).
    var lightStage = false
    var accessibilityText = "The model. Drag to turn it, scroll or pinch to zoom."
    /// Optional companion still while the local model poster loads.
    var poster: URL? = nil
    /// The spool an STL prints in (PRD §5.4); nil draws the neutral material.
    var tint: NSColor? = nil
    /// Together (docs/protocols/seats.md): the scan in its own colours at each seat (row-major 4×4, the part's millimetres).
    var object: URL? = nil
    var seats: [[Double]] = []
    /// The size of what is drawn, in millimetres, once it is loaded.
    var measured: (([Double]) -> Void)? = nil
    @State private var still: CGImage?
    @State private var stillIdentity: String?
    @State private var live = false
    @State private var lastTouch = Date.distantPast
    @State private var visible = true
    @State private var hovering = false
    @State private var scrollMonitor: Any?
    @State private var failed = false

    private var showsLive: Bool { visible && interactive && live }
    private var variant: String { "\(tint?.description ?? "neutral")#\(object?.path ?? "")#\(seats.count)" }
    private var imageIdentity: String { "\(url.path)#\(version)#\(yaw)#\(pitch)#\(fit)#\(variant)" }

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else if lightStage { LightStageBackground() } else { StageBackground() }
            if showsLive {
                realityView
                    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in touch() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in touch() })
            } else if let still, stillIdentity == imageIdentity {
                Image(decorative: still, scale: 1).resizable().scaledToFit()
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 2).onChanged { _ in wake() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in wake() })
            } else if let poster {
                FileImage(url: poster, version: version, contentMode: .fit).padding(40)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 2).onChanged { _ in wake() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in wake() })
            } else if !failed { ProgressView() }
            if interactive && !showsLive {
                VStack {
                    HStack {
                        Spacer()
                        Button { wake() } label: { Label("Explore in 3D", systemImage: "rotate.3d") }
                            .buttonStyle(.glass).padding(.top, 108).padding(.trailing, 24)
                            .environment(\.colorScheme, lightStage ? .light : .dark)
                    }
                    Spacer()
                }
            }
            if failed {
                Text("This model couldn't be shown.").font(.callout).foregroundStyle(.secondary)
            }
        }
        .task(id: "\(imageIdentity)#\(visible)") {
            guard visible else { return }
            let requestedIdentity = imageIdentity
            // Uncovering a window does not need a GPU model when its still is
            // already current. File-version/framing changes must still reload.
            if stillIdentity == requestedIdentity, still != nil { return }
            failed = false
            let loaded = await Self.cached(url, version: version, tint: tint, object: object, seats: seats)
            guard !Task.isCancelled else { return }
            guard let model = loaded else { failed = poster == nil; return }
            let e = model.visualBounds(relativeTo: nil).extents
            measured?([Double(e.x), Double(e.z), Double(e.y)].map { ($0 * 10_000).rounded() / 10 })
            let image = await ModelPoster.image(key: imageIdentity, model: model, yaw: yaw, pitch: pitch, fit: fit)
            guard !Task.isCancelled else { return }
            still = image; stillIdentity = requestedIdentity
            failed = image == nil && poster == nil
        }
        .onChange(of: imageIdentity) { _, _ in live = false }
        .onHover { hovering = $0 }
        .onWindowVisibilityChange { shown in
            visible = shown
            if !shown { live = false }
        }
        .onAppear { watchScrolling() }
        .onDisappear { live = false; if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }; scrollMonitor = nil }
        // Back to the still about 3 s after the last touch.
        .task(id: lastTouch) {
            guard live else { return }
            try? await Task.sleep(for: .seconds(3))
            if Date().timeIntervalSince(lastTouch) >= 2.9 { live = false }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAction(named: "Explore in 3D") { wake() }
    }

    private func wake() {
        guard interactive else { return }
        live = true
        touch()
    }

    private func touch() { lastTouch = Date() }

    /// Scroll-to-zoom has no SwiftUI gesture: a scroll over the stage wakes it, and keeps it awake while it goes on.
    private func watchScrolling() {
        guard interactive, scrollMonitor == nil else { return }
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if hovering { if live { touch() } else { wake() } }
            return event
        }
    }

    private var realityView: some View {
        RealityView { content in
            content.camera = .virtual
            let loaded = await Self.cached(url, version: version, tint: tint, object: object, seats: seats)
            guard !Task.isCancelled, showsLive else { return }
            if let model = loaded {
                content.add(ModelPoster.scene(model: model, yaw: yaw, pitch: pitch, fit: fit).root)
            } else { failed = true }
        }
        .realityViewCameraControls(interactive ? .orbit : .none)
        .allowsHitTesting(interactive)
        .id("\(url.path)#\(version)#\(variant)")
    }

    /// Loaded once per file version: going live again reuses the mesh instead of reading and building it again.
    /// The gallery turns between a part, its scan and the two together: keep those three loaded.
    @MainActor private static let cache = ModelEntityCache(limit: 3)
    @MainActor static func releaseCachedModels() { cache.removeAll() }
    @MainActor static func cached(_ url: URL, version: Double, tint: NSColor? = nil, object: URL? = nil, seats: [[Double]] = []) async -> Entity? {
        await cache.load(key: "\(url.path)#\(version)#\(tint?.description ?? "neutral")#\(object?.path ?? "")#\(seats.map { $0.map { String($0) }.joined(separator: ",") }.joined(separator: ";"))") {
            guard let model = await load(url, tint: tint) else { return nil }
            guard let object, !seats.isEmpty, let scan = try? await Entity(contentsOf: object) else { return model }
            // The scan (metres, Y up) into the seat frame (millimetres, Z up), placed by each seat in the part's frame,
            // then to the stage (metres, Y up) where the part's STL already is (docs/protocols/seats.md).
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

    /// STL through `ModelMesh` (read off the main thread); USDZ and other RealityKit formats directly.
    @MainActor static func load(_ url: URL, tint: NSColor? = nil) async -> Entity? {
        if url.pathExtension.lowercased() == "stl" {
            guard let mesh = await Task.detached(priority: .userInitiated, operation: { ModelMesh.read(url) }).value else { return nil }
            guard let resource = await mesh.resource() else { return nil }
            var material = PhysicallyBasedMaterial()
            material.baseColor = .init(tint: tint ?? NSColor(red: 0.58, green: 0.58, blue: 0.60, alpha: 1))
            material.roughness = 0.55
            material.metallic = 0.0
            material.faceCulling = .none // scans aren't always closed
            return ModelEntity(mesh: resource, materials: [material])
        }
        return try? await Entity(contentsOf: url)
    }
}
