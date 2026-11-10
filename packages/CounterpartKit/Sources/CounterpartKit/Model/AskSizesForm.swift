import Foundation

/// The fields of a size question: one per size the Mac asked about, prefilled with its number, each editable. A plain
/// value, so every client's card (phone, iPad, Mac) reads and checks the fields the same way and the rules are unit
/// tests (`AskSizesFormTests`).
public struct AskSizesForm: Equatable, Sendable {
    public struct Field: Equatable, Sendable, Identifiable {
        public let id: String
        /// What to measure, in the Mac's words ("width at the waist").
        public let label: String
        /// Where the prefilled number came from: `scan` or `published`.
        public let from: String
        /// The Mac's number, as it was asked.
        public let asked: Double
        /// What the field holds now.
        public var text: String
    }
    /// One size to send back.
    public struct Answer: Equatable, Sendable {
        public let id: String
        public let mm: Double
        public init(id: String, mm: Double) { self.id = id; self.mm = mm }
    }

    public var fields: [Field]

    /// Nil when the question lists no sizes: it is not a size question.
    public init?(_ ask: Project.Ask) {
        guard ask.kind == "sizes", let sizes = ask.sizes, !sizes.isEmpty else { return nil }
        fields = sizes.map { Field(id: $0.id, label: $0.label, from: $0.from, asked: $0.mm, text: Self.text($0.mm)) }
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
    /// A field left blank is a size the person doesn't know: it is left out, never sent as confirmed.
    public var answer: [Answer]? {
        var sizes: [Answer] = []
        for field in fields {
            if field.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            guard let mm = Self.millimetres(field.text) else { return nil }
            sizes.append(Answer(id: field.id, mm: mm))
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

    /// Nothing was changed: the button says Confirm. Otherwise it sends corrections.
    public var unchanged: Bool { fields.allSatisfy { Self.millimetres($0.text) == Self.millimetres(Self.text($0.asked)) } }

    /// Beside a field: where the Mac's number came from.
    public static func source(_ from: String) -> String { from == "published" ? "from the maker" : "from your scan" }
}
