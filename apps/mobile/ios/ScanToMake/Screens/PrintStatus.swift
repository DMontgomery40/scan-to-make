import SwiftUI
import CounterpartKit

/// A print on its way: getting it ready, the printer's own question (answered in its sheet), or printing.
struct PrintStatusCard: View {
    let store: ProjectsStore
    let project: Project
    @Binding var working: Bool
    let openPrinting: () -> Void
    let openConfirmation: () -> Void
    @State private var problem: String?

    var body: some View {
        let words = store.words(project)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: words.phase.symbol).foregroundStyle(words.phase.color).symbolEffect(.pulse, isActive: words.busy)
                Text(words.line).font(.headline)
                Spacer()
            }
            if let confirmation = project.printConfirmation {
                Text(confirmation.isRenderable ? "Nothing goes to the printer until you say yes." : "Counterpart can't show this question yet.")
                    .font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button(action: openConfirmation) { Label("Review", systemImage: "checkmark.shield").frame(maxWidth: .infinity).frame(height: 36) }
                        .buttonStyle(.glassProminent)
                    Button(role: .destructive) { answer(confirmation, .cancel, [:]) } label: { Text("Don't Print").frame(maxWidth: .infinity).frame(height: 36) }
                        .buttonStyle(.glass)
                }
                .disabled(working)
            } else if words.phase == .printing {
                if let progress = project.print?.live?.job?.progress { ProgressView(value: progress, total: 100).tint(.okGreen) }
                Button(action: openPrinting) { Label("Watch the Print", systemImage: "camera").frame(maxWidth: .infinity).frame(height: 36) }
                    .buttonStyle(.glass)
            } else {
                ProgressView().progressViewStyle(.linear).tint(words.phase.color)
                if let event = project.print?.events?.last { Text(event.message).font(.footnote).foregroundStyle(.secondary) }
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(16)
        .glassEffect(.regular.tint(words.phase.color.opacity(0.12)), in: .rect(cornerRadius: 24))
    }

    private func answer(_ question: Project.PrintConfirmation, _ action: PrintConfirmationResponse.Action, _ content: [String: Bool]) {
        act {
            guard let response = question.response(confirmationId: question.id, action: action, content: content, atMs: Date().timeIntervalSince1970 * 1000) else {
                await store.reload(project.id)
                throw CompanionError(code: "stale-confirmation", message: "This printer question has changed or expired. Review the current question before continuing.")
            }
            return try await store.mac.answerPrintConfirmation(project.id, response: response)
        }
    }

    private func act(_ body: @escaping () async throws -> Project?) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            do { if let next = try await body() { store.replace(next) } }
            catch let failure as CompanionError { if failure.code != "cancelled" { problem = failure.message } }
            catch { problem = CompanionError.unreachable.message }
        }
    }
}
