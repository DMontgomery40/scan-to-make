/*
See the LICENSE.txt file for this sample’s licensing information.

Abstract:
Top-level View for the Object Capture portion where shots are taken.
*/

import RealityKit
import SwiftUI
import os

private let logger = Logger(subsystem: GuidedCaptureSampleApp.subsystem, category: "CapturePrimaryView")

struct CapturePrimaryView: View {
    @Environment(AppDataModel.self) var appModel
    var session: ObjectCaptureSession

    var body: some View {
        ZStack {
            ObjectCaptureView(session: session,
                              cameraFeedOverlay: { GradientBackground() })
            // Freeform has no box at any point: "Hides the object selection reticle when the session is in `.ready`".
            .hideObjectReticle(appModel.isFreeform || appModel.captureMode == .area)
            .blur(radius: appModel.showOverlaySheets ? 45 : 0)
            .transition(.opacity)

            if appModel.isFreeform {
                FreeformCaptureOverlay(session: session)
            } else {
                CaptureOverlayView(session: session)
            }
        }
        .overlay(alignment: .topLeading) {
            CaptureStopButton { appModel.stopCapture() }
                .padding()
                .padding(.horizontal, 15)
        }
        .onAppear(perform: {
            UIApplication.shared.isIdleTimerDisabled = true
        })
        .id(session.id)
    }
}

// Kept outside CaptureOverlayView so tracking, pause and missing frames cannot hide exit.
struct CaptureStopButton: View {
    let stop: () -> Void

    var body: some View {
        Button("Stop capture", action: stop)
            .font(.subheadline.bold())
            .foregroundStyle(.white)
            .padding(16)
            .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 15))
            .accessibilityIdentifier("capture.stop")
    }
}

private struct GradientBackground: View {
    private let gradient = LinearGradient(
        colors: [.black.opacity(0.4), .clear],
        startPoint: .top,
        endPoint: .bottom
    )
    private let frameHeight: CGFloat = 300

    var body: some View {
        VStack {
            gradient
                .frame(height: frameHeight)

            Spacer()

            gradient
                .rotation3DEffect(Angle(degrees: 180), axis: (x: 1, y: 0, z: 0))
                .frame(height: frameHeight)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

