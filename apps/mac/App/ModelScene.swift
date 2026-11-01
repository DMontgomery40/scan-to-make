import SwiftUI
import SceneKit
import ModelIO
import SceneKit.ModelIO

/// The object's STL as a turnable scene: exactly what will print, in a plain matte material.
/// STL is Z-up (as slicers see it); SceneKit is Y-up, so the model is stood upright and centred,
/// and the camera is framed from its bounding box.
enum ModelScene {
    /// Builds the scene; call it off the main thread, big scans take a moment to read.
    static func load(_ url: URL) -> SCNScene? {
        guard FileManager.default.isReadableFile(atPath:url.path) else { return nil }
        let asset = MDLAsset(url:url)
        guard asset.count > 0 else { return nil }
        let loaded = SCNScene(mdlAsset:asset)
        let model = SCNNode()
        for child in loaded.rootNode.childNodes { model.addChildNode(child) }
        let material = SCNMaterial()
        material.lightingModel = .blinn
        material.diffuse.contents = NSColor(calibratedWhite:0.74, alpha:1)
        material.specular.contents = NSColor(calibratedWhite:0.18, alpha:1)
        material.shininess = 0.25
        material.isDoubleSided = true // scans aren't always closed
        model.enumerateHierarchy { node, _ in node.geometry?.materials = [material] }
        let (low, high) = model.boundingBox
        guard high.x > low.x || high.y > low.y || high.z > low.z else { return nil }
        model.position = SCNVector3(-(low.x + high.x) / 2, -(low.y + high.y) / 2, -(low.z + high.z) / 2)
        let upright = SCNNode()
        upright.eulerAngles.x = -.pi / 2
        upright.addChildNode(model)

        let scene = SCNScene()
        scene.rootNode.addChildNode(upright)
        let radius = Double(max(high.x - low.x, high.y - low.y, high.z - low.z)) * 0.62
        let camera = SCNCamera()
        camera.fieldOfView = 32
        let distance = radius / sin(16 * .pi / 180) * 1.08
        camera.zNear = distance / 100
        camera.zFar = distance * 10
        let eye = SCNNode()
        eye.name = "eye"
        eye.camera = camera
        eye.position = SCNVector3(distance * 0.42, distance * 0.36, distance * 0.83)
        eye.look(at:SCNVector3Zero)
        // A headlight on the camera, so the side the user turns towards is never in shadow.
        let head = SCNNode()
        head.light = SCNLight()
        head.light!.type = .directional
        head.light!.intensity = 520
        eye.addChildNode(head)
        scene.rootNode.addChildNode(eye)
        let key = SCNNode()
        key.light = SCNLight()
        key.light!.type = .directional
        key.light!.intensity = 700
        key.eulerAngles = SCNVector3(-1.0, 0.6, 0)
        scene.rootNode.addChildNode(key)
        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light!.type = .ambient
        ambient.light!.intensity = 210
        scene.rootNode.addChildNode(ambient)
        return scene
    }

    /// A still of the scene from its own camera (design renders and checks).
    static func snapshot(_ scene: SCNScene, size: CGSize) -> NSImage {
        let renderer = SCNRenderer(device:MTLCreateSystemDefaultDevice(), options:nil)
        renderer.scene = scene
        renderer.pointOfView = scene.rootNode.childNode(withName:"eye", recursively:false)
        renderer.autoenablesDefaultLighting = false
        return renderer.snapshot(atTime:0, with:size, antialiasingMode:.multisampling4X)
    }
}

/// SCNScene isn't Sendable; it is built off the main actor and only used on it afterwards.
private struct LoadedScene: @unchecked Sendable { let scene: SCNScene? }

/// The STL, turnable with the mouse or trackpad. It reloads only when the file changes (`version`).
struct ModelViewer: View {
    let url: URL
    let version: Double
    @State private var scene: SCNScene?
    @State private var failed = false
    var body: some View {
        ZStack {
            if let scene {
                TurnableScene(scene:scene).accessibilityLabel("The model, turnable in 3D")
            } else if failed {
                Text("This model couldn't be shown.").font(.callout).foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id:"\(url.path)#\(version)") {
            failed = false
            let url = url
            let loaded = await Task.detached(priority:.userInitiated) { LoadedScene(scene:ModelScene.load(url)) }.value
            guard !Task.isCancelled else { return }
            scene = loaded.scene
            failed = loaded.scene == nil
        }
    }
}

private struct TurnableScene: NSViewRepresentable {
    let scene: SCNScene
    func makeNSView(context: Context) -> SCNView {
        let view = SCNView()
        view.allowsCameraControl = true
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.inertiaEnabled = true
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling4X
        view.autoenablesDefaultLighting = false
        update(view)
        return view
    }
    func updateNSView(_ view: SCNView, context: Context) { if view.scene !== scene { update(view) } }
    private func update(_ view: SCNView) {
        view.scene = scene
        view.pointOfView = scene.rootNode.childNode(withName:"eye", recursively:false)
        view.defaultCameraController.target = SCNVector3Zero
    }
}
