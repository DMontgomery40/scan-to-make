import Foundation
import CryptoKit

/// A regular expression that must match the whole string, as JavaScript `^…$` and NSPredicate MATCHES do.
/// Patterns use `[0-9]` (never `\d`, which in ICU also matches non-ASCII digits).
struct Pattern: Sendable {
    private let regex: NSRegularExpression
    init(_ pattern: String, caseInsensitive: Bool = false) {
        // Patterns are compile-time constants in this package.
        // `\z` (not `$`) so the engine backtracks to the whole string and a trailing newline never matches.
        regex = try! NSRegularExpression(pattern: "(?:\(pattern))\\z", options: caseInsensitive ? [.caseInsensitive] : [])
    }
    func matches(_ value: String?) -> Bool {
        guard let value else { return false }
        let whole = NSRange(value.startIndex..., in: value)
        guard let match = regex.firstMatch(in: value, options: [.anchored], range: whole) else { return false }
        return match.range == whole
    }
}

enum Hex {
    static func string(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
    static func sha256(_ data: Data) -> String { string(SHA256.hash(data: data)) }
    static func bytes(_ hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }
}

enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Text without control characters, between `min` and `max` characters long.
func isPlainText(_ value: String?, min: Int = 1, max: Int) -> Bool {
    Pattern("[^\\x00-\\x1f\\x7f]{\(min),\(max)}").matches(value)
}
