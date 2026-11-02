import SwiftUI
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// PRD §10: one warm accent, used only for the primary action, selection and Ready. Status colours are
// fixed and always paired with a symbol and words.
extension Color {
    /// Filament orange, the app's accent.
    static let filament = Color(red: 1.0, green: 0.45, blue: 0.18)
    static let stageTop = Color(red: 0.13, green: 0.14, blue: 0.17)
    static let stageBottom = Color(red: 0.05, green: 0.05, blue: 0.07)
    static let okGreen = Color(red: 0.25, green: 0.84, blue: 0.47)
}

extension ProjectStage {
    /// The shared tone (CounterpartKit), in this app's fixed colours.
    var tint: Color {
        switch tone {
        case .working: return .blue
        case .needsYou: return .orange
        case .accent: return .filament
        case .printing: return .okGreen
        case .secondary: return .secondary
        case .failed: return .red
        }
    }
}

/// The state in a glass capsule, over the stage.
struct StatusCapsule: View {
    let stage: ProjectStage
    var text: String? = nil
    /// Done (PRD §5.4): the green ✓.
    var done = false
    /// It opens the status menu: a chevron says so.
    var menu = false
    var body: some View {
        HStack(spacing: 4) {
            Label(text ?? stage.label, systemImage: done ? "checkmark.circle.fill" : stage.symbol).labelStyle(.titleAndIcon)
            if menu { Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.7) }
        }
            .font(.caption.weight(.semibold))
            .foregroundStyle(done ? Color.okGreen : stage.tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .glassEffect(.regular, in: .capsule)
    }
}

/// A printer's ready dot. Grey unless the printer itself says it is ready; never green on a guess.
struct ReadyDot: View {
    let state: String?
    var size: CGFloat = 7
    var body: some View {
        Circle().fill(state == "ready" ? Color.okGreen : state == "busy" ? Color.orange : Color.gray).frame(width: size, height: size)
            .accessibilityLabel(state == "ready" ? "Ready" : state == "busy" ? "Busy" : state == "offline" ? "Offline" : "State not known")
    }
}

/// The app's mark, wherever the app introduces itself.
struct AppMark: View {
    let size: CGFloat
    var body: some View {
        Image("AppMark")
            .resizable().interpolation(.high).frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// The app's mark, a title and one calm sentence, for the states that have nothing else to show.
struct QuietMessage: View {
    var title: String?
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            AppMark(size: 64).padding(.bottom, 4)
            if let title { Text(title).font(.title3.weight(.semibold)) }
            Text(text).font(.body).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

/// A small uppercase heading, as in the inspector.
struct SectionHeading: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }
}
