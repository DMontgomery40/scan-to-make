import Foundation

/// One policy for ZIP input, parsed resources, component expansion and SceneKit's flat-shaded buffers.
/// Nov 10 real-file baseline (read-only): largest model XML 62.2 MB total / 8.1 MB per part,
/// 395,982 parsed vertices / 792,360 triangles; 54 placed meshes / 568,964 vertices / 1,138,264 triangles.
/// These are picture budgets, not limits on what a person may print. Refuse before allocating beyond them.
struct ThreeMFLimits {
    var partBytes = 32 * 1024 * 1024
    var totalBytes = 128 * 1024 * 1024
    var listingBytes = 4 * 1024 * 1024
    var archiveEntries = 4096
    var vertices = 1_000_000
    var triangles = 1_500_000
    var placedMeshes = 1024
    var placedVertices = 1_500_000
    // Three corners per triangle, each with a position, normal and index. Also bounds placed triangles.
    var renderedVertices = 6_000_000
    var depth = 16
    // Includes component-only objects, so a branching tree of empty objects cannot expand without bound.
    var placements = 8192
    var colours = 4096
    var xmlDepth = 64
    var materials = 4096
}

enum ThreeMFError: Error, CustomStringConvertible {
    case budget(String)
    case unreadable(String)
    case unsupported(String)

    var description: String {
        switch self {
        case .budget(let reason): return "3MF picture limit exceeded: \(reason)"
        case .unreadable(let reason): return "3MF is not readable: \(reason)"
        case .unsupported(let reason): return "3MF cannot be drawn: \(reason)"
        }
    }
}

/// Used before component copies and again before SceneKit allocates any expanded buffers.
struct ThreeMFPlacementBudget {
    let limits: ThreeMFLimits
    private var meshes = 0, vertices = 0, corners = 0

    mutating func consume(vertices count: Int, triangles: Int) throws {
        guard meshes < limits.placedMeshes else { throw ThreeMFError.budget("placed meshes") }
        guard count <= limits.placedVertices - vertices else { throw ThreeMFError.budget("placed vertices") }
        guard triangles <= (limits.renderedVertices - corners) / 3 else { throw ThreeMFError.budget("rendered vertices") }
        meshes += 1; vertices += count; corners += triangles * 3
    }
}
