import SwiftUI
import UIKit
import AVFoundation
import CoreImage
import ImageIO
import Vision

// "Hold it up and turn it" (KAN-210): the phone stays still and the object turns in the user's hand, so a scan
// needs no room to walk around a desk. The phone takes full-resolution photos with depth embedded (EXIF and the
// camera's calibration come along) about twice a second through three passes. The Mac cuts the object out of
// each photo and rebuilds it at full detail (tools/mac-reconstruct samples), then the touch-up runs as usual.
// The front TrueDepth camera is the default: the phone can be propped up and the user sees what it sees.

enum HandheldCapture {
    static let passes = ["Turn it slowly all the way round.", "Now turn it over.", "Once more on its side."]
    static let photosPerPass = 40          // about 20 seconds at two a second
    static let minimumPhotos = 24

    static var frontCamera: AVCaptureDevice? { AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front) }
    static var backCamera: AVCaptureDevice? { AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back) }
    static var isAvailable: Bool {
        #if targetEnvironment(simulator)
        return true   // so the screens can be checked in the Simulator, which has no camera to capture with
        #else
        return frontCamera != nil || backCamera != nil
        #endif
    }

    #if targetEnvironment(simulator)
    /// Simulator only: `-STMHandheldPreview ready|capturing` opens the capture screen at launch, for screenshots.
    @MainActor static func previewIfAsked() {
        guard let state = UserDefaults.standard.string(forKey: "STMHandheldPreview") else { return }
        UserDefaults.standard.removeObject(forKey: "STMHandheldPreview")
        Task { _ = await run(objectId: UUID().uuidString.lowercased(), preview: state == "capturing") }
    }
    #endif

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

