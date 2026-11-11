import SwiftUI
import CounterpartKit

// The visual system (PRD §10), as the mockups in docs/design/overhaul/mockup-app draw it: one warm accent,
// fixed status colours always paired with a symbol and words, content on a near-black stage, and system
// Liquid Glass for the controls on top.

extension Color {
    /// "Filament orange": the primary action, selection and Ready only.
    static let filament = Color(red: 1.0, green: 0.45, blue: 0.18)
    static let stageTop = Color(red: 0.13, green: 0.14, blue: 0.17)
    static let stageBottom = Color(red: 0.05, green: 0.05, blue: 0.07)
    static let okGreen = Color(red: 0.25, green: 0.84, blue: 0.47)
    /// Cards and tiles on the black page.
    static let card = Color(white: 0.09)
    static let well = Color(white: 0.07)
}

/// The in-hand recorder's own blue (HandheldCapture.swift keeps its look).
let cobalt = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
    ? UIColor(red: 0x3A / 255, green: 0x63 / 255, blue: 0xF2 / 255, alpha: 1)
    : UIColor(red: 0x24 / 255, green: 0x48 / 255, blue: 0xD8 / 255, alpha: 1) })

extension Tone {
    var color: Color {
        switch self {
        case .working: .blue
        case .needsYou: .orange
        case .accent: .filament
        case .printing: .okGreen
        case .secondary: .secondary
        case .failed: .red
        }
    }
}

extension ProjectPhase {
    var color: Color { tone.color }
}

/// The dark stage behind models and photos: dark for every part, however dark its filament (a dark part is
/// floored in its material, CounterpartKit `StageMaterial`, never by lightening the stage).
struct StageBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [.stageTop, .stageBottom], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color.white.opacity(0.10), .clear], center: .init(x: 0.5, y: 0.62), startRadius: 4, endRadius: 220)
        }
    }
}

/// A project's state: symbol and words on glass, in the state's colour.
struct StatusCapsule: View {
    let phase: ProjectPhase
    var text: String? = nil
    var body: some View {
        Label(text ?? phase.label, systemImage: phase.symbol)
            .font(.caption.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .lineLimit(1).minimumScaleFactor(0.75)
            .foregroundStyle(phase == .printed ? Color.white.opacity(0.75) : phase.color)
            .padding(.horizontal, 10).padding(.vertical, 5)
            // Dark glass: readable on a light render as on a dark one.
            .glassEffect(.regular.tint(.black.opacity(0.55)), in: .capsule)
            .accessibilityElement(children: .combine)
    }
}

/// A spool: its colour with the hub drawn in.
struct SpoolDot: View {
    let color: Color
    var size: CGFloat = 30
    var selected = false
    var body: some View {
        ZStack {
            Circle().fill(color)
            Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1)
            Circle().fill(.black.opacity(0.35)).frame(width: size * 0.32)
        }
        .frame(width: size, height: size)
        .overlay { if selected { Circle().strokeBorder(Color.filament, lineWidth: 3).padding(-5) } }
        .accessibilityHidden(true)
    }
}

extension PrinterFilament {
    var color: Color { let c = rgb; return Color(red: c.red, green: c.green, blue: c.blue) }
}

/// "#RRGGBB" as a colour.
func hexColor(_ hex: String?) -> Color? {
    guard let hex else { return nil }
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard digits.count >= 6, let value = Int(digits.prefix(6), radix: 16) else { return nil }
    return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.title3.weight(.bold)).foregroundStyle(.white).accessibilityAddTraits(.isHeader) }
}

/// A symbol over a word, for a row of equal glass buttons.
struct StackLabel: View {
    let text: String, symbol: String
    var body: some View {
        VStack(spacing: 4) { Image(systemName: symbol); Text(text).lineLimit(1).minimumScaleFactor(0.8) }
            .frame(maxWidth: .infinity).padding(.vertical, 4)
    }
}

/// One number with its name, on a dark tile.
struct InfoTile: View {
    let title: String, value: String, symbol: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol).foregroundStyle(.secondary)
            Text(value).font(.headline.monospacedDigit()).lineLimit(1).minimumScaleFactor(0.7)
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.card, in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }
}

/// A glass capsule with a symbol and a number: time, grams, layers.
struct Metric: View {
    let symbol: String, text: String
    var body: some View {
        Label(text, systemImage: symbol).font(.caption.weight(.semibold).monospacedDigit())
            .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule)
    }
}

/// Fills a fixed-height box with an image without widening the layout.
struct FillImage: View {
    let image: UIImage?
    var height: CGFloat
    var body: some View {
        Color.well.frame(height: height)
            .overlay { if let image { Image(uiImage: image).resizable().scaledToFill() } }
            .clipped()
    }
}

/// A spool colour in a word ("Black", "Yellow"), from its hex, for a filament chip when the printer
/// reports the colour but not a name.
enum ColourName {
    static let palette: [(String, Double, Double, Double)] = [
        ("Black", 0.08, 0.08, 0.08), ("White", 0.96, 0.96, 0.96), ("Grey", 0.55, 0.55, 0.57), ("Red", 0.85, 0.12, 0.12),
        ("Orange", 1.0, 0.5, 0.1), ("Yellow", 0.98, 0.8, 0.1), ("Green", 0.15, 0.65, 0.25), ("Blue", 0.12, 0.35, 0.85),
        ("Purple", 0.5, 0.25, 0.7), ("Pink", 0.95, 0.5, 0.7), ("Brown", 0.45, 0.3, 0.18), ("Beige", 0.85, 0.78, 0.62),
    ]
    static func of(_ hex: String?) -> String? {
        guard let hex else { return nil }
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count >= 6, let value = Int(digits.prefix(6), radix: 16) else { return nil }
        let r = Double((value >> 16) & 255) / 255, g = Double((value >> 8) & 255) / 255, b = Double(value & 255) / 255
        return palette.min { ($0.1 - r) * ($0.1 - r) + ($0.2 - g) * ($0.2 - g) + ($0.3 - b) * ($0.3 - b)
                               < ($1.1 - r) * ($1.1 - r) + ($1.2 - g) * ($1.2 - g) + ($1.3 - b) * ($1.3 - b) }?.0
    }
}
