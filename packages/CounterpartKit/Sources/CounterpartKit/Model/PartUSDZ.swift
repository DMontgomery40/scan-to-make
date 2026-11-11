#if canImport(ModelIO)
import Foundation
import ModelIO
import simd

/// A part as a real USDZ for AR Quick Look (board: Nov 11, a designed part never appeared in AR).
///
/// RealityKit's `Entity.write(to:)` writes a Reality file (`assets/*.compiledmesh`, `header.json`), not USD, and the app
/// had named that `model.usdz`. This writes one USD layer by hand, in the frame Object Capture's scans use (metres, Y up,
/// `metersPerUnit = 1`), and packages it with Model I/O's `MDLUtility.convert(toUSDZ:writeTo:)`, which writes the
/// layer as binary USD in an uncompressed, aligned zip. The part rests on y = 0 with its footprint centred, so AR Quick
/// Look sets it on the surface the person points at, the way it prints (STL Z up becomes Y up).
@available(iOS 18, macOS 15, *)
public enum PartUSDZ {
    public typealias Triangle = (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)

    public enum Failure: Error, Equatable { case empty, notUSDZ, cancelled }

    /// Writes `triangles` (STL frame: millimetres, Z up) in `srgb` (0…1, the spool's colour) to `target`, through a
    /// scratch file beside it so a half-written file is never there to be reused. Call it off the main actor.
    public static func write(_ triangles: [Triangle], srgb: SIMD3<Float>, to target: URL) throws {
        let folder = target.deletingLastPathComponent()
        let scratch = folder.appendingPathComponent("ar-\(UUID().uuidString)")
        let layer = scratch.appendingPathExtension("usda"), packed = scratch.appendingPathExtension("usdz")
        defer { try? FileManager.default.removeItem(at: layer); try? FileManager.default.removeItem(at: packed) }
        guard try usda(triangles, srgb: srgb, to: layer) > 0 else { throw Failure.empty }
        guard !Task.isCancelled else { throw Failure.cancelled }
        MDLUtility.convert(toUSDZ: layer, writeTo: packed)
        guard isUSDZ(packed) else { throw Failure.notUSDZ }
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: packed, to: target)
    }

    /// Whether the file is a USDZ package: a zip whose first entry is a USD layer (`.usdc` or `.usda`, by its bytes too).
    /// A Reality file is also a zip, but its first entry is `assets/…compiledscene`, so it is not one.
    public static func isUSDZ(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 1024), head.count >= 30 else { return false }
        let bytes = [UInt8](head)
        guard bytes[0] == 0x50, bytes[1] == 0x4B, bytes[2] == 0x03, bytes[3] == 0x04 else { return false }
        let nameLength = Int(bytes[26]) | Int(bytes[27]) << 8, extraLength = Int(bytes[28]) | Int(bytes[29]) << 8
        guard 30 + nameLength <= bytes.count, let name = String(bytes: bytes[30..<(30 + nameLength)], encoding: .utf8) else { return false }
        let ext = (name as NSString).pathExtension.lowercased()
        guard ext == "usdc" || ext == "usda" else { return false }
        let start = 30 + nameLength + extraLength
        guard start + 8 <= bytes.count else { return false }
        let magic = String(decoding: bytes[start..<(start + 8)], as: UTF8.self)
        return ext == "usdc" ? magic == "PXR-USDC" : magic.hasPrefix("#usda")
    }

    /// sRGB-encoded to linear: UsdPreviewSurface's `diffuseColor` is linear, so the hex the printer reports is decoded.
    public static func linear(_ c: Float) -> Float { c <= 0.04045 ? c / 12.92 : powf((c + 0.055) / 1.055, 2.4) }

    /// The USD layer, streamed to `url` in chunks (a part can be half a million triangles). Returns the triangle count.
    static func usda(_ triangles: [Triangle], srgb: SIMD3<Float>, to url: URL) throws -> Int {
        func stage(_ p: SIMD3<Float>) -> SIMD3<Float> { SIMD3(p.x, p.z, -p.y) * 0.001 }
        var kept: [Triangle] = []
        kept.reserveCapacity(triangles.count)
        var low = SIMD3<Float>(repeating: .infinity), high = SIMD3<Float>(repeating: -.infinity)
        for t in triangles {
            let a = stage(t.0), b = stage(t.1), c = stage(t.2)
            guard [a, b, c].allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }),
                  simd_length(simd_cross(b - a, c - a)) > 0 else { continue }
            low = simd_min(low, simd_min(a, simd_min(b, c))); high = simd_max(high, simd_max(a, simd_max(b, c)))
            kept.append((a, b, c))
        }
        guard !kept.isEmpty else { return 0 }
        // Resting on y = 0, its footprint centred on the origin.
        let shift = SIMD3<Float>(-(low.x + high.x) / 2, -low.y, -(low.z + high.z) / 2)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let out = try FileHandle(forWritingTo: url)
        defer { try? out.close() }
        var buffer = [UInt8](); buffer.reserveCapacity(1 << 22)
        func text(_ s: String) { buffer.append(contentsOf: s.utf8) }
        func flush(force: Bool = false) throws {
            guard force || buffer.count > 1 << 22 else { return }
            try out.write(contentsOf: buffer); buffer.removeAll(keepingCapacity: true)
        }
        /// A number with `places` decimals, without Foundation's formatter (millions of them).
        func number(_ v: Float, places: Int, scale: Float) {
            var n = Int64((v * scale).rounded())
            if n < 0 { buffer.append(UInt8(ascii: "-")); n = -n }
            let whole = n / Int64(scale), fraction = n % Int64(scale)
            text(String(whole)); buffer.append(UInt8(ascii: "."))
            let digits = String(fraction)
            for _ in digits.count..<places { buffer.append(UInt8(ascii: "0")) }
            text(digits)
        }
        func vector(_ v: SIMD3<Float>, places: Int, scale: Float) {
            buffer.append(UInt8(ascii: "(")); number(v.x, places: places, scale: scale); text(", ")
            number(v.y, places: places, scale: scale); text(", "); number(v.z, places: places, scale: scale); buffer.append(UInt8(ascii: ")"))
        }
        let linear = SIMD3(Self.linear(srgb.x), Self.linear(srgb.y), Self.linear(srgb.z))
        let lo = low + shift, hi = high + shift
        text("""
        #usda 1.0
        (
            defaultPrim = "Part"
            metersPerUnit = 1
            upAxis = "Y"
        )

        def Xform "Part" (
            assetInfo = {
                string name = "Part"
            }
            kind = "component"
        )
        {
            def Mesh "Mesh" (
                prepend apiSchemas = ["MaterialBindingAPI"]
            )
            {
                float3[] extent = [
        """)
        vector(lo, places: 6, scale: 1e6); text(", "); vector(hi, places: 6, scale: 1e6)
        text("]\n        int[] faceVertexCounts = [")
        for i in 0..<kept.count { text(i == 0 ? "3" : ", 3"); if i % 65_536 == 0 { try flush() } }
        text("]\n        int[] faceVertexIndices = [")
        for i in 0..<(kept.count * 3) { if i > 0 { text(", ") }; text(String(i)); if i % 65_536 == 0 { try flush() } }
        text("]\n        rel material:binding = </Part/Materials/Filament>\n        normal3f[] normals = [")
        // Flat, per corner, as the stage draws it (`ModelStage.geometry`): a printed part's edges stay sharp.
        for (i, t) in kept.enumerated() {
            let n = simd_normalize(simd_cross(t.1 - t.0, t.2 - t.0))
            for k in 0..<3 { if i > 0 || k > 0 { text(", ") }; vector(n, places: 4, scale: 1e4) }
            if i % 16_384 == 0 { guard !Task.isCancelled else { throw Failure.cancelled }; try flush() }
        }
        text("] (\n            interpolation = \"vertex\"\n        )\n        uniform token orientation = \"rightHanded\"\n        point3f[] points = [")
        for (i, t) in kept.enumerated() {
            for (k, p) in [t.0, t.1, t.2].enumerated() { if i > 0 || k > 0 { text(", ") }; vector(p + shift, places: 6, scale: 1e6) }
            if i % 16_384 == 0 { guard !Task.isCancelled else { throw Failure.cancelled }; try flush() }
        }
        text("]\n        uniform token subdivisionScheme = \"none\"\n    }\n\n    def Scope \"Materials\"\n    {\n")
        text("        def Material \"Filament\"\n        {\n")
        text("            token outputs:surface.connect = </Part/Materials/Filament/Surface.outputs:surface>\n\n")
        text("            def Shader \"Surface\"\n            {\n                uniform token info:id = \"UsdPreviewSurface\"\n")
        text("                color3f inputs:diffuseColor = "); vector(linear, places: 4, scale: 1e4)
        text("\n                float inputs:metallic = 0\n                float inputs:roughness = 0.55\n                token outputs:surface\n")
        text("            }\n        }\n    }\n}\n")
        try flush(force: true)
        return kept.count
    }
}
#endif
