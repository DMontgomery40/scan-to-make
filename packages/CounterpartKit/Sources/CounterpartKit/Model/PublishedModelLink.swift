import Foundation

/// Published model pages are inputs, not requests to redraw an object from pictures.
public enum PublishedModelLink {
    public static func find(in text: String) -> URL? {
        let sites = ["makerworld.com", "printables.com", "prusaprinters.org", "thingiverse.com", "thangs.com", "cults3d.com", "myminifactory.com", "grabcad.com", "makershop.co", "crealitycloud.com", "printables.cz"]
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        return detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap(\.url).first { url in
            guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased(), url.path.count > 1 else { return false }
            return ["3mf", "stl"].contains(url.pathExtension.lowercased()) || sites.contains { host == $0 || host.hasSuffix("." + $0) }
        }
    }
}
