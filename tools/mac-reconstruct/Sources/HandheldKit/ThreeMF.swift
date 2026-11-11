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
        try read(url, limits: ThreeMFLimits())
    }

    static func read(_ url: URL, limits: ThreeMFLimits) throws -> ThreeMF {
        let archive = try ZipEntries(url, limits: limits)
        let root = try archive.rootModel()
        var reader = Reader(archive: archive)
        try reader.load(root)
        guard !(reader.parts[root]?.build.isEmpty ?? true) else { throw ThreeMFError.unsupported("build has no items") }
        var meshes: [Mesh] = []
        for item in reader.parts[root]?.build ?? [] {
            try reader.place(part: item.path ?? root, object: item.objectId, transform: threeMFMillimetreTransform(item.transform, unit: reader.parts[root]?.scale ?? 1), depth: 0, into: &meshes)
        }
        guard !meshes.isEmpty else { throw ThreeMFError.unsupported("no supported mesh triangles in the build" + (reader.skipped.isEmpty ? "" : ": " + reader.skipped.joined(separator: "; "))) }
        return ThreeMF(meshes: meshes)
    }
}

/// The entries of a 3MF (a ZIP), read with the system's own `unzip`: listed once, each part read when needed.
final class ZipEntries {
    let url: URL
    let sizes: [String: Int]
    let limits: ThreeMFLimits
    private var readBytes = 0

    init(_ url: URL, limits: ThreeMFLimits = ThreeMFLimits()) throws {
        self.url = url
        self.limits = limits
        let listing = try Self.run(["-Z", "-l", url.path], maxBytes: limits.listingBytes, reason: "ZIP listing bytes")
        var sizes: [String: Int] = [:]
        var total = 0
        for line in String(decoding: listing, as: UTF8.self).split(separator: "\n") {
            // zipinfo's long listing: permissions, version, host, size, flags, compressed size, method, date, time, name.
            let fields = line.split(maxSplits: 9, whereSeparator: \.isWhitespace)
            if line.hasPrefix("Archive:") || line.hasPrefix("Zip file size:") { continue }
            if fields.count > 1, Int(fields[0]) != nil, ["file,", "files,"].contains(String(fields[1])) { continue }
            guard fields.count == 10, Double(fields[1]) != nil,
                  let bytes = Int(fields[3]), bytes >= 0, Int(fields[5]) != nil else {
                throw ThreeMFError.unreadable("ZIP directory has an invalid size or entry")
            }
            let name = String(fields[9])
            guard sizes.count < limits.archiveEntries else { throw ThreeMFError.budget("archive entries") }
            guard sizes[name] == nil else { throw ThreeMFError.unreadable("duplicate ZIP entry \(name)") }
            guard bytes <= limits.partBytes else { throw ThreeMFError.budget("part bytes (\(name))") }
            guard bytes <= limits.totalBytes - total else { throw ThreeMFError.budget("total bytes") }
            total += bytes
            sizes[name] = bytes
        }
        guard !sizes.isEmpty else { throw ThreeMFError.unreadable("\(url.lastPathComponent) is not a 3MF") }
        self.sizes = sizes
    }

