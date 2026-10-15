/* See LICENSE.txt for the Apple sample license. */
import RealityKit
import SwiftUI

struct ReconstructionPrimaryView: View {
    @Environment(AppDataModel.self) var appModel
    let outputFile: URL
    var body: some View {
        if appModel.state == .viewing && !appModel.isEmbedded {
            ModelView(modelFile: outputFile, endCaptureCallback: { [weak appModel] in appModel?.endCapture() })
        } else {
            VStack(spacing: 24) {
                if appModel.state == .reconstructing {
                    Button(appModel.isStoppingReconstruction ? "Stopping…" : "Cancel") { appModel.cancelReconstruction() }
                        .disabled(appModel.isStoppingReconstruction)
                }
                Spacer()
                TitleView()
                ProgressBarView(progress: appModel.reconstructionProgress,
                                estimatedRemainingTime: appModel.reconstructionRemainingTime,
                                processingStageDescription: appModel.reconstructionStage)
                if appModel.reconstructionStopWaitExceeded {
                    Text("Reconstruction is taking longer to stop. Your files are kept. A new scan stays unavailable until stopping finishes.")
                }
                Spacer()
            }.padding(24)
        }
    }
}

extension PhotogrammetrySession.Output.ProcessingStage {
    var processingStageString: String? {
        switch self {
            case .preProcessing:
                return NSLocalizedString(
                    "Preprocessing (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Preprocessing…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            case .imageAlignment:
                return NSLocalizedString(
                    "Aligning Images (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Aligning Images…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            case .pointCloudGeneration:
                return NSLocalizedString(
                    "Generating Point Cloud (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Generating Point Cloud…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            case .meshGeneration:
                return NSLocalizedString(
                    "Generating Mesh (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Generating Mesh…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            case .textureMapping:
                return NSLocalizedString(
                    "Mapping Texture (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Mapping Texture…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            case .optimization:
                return NSLocalizedString(
                    "Optimizing (Reconstruction)",
                    bundle: Bundle.main,
                    value: "Optimizing…",
                    comment: "Feedback message during the object reconstruction phase."
                )
            default:
                return nil
            }
    }
}

private struct TitleView: View {
    var body: some View {
        Text(LocalizedString.processingTitle)
            .font(.largeTitle)
            .fontWeight(.bold)

    }

    private struct LocalizedString {
        static let processingTitle = NSLocalizedString(
            "Processing title (Object Capture)",
            bundle: Bundle.main,
            value: "Processing",
            comment: "Title of processing view during processing phase."
        )
    }
}
