import SwiftUI
import UIKit
import AVFoundation
import CoreImage
import ImageIO
import Vision

// Handheld capture records synchronized rear-camera RGB and LiDAR depth. The object can move independently
// of the phone; reconstruction must estimate object-relative poses. These are measured inputs, not a claim
// that a photo count constitutes complete coverage. The separate Object Capture scanner is unchanged.

enum HandheldCapture {
    static let minimumPhotos = 24

    static var backCamera: AVCaptureDevice? { AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back) }
    static var isAvailable: Bool {
        #if targetEnvironment(simulator)
        return true   // so the screens can be checked in the Simulator, which has no camera to capture with
        #else
        return backCamera != nil
        #endif
    }

    /// Launched with `-STMHandheldPreview ready` the capture screen opens at once, so a build can be checked on a
    /// device or the Simulator without tapping through. `capturing` (Simulator only) shows the capturing layout.
    @MainActor static func previewIfAsked() {
        guard let state = UserDefaults.standard.string(forKey: "STMHandheldPreview") else { return }
        UserDefaults.standard.removeObject(forKey: "STMHandheldPreview")
        #if targetEnvironment(simulator)
        let preview = state == "capturing"
        #else
        let preview = false
        #endif
        Task { _ = await run(objectId: UUID().uuidString.lowercased(), preview: preview) }
    }

    /// One folder per object: Documents/HandheldCaptures/<object id>/0000.heic … plus `finished` when complete.
    static func folder(_ objectId: String) -> URL {
        URL.documentsDirectory.appending(path: "HandheldCaptures/\(objectId)", directoryHint: .isDirectory)
    }
    /// A capture that finished on this phone, so a send cut short can resume.
    static func finished(_ objectId: String) -> Bool {
        FileManager.default.fileExists(atPath: folder(objectId).appending(path: "finished").path)
    }

    /// Shows the capture full screen. True when photos were taken and finished; false when cancelled.
    @MainActor static func run(objectId: String, preview: Bool = false) async -> Bool {
        guard let presenter = topViewController() else { return false }
        return await withCheckedContinuation { continuation in
            var resumed = false
            let host = UIHostingController(rootView: AnyView(EmptyView()))
            host.rootView = AnyView(HandheldCaptureView(folder: folder(objectId), preview: preview) { done in
                host.dismiss(animated: true)
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: done)
            })
            host.modalPresentationStyle = .fullScreen
            presenter.present(host, animated: true)
        }
    }

    @MainActor private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

/// The two ways to scan, for a "Scan It" menu: walk around it (Object Capture) or hold it up and turn it.
struct ScanChoices: View {
    let walkAround: Bool
    let choose: (_ handheld: Bool) -> Void
    var body: some View {
        if HandheldCapture.isAvailable {
            Button("Hold It Up and Turn It", systemImage: "hand.raised") { choose(true) }
        }
        if walkAround {
            Button("Walk Around It", systemImage: "figure.walk") { choose(false) }
        }
    }
}

// MARK: - Camera

/// Sensor evidence, separate from how dark the object itself is. A valid exposure can legitimately
/// produce a very dark photo; the failed capture had both near-black pixels and zero exposure/ISO.
enum HandheldCaptureQuality {
    static func canCapture(lastFrameAt: TimeInterval?, lastDepthAt: TimeInterval?, now: TimeInterval, exposure: Double, iso: Double) -> Bool {
        guard let lastFrameAt, let lastDepthAt, exposure.isFinite, exposure > 0, iso.isFinite, iso > 0 else { return false }
        return now >= lastFrameAt && now - lastFrameAt < 1.5 && now >= lastDepthAt && now - lastDepthAt < 1.5
    }
}

/// At most one live analysis at a time, four a second: late frames are simply skipped.
private final class AnalysisGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var last = Date.distantPast
    func enter() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !busy, Date().timeIntervalSince(last) > 0.25 else { return false }
        busy = true; last = Date()
        return true
    }
    func leave() { lock.lock(); busy = false; lock.unlock() }
}
private let analysisGate = AnalysisGate()
private let readinessGate = AnalysisGate()
private let depthReadinessGate = AnalysisGate()

