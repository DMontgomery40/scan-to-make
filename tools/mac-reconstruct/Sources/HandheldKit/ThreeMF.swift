import Foundation
import simd

/// A 3MF model, read from the open 3MF standard only: the core specification (objects, meshes, components, build items,
/// transforms, units), the materials and properties extension (`basematerials`, `colorgroup`) and the production
/// extension (components kept in other model parts, `p:path`). Never a slicer's own files under `Metadata/`: which part
/// prints on which filament and which objects sit on which plate are the printer MCP's to report (AGENTS.md, "The app
/// staples onto the MCPs"). Nov 10: a 3MF with four objects had no picture, and David couldn't tell what it was.
public struct ThreeMF {
    /// One placed mesh, in the build's frame, in millimetres (Z up, as the file has it).
    public struct Mesh {
        public var name: String?
        public var positions: [SIMD3<Float>]
        public var triangles: [SIMD3<UInt32>]
        /// Each triangle's colour from the file (sRGB, 0...1), or nil where the file gives none.
        public var colours: [SIMD4<Float>?]
    }
    public var meshes: [Mesh]

    /// Every object the build places, with its components, as it sits in the build.
    public static func read(_ url: URL) throws -> ThreeMF {
        let archive = try ZipEntries(url)
        let root = archive.rootModel()
        var reader = Reader(archive: archive)
        try reader.load(root)
        var meshes: [Mesh] = []
        for item in reader.parts[root]?.build ?? [] {
            try reader.place(part: item.path ?? root, object: item.objectId, transform: threeMFMillimetreTransform(item.transform, unit: reader.parts[root]?.scale ?? 1), depth: 0, into: &meshes)
        }
        guard !meshes.isEmpty else { throw HandheldError.io("\(url.lastPathComponent) has no objects to draw") }
        return ThreeMF(meshes: meshes)
    }
}

/// The entries of a 3MF (a ZIP), read with the system's own `unzip`: listed once, each part read when needed.
struct ZipEntries {
    let url: URL
    let names: Set<String>

    init(_ url: URL) throws {
        self.url = url
        let listing = try Self.run(["-Z1", url.path])
        names = Set(String(decoding: listing, as: UTF8.self).split(separator: "\n").map(String.init))
        guard !names.isEmpty else { throw HandheldError.io("\(url.lastPathComponent) is not a 3MF") }
    }

    /// The model part the package's relationships name as the 3D model (core spec §2.1), else the usual place.
    func rootModel() -> String {
        if let rels = try? data("_rels/.rels"), let text = String(data: rels, encoding: .utf8),
           let tags = try? NSRegularExpression(pattern: "<Relationship\\b[^>]*>"), let targets = try? NSRegularExpression(pattern: "Target=\"([^\"]+)\"") {
            for match in tags.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let range = Range(match.range, in: text) else { continue }
                let tag = String(text[range])
                guard tag.contains("/3dmodel\""), let found = targets.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
                      let value = Range(found.range(at: 1), in: tag) else { continue }
                let target = String(tag[value])
                let path = target.hasPrefix("/") ? String(target.dropFirst()) : target
                if names.contains(path) { return path }
            }
        }
        return "3D/3dmodel.model"
    }

    func data(_ name: String) throws -> Data {
        guard names.contains(name) else { throw HandheldError.io("\(url.lastPathComponent) has no \(name)") }
        return try Self.run(["-qq", "-p", url.path, name])
    }

    private static func run(_ arguments: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = arguments  // `-Z` (list) must come first
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw HandheldError.io("couldn't read the 3MF (unzip \(process.terminationStatus))") }
        return data
    }
}