    /// The model part the package's relationships name as the 3D model (core spec §2.1), else the usual place.
    func rootModel() throws -> String {
        if sizes["_rels/.rels"] != nil {
            let rels = try data("_rels/.rels")
            if let text = String(data: rels, encoding: .utf8),
               let tags = try? NSRegularExpression(pattern: "<Relationship\\b[^>]*>"), let targets = try? NSRegularExpression(pattern: "Target=\"([^\"]+)\"") {
                for match in tags.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    guard let range = Range(match.range, in: text) else { continue }
                    let tag = String(text[range])
                    guard tag.contains("/3dmodel\""), let found = targets.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
                          let value = Range(found.range(at: 1), in: tag) else { continue }
                    let target = String(tag[value])
                    let path = target.hasPrefix("/") ? String(target.dropFirst()) : target
                    if sizes[path] != nil { return path }
                }
            }
        }
        return "3D/3dmodel.model"
    }

    func data(_ name: String) throws -> Data {
        guard !name.lowercased().hasPrefix("metadata/") else { throw ThreeMFError.unsupported("private metadata is not model geometry") }
        guard let bytes = sizes[name] else { throw ThreeMFError.unreadable("\(url.lastPathComponent) has no \(name)") }
        // unzip accepts patterns even after the archive argument. Escape metacharacters, including a literal backslash.
        let literal = name.map { "\\[]*?-".contains($0) ? "\\\($0)" : String($0) }.joined()
        guard bytes <= limits.totalBytes - readBytes else { throw ThreeMFError.budget("total inflated bytes") }
        let data = try Self.run(["-qq", "-p", url.path, literal], maxBytes: bytes, reason: "inflated bytes (\(name))")
        readBytes += data.count
        return data
    }

    private static func run(_ arguments: [String], maxBytes: Int, reason: String) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = arguments  // `-Z` (list) must come first
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer { try? out.fileHandleForReading.close(); process.waitUntilExit() }
        var data = Data()
        while true {
            // Read at most one byte beyond the allowance, never a whole inflated part before checking.
            let chunk = out.fileHandleForReading.readData(ofLength: min(64 * 1024, maxBytes - data.count + 1))
            if chunk.isEmpty { break }
            guard chunk.count <= maxBytes - data.count else {
                process.terminate()
                throw ThreeMFError.budget(reason)
            }
            data.append(chunk)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ThreeMFError.unreadable("unzip \(process.terminationStatus)") }
        return data
    }
}