// fileprivate keeps the AVFoundation owner out of the generated Objective-C header.
@MainActor @Observable fileprivate final class HandheldCamera: NSObject {
    enum Phase: Equatable { case ready, countdown(Int), capturing, paused, saving, finished }
    var phase: Phase = .ready
    var taken = 0
    var bytesSaved: Int64 = 0
    var failure: String?
    var notice: String?
    var mask: CGImage?
    var lastVideoFrameAt: TimeInterval?
    var lastDepthFrameAt: TimeInterval?
    var previewRendering = false
    var previewSize = CGSize.zero
    var legacyCapture = false
    var recordingLimitReached = false

    let session = AVCaptureSession()
    let folder: URL
    private let videoOutput = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "handheld.camera")
    private var device: AVCaptureDevice?
    private var recorder: HandheldDepthRecorder?
    private var countdownTask: Task<Void, Never>?
    private var watchdog: Timer?
    private var closed = false
    private var finishInProgress = false
    private var didFinish = false

    init(folder: URL) { self.folder = folder; super.init() }

    var canStart: Bool {
        let now = ProcessInfo.processInfo.systemUptime
        guard !closed, !recordingLimitReached, !legacyCapture, failure == nil, recorder != nil, session.isRunning, let device,
              previewRendering, previewSize.width > 1, previewSize.height > 1 else { return false }
        return HandheldCaptureQuality.canCapture(lastFrameAt: lastVideoFrameAt, lastDepthAt: lastDepthFrameAt, now: now,
            exposure: CMTimeGetSeconds(device.exposureDuration), iso: Double(device.iso))
    }

    fileprivate func previewChanged(rendering: Bool, size: CGSize) {
        previewRendering = rendering; previewSize = size
    }

    private func recordDiagnostics(_ event: String) {
        let report: [String: Any] = [
            "event": event, "at": ISO8601DateFormatter().string(from: Date()),
            "captureMethod": "synchronized-rear-lidar", "sessionRunning": session.isRunning,
            "previewRendering": previewRendering, "previewWidth": previewSize.width,
            "previewHeight": previewSize.height, "framesSaved": taken, "bytesSaved": bytesSaved,
            "rgbReceived": lastVideoFrameAt != nil, "depthReceived": lastDepthFrameAt != nil,
            "failure": failure ?? "", "notice": notice ?? ""
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
            try? data.write(to: folder.appending(path: "capture-ui-diagnostics.json"), options: .atomic)
        }
    }

    private func retain(_ summary: HandheldDepthRecorder.Summary) {
        taken = summary.framesSaved; bytesSaved = summary.bytes
        recordingLimitReached = summary.limitReached
        if let data = try? JSONEncoder().encode(summary) {
            try? data.write(to: folder.appending(path: "capture-diagnostics.json"), options: .atomic)
        }
    }

    func open() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            failure = "Counterpart needs camera access. You can enable it in Settings."; return
        }
        guard !closed else { return }
        guard let device = HandheldCapture.backCamera else {
            failure = "Handheld depth capture needs a rear LiDAR camera."; return
        }
        // A completed capture belongs to the retry flow; opening a camera must never erase it.
        if FileManager.default.fileExists(atPath: folder.appending(path: "finished").path) {
            failure = "This capture is already saved. Return to the project to send it."; return
        }
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        catch { failure = "Counterpart couldn't create a folder for this capture."; return }
        self.device = device
        let callbacks = HandheldDepthRecorder.Callbacks(
            onVideo: { [weak self] sample in self?.receivedVideo(sample) },
            onSaved: { [weak self] frame in
                Task { @MainActor in
                    guard let self, !self.closed else { return }
                    self.taken = frame.framesSaved
                    self.bytesSaved += frame.byteCount
                }
            },
            onDepthReady: { [weak self] in
                guard depthReadinessGate.enter() else { return }
                let now = ProcessInfo.processInfo.systemUptime
                Task { @MainActor in self?.lastDepthFrameAt = now }
                depthReadinessGate.leave()
            },
            onFailure: { [weak self] message in Task { @MainActor in await self?.captureFailed(message) } },
            onLimitReached: { [weak self] message in Task { @MainActor in await self?.recordingLimit(message) } })
        let recorder = HandheldDepthRecorder(device: device, videoOutput: videoOutput, folder: folder, callbacks: callbacks)
        self.recorder = recorder
        do {
            let recovered = try await recorder.recover()
            retain(recovered)
            if recovered.framesSaved > 0 {
                phase = .paused
                notice = "Your recorded frames are still here. Resume capture or save them to the project."
            }
        } catch is HandheldDepthFrameCodec.LegacyCapture {
            // An older photo capture can be saved, but must not be mixed with a new RGB-D stream.
            self.recorder = nil; legacyCapture = true; phase = .paused
            let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])) ?? []
            let images = files.filter { $0.pathExtension.lowercased() == "heic" }
            taken = images.count
            bytesSaved = images.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            notice = "Your previous photos are still here. Save this capture to the project."
            return
        } catch {
            failure = "The saved capture couldn't be reopened: \(error.localizedDescription)"; return
        }
        guard !closed else { return }
        let session = session, videoOutput = videoOutput
        let error: String? = await withCheckedContinuation { continuation in
            queue.async {
                session.beginConfiguration()
                do {
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else { throw CaptureSetupError.input }
                    session.addInput(input)
                    videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                    videoOutput.alwaysDiscardsLateVideoFrames = true
                    guard session.canAddOutput(videoOutput) else { throw CaptureSetupError.output }
                    session.addOutput(videoOutput)
                    try recorder.install(in: session)
                    session.commitConfiguration()
                    session.startRunning()
                    continuation.resume(returning: nil)
                } catch {
                    session.commitConfiguration()
                    continuation.resume(returning: error.localizedDescription)
                }
            }
        }
        if closed { let session = session; queue.async { session.stopRunning() }; return }
        if let error { failure = "The depth camera couldn't start: \(error)" }
        recordDiagnostics("configured")
    }

    private enum CaptureSetupError: LocalizedError {
        case input, output
        var errorDescription: String? { "The camera does not support this capture configuration." }
    }

    func start() {
        guard (phase == .ready || phase == .paused), canStart else { return }
        countdownTask?.cancel()
        phase = .countdown(3)
        countdownTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for remaining in stride(from: 3, to: 0, by: -1) {
                guard !Task.isCancelled, !self.closed else { return }
                self.phase = .countdown(remaining)
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
            guard self.canStart, let recorder = self.recorder else {
                self.phase = .paused
                self.notice = "Waiting for synchronized camera and depth data."; return
            }
            do {
                try await recorder.start()
                guard !self.closed else { _ = await recorder.stop(); return }
                self.phase = .capturing; self.notice = nil
                self.watchdog?.invalidate()
                self.watchdog = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, self.phase == .capturing else { return }
                        if !self.canStart { await self.captureFailed("The camera stopped delivering synchronized RGB and depth. The frames already recorded are saved.") }
                    }
                }
                self.recordDiagnostics("recording")
            } catch { await self.captureFailed(error.localizedDescription) }
        }
    }

    func pause() async {
        guard phase == .capturing else { return }
        phase = .saving; watchdog?.invalidate(); watchdog = nil
        if let summary = await recorder?.stop() { retain(summary) }
        guard !closed else { return }
        phase = .paused; recordDiagnostics("paused")
    }

    private func captureFailed(_ message: String) async {
        guard !closed, phase != .finished else { return }
        failure = message; countdownTask?.cancel(); watchdog?.invalidate(); watchdog = nil
        phase = .saving
        if let summary = await recorder?.stop() { retain(summary) }
        guard !closed else { return }
        phase = .paused; recordDiagnostics("capture-failed")
    }

    private func recordingLimit(_ message: String) async {
        guard !closed else { return }
        notice = message
        await pause()
        recordDiagnostics("recording-limit")
    }

    /// Stop admitting frames and drain the single writer before the upload can see a finished marker.
    func finish() async -> Bool {
        guard !closed, !finishInProgress else { return didFinish }
        finishInProgress = true
        let savingKnownFailure = failure != nil
        countdownTask?.cancel(); watchdog?.invalidate(); watchdog = nil; phase = .saving
        if let summary = await recorder?.stop() {
            retain(summary)
            if let failure = summary.failure, !savingKnownFailure {
                self.failure = failure; phase = .paused; finishInProgress = false
                return false
            }
        }
        guard !closed else { finishInProgress = false; return false }
        guard taken >= HandheldCapture.minimumPhotos else {
            phase = .paused; notice = "There aren't enough recorded frames to send yet."
            finishInProgress = false; return false
        }
        do {
            try Data().write(to: folder.appending(path: "finished"), options: .atomic)
            didFinish = true; phase = .finished; recordDiagnostics("saved")
        } catch { failure = "Counterpart couldn't save the capture."; phase = .paused }
        finishInProgress = false
        return didFinish
    }

    func close() {
        guard !closed else { return }
        closed = true; countdownTask?.cancel(); watchdog?.invalidate(); watchdog = nil
        let recorder = recorder, session = session, queue = queue
        Task { _ = await recorder?.stop(); queue.async { session.stopRunning() } }
    }

    nonisolated private func receivedVideo(_ sample: CMSampleBuffer) {
        guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        if readinessGate.enter() {
            let now = ProcessInfo.processInfo.systemUptime
            Task { @MainActor [weak self] in self?.lastVideoFrameAt = now }
            readinessGate.leave()
        }
        guard analysisGate.enter() else { return }
        nonisolated(unsafe) let frame = pixels
        Task.detached { [weak self] in
            let mask = await Self.objectMask(frame)
            await MainActor.run { if let mask { self?.mask = mask } }
            analysisGate.leave()
        }
    }

    nonisolated static func objectMask(_ pixels: CVPixelBuffer) async -> CGImage? {
        guard #available(iOS 27.0, *) else { return nil }
        let request = GenerateIterativeSegmentationRequest(seedPoint: NormalizedPoint(x: 0.5, y: 0.5))
        guard case .ready = await request.assetStatus else {
            Task.detached(priority: .background) { try? await request.downloadAssets() }
            return nil
        }
        request.qualityLevel = .fast
        return try? await request.perform(on: pixels, orientation: nil)?.cgImage
    }
}


