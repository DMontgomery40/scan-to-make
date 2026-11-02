import SwiftUI
import AppKit
import RealityKit
import CounterpartKit

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
    /// Optional companion still while the local model poster loads.
    var poster: URL? = nil
    @State private var still: CGImage?
    @State private var live = false
    @State private var lastTouch = Date.distantPast
    @State private var visible = true
    @State private var hovering = false
    @State private var scrollMonitor: Any?
    @State private var failed = false

    private var showsLive: Bool { visible && interactive && live }
    private var imageIdentity: String { "\(url.path)#\(version)#\(yaw)#\(pitch)#\(fit)" }

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else { StageBackground() }
            if showsLive {
                realityView
                    .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in touch() })
                    .simultaneousGesture(MagnifyGesture().onChanged { _ in touch() })
            } else if let still {
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
            failed = false
            let loaded = await Self.cached(url, version: version)
            guard !Task.isCancelled else { return }
            guard let model = loaded else { failed = poster == nil; return }
            let image = await ModelPoster.image(key: imageIdentity, model: model, yaw: yaw, pitch: pitch, fit: fit)
            guard !Task.isCancelled else { return }
            still = image; failed = image == nil && poster == nil
        }
        .onChange(of: imageIdentity) { _, _ in still = nil; live = false }
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
            let loaded = await Self.cached(url, version: version)
            guard !Task.isCancelled, showsLive else { return }
            if let model = loaded {
                content.add(ModelPoster.scene(model: model, yaw: yaw, pitch: pitch, fit: fit).root)
            } else { failed = true }
        }
        .realityViewCameraControls(interactive ? .orbit : .none)
        .allowsHitTesting(interactive)
        .id("\(url.path)#\(version)")
    }

    /// Loaded once per file version: going live again reuses the mesh instead of reading and building it again.
    @MainActor private static let cache = ModelEntityCache(limit: 1)
    @MainActor static func cached(_ url: URL, version: Double) async -> Entity? {
        await cache.load(key: "\(url.path)#\(version)") { await load(url) }
    }

    /// STL through `ModelMesh` (read off the main thread); USDZ and other RealityKit formats directly.
    @MainActor static func load(_ url: URL) async -> Entity? {
        if url.pathExtension.lowercased() == "stl" {
            guard let mesh = await Task.detached(priority: .userInitiated, operation: { ModelMesh.read(url) }).value else { return nil }
            guard let resource = await mesh.resource() else { return nil }
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