/// A 3MF transform (core spec §3.3): the row-vector 3×4 matrix "m00 m01 m02 m10 … m32", as a 4×4 acting on columns.
func threeMFTransform(_ text: String?) -> simd_float4x4 {
    guard let text else { return matrix_identity_float4x4 }
    let v = text.split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
    guard v.count == 12 else { return matrix_identity_float4x4 }
    return simd_float4x4(rows: [SIMD4(v[0], v[3], v[6], v[9]), SIMD4(v[1], v[4], v[7], v[10]),
                                SIMD4(v[2], v[5], v[8], v[11]), SIMD4(0, 0, 0, 1)])
}

/// Placements act on millimetre geometry. Their linear coefficients are dimensionless; their translation belongs
/// to the part containing the build item/component, including at a boundary to a differently-unitized part.
private func threeMFMillimetreTransform(_ transform: simd_float4x4, unit: Float) -> simd_float4x4 {
    var result = transform
    result.columns.3 = SIMD4(transform.columns.3.x * unit, transform.columns.3.y * unit, transform.columns.3.z * unit, 1)
    return result
}

/// Hex `#RRGGBB` or `#RRGGBBAA` (materials extension) to sRGB 0...1.
func threeMFColour(_ text: String?) -> SIMD4<Float>? {
    guard let text, text.hasPrefix("#") else { return nil }
    let hex = text.dropFirst()
    guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
    let rgba = hex.count == 6 ? (value << 8) | 0xFF : value
    return SIMD4(Float((rgba >> 24) & 255) / 255, Float((rgba >> 16) & 255) / 255, Float((rgba >> 8) & 255) / 255, Float(rgba & 255) / 255)
}

private struct Reader {
    let archive: ZipEntries
    var parts: [String: Part] = [:]
    /// Bounds on what one picture reads, so a hostile or broken file can't run away with the Mac.
    static let maxVertices = 20_000_000, maxDepth = 16

    struct Item { var objectId: String; var transform: simd_float4x4; var path: String? }
    struct Component { var objectId: String; var transform: simd_float4x4; var path: String? }
    struct Object {
        var name: String?
        var pid: String?, pindex: Int?
        var positions: [SIMD3<Float>] = []
        var triangles: [SIMD3<UInt32>] = []
        /// Each triangle's property group and index (pid, p1), when it names one.
        var properties: [(String, Int)?] = []
        var components: [Component] = []
    }
    struct Part {
        var scale: Float = 1
        var objects: [String: Object] = [:]
        var colours: [String: [SIMD4<Float>?]] = [:]
        var build: [Item] = []
    }

    init(archive: ZipEntries) { self.archive = archive }

    mutating func load(_ path: String) throws {
        guard parts[path] == nil else { return }
        let parser = ModelParser(data: try archive.data(path))
        guard parser.parse() else { throw HandheldError.io("\(path) in the 3MF isn't readable: \(parser.failure ?? "XML error")") }
        parts[path] = parser.part
        if parser.vertices > Self.maxVertices { throw HandheldError.io("the 3MF is too large to draw") }
    }

    mutating func place(part path: String, object id: String, transform: simd_float4x4, depth: Int, into meshes: inout [ThreeMF.Mesh]) throws {
        guard depth < Self.maxDepth else { throw HandheldError.io("the 3MF's components nest too deep") }
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        try load(clean)
        guard let part = parts[clean], let object = part.objects[id] else { return }
        // Millimetres in the build's frame: the part's unit, then the placement.
        let scale = simd_float4x4(diagonal: SIMD4(part.scale, part.scale, part.scale, 1))
        if !object.positions.isEmpty {
            let m = transform * scale
            let positions = object.positions.map { p -> SIMD3<Float> in let q = m * SIMD4(p, 1); return SIMD3(q.x, q.y, q.z) }
            let fallback = object.pid.flatMap { pid in object.pindex.flatMap { part.colours[pid]?[safe: $0] ?? nil } }
            let colours = object.properties.map { property -> SIMD4<Float>? in
                guard let (pid, index) = property else { return fallback }
                return part.colours[pid]?[safe: index] ?? fallback
            }
            meshes.append(ThreeMF.Mesh(name: object.name, positions: positions, triangles: object.triangles, colours: colours))
        }
        for component in object.components {
            try place(part: component.path ?? clean, object: component.objectId, transform: transform * threeMFMillimetreTransform(component.transform, unit: part.scale), depth: depth + 1, into: &meshes)
        }
    }
}


