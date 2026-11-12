#if canImport(RealityKit) && canImport(Metal)
import Foundation
import CoreGraphics
import Metal
import RealityKit
import simd

/// A bounded still of a model, without a camera session or a persistent render loop.
@available(iOS 18, macOS 15, *)
@MainActor public enum ModelPoster {
    private static let images: NSCache<NSString, CGImage> = {
        let cache = NSCache<NSString, CGImage>()
        cache.countLimit = 8
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()
    private static let work = MediaWork<CGImage>(label: "poster", timeout: .seconds(15))

    public static func image(key: String, model: Entity, yaw: Float, pitch: Float, fit: Float) async -> CGImage? {
        guard !Task.isCancelled else { return nil }
        let key = "\(key)#\(yaw)#\(pitch)#\(fit)"
        if let image = images.object(forKey: key as NSString) { MediaTrace.record("poster.hit"); return image }
        let image = await work.run(key: key) {
            guard ModelEntityCache.hasGeometry(model), !Task.isCancelled else { return nil }
            do { return try await render(model: model, yaw: yaw, pitch: pitch, fit: fit) }
            catch { MediaTrace.record("poster.render-error", ["code": String((error as NSError).code)]); return nil }
        }
        guard !Task.isCancelled else { return nil }
        if let image { images.setObject(image, forKey: key as NSString, cost: image.bytesPerRow * image.height) }
        return image
    }

    /// The still already drawn for this model and pose, if this process has it: a stage shows it at once on a revisit,
    /// before its mesh is loaded again (#720, audit row 3: the stage loaded the mesh before asking for the still).
    public static func cached(key: String, yaw: Float, pitch: Float, fit: Float) -> CGImage? {
        images.object(forKey: "\(key)#\(yaw)#\(pitch)#\(fit)" as NSString)
    }

    /// End pending demand when its scene deactivates; completed pictures remain usable.
    public static func deferPending() { work.cancelAll() }

    static func visiblePixels(_ bytes: [UInt8]) -> Int {
        stride(from: 3, to: bytes.count, by: 4).reduce(0) { $0 + (bytes[$1] > 0 ? 1 : 0) }
    }

    /// Shared framing makes the idle still and the interactive model agree.
    public static func scene(model: Entity, yaw: Float, pitch: Float, fit: Float) -> (root: Entity, pivot: Entity, camera: PerspectiveCamera) {
        let root = Entity(), pivot = Entity(), object = model.clone(recursive: true)
        let bounds = object.visualBounds(relativeTo: nil)
        let size = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
        let scale = fit / max(size, 0.0001)
        object.scale = SIMD3(repeating: scale)
        object.position = -bounds.center * scale
        pivot.addChild(object)
        pivot.orientation = simd_quatf(angle: pitch, axis: [1, 0, 0]) * simd_quatf(angle: yaw, axis: [0, 1, 0])
        root.addChild(pivot)
        for (intensity, from) in [(Float(4200), SIMD3<Float>(0.4, 0.6, 0.5)), (1600, [-0.5, 0.1, 0.3]), (2200, [0, 0.3, -0.6]), (900, [0, -0.5, 0.3])] {
            let light = DirectionalLight()
            light.light.intensity = intensity
            light.look(at: .zero, from: from, relativeTo: nil)
            root.addChild(light)
        }
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 34
        // A rotated cube's diagonal is larger than any one side. Frame its
        // bounding sphere so even the largest allowed preview cannot clip.
        let distance = max(Float(0.58), simd_length(bounds.extents * scale) * 0.5 / sin(Float.pi * 17 / 180) * 1.15)
        camera.look(at: .zero, from: [0, distance * 0.08, distance], relativeTo: nil)
        root.addChild(camera)
        return (root, pivot, camera)
    }

    private static func render(model: Entity, yaw: Float, pitch: Float, fit: Float) async throws -> CGImage? {
        guard !Task.isCancelled else { return nil }
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: 768, height: 768, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead, .shaderWrite]
        descriptor.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        let renderer = try RealityRenderer()
        MediaTrace.record("poster.renderer-made")
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0, green: 0, blue: 0, alpha: 0))
        let (root, _, camera) = scene(model: model, yaw: yaw, pitch: pitch, fit: fit)
        renderer.entities.append(root)
        renderer.activeCamera = camera
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        guard !Task.isCancelled else { return nil }
        let completion = MediaCallback(), context = MediaTrace.context, trace = MediaTrace.destination ?? .shared
        MediaTrace.record("poster.submitted")
        do {
            try renderer.updateAndRender(deltaTime: 0, cameraOutput: output,
                whenScheduled: { _ in trace.record("poster.whenScheduled", [:], context: context) },
                onComplete: { _ in
                    trace.record("poster.onComplete", [:], context: context)
                    completion.finish(true)
                })
        } catch {
            completion.finish(false)
            MediaTrace.record("poster.submit-error", ["code": String((error as NSError).code)])
        }
        guard await completion.wait(timeout: .seconds(12)), !Task.isCancelled else { return nil }
        var bytes = [UInt8](repeating: 0, count: 768 * 768 * 4)
        texture.getBytes(&bytes, bytesPerRow: 768 * 4, from: MTLRegionMake2D(0, 0, 768, 768), mipmapLevel: 0)
        let visible = visiblePixels(bytes)
        MediaTrace.record("poster.readback", ["visiblePixels": String(visible)])
        guard visible > 0 else { return nil }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: 768, height: 768, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 768 * 4,
                       space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
#endif
