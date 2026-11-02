import SwiftUI
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

/// The project's model in RealityKit: the STL that will print (or the scan as it arrived), lit on the dark
/// stage. Interactive stages orbit and zoom with the system's own camera controls.
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
    @State private var failed = false

    var body: some View {
        ZStack {
            if let backdrop { backdrop } else { StageBackground() }
            RealityView { content in
                let root = Entity()
                if let model = await Self.load(url) {
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
            if failed {
                Text("This model couldn't be shown.").font(.callout).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
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
