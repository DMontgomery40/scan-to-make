import Foundation

/// Any JSON value, kept exactly as read. The pairing record is stored this way so a record written by
/// an earlier app (or a companion field this version doesn't know) round-trips through the Keychain.
public enum JSONValue: Equatable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    /// From `JSONSerialization` output. Booleans stay booleans (CFBoolean), numbers become doubles.
    public init?(any value: Any) {
        switch value {
        case is NSNull: self = .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]:
            var out: [JSONValue] = []
            for item in a { guard let v = JSONValue(any: item) else { return nil }; out.append(v) }
            self = .array(out)
        case let d as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (k, item) in d { guard let v = JSONValue(any: item) else { return nil }; out[k] = v }
            self = .object(out)
        default: return nil
        }
    }

    /// For `JSONSerialization`. Whole numbers are written without a fraction, as JavaScript writes them.
    public var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let v): return v
        case .number(let v):
            if v.rounded() == v, abs(v) < 9_007_199_254_740_992 { return NSNumber(value: Int64(v)) }
            return v
        case .string(let v): return v
        case .array(let v): return v.map(\.any)
        case .object(let v): return v.mapValues(\.any)
        }
    }

    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var number: Double? { if case .number(let v) = self { return v }; return nil }
    public var array: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    public var object: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }

    /// Parses a JSON object, or nil.
    public static func object(from data: Data) -> [String: JSONValue]? {
        guard let any = try? JSONSerialization.jsonObject(with: data), let value = JSONValue(any: any) else { return nil }
        return value.object
    }

    public static func data(_ object: [String: JSONValue]) -> Data? {
        let any = object.mapValues(\.any)
        guard JSONSerialization.isValidJSONObject(any) else { return nil }
        return try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys])
    }
}

/// Literals for answers and tests: `["confirmed": true, "speed": "fast", "copies": 2]`.
extension JSONValue: ExpressibleByBooleanLiteral, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
}