/// A 3MF transform (core spec §3.3): the row-vector 3×4 matrix "m00 m01 m02 m10 … m32", as a 4×4 acting on columns.
func threeMFTransform(_ text: String?) throws -> simd_float4x4 {
    guard let text else { return matrix_identity_float4x4 }
    let v = text.split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
    guard v.count == 12, text.split(whereSeparator: \.isWhitespace).count == 12, v.allSatisfy(\.isFinite) else { throw ThreeMFError.unreadable("malformed transform") }
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
    var failed: [String: ThreeMFError] = [:]
    var skipped: [String] = []

    mutating func skip(_ reason: String) { if skipped.count < 8 { skipped.append(String(reason.prefix(256))) } }
    let limits: ThreeMFLimits
    var vertices = 0, triangles = 0, colours = 0, placements = 0
    var placed: ThreeMFPlacementBudget

    struct Item { var objectId: String; var transform: simd_float4x4; var path: String? }
    struct Component { var objectId: String; var transform: simd_float4x4; var path: String? }
    struct Object {
        var name: String?
        var pid: String?, pindex: Int?
        var positions: [SIMD3<Float>] = []
        var triangles: [SIMD3<UInt32>] = []
        /// Each triangle's property group and index (pid, p1), populated only when triangles override object properties.
        var properties: [(String, Int)?] = []
        var hasTriangleProperties = false
        var components: [Component] = []
    }
    struct Part {
        var scale: Float = 1
        var objects: [String: Object] = [:]
        var colours: [String: [SIMD4<Float>?]] = [:]
        var build: [Item] = []
    }

    init(archive: ZipEntries) {
        self.archive = archive
        limits = archive.limits
        placed = ThreeMFPlacementBudget(limits: archive.limits)
    }

    mutating func load(_ path: String) throws {
        guard parts[path] == nil else { return }
        if let error = failed[path] { throw error }
        do {
            var remaining = limits
            remaining.vertices -= vertices; remaining.triangles -= triangles; remaining.colours -= colours
            let parser = try ModelParser(data: archive.data(path), limits: remaining)
            let parsed = parser.parse()
            vertices += parser.vertices; triangles += parser.triangles; colours += parser.colours
            guard parsed else { throw parser.failure ?? ThreeMFError.unreadable("\(path): XML error") }
            parts[path] = parser.part
        } catch let error as ThreeMFError {
            if case .budget = error { throw error }
            failed[path] = error
            throw error
        }
    }

    mutating func place(part path: String, object id: String, transform: simd_float4x4, depth: Int, into meshes: inout [ThreeMF.Mesh]) throws {
        guard depth < limits.depth else { throw ThreeMFError.budget("component depth") }
        guard placements < limits.placements else { throw ThreeMFError.budget("component placements") }
        placements += 1
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        do { try load(clean) }
        catch let error as ThreeMFError {
            if case .unreadable = error { skip(error.description); return }
            throw error
        }
        guard let part = parts[clean], let object = part.objects[id] else { skip("missing object \(id) in \(clean)"); return }
        // Millimetres in the build's frame: the part's unit, then the placement.
        let scale = simd_float4x4(diagonal: SIMD4(part.scale, part.scale, part.scale, 1))
        if !object.positions.isEmpty && object.triangles.isEmpty {
            throw ThreeMFError.unsupported("object \(id) has no supported mesh triangles")
        }
        if !object.positions.isEmpty {
            try placed.consume(vertices: object.positions.count, triangles: object.triangles.count)
            let m = transform * scale
            let c0 = SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z)
            let c1 = SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z)
            let c2 = SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
            let c3 = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
            var positions = [SIMD3<Float>]()
            positions.reserveCapacity(object.positions.count)
            for p in object.positions {
                let q = c0 * p.x + c1 * p.y + c2 * p.z + c3
                guard q.x.isFinite && q.y.isFinite && q.z.isFinite else {
                    throw ThreeMFError.unsupported("non-finite placed geometry")
                }
                positions.append(q)
            }
            let fallback = object.pid.flatMap { pid in object.pindex.flatMap { part.colours[pid]?[safe: $0] ?? nil } }
            let colours: [SIMD4<Float>?]
            if object.hasTriangleProperties {
                colours = object.properties.map { property -> SIMD4<Float>? in
                    guard let (pid, index) = property else { return fallback }
                    return part.colours[pid]?[safe: index] ?? fallback
                }
            } else {
                colours = [SIMD4<Float>?](repeating: fallback, count: object.triangles.count)
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
    private static let units: [String: Float] = [
        "micron": 0.001, "millimeter": 1, "centimeter": 10, "inch": 25.4, "foot": 304.8, "meter": 1000
    ]
    private let parser: XMLParser
    var part = Reader.Part()
    var failure: ThreeMFError?
    var vertices = 0, triangles = 0, colours = 0
    private let limits: ThreeMFLimits
    private var xmlDepth = 0
    private var object: (id: String, value: Reader.Object)?
    private var group: (id: String, colours: [SIMD4<Float>?])?
    private var inBuild = false

    init(data: Data, limits: ThreeMFLimits) throws {
        guard String(data: data, encoding: .utf8) != nil, !data.contains(0) else { throw ThreeMFError.unreadable("model XML must be UTF-8") }
        guard data.range(of: Data("<!DOCTYPE".utf8)) == nil else { throw ThreeMFError.unsupported("DTD content is not allowed") }
        self.limits = limits
        parser = XMLParser(data: data)
        super.init()
        parser.delegate = self
        parser.shouldProcessNamespaces = false
        parser.shouldResolveExternalEntities = false
        parser.externalEntityResolvingPolicy = .never
    }

    func parse() -> Bool { parser.parse() && failure == nil }

    private func fail(_ error: ThreeMFError) { failure = error; parser.abortParsing() }

    @inline(__always)
    private static func local(_ name: String) -> Substring {
        if let colon = name.lastIndex(of: ":") { return name[name.index(after: colon)...] }
        return name[...]
    }

    @inline(__always)
    private static func parseUInt32(_ text: String) -> UInt32? {
        let utf8 = text.utf8
        guard !utf8.isEmpty else { return nil }
        var acc: UInt64 = 0
        for byte in utf8 {
            guard byte >= 48 && byte <= 57 else { return UInt32(text) }
            acc = acc &* 10 &+ UInt64(byte - 48)
            if acc > UInt64(UInt32.max) { return nil }
        }
        return UInt32(acc)
    }

    private static func path(_ attributes: [String: String]) -> String? {
        attributes.first { Self.local($0.key) == "path" && $0.key != "path" }?.value
    }

    func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
        guard failure == nil else { return }
        guard xmlDepth < limits.xmlDepth else { fail(.budget("XML depth")); return }
        xmlDepth += 1
        switch Self.local(element) {
        case "model":
            let unit = attributes["unit"] ?? "millimeter"
            guard let scale = Self.units[unit] else { fail(.unsupported("unknown unit \(unit)")); return }
            part.scale = scale
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
            guard x.isFinite && y.isFinite && z.isFinite else { fail(.unreadable("non-finite vertex")); return }
            guard vertices < limits.vertices else { fail(.budget("parsed vertices")); return }
            vertices += 1
            object!.value.positions.append(SIMD3(x, y, z))
        case "triangle":
            guard object != nil, let a = attributes["v1"].flatMap(Self.parseUInt32), let b = attributes["v2"].flatMap(Self.parseUInt32),
                  let c = attributes["v3"].flatMap(Self.parseUInt32) else { return }
            guard triangles < limits.triangles else { fail(.budget("parsed triangles")); return }
            triangles += 1
            let vertexCount = object!.value.positions.count
            // Core meshes put vertices before triangles. Invalid indices cannot become an empty SceneKit success.
            guard Int(a) < vertexCount, Int(b) < vertexCount, Int(c) < vertexCount else { return }
            object!.value.triangles.append(SIMD3(a, b, c))
            let attrPid = attributes["pid"]
            let attrP1 = attributes["p1"]
            if attrPid != nil || attrP1 != nil {
                if !object!.value.hasTriangleProperties {
                    let defaultProp = object!.value.pid.flatMap { pid in object!.value.pindex.map { (pid, $0) } }
                    object!.value.properties = [(String, Int)?](repeating: defaultProp, count: object!.value.triangles.count - 1)
                    object!.value.hasTriangleProperties = true
                }
                let pid = attrPid ?? object!.value.pid
                let index = attrP1.flatMap(Int.init) ?? (attrPid == nil ? object!.value.pindex : nil)
                object!.value.properties.append(pid.flatMap { pid in index.map { (pid, $0) } })
            } else if object!.value.hasTriangleProperties {
                let defaultProp = object!.value.pid.flatMap { pid in object!.value.pindex.map { (pid, $0) } }
                object!.value.properties.append(defaultProp)
            }
        case "component":
            guard object != nil, let id = attributes["objectid"] else { return }
            guard let transform = try? threeMFTransform(attributes["transform"]) else { fail(.unreadable("malformed component transform")); return }
            object!.value.components.append(.init(objectId: id, transform: transform, path: Self.path(attributes)))
        case "basematerials", "colorgroup":
            guard let id = attributes["id"] else { return }
            group = (id, [])
        case "base":
            guard colours < limits.colours else { fail(.budget("colours")); return }
            colours += 1
            group?.colours.append(threeMFColour(attributes["displaycolor"]))
        case "color":
            guard colours < limits.colours else { fail(.budget("colours")); return }
            colours += 1
            group?.colours.append(threeMFColour(attributes["color"]))
        case "build":
            inBuild = true
        case "item":
            guard inBuild, let id = attributes["objectid"] else { return }
            guard let transform = try? threeMFTransform(attributes["transform"]) else { fail(.unreadable("malformed build transform")); return }
            part.build.append(.init(objectId: id, transform: transform, path: Self.path(attributes)))
        default: break
        }
    }

    func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?, qualifiedName: String?) {
        xmlDepth -= 1
        guard failure == nil else { return }
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

    func parser(_ parser: XMLParser, parseErrorOccurred error: Error) { failure = failure ?? .unreadable(error.localizedDescription) }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
