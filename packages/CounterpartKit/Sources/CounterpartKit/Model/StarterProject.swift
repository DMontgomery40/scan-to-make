import Foundation

/// Curated catalog data, never a serialized user project.
public struct StarterProject: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let summary: String
    public let instructions: String
    public let designer: String
    public let site: String
    public let url: URL
    public let licence: String
    public let symbol: String
    public let image: String?
    public let imageURL: URL?
    public let imageCredit: String?
    public let detail: String
    public let source: String

    public var imageFile: URL? { image.flatMap(Self.resource) }
    private static func resource(_ path: String) -> URL? {
        Bundle.module.url(forResource: path, withExtension: nil, subdirectory: "Starters")
    }
    public static let all: [StarterProject] = {
        guard let url = resource("catalog.json"), let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([StarterProject].self, from: data)) ?? []
    }()
}
