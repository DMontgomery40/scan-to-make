#if canImport(SwiftUI)
import SwiftUI

/// The code design engine's row (PRD §5.9, §7.5, §8.9), the same on the Mac, iPhone and iPad: its state from the printer
/// MCP's `cad_status`, and Set Up, which the computer runs (`cad_setup`) while this row shows its progress.
public struct CodeEngineSettingsSection: View {
    private let request: @MainActor @Sendable (CodeEngineStatus.Action) async throws -> CodeEngineStatus?
    @State private var status: CodeEngineStatus?
    @State private var problem: String?
    @State private var action = CodeEngineStatus.Action.status
    @State private var revision = 0
    @State private var loaded = false
    public init(request: @escaping @MainActor @Sendable (CodeEngineStatus.Action) async throws -> CodeEngineStatus?) { self.request = request }
    public var body: some View {
        // A computer whose companion predates the engine has nothing to show.
        if !loaded || status != nil {
            Section {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: status?.state == "ready" ? "checkmark.seal.fill" : "chevron.left.forwardslash.chevron.right")
                        .font(.title3).foregroundStyle(status?.state == "ready" ? Color.green : Color.secondary)
                        .frame(width: 36, height: 36).modifier(GlassTile())
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Code design engine").font(.body.weight(.semibold))
                        Text(status?.message ?? "Checking…").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("codeEngine.message")
                    }
                    Spacer()
                    if status?.isWorking == true { ProgressView().controlSize(.small) }
                    if status?.canSetUp == true {
                        Button(status?.state == "ready" ? "Set Up Again" : "Set Up") { action = .setup; revision += 1 }
                            .modifier(GlassProminent()).accessibilityIdentifier("codeEngine.setUp")
                    }
                }
                if let result = status?.result {
                    Label(result.message, systemImage: result.ok ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(result.ok ? Color.green : Color.orange)
                }
                if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
            } header: { Text("Code design engine") } footer: {
                Text(footer)
            }
            .task(id: revision) { await run() }
        }
    }
    private var footer: String {
        let server = status?.server ?? "your printer MCP"
        return "Designs new parts and cleans up scans as a script, without opening Blender or Fusion, and a later change starts from that script. It runs inside \(server) on your computer; Set Up downloads it there. Printing an existing model or reprinting never needs it."
    }
    @MainActor private func run() async {
        let requested = action
        action = .status // A view reappearance only reads; an explicit button consumes one Set Up.
        problem = nil
        do {
            status = try await request(requested)
            loaded = true
            // Setting up can take minutes: follow it, then show the outcome.
            for _ in 0..<1200 where status?.isWorking == true && !Task.isCancelled {
                try await Task.sleep(for: .seconds(2))
                status = try await request(.status)
            }
        } catch is CancellationError {} catch {
            loaded = true
            if !Task.isCancelled { problem = error.localizedDescription }
        }
    }
}
/// Liquid Glass where the system has it (iOS and macOS 26 and later); the package still builds for older systems.
private struct GlassTile: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, macOS 26, *) { content.glassEffect(.regular, in: .rect(cornerRadius: 10)) } else { content }
    }
}
private struct GlassProminent: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, macOS 26, *) { content.buttonStyle(.glassProminent) } else { content.buttonStyle(.borderedProminent) }
    }
}
#endif
