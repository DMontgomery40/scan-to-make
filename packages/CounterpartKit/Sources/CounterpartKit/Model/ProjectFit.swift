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
