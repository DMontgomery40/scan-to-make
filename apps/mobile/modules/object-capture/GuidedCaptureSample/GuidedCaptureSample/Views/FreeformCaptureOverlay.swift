/* See LICENSE.txt for the Apple sample license. */
import RealityKit
import SwiftUI

/// The scan over Apple's capture view (quick-sweep-capture.md §3.1, §3.4): one card, Record, one line of progress, and
/// Done once the photos are enough to rebuild (60, from two heights), which pauses the session and shows Apple's point
/// cloud to review. There is no box, no Area/Object switch, no segments or flips and no tutorial video; those were our
/// sample app's choices, not Apple's requirements.
struct FreeformCaptureOverlay: View {
    @Environment(AppDataModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var session: ObjectCaptureSession

    var body: some View {
        VStack(spacing: 16) {
            if appModel.freeformFlow.step == .ready {
                card
            }
            FeedbackView(messageList: appModel.messageList)
            Spacer()
            controls
        }
        // Apple's coaching overlay has the screen while tracking recovers ("the app may need to hide its UI at this
        // time"), as the guided overlay does; Record and Done are also refused by the flow until tracking is normal.
        .opacity(showsOverlay ? 1 : 0)
        .allowsHitTesting(showsOverlay)
        .padding(.horizontal, 16)
        .padding(.top, 76)      // below Stop capture
        .padding(.bottom, 24)
        .frame(maxWidth: horizontalSizeClass == .regular ? 560 : .infinity)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .default, value: appModel.freeformFlow.step)
        .sheet(isPresented: reviewing) {
            FreeformReviewSheet(session: session)
        }
        .onChange(of: appModel.messageList.activeMessage?.message) { _, message in
            // Apple's feedback is announced as it changes (§3.4).
            if let message { AccessibilityNotification.Announcement(message).post() }
        }
    }

    private var reviewing: Binding<Bool> {
        Binding(get: { appModel.freeformFlow.isReviewing },
                set: { shown in if !shown { appModel.freeformKeepScanning() } })
    }

    private var trackingNormal: Bool { session.cameraTracking == .normal }

    private var showsOverlay: Bool {
        appModel.freeformFlow.step == .finishing || (trackingNormal && !session.isPaused) || appModel.freeformFlow.isReviewing
    }

    private var sessionReady: Bool {
        if case .ready = session.state { return true }
        return false
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Go round it twice: low, then high. Keep the room in view.")
                .font(.headline)
            Text("On the rig: clamp low, swing round; clamp high, swing again.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .environment(\.colorScheme, .dark)
        .glassEffect(.regular.tint(.black.opacity(0.35)), in: .rect(cornerRadius: 22))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("capture.card")
    }

    @ViewBuilder private var controls: some View {
        switch appModel.freeformFlow.step {
        case .ready:
            Button { appModel.freeformRecord() } label: {
                Label("Record", systemImage: "record.circle")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.extraLarge)
            .disabled(!appModel.freeformFlow.canRecord(sessionReady: sessionReady, trackingNormal: trackingNormal))
            .accessibilityLabel("Record scan")
            .accessibilityIdentifier("capture.record")
        case .capturing, .review:
            VStack(spacing: 12) {
                // One plain line: the count and what to do next ("42 photos · now go higher and look down").
                Text(appModel.captureCoverage.line)
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .glassEffect(.regular.tint(.black.opacity(0.35)), in: .capsule)
                    .accessibilityIdentifier("capture.shots")
                HStack(spacing: 12) {
                    // Apple's manual shot, beside its automatic capture (`requestImageCapture()`).
                    Button { appModel.freeformTakePhoto() } label: {
                        Label("Take a photo", systemImage: "camera.circle.fill")
                            .labelStyle(.iconOnly)
                            .font(.title)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.extraLarge)
                    .disabled(!session.canRequestImageCapture)
                    .accessibilityIdentifier("capture.shutter")
                    Spacer(minLength: 0)
                    // Done is offered only once the photos are enough to rebuild: 60, from two heights.
                    Button("Done") { appModel.freeformDone() }
                        .font(.headline)
                        .buttonStyle(.glassProminent)
                        .controlSize(.extraLarge)
                        .disabled(!appModel.freeformFlow.canFinish(coverage: appModel.captureCoverage,
                                                                   trackingNormal: trackingNormal && !session.isPaused))
                        .accessibilityIdentifier("capture.done")
                }
            }
        case .finishing:
            ProgressView("Saving scan")
                .padding(16)
                .environment(\.colorScheme, .dark)
                .glassEffect(.regular.tint(.black.opacity(0.35)), in: .rect(cornerRadius: 22))
        case .stopped:
            EmptyView()
        }
    }
}

/// Done → paused → Apple's point cloud: "This view allows the user to review the captured 3D model before finishing
/// the capture" (ObjectCapturePointCloudView).
private struct FreeformReviewSheet: View {
    @Environment(AppDataModel.self) private var appModel
    var session: ObjectCaptureSession

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                ObjectCapturePointCloudView(session: session)
                    .showShotLocations()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("The scan's points, \(session.numberOfShotsTaken) photos")
                Text("Turn it to check every side. Gaps mean another pass at that height.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                VStack(spacing: 10) {
                    Button { appModel.freeformUseScan() } label: {
                        Text("Use scan").font(.headline).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.extraLarge)
                    .accessibilityIdentifier("capture.useScan")
                    Button { appModel.freeformKeepScanning() } label: {
                        Text("Keep scanning").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.extraLarge)
                    .accessibilityIdentifier("capture.keepScanning")
                }
            }
            .padding(16)
            .navigationTitle("\(session.numberOfShotsTaken) photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // The same stop as the capture screen's; the files are kept.
                    Button("Stop capture", role: .cancel) { appModel.freeformStop() }
                        .accessibilityIdentifier("capture.review.stop")
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear {
            AccessibilityNotification.Announcement("Scan paused. Use scan, or keep scanning.").post()
        }
    }
}