/// One model part's XML, streamed (a model part is often several megabytes).
private final class ModelParser: NSObject, XMLParserDelegate {
    private let parser: XMLParser
    var part = Reader.Part()
    var failure: String?
    var vertices = 0
    private var object: (id: String, value: Reader.Object)?
    private var group: (id: String, colours: [SIMD4<Float>?])?
    private var inBuild = false

    init(data: Data) {
        parser = XMLParser(data: data)
        super.init()
        parser.delegate = self
        parser.shouldProcessNamespaces = false
    }

    func parse() -> Bool { parser.parse() && failure == nil }

    private static func local(_ name: String) -> String { name.split(separator: ":").last.map(String.init) ?? name }
    private static func path(_ attributes: [String: String]) -> String? {
        attributes.first { Self.local($0.key) == "path" && $0.key != "path" }?.value
    }

    func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
        switch Self.local(element) {
        case "model":
            let units: [String: Float] = ["micron": 0.001, "millimeter": 1, "centimeter": 10, "inch": 25.4, "foot": 304.8, "meter": 1000]
            part.scale = units[attributes["unit"] ?? "millimeter"] ?? 1
        case "object":
            guard let id = attributes["id"] else { return }
            var value = Reader.Object()
            value.name = attributes["name"]
            value.pid = attributes["pid"]
            value.pindex = attributes["pindex"].flatMap(Int.init)
            object = (id, value)
        case "vertex":
            guard object != nil, let x = attributes["x"].flatMap(Float.init), let y = attributes["y"].flatMap(Float.init),
                  let z = attributes["z"].flatMap(Float.init) else { return }
            object!.value.positions.append(SIMD3(x, y, z))
            vertices += 1
            if vertices > Reader.maxVertices { failure = "too many vertices"; parser.abortParsing() }
        case "triangle":
            guard object != nil, let a = attributes["v1"].flatMap(UInt32.init), let b = attributes["v2"].flatMap(UInt32.init),
                  let c = attributes["v3"].flatMap(UInt32.init) else { return }
            object!.value.triangles.append(SIMD3(a, b, c))
            let pid = attributes["pid"] ?? object!.value.pid
            let index = attributes["p1"].flatMap(Int.init) ?? (attributes["pid"] == nil ? object!.value.pindex : nil)
            object!.value.properties.append(pid.flatMap { pid in index.map { (pid, $0) } })
        case "component":
            guard object != nil, let id = attributes["objectid"] else { return }
            object!.value.components.append(.init(objectId: id, transform: threeMFTransform(attributes["transform"]), path: Self.path(attributes)))
        case "basematerials", "colorgroup":
            guard let id = attributes["id"] else { return }
            group = (id, [])
        case "base":
            group?.colours.append(threeMFColour(attributes["displaycolor"]))
        case "color":
            group?.colours.append(threeMFColour(attributes["color"]))
        case "build":
            inBuild = true
        case "item":
            guard inBuild, let id = attributes["objectid"] else { return }
            part.build.append(.init(objectId: id, transform: threeMFTransform(attributes["transform"]), path: Self.path(attributes)))
        default: break
        }
    }

    func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?, qualifiedName: String?) {
        switch Self.local(element) {
        case "object":
            if let object { part.objects[object.id] = object.value }
            object = nil
        case "basematerials", "colorgroup":
            if let group { part.colours[group.id] = group.colours }
            group = nil
        case "build": inBuild = false
        default: break
        }
    }

    func parser(_ parser: XMLParser, parseErrorOccurred error: Error) { failure = failure ?? error.localizedDescription }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