// fileprivate keeps it (and its AVFoundation delegates) out of the app's generated Objective-C header.
@MainActor @Observable fileprivate final class HandheldCamera: NSObject {
    enum Phase: Equatable { case ready, countdown(Int), capturing, finished }
    var phase: Phase = .ready
    var pass = 0
    var taken = 0                       // photos kept in this capture
    var takenThisPass = 0
    var warning: String?
    var mask: CGImage?                  // the object as the phone sees it, for the live preview
    var front = true
    var failure: String?

    let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "handheld.camera")
    private let analysis = DispatchQueue(label: "handheld.analysis")
    private var device: AVCaptureDevice?
    private var timer: Timer?
    private var inFlight = false
    private var closed = false
    private var sharpness: [Double] = []
    private var blurry = false
    let folder: URL

    init(folder: URL) {
        self.folder = folder
        super.init()
    }

    var canSwitch: Bool { HandheldCapture.frontCamera != nil && HandheldCapture.backCamera != nil }

    func open() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            failure = "Counterpart needs the camera to scan. Turn it on in Settings."
            return
        }
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        configure(front: HandheldCapture.frontCamera != nil)
    }

    func configure(front: Bool) {
        guard let device = front ? HandheldCapture.frontCamera : HandheldCapture.backCamera else { return }
        self.front = front
        self.device = device
        let session = session, photoOutput = photoOutput, videoOutput = videoOutput
        queue.async { [weak self] in
            session.beginConfiguration()
            session.sessionPreset = .photo
            session.inputs.forEach(session.removeInput)
            if let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) { session.addInput(input) }
            if session.outputs.isEmpty {
                if session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }
                videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                videoOutput.alwaysDiscardsLateVideoFrames = true
                if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
            }
            photoOutput.isDepthDataDeliveryEnabled = photoOutput.isDepthDataDeliverySupported
            photoOutput.maxPhotoQualityPrioritization = .balanced
            if let largest = device.activeFormat.supportedMaxPhotoDimensions.max(by: { $0.width * $0.height < $1.width * $1.height }) {
                photoOutput.maxPhotoDimensions = largest
            }
            // Photos as the sensor sees them: never mirrored (a mirrored photo set rebuilds a mirror-image part),
            // and all in one orientation. Only the on-screen preview is mirrored for the front camera.
            if let connection = photoOutput.connection(with: .video) {
                connection.automaticallyAdjustsVideoMirroring = false
                if connection.isVideoMirroringSupported { connection.isVideoMirrored = false }
                if connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }
            }
            if let connection = videoOutput.connection(with: .video) {
                connection.automaticallyAdjustsVideoMirroring = false
                if connection.isVideoMirroringSupported { connection.isVideoMirrored = false }
                if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
            }
            session.commitConfiguration()
            videoOutput.setSampleBufferDelegate(self, queue: self?.analysis)
            if !session.isRunning { session.startRunning() }
        }
    }

    func start() {
        guard phase == .ready else { return }
        lock()
        countdown(then: .capturing)
    }

    func close() {
        closed = true
        timer?.invalidate()
        let session = session
        queue.async { session.stopRunning() }
    }

    /// Done: keeps what was taken when there is enough to build from.
    func finish() -> Bool {
        timer?.invalidate()
        phase = .finished
        guard taken >= HandheldCapture.minimumPhotos else { return false }
        FileManager.default.createFile(atPath: folder.appending(path: "finished").path, contents: Data())
        return true
    }

    /// Focus, exposure and white balance stay fixed once capture starts, so every photo of the object matches.
    private func lock() {
        guard let device, (try? device.lockForConfiguration()) != nil else { return }
        if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
        if device.isExposureModeSupported(.locked) { device.exposureMode = .locked }
        if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
        device.unlockForConfiguration()
    }

    private func countdown(then next: Phase, from seconds: Int = 3) {
        timer?.invalidate()
        phase = .countdown(seconds)
        Task { @MainActor in
            for remaining in stride(from: seconds, to: 0, by: -1) {
                phase = .countdown(remaining)
                try? await Task.sleep(for: .seconds(1))
                if phase == .finished || closed { return }
            }
            phase = next
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.shoot() }
            }
        }
    }

    private func shoot() {
        guard phase == .capturing, !inFlight else { return }
        if blurry { warning = "Turn it more slowly."; return }
        inFlight = true
        let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
        settings.isDepthDataDeliveryEnabled = photoOutput.isDepthDataDeliveryEnabled
        settings.embedsDepthDataInPhoto = true
        settings.isDepthDataFiltered = true
        settings.photoQualityPrioritization = .balanced
        settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
        photoOutput.capturePhoto(with: settings, delegate: self)
    }

    fileprivate func kept(_ data: Data, depthMetres: Float?, mirrored: Bool) {
        inFlight = false
        guard phase == .capturing else { return }
        guard !mirrored else { failure = "This camera sent a mirrored photo. Switch cameras and try again."; return }
        if let d = depthMetres {
            warning = d < 0.18 ? "Move it back a little." : d > 0.45 ? "Hold it closer to the phone." : nil
            if d < 0.12 || d > 0.7 { return }
        }
        let name = String(format: "%04d.heic", taken)
        guard (try? data.write(to: folder.appending(path: name))) != nil else { return }
        taken += 1
        takenThisPass += 1
        if takenThisPass >= HandheldCapture.photosPerPass {
            takenThisPass = 0
            if pass + 1 < HandheldCapture.passes.count {
                pass += 1
                countdown(then: .capturing, from: 4)
            } else {
                _ = finish()
            }
        }
    }

    fileprivate func missed() { inFlight = false }

    fileprivate func analysed(sharp: Double, mask: CGImage?) {
        sharpness.append(sharp)
        if sharpness.count > 30 { sharpness.removeFirst() }
        let typical = sharpness.sorted()[sharpness.count / 2]
        blurry = sharpness.count > 5 && sharp < typical * 0.45
        if !blurry && warning == "Turn it more slowly." { warning = nil }
        if let mask { self.mask = mask }
    }

}

extension HandheldCamera: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard error == nil, let data = photo.fileDataRepresentation() else { Task { @MainActor in self.missed() }; return }
        let orientation = (photo.metadata[kCGImagePropertyOrientation as String] as? Int) ?? 1
        let depth = photo.depthData.map(Self.centreDepth)
        Task { @MainActor in self.kept(data, depthMetres: depth ?? nil, mirrored: [2, 4, 5, 7].contains(orientation)) }
    }

    /// Median depth in the middle of the frame, where the object is held.
    nonisolated static func centreDepth(_ depthData: AVDepthData) -> Float? {
        let map = depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32).depthDataMap
        CVPixelBufferLockBaseAddress(map, .readOnly); defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map), row = CVPixelBufferGetBytesPerRow(map)
        guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        var values: [Float] = []
        for y in stride(from: h * 35 / 100, to: h * 65 / 100, by: 2) {
            for x in stride(from: w * 35 / 100, to: w * 65 / 100, by: 2) {
                let v = base.advanced(by: y * row + x * 4).assumingMemoryBound(to: Float.self).pointee
                if v.isFinite && v > 0.05 { values.append(v) }
            }
        }
        guard values.count > 10 else { return nil }
        // The near quarter: the object, not the face or wall behind it.
        return values.sorted()[values.count / 4]
    }
}

