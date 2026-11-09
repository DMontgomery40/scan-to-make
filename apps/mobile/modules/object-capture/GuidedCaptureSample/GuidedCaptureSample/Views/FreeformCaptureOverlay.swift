/* See LICENSE.txt for the Apple sample license. */
import RealityKit
import SwiftUI

/// The quick scan over Apple's capture view (quick-sweep-capture.md §3.1, §3.4): one card, Record, and Done after ten
/// photos, which pauses the session and shows Apple's point cloud to review. There is no box, no Area/Object switch,
/// no segments or flips and no tutorial video; those were our sample app's choices, not Apple's requirements.
struct FreeformCaptureOverlay: View {
    @Environment(AppDataModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var session: ObjectCaptureSession

    var body: some View {
        VStack(spacing: 16) {
            if appModel.freeformFlow.step != .finishing {
                card
                    // Apple's coaching overlay needs the screen while tracking recovers.
                    .opacity(session.cameraTracking == .normal ? 1 : 0)
            }
            FeedbackView(messageList: appModel.messageList)
            Spacer()
            controls
        }
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
            .disabled(!appModel.freeformFlow.canRecord(sessionReady: sessionReady))
            .accessibilityLabel("Record scan")
            .accessibilityIdentifier("capture.record")
        case .capturing, .review:
            HStack(spacing: 12) {
                Text("\(session.numberOfShotsTaken) photos")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .glassEffect(.regular.tint(.black.opacity(0.35)), in: .capsule)
                    .accessibilityIdentifier("capture.shots")
                Spacer(minLength: 0)
                if appModel.freeformFlow.canFinish(shots: session.numberOfShotsTaken) {
                    Button("Done") { appModel.freeformDone() }
                        .font(.headline)
                        .buttonStyle(.glassProminent)
                        .controlSize(.extraLarge)
                        .accessibilityIdentifier("capture.done")
                        .transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.9)))
                }
            }
        case .finishing:
            ProgressView("Saving scan")
                .padding(16)
                .environment(\.colorScheme, .dark)
                .glassEffect(.regular.tint(.black.opacity(0.35)), in: .rect(cornerRadius: 22))
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
        }
        .interactiveDismissDisabled()
        .onAppear {
            AccessibilityNotification.Announcement("Scan paused. Use scan, or keep scanning.").post()
        }
    }
}