// MARK: - Screen

struct HandheldCaptureView: View {
    let folder: URL
    let done: (Bool) -> Void
    private let preview: Bool
    @State private var camera: HandheldCamera

    fileprivate init(folder: URL, preview: Bool = false, done: @escaping (Bool) -> Void) {
        self.folder = folder
        self.done = done
        self.preview = preview
        let camera = HandheldCamera(folder: folder)
        if preview { camera.phase = .capturing; camera.taken = 52 }
        _camera = State(initialValue: camera)
    }

    private var instruction: String {
        switch camera.phase {
        case .ready: return "Hold the whole object in view."
        case .countdown, .capturing: return "Show different views of the object. You can pause to change your grip."
        case .paused: return "Capture paused. Resume when you're ready, or save what you've captured."
        case .saving: return "Saving the recorded camera and depth data."
        case .finished: return "Capture saved."
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: camera.session, mirrored: false) { rendering, size in
                camera.previewChanged(rendering: rendering, size: size)
            }
            .ignoresSafeArea()
            if let mask = camera.mask {
                Image(decorative: mask, scale: 1, orientation: .right)
                    .resizable()
                    .scaledToFill()
                    .colorMultiply(cobalt)
                    .blendMode(.screen)
                    .opacity(0.45)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            Circle()
                .strokeBorder(.white.opacity(0.7), style: StrokeStyle(lineWidth: 2, dash: [8, 8]))
                .frame(width: 260, height: 260)
                .allowsHitTesting(false)
            if case .countdown(let seconds) = camera.phase {
                Text("\(seconds)")
                    .font(.system(size: 88, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .contentTransition(.numericText(countsDown: true))
                    .accessibilityLabel("Starting in \(seconds)")
            }
            VStack(spacing: 12) {
                HStack {
                    Button("Cancel", systemImage: "xmark") { camera.close(); done(false) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.glass)
                        .controlSize(.large)
                    Spacer()
                    Label(camera.legacyCapture ? "Saved Capture" : "Handheld LiDAR", systemImage: "viewfinder")
                        .font(.headline).padding(12).glassEffect(.regular, in: .capsule)
                }
                Text(camera.failure ?? (camera.phase == .ready && !camera.canStart ? "Waiting for the camera and LiDAR." : instruction))
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
                if let notice = camera.notice {
                    Label(notice, systemImage: "info.circle")
                        .font(.headline)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular.tint(.orange), in: .capsule)
                }
                Spacer()
                if camera.phase != .ready {
                    HStack {
                        if camera.phase == .saving { ProgressView() }
                        Text("\(camera.taken) depth frames recorded")
                        Spacer()
                        Text(ByteCountFormatter.string(fromByteCount: camera.bytesSaved, countStyle: .file))
                            .foregroundStyle(.secondary)
                    }
                    .font(.subheadline.monospacedDigit())
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
                }
                if camera.phase == .ready {
                    Button { camera.start() } label: { Label("Start", systemImage: "record.circle").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                        .controlSize(.extraLarge)
                        .disabled(!camera.canStart)
                } else if camera.phase == .paused {
                    if !camera.recordingLimitReached && !camera.legacyCapture && camera.failure == nil {
                        Button { camera.start() } label: { Label("Resume", systemImage: "record.circle").frame(maxWidth: .infinity) }
                            .buttonStyle(.glassProminent)
                            .controlSize(.extraLarge)
                            .disabled(!camera.canStart)
                    }
                    Button { Task { if await camera.finish() { done(true) } } } label: { Label("Save Capture", systemImage: "checkmark").frame(maxWidth: .infinity) }
                        .buttonStyle(.glass)
                        .controlSize(.large)
                        .disabled(camera.taken < HandheldCapture.minimumPhotos)
                } else if camera.phase == .capturing {
                    HStack {
                        Button { Task { await camera.pause() } } label: { Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity) }
                            .buttonStyle(.glass)
                        Button { Task { if await camera.finish() { done(true) } } } label: { Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity) }
                            .buttonStyle(.glassProminent)
                            .disabled(camera.taken < HandheldCapture.minimumPhotos)
                    }
                    .controlSize(.extraLarge)
                }
            }
            .padding(20)
        }
        .tint(cobalt)
        .task { if !preview { await camera.open() } }
        .onDisappear { camera.close() }
    }
}

