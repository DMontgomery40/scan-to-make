/* See LICENSE.txt for the Apple sample license. */
import SwiftUI
import RealityKit

@main
struct GuidedCaptureSampleApp: App {
    static let subsystem = "org.scantomake.capture-evaluation"
    @State private var started = false
    @State private var appModel = AppDataModel.instance
    @Environment(\.scenePhase) private var scenePhase
    var body: some SwiftUI.Scene {
        WindowGroup {
            if started && !appModel.captureStopped {
                ContentView().environment(appModel)
            } else {
                NavigationStack {
                    SwiftUI.Form {
                        if appModel.captureStopped {
                            SwiftUI.Section(appModel.isStoppingCapture ? "Stopping capture" : "Capture stopped") {
                                if appModel.isStoppingCapture {
                                    Text(appModel.stopWaitExceeded
                                         ? "Capture is taking longer to stop. Your files are kept. A new capture stays unavailable until stopping finishes."
                                         : "Your capture files are kept. Please wait while capture stops.")
                                } else {
                                    Text("Your capture files have been kept. Choose Begin when you want to start a new capture.")
                                }
                                if let message = appModel.evaluationWriteError {
                                    Text(message).foregroundStyle(.red)
                                }
                            }
                        }
                        SwiftUI.Section("Native capture evaluation") {
                            Text("Capture an object from all sides, or explore a surface in area mode. Apple's capture view guides detection, distance, lighting and coverage.")
                            Text("Reflective, transparent and dark interiors may not reconstruct. Coverage is not a measurement or a fit guarantee.")
                        }
                        SwiftUI.Section("This device") {
                            LabeledContent("Object Capture", value: ObjectCaptureSession.isSupported ? "Supported" : "Unavailable")
                            LabeledContent("Reconstruction", value: PhotogrammetrySession.isSupported ? "Supported" : "Unavailable")
                            Text("Requires a physical LiDAR device, A14 or later, iOS 18 or later. No camera starts until you choose Begin.")
                        }
                        SwiftUI.Section {
                            Button("Begin guided capture") {
                                appModel.beginCapture()
                                started = true
                            }
                                .disabled(appModel.isStoppingCapture || !ObjectCaptureSession.isSupported || !PhotogrammetrySession.isSupported)
                            Text("Completed captures and original images remain in Files → On My iPhone → Capture Evaluation. Share the entire capture folder for independent inspection. Keep personal captures private.")
                        }
                    }.navigationTitle("Capture Evaluation")
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                appModel.stopCapture(reason: "App entered background")
            }
        }
    }
}
