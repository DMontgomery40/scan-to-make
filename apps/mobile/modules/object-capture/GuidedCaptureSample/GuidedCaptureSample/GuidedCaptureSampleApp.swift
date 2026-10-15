/* See LICENSE.txt for the Apple sample license. */
import SwiftUI
import RealityKit

@main
struct GuidedCaptureSampleApp: App {
    static let subsystem = "org.scantomake.capture-evaluation"
    @State private var started = false
    var body: some SwiftUI.Scene {
        WindowGroup {
            if started {
                ContentView().environment(AppDataModel.instance)
            } else {
                NavigationStack {
                    SwiftUI.Form {
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
                            Button("Begin guided capture") { started = true }
                                .disabled(!ObjectCaptureSession.isSupported || !PhotogrammetrySession.isSupported)
                            Text("Completed captures and original images remain in Files → On My iPhone → Capture Evaluation. Share the entire capture folder for independent inspection. Keep personal captures private.")
                        }
                    }.navigationTitle("Capture Evaluation")
                }
            }
        }
    }
}
