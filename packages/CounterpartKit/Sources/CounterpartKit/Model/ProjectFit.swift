import Foundation

/// How a fit gets its exact size, chosen in New and sent as fields beside the request (contracts `FitSchema`). The
/// request itself is only what the person typed: the Mac composes the worker's brief from this.
public struct ProjectFit: Equatable, Sendable {
    public enum SizeSource: String, CaseIterable, Hashable, Sendable {
        /// The maker's published size, which the Mac looks up and the person confirms.
        case lookup
        /// The person's own measurements.
        case measured
        /// The scan's size, as an estimate.
        case scan
    }
    /// One size in millimetres. `id` is opaque; `label` says what was measured in words a person can act on.
    public struct Size: Equatable, Sendable {
        public var id: String
        public var label: String
        public var mm: Double
        public init(id: String, label: String, mm: Double) { self.id = id; self.label = label; self.mm = mm }
    }

    public var sizeSource: SizeSource
    /// Only with `.measured`, and then at least one.
    public var measured: [Size]

    /// Nil when the person chose "I measured" and gave no size: there is nothing to send.
    public init?(sizeSource: SizeSource, measured: [Size] = []) {
        if sizeSource == .measured, measured.isEmpty { return nil }
        self.sizeSource = sizeSource
        self.measured = sizeSource == .measured ? measured : []
    }

    /// The `fit` field of a create or draft request.
    public var json: [String: Any] {
        var json: [String: Any] = ["sizeSource": sizeSource.rawValue]
        if sizeSource == .measured { json["measured"] = measured.map { ["id": $0.id, "label": $0.label, "mm": $0.mm] as [String: Any] } }
        return json
    }
}

public extension ProjectFit.SizeSource {
    /// The choice's name in New's "Exact size" control, the same on every layout.
    var label: String {
        switch self {
        case .lookup: "Look up"
        case .measured: "I measured"
        case .scan: "Use scan"
        }
    }
    /// What the choice does, under the control. `computer` names the machine that does it ("your Mac").
    func detail(computer: String = "your Mac") -> String {
        let named = computer.prefix(1).uppercased() + computer.dropFirst()
        switch self {
        case .lookup: return "\(named) identifies it, finds the maker's published size, and asks “I found this exact size — is that right?” before designing to it."
        case .measured: return "Measure the outside of the real thing. Leave a side blank if you don't know it."
        case .scan: return "Uses the scan's size as an estimate. Best for loose holders; \(computer) says the clearance it allowed."
        }
    }
}

/// New's "Exact size" for a fit, as the person set it: where the size comes from and the sides they typed. Made from a
/// scan the companion already has, it starts on "Use scan": the scan is the very thing the new part must fit.
public struct FitChoice: Equatable, Sendable {
    public var source: ProjectFit.SizeSource
    public var longest = "", middle = "", shortest = ""

    public init(source: ProjectFit.SizeSource = .scan) { self.source = source }

    /// The sides typed as positive millimetres (a comma decimal too), by the edge named; blank sides are unknown.
    public var measured: [ProjectFit.Size] {
        [("longest", longest), ("middle", middle), ("shortest", shortest)].compactMap { edge, text in
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, let mm = Double(value.replacingOccurrences(of: ",", with: ".")), mm > 0, mm <= 10_000 else { return nil }
            return ProjectFit.Size(id: edge, label: "\(edge) side", mm: mm)
        }
    }
    /// At least one side typed, and every typed side a size.
    public var measuredValid: Bool {
        let typed = [longest, middle, shortest].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !typed.isEmpty && measured.count == typed.count
    }
    /// What is still needed before it can be sent, in words; nil when nothing is.
    public var missing: String? { source == .measured && !measuredValid ? "Enter at least one measurement in millimetres." : nil }
    /// The `fit` field to send; nil while "I measured" has no size.
    public var fit: ProjectFit? { ProjectFit(sizeSource: source, measured: source == .measured ? measured : []) }
}
