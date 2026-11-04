#if canImport(SwiftUI)
import SwiftUI

/// Both clients display the companion's readiness and repair result, without starting Blender.
public struct BlenderAddonSettingsSection: View {
    private let request: @MainActor @Sendable (BlenderAddonStatus.Action) async throws -> BlenderAddonStatus
    @State private var status: BlenderAddonStatus?
    @State private var problem: String?
    @State private var working = false
    @State private var action = BlenderAddonStatus.Action.check
    @State private var revision = 0
    public init(request: @escaping @MainActor @Sendable (BlenderAddonStatus.Action) async throws -> BlenderAddonStatus) { self.request = request }
    public var body: some View {
        Section {
            Label(status?.message ?? "Checking Blender…", systemImage: status?.state == "ready" ? "checkmark.circle" : "cube.transparent")
                .font(.subheadline)
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
            HStack {
                if working { ProgressView().controlSize(.small) }
                Button("Check Again") { action = .check; revision += 1 }.disabled(working)
                if status?.canUpdate == true {
                    Button("Update Add-on") { action = .update; revision += 1 }.disabled(working)
                }
            }
        } header: { Text("Blender · Optional") } footer: {
            Text("Blender is used for scan cleanup and model changes. Printing an existing model or reprinting needs neither Blender nor Fusion. Updating the add-on backs up its existing file; save your work before restarting Blender.")
        }
        .task(id: revision) { await run() }
    }
    @MainActor private func run() async {
        let requested = action
        action = .status // A view reappearance only reads; an explicit button consumes one mutation.
        working = true; problem = nil
        defer { working = false }
        do {
            status = try await request(requested)
            for _ in 0..<120 where status?.isWorking == true && !Task.isCancelled {
                try await Task.sleep(for: .seconds(1))
                status = try await request(.status)
            }
            if status?.isWorking == true && !Task.isCancelled { problem = "The Mac is still working. Check Again for its latest result." }
        } catch is CancellationError {} catch {
            if !Task.isCancelled { problem = error.localizedDescription }
        }
    }
}
#endif
