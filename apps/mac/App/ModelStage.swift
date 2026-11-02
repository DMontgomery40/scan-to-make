import SwiftUI
import AppKit
import RealityKit

/// The dark "stage" behind every model (PRD §2.1, §10): the object is the hero, glass floats over it.
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
    var accessibilityText = "The model. Drag to turn it, scroll or pinch to zoom."
    /// A still of the same model, shown until the person turns or zooms it. Without one the model is live.
    var poster: URL? = nil
    @State private var live = false
    @State private var lastTouch = Date.distantPast
    @State private var visible = true
    @State private var hovering = false
    @State private var scrollMonitor: Any?
    @State private var failed = false

    private var showsLive: Bool { visible && (poster == nil || (interactive && live)) }

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else { StageBackground() }
            if showsLive {
                realityView
                    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in touch() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in touch() })
            } else if let poster {
                FileImage(url: poster, version: version, contentMode: .fit).padding(40)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 2).onChanged { _ in wake() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in wake() })
                if interactive {
                    // Top right, under the size: the bottom belongs to the card and the Ask and Print bar.
                    VStack {
                        HStack {
                            Spacer()
                            Button { wake() } label: { Label("Explore in 3D", systemImage: "rotate.3d") }
                                .buttonStyle(.glass).padding(.top, 108).padding(.trailing, 24)
                        }
                        Spacer()
                    }
                }
            }
            if failed {
                Text("This model couldn't be shown.").font(.callout).foregroundStyle(.secondary)
            }
        }
        .onHover { hovering = $0 }
        .onWindowVisibilityChange { shown in
            visible = shown
            if !shown { live = false }
        }
        .onAppear { watchScrolling() }
        .onDisappear { if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor) }; scrollMonitor = nil }
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
            let root = Entity()
            if let model = await Self.cached(url, version: version) {
                let bounds = model.visualBounds(relativeTo: nil)
                let size = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
                let scale = fit / max(size, 0.0001)
                model.scale = SIMD3(repeating: scale)
                model.position = -bounds.center * scale
                let pivot = Entity()
                pivot.addChild(model)
                pivot.orientation = simd_quatf(angle: pitch, axis: [1, 0, 0]) * simd_quatf(angle: yaw, axis: [0, 1, 0])
                root.addChild(pivot)
            } else {
                failed = true
            }
            for (intensity, from) in [(Float(4200), SIMD3<Float>(0.4, 0.6, 0.5)), (1600, [-0.5, 0.1, 0.3]), (2200, [0, 0.3, -0.6])] {
                let light = DirectionalLight()
                light.light.intensity = intensity
                light.look(at: .zero, from: from, relativeTo: nil)
                root.addChild(light)
            }
            let camera = PerspectiveCamera()
            camera.camera.fieldOfViewInDegrees = 34
            camera.look(at: [0, 0.01, 0], from: [0, 0.05, 0.58], relativeTo: nil)
            root.addChild(camera)
            content.add(root)
        }
        .realityViewCameraControls(interactive ? .orbit : .none)
        .allowsHitTesting(interactive)
        .id("\(url.path)#\(version)")
    }

    /// Loaded once per file version: going live again reuses the mesh instead of reading and building it again.
    @MainActor private static var cache: [String: Entity] = [:]
    @MainActor private static var order: [String] = []
    @MainActor static func cached(_ url: URL, version: Double) async -> Entity? {
        let key = "\(url.path)#\(version)"
        if let entity = cache[key] { return entity.clone(recursive: true) }
        guard let entity = await load(url) else { return nil }
        cache[key] = entity
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > 4 { cache[order.removeFirst()] = nil }
        return entity.clone(recursive: true)
    }

    /// STL through `ModelMesh` (read off the main thread); USDZ and other RealityKit formats directly.
    @MainActor static func load(_ url: URL) async -> Entity? {
        if url.pathExtension.lowercased() == "stl" {
            guard let mesh = await Task.detached(priority: .userInitiated, operation: { ModelMesh.read(url) }).value else { return nil }
            var descriptor = MeshDescriptor()
            descriptor.positions = MeshBuffers.Positions(mesh.positions)
            descriptor.normals = MeshBuffers.Normals(mesh.normals)
            descriptor.primitives = .triangles(Array(0..<UInt32(mesh.positions.count)))
            guard let resource = try? await MeshResource(from: [descriptor]) else { return nil }
            var material = PhysicallyBasedMaterial()
            material.baseColor = .init(tint: NSColor(red: 0.58, green: 0.58, blue: 0.60, alpha: 1))
            material.roughness = 0.55
            material.metallic = 0.0
            material.faceCulling = .none // scans aren't always closed
            return ModelEntity(mesh: resource, materials: [material])
        }
        return try? await Entity(contentsOf: url)
    }
}