extension HandheldCamera: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer), analysisGate.enter() else { return }
        let sharp = Self.sharpness(pixels)
        nonisolated(unsafe) let frame = pixels
        Task.detached { [weak self] in
            let mask = await Self.objectMask(frame)
            await MainActor.run { self?.analysed(sharp: sharp, mask: mask) }
            analysisGate.leave()
        }
    }

    /// Variance of a Laplacian over the middle of a small grey copy: low when the object smears.
    nonisolated static func sharpness(_ pixels: CVPixelBuffer) -> Double {
        CVPixelBufferLockBaseAddress(pixels, .readOnly); defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels), row = CVPixelBufferGetBytesPerRow(pixels)
        guard let base = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        func grey(_ x: Int, _ y: Int) -> Double {
            let p = base + y * row + x * 4
            return 0.114 * Double(p[0]) + 0.587 * Double(p[1]) + 0.299 * Double(p[2])
        }
        var sum = 0.0, sumSquares = 0.0, n = 0.0
        for y in stride(from: h * 3 / 10, to: h * 7 / 10, by: 4) {
            for x in stride(from: w * 3 / 10, to: w * 7 / 10, by: 4) {
                let l = 4 * grey(x, y) - grey(x - 2, y) - grey(x + 2, y) - grey(x, y - 2) - grey(x, y + 2)
                sum += l; sumSquares += l * l; n += 1
            }
        }
        guard n > 0 else { return 0 }
        return sumSquares / n - (sum / n) * (sum / n)
    }

    /// The object held in the middle of the frame, cut out on the Neural Engine (Vision, iOS 27).
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
    @State private var camera: HandheldCamera

    fileprivate init(folder: URL, preview: Bool = false, done: @escaping (Bool) -> Void) {
        self.folder = folder
        self.done = done
        let camera = HandheldCamera(folder: folder)
        if preview { camera.phase = .capturing; camera.pass = 1; camera.taken = 52; camera.warning = "Hold it closer to the phone." }
        _camera = State(initialValue: camera)
    }

    private var instruction: String {
        switch camera.phase {
        case .ready: return "Prop the phone up. Hold the object in the circle, about 30 cm away."
        case .countdown, .capturing: return HandheldCapture.passes[camera.pass]
        case .finished: return "Done."
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: camera.session, mirrored: camera.front).ignoresSafeArea()
            if let mask = camera.mask {
                Image(decorative: mask, scale: 1)
                    .resizable()
                    .scaleEffect(x: camera.front ? -1 : 1, y: 1)
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
                    if camera.canSwitch && camera.phase == .ready {
                        Button("Switch Camera", systemImage: "arrow.triangle.2.circlepath.camera") { camera.configure(front: !camera.front) }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glass)
                            .controlSize(.large)
                    }
                }
                Text(camera.failure ?? instruction)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
                if let warning = camera.warning, camera.phase == .capturing {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .glassEffect(.regular.tint(.orange), in: .capsule)
                }
                Spacer()
                if camera.phase != .ready {
                    ProgressView(value: Double(camera.taken), total: Double(HandheldCapture.photosPerPass * HandheldCapture.passes.count)) {
                        Text("Turn \(camera.pass + 1) of \(HandheldCapture.passes.count)")
                    }
                    .tint(cobalt)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 22))
                }
                if camera.phase == .ready {
                    Button { camera.start() } label: { Label("Start", systemImage: "record.circle").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                        .controlSize(.extraLarge)
                        .disabled(camera.failure != nil)
                } else {
                    Button { done(camera.finish()) } label: { Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                        .controlSize(.extraLarge)
                        .disabled(camera.taken < HandheldCapture.minimumPhotos)
                }
            }
            .padding(20)
        }
        .tint(cobalt)
        .task { await camera.open() }
        .onChange(of: camera.phase) { _, phase in
            if phase == .finished && camera.taken >= HandheldCapture.photosPerPass * HandheldCapture.passes.count { camera.close(); done(true) }
        }
        .onDisappear { camera.close() }
    }
}

/// The live camera image. The front camera's preview is mirrored like a mirror; the photos never are.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    let mirrored: Bool

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.preview.session = session
        view.preview.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        guard let connection = view.preview.connection else { return }
        if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        connection.automaticallyAdjustsVideoMirroring = false
        if connection.isVideoMirroringSupported { connection.isVideoMirrored = mirrored }
    }
}
