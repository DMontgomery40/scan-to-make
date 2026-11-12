import Foundation

/// The fields of a size question: one per size the Mac asked about, prefilled with its number, each editable. A plain
/// value, so every client's card (phone, iPad, Mac) reads and checks the fields the same way and the rules are unit
/// tests (`AskSizesFormTests`).
public struct AskSizesForm: Equatable, Sendable {
    public struct Field: Equatable, Sendable, Identifiable {
        public let id: String
        /// What to measure, in the Mac's words ("width at the waist").
        public let label: String
        /// Where the prefilled number came from: `published`, `scan` or `estimate` (#622).
        public let from: String
        /// For a published number: the exact product it is for, and where the maker published it.
        public let product: String?
        public let reference: String?
        /// The Mac's number, as it was asked.
        public let asked: Double
        /// What the field holds now.
        public var text: String
        /// The person typed or edited this number (anything but the prefilled text, spaces aside). Untouched, it is
        /// the Mac's number accepted, never a measurement.
        public var measured: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines) != AskSizesForm.text(asked) }
        public init(id: String, label: String, from: String, product: String? = nil, reference: String? = nil, asked: Double, text: String) {
            self.id = id; self.label = label; self.from = from; self.product = product; self.reference = reference; self.asked = asked; self.text = text
        }
    }
    /// One size to send back, and whether the person typed it (`measured`) or let the Mac's number stand.
    public struct Answer: Equatable, Sendable {
        public let id: String
        public let mm: Double
        public let measured: Bool
        public init(id: String, mm: Double, measured: Bool = false) { self.id = id; self.mm = mm; self.measured = measured }
    }

    public var fields: [Field]

    /// Nil when the question lists no sizes: it is not a size question.
    public init?(_ ask: Project.Ask) {
        guard ask.kind == "sizes", let sizes = ask.sizes, !sizes.isEmpty else { return nil }
        fields = sizes.map { Field(id: $0.id, label: $0.label, from: $0.from, product: $0.product, reference: $0.reference, asked: $0.mm, text: Self.text($0.mm)) }
    }

    /// A number as a person types it: no trailing ".0", at most two decimals.
    public static func text(_ mm: Double) -> String {
        let rounded = (mm * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }

    /// The number a field holds, when it is one (a comma or a point for the decimal; over zero, at most 10 m).
    public static func millimetres(_ text: String) -> Double? {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        // Digits with at most one decimal part, as the Kotlin and Linux forms take it: never "1e3", ".5" or "5.",
        // which `Double` alone would accept here and nowhere else.
        guard typed.range(of: #"^[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil,
              let mm = Double(typed), mm.isFinite, mm > 0, mm <= 10_000 else { return nil }
        return mm
    }

    /// What to send: every field that holds a number. Nil while any filled field isn't a number, or none is filled.
    /// A field left blank is a size the person doesn't know: it is left out, never sent as accepted.
    public var answer: [Answer]? {
        var sizes: [Answer] = []
        for field in fields {
            if field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            guard let mm = Self.millimetres(field.text) else { return nil }
            sizes.append(Answer(id: field.id, mm: mm, measured: field.measured))
        }
        return sizes.isEmpty ? nil : sizes
    }

    /// Said under the fields while nothing can be sent, and when another answer is pressed with a field that isn't a number.
    public static let invalidWords = "Enter each size in millimetres, or leave one empty if you don't know it."

    /// What goes with any other answer sent from the same card (words, a caliper photo): one answer carries
    /// everything the card holds, so a number typed into a field is never dropped by pressing another button.
    public enum Carried: Equatable, Sendable {
        /// The numbers as they stand, edited or prefilled.
        case sizes([Answer])
        /// Every field is blank: the person knows none of them, and the other answer goes alone.
        case none
        /// A filled field isn't a number: nothing is sent until it is fixed or cleared.
        case invalid
    }
    public var carried: Carried {
        if let answer { return .sizes(answer) }
        return fields.allSatisfy { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ? .none : .invalid
    }

    /// Nothing was typed: the button says Confirm, and every number goes as accepted. Otherwise it sends the person's.
    public var unchanged: Bool { !fields.contains(where: \.measured) }

    /// Under a field: where the Mac's number came from (#622). A published one names the product it is for and where
    /// it was published; a source this build doesn't know reads as an estimate, never as the scan or the maker's.
    public static func source(_ from: String, product: String? = nil, reference: String? = nil) -> String {
        switch from {
        case "published":
            guard let product = product?.trimmingCharacters(in: .whitespacesAndNewlines), !product.isEmpty else { return "Published size, product not named" }
            guard let place = reference.flatMap(Self.place) else { return "Published for \(product)" }
            return "Published for \(product) · \(place)"
        case "scan": return "Read from your scan"
        default: return "The Mac's estimate, not measured"
        }
    }
    public static func source(_ field: Field) -> String { source(field.from, product: field.product, reference: field.reference) }
    /// Where a published size was published, short: a link's site (without "www."), or the document's name as given.
    static func place(_ reference: String) -> String? {
        let trimmed = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host(), !host.isEmpty {
            return host.lowercased().hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        return trimmed
    }
}
