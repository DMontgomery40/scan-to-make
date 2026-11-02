import SwiftUI

struct NativeCaptureHostView: View {
    let owner: NativeCaptureRunOwner
    let model: AppDataModel
    let close: (Bool) -> Void
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        NavigationStack {
            Group {
                if model.state == .capturing, let session = model.objectCaptureSession {
                    CapturePrimaryView(session: session)
                } else if model.state == .reconstructing, let folders = model.captureFolderManager {
                    ReconstructionPrimaryView(outputFile: folders.modelsFolder.appendingPathComponent("model-mobile.usdz"))
                } else {
                    VStack(alignment: .leading, spacing: 20) {
                        if model.isStoppingCapture || model.isStoppingReconstruction {
                            Text("Stopping scan").font(.title.bold())
                            Text(model.stopWaitExceeded || model.reconstructionStopWaitExceeded
                                 ? "Stopping is taking longer than expected. Your files are kept, and a new scan stays unavailable until stopping finishes."
                                 : "Your files are kept. Please wait while scanning stops.")
                        } else if model.state == .viewing, owner.message == nil {
                            Text(model.stitchingIncomplete ? "Check every side" : "Scan ready").font(.title.bold())
                            if model.stitchingIncomplete {
                                Label(NativeCaptureDraft.stitchingWarning, systemImage: "exclamationmark.triangle")
                                    .foregroundStyle(.orange)
                            }
                            Text("Add this scan to your project to review its shape. Measurements and fit still need checking.")
                            Button("Add to this project") { close(true) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Text("Scan kept on this device").font(.title.bold())
                            Text(model.error?.localizedDescription ?? "Your original files are kept. You can start another scan from Project captures.")
                        }
                        if let message = owner.message ?? model.evaluationWriteError {
                            Text(message).foregroundStyle(.red)
                        }
                        Button("Keep for later") { close(false) }.buttonStyle(.bordered)
                    }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            .navigationTitle("Scan object")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { close(false) }
                }
            }
        }
        .environment(model)
        .interactiveDismissDisabled()
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { owner.stop() }
        }
    }
}
