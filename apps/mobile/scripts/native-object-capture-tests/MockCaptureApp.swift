import SwiftUI

@MainActor final class MockCaptureEngine: NativeCaptureEngine {
    let model = AppDataModel()
    var onFinish: ((NativeCaptureOutcome) -> Void)?
    init(directory: URL) {
        model.fixtureRoot = directory
        model.onEmbeddedCompletion = { [weak self] url, error in
            self?.onFinish?(url != nil ? .completed : error.map(NativeCaptureOutcome.failed) ?? .stopped)
        }
    }
    func start() { model.beginCapture() }
    func stop() { model.stopEmbeddedCapture() }
}
struct CapturePrimaryView: View {
    @Environment(AppDataModel.self) var model
    let session: ObjectCaptureSession
    var body: some View {
        VStack(spacing: 24) {
            Text("Isolated camera fixture")
            Button("Stop capture") { model.stopCapture() }
            Button("Finish fixture scan") {
                model.deliverCapture(.completed)
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(300))
                    let output = model.captureFolderManager!.modelsFolder.appendingPathComponent("model-mobile.usdz")
                    try? Data("fixture model".utf8).write(to: output)
                    model.photogrammetrySession?.emit(.processingComplete)
                }
            }
        }
    }
}
struct ModelView: View {
    let modelFile: URL
    let endCaptureCallback: () -> Void
    var body: some View { Text("Fixture model") }
}

@main struct MockCaptureApp: App {
    @State private var owner = NativeCaptureRunOwner(store: NativeCaptureDraftStore()) { MockCaptureEngine(directory: $0) }
    @State private var model: AppDataModel?
    @State private var message = "Ready"
    @State private var draftCount = 0
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                VStack(spacing: 20) {
                    Text(message).accessibilityIdentifier("fixture.message")
                    Button("Scan object") {
                        do {
                            _ = try owner.start(origin: NativeCaptureDestination(projectId: "fixture", revision: 0, snapshot: "{}", context: nil))
                            model = (owner.engine as? MockCaptureEngine)?.model
                        } catch { message = error.localizedDescription }
                    }.disabled(owner.activeRunID != nil)
                    if owner.activeRunID != nil {
                        Text("Stopping or active scan")
                        Button("Deliver terminal event") {
                            let active = (owner.engine as? MockCaptureEngine)?.model
                            active?.objectCaptureSession?.emit(.failed(ObjectCaptureSession.Error.cancelled))
                            active?.photogrammetrySession?.emit(.processingCancelled)
                        }
                    }
                    Text("Local drafts: \(draftCount)")
                    Button("Reload retained drafts") {
                        draftCount = (try? owner.store.list(activeRunID: owner.activeRunID).count) ?? 0
                    }
                }.padding().navigationTitle("Project captures")
            }
            .fullScreenCover(item: $model) { presented in
                    NativeCaptureHostView(owner: owner, model: presented) { add in
                        owner.stop(); model = nil
                        draftCount = (try? owner.store.list(activeRunID: owner.activeRunID).count) ?? 0
                        message = add ? "Explicit add requested" : "Scan kept locally"
                    }
            }
        }
    }
}