/// The live camera image. The front camera's preview is mirrored like a mirror; the photos never are.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    let mirrored: Bool
    let stateChanged: (Bool, CGSize) -> Void

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        var stateChanged: ((Bool, CGSize) -> Void)?
        private var observation: NSKeyValueObservation?
        private var lastRendering: Bool?
        private var lastSize = CGSize.zero
        func observePreview() {
            observation = preview.observe(\.isPreviewing, options: [.initial, .new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.reportState() }
            }
        }
        override func layoutSubviews() { super.layoutSubviews(); reportState() }
        override func didMoveToWindow() { super.didMoveToWindow(); reportState() }
        private func reportState() {
            let rendering = window != nil && preview.isPreviewing
            let size = bounds.size
            guard rendering != lastRendering || size != lastSize else { return }
            lastRendering = rendering; lastSize = size
            DispatchQueue.main.async { [weak self] in self?.stateChanged?(rendering, size) }
        }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.stateChanged = stateChanged
        view.preview.session = session
        view.preview.videoGravity = .resizeAspectFill
        view.observePreview()
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        view.stateChanged = stateChanged
        guard let connection = view.preview.connection else { return }
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        connection.automaticallyAdjustsVideoMirroring = false
        if connection.isVideoMirroringSupported { connection.isVideoMirrored = mirrored }
    }
}
