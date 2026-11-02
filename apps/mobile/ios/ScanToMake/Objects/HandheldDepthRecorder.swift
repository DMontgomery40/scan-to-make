import Foundation
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import simd

/// Save cadence uses the sensor clock, not timer or encoder completion time.
struct HandheldFrameAdmission {
    let targetFPS: Double
    private(set) var lastAccepted: Double?
    mutating func admit(timestamp: Double, writerBusy: Bool) -> Bool {
        guard timestamp.isFinite, !writerBusy, targetFPS > 0 else { return false }
        if let previous = lastAccepted, timestamp - previous < 1 / targetFPS - 0.000_001 { return false }
        lastAccepted = timestamp
        return true
    }
}

/// Preserve the sensor-produced depth dictionary, including calibration and invalid pixels.
/// Never use replacingDepthDataMap here: AVFoundation documents that it discards calibration.
enum HandheldDepthFrameCodec {
    static func encode(image: CGImage, depth: AVDepthData, properties: [CFString: Any]) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.heic.identifier as CFString, 1, nil) else {
            throw RecorderError("The RGB-D image encoder is unavailable.")
        }
        var type: NSString?
        let metricDepth = depth.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        guard let auxiliary = metricDepth.dictionaryRepresentation(forAuxiliaryDataType: &type), let type else {
            throw RecorderError("The camera depth could not be saved.")
        }
        var properties = properties
        properties[kCGImagePropertyOrientation] = 1
        properties[kCGImageDestinationLossyCompressionQuality] = 1.0
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        CGImageDestinationAddAuxiliaryDataInfo(destination, type as CFString, auxiliary as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw RecorderError("The RGB-D image could not be encoded.") }
        return data as Data
    }

    /// Lossless companion to the HEIC: ImageIO quantizes HEIC auxiliary depth even at quality 1.
    /// The payload and calibration XMP come from AVFoundation, not generated camera parameters.
    static func exactDepthRepresentation(_ depth: AVDepthData, rgbTimestamp: Double, depthTimestamp: Double,
                                         rgbWidth: Int, rgbHeight: Int, rgbIntrinsics: [Float]? = nil,
                                         rgbGeometry: [String: Any]? = nil) throws -> Data {
        let metric = depth.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        var type: NSString?
        guard let info = metric.dictionaryRepresentation(forAuxiliaryDataType: &type), let type,
              let bytes = info[kCGImageAuxiliaryDataInfoData] as? Data,
              let description = info[kCGImageAuxiliaryDataInfoDataDescription] as? [AnyHashable: Any],
              let metadataValue = info[kCGImageAuxiliaryDataInfoMetadata] else {
            throw RecorderError("The original depth and calibration could not be serialized.")
        }
        let metadata = metadataValue as! CGImageMetadata
        guard let xmp = CGImageMetadataCreateXMPData(metadata, nil) else {
            throw RecorderError("The original depth calibration could not be serialized.")
        }
        var payload: [String: Any] = [
            "schemaVersion": 1, "auxiliaryDataType": type as String,
            "rgbTimestamp": rgbTimestamp, "depthTimestamp": depthTimestamp,
            "rgbWidth": rgbWidth, "rgbHeight": rgbHeight,
            "depthUnit": "metres", "invalidDepth": "nonfinite", "byteOrder": "little-endian",
            "data": bytes, "description": description, "metadataXMP": xmp as Data
        ]
        if let rgbIntrinsics { payload["rgbIntrinsicsColumnMajor"] = rgbIntrinsics }
        payload["rgbIntrinsicsStatus"] = rgbIntrinsics == nil ? "unavailable" : "sample-buffer-attachment"
        if let rgbGeometry { payload["rgbGeometry"] = rgbGeometry }
        return try PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0)
    }

    /// Also usable by the Mac reader. Read the checked AVFoundation dictionary rather than
    /// fabricating a PhotogrammetrySample camera or substituting a world/object pose.
    static func restoreExactDepth(from data: Data) throws -> AVDepthData {
        guard let payload = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              payload["schemaVersion"] as? Int == 1,
              payload["auxiliaryDataType"] as? String == kCGImageAuxiliaryDataTypeDepth as String,
              payload["depthUnit"] as? String == "metres", payload["byteOrder"] as? String == "little-endian",
              let bytes = payload["data"] as? Data, let description = payload["description"] as? [AnyHashable: Any],
              let xmp = payload["metadataXMP"] as? Data, let metadata = CGImageMetadataCreateFromXMPData(xmp as CFData) else {
            throw RecorderError("The retained depth sidecar is invalid.")
        }
        let info: [AnyHashable: Any] = [kCGImageAuxiliaryDataInfoData: bytes,
                                       kCGImageAuxiliaryDataInfoDataDescription: description,
                                       kCGImageAuxiliaryDataInfoMetadata: metadata]
        let depth = try AVDepthData(fromDictionaryRepresentation: info)
        guard depth.depthDataType == kCVPixelFormatType_DepthFloat32 else {
            throw RecorderError("The retained depth is not metric Float32 data.")
        }
        return depth
    }

    struct LegacyCapture: LocalizedError {
        var errorDescription: String? { "This retained photo capture uses the earlier capture format. Save it before starting a new capture." }
    }
    struct RecoveredCapture: Sendable {
        let framesSaved: Int
        let bytes: Int64
    }
    /// Validate before adopting existing files. Orphan sidecars were never committed image pairs;
    /// preserve them under a unique recovery folder rather than overwriting or deleting their data.
    static func recover(in folder: URL) throws -> RecoveredCapture {
        let fm = FileManager.default
        guard fm.fileExists(atPath: folder.path) else { return RecoveredCapture(framesSaved: 0, bytes: 0) }
        let files = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])
        let images = files.filter { ["heic", "heif"].contains($0.pathExtension.lowercased()) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        let sidecars = files.filter { $0.lastPathComponent.hasSuffix(".depth.plist") }
        if !images.isEmpty && sidecars.isEmpty && !fm.fileExists(atPath: folder.appendingPathComponent("capture-frames.jsonl").path) { throw LegacyCapture() }
        for (index, image) in images.enumerated() {
            let expected = String(format: "%04d.heic", index)
            guard image.lastPathComponent == expected else { throw RecorderError("The retained RGB-D frames are not a contiguous capture.") }
            let depthURL = folder.appendingPathComponent(String(format: "%04d.depth.plist", index))
            guard fm.fileExists(atPath: depthURL.path), let source = CGImageSourceCreateWithURL(image as CFURL, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int else {
                throw RecorderError("A retained RGB-D frame is incomplete. Its saved files have been preserved.")
            }
            let data = try Data(contentsOf: depthURL)
            let depth = try restoreExactDepth(from: data)
            guard let payload = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
                  payload["rgbWidth"] as? Int == width, payload["rgbHeight"] as? Int == height,
                  let rgbPTS = payload["rgbTimestamp"] as? Double, rgbPTS.isFinite,
                  let depthPTS = payload["depthTimestamp"] as? Double, depthPTS.isFinite,
                  depth.cameraCalibrationData != nil, CVPixelBufferGetWidth(depth.depthDataMap) > 0,
                  CVPixelBufferGetHeight(depth.depthDataMap) > 0,
                  (properties[kCGImagePropertyOrientation as String] as? Int ?? 1) == 1 else {
                throw RecorderError("A retained RGB-D frame has inconsistent image or calibration metadata.")
            }
        }
        let committedNames = Set(images.map { $0.deletingPathExtension().lastPathComponent + ".depth.plist" })
        let orphans = sidecars.filter { !committedNames.contains($0.lastPathComponent) }
        if !orphans.isEmpty {
            let preserved = folder.appendingPathComponent("interrupted-pairs").appendingPathComponent(UUID().uuidString)
            try fm.createDirectory(at: preserved, withIntermediateDirectories: true)
            for orphan in orphans { try fm.moveItem(at: orphan, to: preserved.appendingPathComponent(orphan.lastPathComponent)) }
        }
        // Preserved interrupted payloads still consume the local storage budget.
        var bytes: Int64 = 0
        if let all = fm.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) {
            for case let url as URL in all {
                let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                if values.isRegularFile == true { bytes += Int64(values.fileSize ?? 0) }
            }
        }
        return RecoveredCapture(framesSaved: images.count, bytes: bytes)
    }

    struct StorageLimit: LocalizedError {
        var errorDescription: String? { "The recording reached its storage limit." }
    }

    /// The final HEIC commits a pair. No caller can observe a final image before its depth exists.
    /// Called by the single writer; host tests exercise budget, collision, and rollback behaviour.
    static func commit(image: Data, exactDepth: Data, metadata: Data, folder: URL,
                       index: Int, remainingBytes: Int64) throws -> Int64 {
        let byteCount = Int64(image.count + exactDepth.count + metadata.count)
        guard byteCount <= remainingBytes else { throw StorageLimit() }
        guard (0..<10000).contains(index) else { throw RecorderError("The capture frame index is invalid.") }
        let url = folder.appendingPathComponent(String(format: "%04d.heic", index))
        let depthURL = folder.appendingPathComponent(String(format: "%04d.depth.plist", index))
        guard !FileManager.default.fileExists(atPath: url.path), !FileManager.default.fileExists(atPath: depthURL.path) else {
            throw RecorderError("A saved capture frame would be overwritten.")
        }
        let temporaryStem = "." + UUID().uuidString
        let temporaryImage = folder.appendingPathComponent(temporaryStem + ".heic.partial")
        let temporaryDepth = folder.appendingPathComponent(temporaryStem + ".depth.partial")
        defer {
            try? FileManager.default.removeItem(at: temporaryImage)
            try? FileManager.default.removeItem(at: temporaryDepth)
        }
        try image.write(to: temporaryImage, options: .withoutOverwriting)
        try exactDepth.write(to: temporaryDepth, options: .withoutOverwriting)
        var committedDepth = false, committedImage = false
        do {
            try FileManager.default.moveItem(at: temporaryDepth, to: depthURL); committedDepth = true
            try FileManager.default.moveItem(at: temporaryImage, to: url); committedImage = true
            let logURL = folder.appendingPathComponent("capture-frames.jsonl")
            if !FileManager.default.fileExists(atPath: logURL.path) { try Data().write(to: logURL, options: .withoutOverwriting) }
            let log = try FileHandle(forWritingTo: logURL)
            defer { try? log.close() }
            let previousSize = try log.seekToEnd()
            do { try log.write(contentsOf: metadata) }
            catch { try? log.truncate(atOffset: previousSize); throw error }
        } catch {
            if committedImage { try? FileManager.default.removeItem(at: url) }
            if committedDepth { try? FileManager.default.removeItem(at: depthURL) }
            throw error
        }
        return byteCount
    }

    struct RecorderError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}

#if os(iOS)
/// The session owner installs this while its configuration is open. All recording state then belongs
/// to eventQueue. Exactly one synchronized pair may be retained for the writer; there is no work backlog.
final class HandheldDepthRecorder: NSObject, AVCaptureDataOutputSynchronizerDelegate, @unchecked Sendable {
    struct Configuration: Sendable {
        // Initial local storage/processing budgets, not reconstruction coverage or device guarantees.
        var targetFPS: Double = 10
        var maximumFrames: Int = 1200
        var maximumBytes: Int64 = 1_073_741_824
        var preferredMaximumVideoWidth: Int32 = 1920
    }
    struct RuntimeConfiguration: Codable, Sendable {
        let videoWidth: Int32, videoHeight: Int32, depthWidth: Int32, depthHeight: Int32
        let videoFPS: Double, depthMaximumFPS: Double, targetSavedFPS: Double
        let maximumFrames: Int, maximumBytes: Int64
        let depthFiltering: Bool
    }
    struct SavedFrame: Sendable {
        let index: Int, framesSaved: Int
        let url: URL
        let rgbTimestamp: Double, depthTimestamp: Double
        let byteCount: Int64
        let dataDepthPresent = true
    }
    struct Summary: Codable, Sendable {
        let framesSaved: Int
        let bytes: Int64
        let firstPTS: Double?, lastPTS: Double?, effectiveSavedFPS: Double?
        let drops: [String: Int]
        let runtimeConfiguration: RuntimeConfiguration?
        let failure: String?
        let limitReached: Bool
    }
    struct DiagnosticSnapshot: Codable, Sendable {
        struct Format: Codable, Sendable {
            let fourCC: String
            let width: Int32, height: Int32
            let binned: Bool
            let unsupportedOutputs: [String]
        }
        struct Connection: Codable, Sendable {
            let present: Bool, enabled: Bool, active: Bool
        }
        let summary: Summary
        let synchronizedCallbacks: Int
        let events: [String: Int]
        let secondsSinceVideo: Double?, secondsSinceDepth: Double?
        let lastRGBTimestamp: Double?, lastDepthTimestamp: Double?
        let recording: Bool, writerBusy: Bool
        let sessionRunning: Bool, sessionInterrupted: Bool
        let videoFormat: Format, depthFormat: Format?
        let availableVideoPixelFormats: [String]
        let requestedVideoPixelFormat: String?
        let videoConnection: Connection, depthConnection: Connection
    }
    enum Drop: String, Codable, Sendable {
        case videoDropped, depthDropped, missingDepth, invalidTimestamp, missingCalibration
        case backpressure, cadence, storageLimit
    }
    struct Callbacks: Sendable {
        let onVideo: @Sendable (CMSampleBuffer) -> Void
        let onDepthReady: @Sendable () -> Void
        let onSaved: @Sendable (SavedFrame) -> Void
        let onDrop: @Sendable (Drop) -> Void
        let onFailure: @Sendable (String) -> Void
        let onLimitReached: @Sendable (String) -> Void
        init(onVideo: @escaping @Sendable (CMSampleBuffer) -> Void,
             onSaved: @escaping @Sendable (SavedFrame) -> Void,
             onDepthReady: @escaping @Sendable () -> Void = {},
             onDrop: @escaping @Sendable (Drop) -> Void = { _ in },
             onFailure: @escaping @Sendable (String) -> Void,
             onLimitReached: @escaping @Sendable (String) -> Void) {
            self.onVideo = onVideo; self.onSaved = onSaved; self.onDepthReady = onDepthReady; self.onDrop = onDrop
            self.onFailure = onFailure; self.onLimitReached = onLimitReached
        }
    }
    private struct FrameRecord: Codable {
        let index: Int, filename: String, depthFilename: String
        let rgbTimestamp: Double, depthTimestamp: Double
        let rgbWidth: Int, rgbHeight: Int, depthWidth: Int, depthHeight: Int
        let exposureSeconds: Double?, iso: Double?
        let rgbIntrinsicsColumnMajor: [Float]?
        // Device observations are labelled separately: they are not guaranteed per-frame EXIF.
        let observedDeviceExposureSeconds: Double, observedDeviceISO: Double
        let depthFiltered: Bool, depthAccuracy: Int, depthQuality: Int
        let bytes: Int64
    }
    private struct Pair: @unchecked Sendable {
        let video: CMSampleBuffer
        let depth: AVDepthData
        let rgbPTS: Double, depthPTS: Double
        let observedExposure: Double, observedISO: Double
        let observedGDCSupported: Bool, observedGDCEnabled: Bool
        let observedZoomFactor: Double
    }
    private let device: AVCaptureDevice
    private let videoOutput: AVCaptureVideoDataOutput
    private let depthOutput = AVCaptureDepthDataOutput()
    private var synchronizer: AVCaptureDataOutputSynchronizer?
    private weak var captureSession: AVCaptureSession?
    private let folder: URL
    private let callbacks: Callbacks
    private let configuration: Configuration
    private let eventQueue = DispatchQueue(label: "handheld.rgbd.events")
    private let writerQueue = DispatchQueue(label: "handheld.rgbd.writer", qos: .utility)
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private var runtime: RuntimeConfiguration?
    private var admission: HandheldFrameAdmission
    private var recording = false, started = false, writerBusy = false
    private var framesSaved = 0
    private var segmentFrames = 0
    private var bytes: Int64 = 0
    private var firstPTS: Double?, lastPTS: Double?
    private var drops: [String: Int] = [:]
    private var failure: String?
    private var limitReached = false
    private var drains: [CheckedContinuation<Summary, Never>] = []
    private var synchronizedCallbacks = 0
    private var diagnosticEvents: [String: Int] = [:]
    private var lastVideoAt: TimeInterval?, lastDepthAt: TimeInterval?
    private var lastRGBTimestamp: Double?, lastDepthTimestamp: Double?

    init(device: AVCaptureDevice, videoOutput: AVCaptureVideoDataOutput, folder: URL,
         callbacks: Callbacks, configuration: Configuration = .init()) {
        self.device = device; self.videoOutput = videoOutput; self.folder = folder
        self.callbacks = callbacks; self.configuration = configuration
        self.admission = HandheldFrameAdmission(targetFPS: configuration.targetFPS)
        super.init()
    }

    /// Call only on the owner's session queue, between beginConfiguration and commitConfiguration.
    func install(in session: AVCaptureSession) throws {
        captureSession = session
        guard device.position == .back, device.deviceType == .builtInLiDARDepthCamera else {
            throw HandheldDepthFrameCodec.RecorderError("Photo capture needs the rear LiDAR camera.")
        }
        guard configuration.targetFPS > 0, configuration.maximumFrames > 0,
              configuration.maximumFrames <= 10000, configuration.maximumBytes > 0 else {
            throw HandheldDepthFrameCodec.RecorderError("Invalid RGB-D recording configuration.")
        }
        // Formats only, as Apple's LiDAR depth sample does ("Capturing depth using the LiDAR camera"): never a
        // frame duration. Writing activeVideoMin/MaxFrameDuration or activeDepthDataMinFrameDuration on the LiDAR
        // camera reprograms its sync generator ("SetExternalSyncFrameRateRational … 0/1") and leaves every app's
        // camera black until a reboot (KAN-217 P0, Davica3 syslog 2026-11-01).
        guard let choice = Self.formats(device.formats, maximumWidth: configuration.preferredMaximumVideoWidth) else {
            throw HandheldDepthFrameCodec.RecorderError("No compatible rear LiDAR video and depth format is available.")
        }
        try device.lockForConfiguration()
        device.activeFormat = choice.video
        device.activeDepthDataFormat = choice.depth
        device.unlockForConfiguration()
        if !session.outputs.contains(where: { $0 === videoOutput }) {
            guard session.canAddOutput(videoOutput) else { throw HandheldDepthFrameCodec.RecorderError("The camera cannot supply RGB frames.") }
            session.addOutput(videoOutput)
        }
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        if !session.outputs.contains(where: { $0 === depthOutput }) {
            guard session.canAddOutput(depthOutput) else { throw HandheldDepthFrameCodec.RecorderError("The camera cannot supply synchronized depth.") }
            session.addOutput(depthOutput)
        }
        depthOutput.isFilteringEnabled = false
        depthOutput.alwaysDiscardsLateDepthData = true
        for connection in [videoOutput.connection(with: .video), depthOutput.connection(with: .depthData)].compactMap({ $0 }) {
            connection.automaticallyAdjustsVideoMirroring = false
            if connection.isVideoMirroringSupported { connection.isVideoMirrored = false }
            #if compiler(>=5.9)
            if #available(iOS 17.0, *), connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }
            else if connection.isVideoOrientationSupported { connection.videoOrientation = .landscapeRight }
            #else
            if connection.isVideoOrientationSupported { connection.videoOrientation = .landscapeRight }
            #endif
            if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
        }
        if let connection = videoOutput.connection(with: .video), connection.isCameraIntrinsicMatrixDeliverySupported {
            connection.isCameraIntrinsicMatrixDeliveryEnabled = true
        }
        let sync = AVCaptureDataOutputSynchronizer(dataOutputs: [depthOutput, videoOutput])
        synchronizer = sync
        sync.setDelegate(self, queue: eventQueue)
        // The rates the device runs at by default, read and never set.
        let videoFPS = Self.rate(device.activeVideoMinFrameDuration) ?? 30
        let depthFPS = choice.depth.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? videoFPS
        runtime = RuntimeConfiguration(videoWidth: choice.width, videoHeight: choice.height,
                                       depthWidth: choice.depthWidth, depthHeight: choice.depthHeight,
                                       videoFPS: videoFPS, depthMaximumFPS: depthFPS, targetSavedFPS: configuration.targetFPS,
                                       maximumFrames: configuration.maximumFrames, maximumBytes: configuration.maximumBytes,
                                       depthFiltering: false)
    }

    struct FormatChoice {
        let video: AVCaptureDevice.Format, depth: AVCaptureDevice.Format
        let width: Int32, height: Int32, depthWidth: Int32, depthHeight: Int32
    }

    /// The video format with depth, as large as allowed (not binned), and its largest Float16/Float32 depth format.
    /// Chosen by size alone: frame rates stay the device's defaults.
    static func formats(_ formats: [AVCaptureDevice.Format], maximumWidth: Int32) -> FormatChoice? {
        let depthTypes: Set<FourCharCode> = [kCVPixelFormatType_DepthFloat16, kCVPixelFormatType_DepthFloat32]
        let choices: [FormatChoice] = formats.compactMap { format in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let depths = format.supportedDepthDataFormats.filter { depthTypes.contains(CMFormatDescriptionGetMediaSubType($0.formatDescription)) }
            guard let depth = depths.max(by: { area($0) < area($1) }) else { return nil }
            let depthSize = CMVideoFormatDescriptionGetDimensions(depth.formatDescription)
            return FormatChoice(video: format, depth: depth, width: size.width, height: size.height, depthWidth: depthSize.width, depthHeight: depthSize.height)
        }
        let unbinned = choices.filter { !$0.video.isVideoBinned }
        let pool = unbinned.isEmpty ? choices : unbinned
        let bounded = pool.filter { $0.width <= maximumWidth }
        if bounded.isEmpty { return pool.min { $0.width * $0.height < $1.width * $1.height } }
        return bounded.max { a, b in
            a.width * a.height != b.width * b.height ? a.width * a.height < b.width * b.height
                : a.depthWidth * a.depthHeight < b.depthWidth * b.depthHeight
        }
    }
    private static func area(_ format: AVCaptureDevice.Format) -> Int32 {
        let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        return size.width * size.height
    }
    private static func rate(_ duration: CMTime) -> Double? {
        let seconds = CMTimeGetSeconds(duration)
        return seconds.isFinite && seconds > 0 ? 1 / seconds : nil
    }

    /// Explicit recovery precedes the user's Resume/Save decision; it never opens the camera.
    func recover() async throws -> Summary {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Summary, Error>) in
            eventQueue.async {
                guard !self.recording, !self.writerBusy else {
                    continuation.resume(throwing: HandheldDepthFrameCodec.RecorderError("Stop recording before recovering saved frames.")); return
                }
                self.writerBusy = true
                self.writerQueue.async {
                    let result = Result { try HandheldDepthFrameCodec.recover(in: self.folder) }
                    self.eventQueue.async {
                        self.writerBusy = false
                        switch result {
                        case .success(let recovered):
                            self.framesSaved = recovered.framesSaved; self.bytes = recovered.bytes
                            self.started = true; self.failure = nil
                            self.firstPTS = nil; self.lastPTS = nil; self.segmentFrames = 0
                            self.admission = HandheldFrameAdmission(targetFPS: self.configuration.targetFPS)
                            self.limitReached = self.framesSaved >= self.configuration.maximumFrames || self.bytes >= self.configuration.maximumBytes
                            continuation.resume(returning: self.summary())
                        case .failure(let error): continuation.resume(throwing: error)
                        }
                        self.finishDrainsIfIdle()
                    }
                }
            }
        }
    }

    /// Starts a new folder or resumes this recorder after a drain. Recovery is explicit above.
    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            eventQueue.async {
                do {
                    guard self.runtime != nil, !self.recording, !self.writerBusy, self.failure == nil, !self.limitReached else {
                        throw HandheldDepthFrameCodec.RecorderError("The RGB-D recorder is not ready to start.")
                    }
                    if !self.started {
                        try FileManager.default.createDirectory(at: self.folder, withIntermediateDirectories: true)
                        let files = try FileManager.default.contentsOfDirectory(at: self.folder, includingPropertiesForKeys: nil)
                        guard !files.contains(where: { ["heic", "heif"].contains($0.pathExtension.lowercased()) || $0.lastPathComponent.hasSuffix(".depth.plist") || $0.lastPathComponent == "capture-frames.jsonl" }) else {
                            throw HandheldDepthFrameCodec.RecorderError("This capture already contains saved photos.")
                        }
                        self.started = true
                    }
                    try FileManager.default.createDirectory(at: self.folder, withIntermediateDirectories: true)
                    self.admission = HandheldFrameAdmission(targetFPS: self.configuration.targetFPS)
                    self.firstPTS = nil; self.lastPTS = nil; self.segmentFrames = 0
                    self.recording = true
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// Closes admission before awaiting the sole in-flight write. Safe to call more than once.
    func stop() async -> Summary {
        await withCheckedContinuation { continuation in
            eventQueue.async {
                self.recording = false
                self.drains.append(continuation)
                self.finishDrainsIfIdle()
            }
        }
    }

    /// Observe the stream without changing admission or waiting for the writer to drain.
    func diagnosticSnapshot() async -> DiagnosticSnapshot {
        await withCheckedContinuation { continuation in
            eventQueue.async {
                let now = ProcessInfo.processInfo.systemUptime
                func fourCC(_ value: OSType) -> String {
                    let bytes = stride(from: 24, through: 0, by: -8).map { UInt8((value >> $0) & 0xff) }
                    return String(bytes: bytes, encoding: .ascii) ?? String(format: "0x%08x", value)
                }
                func format(_ value: AVCaptureDevice.Format) -> DiagnosticSnapshot.Format {
                    let size = CMVideoFormatDescriptionGetDimensions(value.formatDescription)
                    return .init(fourCC: fourCC(CMFormatDescriptionGetMediaSubType(value.formatDescription)),
                                 width: size.width, height: size.height, binned: value.isVideoBinned,
                                 unsupportedOutputs: value.unsupportedCaptureOutputClasses.map { NSStringFromClass($0) })
                }
                func connection(_ value: AVCaptureConnection?) -> DiagnosticSnapshot.Connection {
                    .init(present: value != nil, enabled: value?.isEnabled ?? false, active: value?.isActive ?? false)
                }
                let requested = (self.videoOutput.videoSettings?[kCVPixelBufferPixelFormatTypeKey as String] as? NSNumber)?.uint32Value
                continuation.resume(returning: DiagnosticSnapshot(
                    summary: self.summary(), synchronizedCallbacks: self.synchronizedCallbacks, events: self.diagnosticEvents,
                    secondsSinceVideo: self.lastVideoAt.map { now - $0 }, secondsSinceDepth: self.lastDepthAt.map { now - $0 },
                    lastRGBTimestamp: self.lastRGBTimestamp, lastDepthTimestamp: self.lastDepthTimestamp,
                    recording: self.recording, writerBusy: self.writerBusy,
                    sessionRunning: self.captureSession?.isRunning ?? false, sessionInterrupted: self.captureSession?.isInterrupted ?? false,
                    videoFormat: format(self.device.activeFormat), depthFormat: self.device.activeDepthDataFormat.map(format),
                    availableVideoPixelFormats: self.videoOutput.availableVideoPixelFormatTypes.map(fourCC),
                    requestedVideoPixelFormat: requested.map(fourCC),
                    videoConnection: connection(self.videoOutput.connection(with: .video)),
                    depthConnection: connection(self.depthOutput.connection(with: .depthData))))
            }
        }
    }

    func dataOutputSynchronizer(_ synchronizer: AVCaptureDataOutputSynchronizer,
                                didOutput collection: AVCaptureSynchronizedDataCollection) {
        synchronizedCallbacks += 1
        func observed(_ reason: String) { diagnosticEvents[reason, default: 0] += 1 }
        guard let video = collection.synchronizedData(for: videoOutput) as? AVCaptureSynchronizedSampleBufferData else { observed("missingVideo"); return }
        guard !video.sampleBufferWasDropped else { observed("videoDropped:\(video.droppedReason.rawValue)"); if recording { dropped(.videoDropped, sensorReason: video.droppedReason.rawValue) }; return }
        observed("videoReceived")
        lastVideoAt = ProcessInfo.processInfo.systemUptime
        if CMSampleBufferGetImageBuffer(video.sampleBuffer) == nil { observed("videoWithoutImageBuffer") }
        callbacks.onVideo(video.sampleBuffer) // Preview/readiness continue before Start and after Stop.
        guard let depth = collection.synchronizedData(for: depthOutput) as? AVCaptureSynchronizedDepthData else { observed("missingDepth"); if recording { dropped(.missingDepth) }; return }
        guard !depth.depthDataWasDropped else { observed("depthDropped:\(depth.droppedReason.rawValue)"); if recording { dropped(.depthDropped, sensorReason: depth.droppedReason.rawValue) }; return }
        observed("depthReceived")
        guard depth.depthData.cameraCalibrationData != nil else { observed("missingCalibration"); if recording { dropped(.missingCalibration) }; return }
        let rgbPTS = CMTimeGetSeconds(video.timestamp), depthPTS = CMTimeGetSeconds(depth.timestamp)
        guard rgbPTS.isFinite, depthPTS.isFinite else { observed("invalidTimestamp"); if recording { dropped(.invalidTimestamp) }; return }
        observed("calibratedPair")
        lastDepthAt = ProcessInfo.processInfo.systemUptime; lastRGBTimestamp = rgbPTS; lastDepthTimestamp = depthPTS
        callbacks.onDepthReady()
        guard recording else { return }
        guard !writerBusy else { dropped(.backpressure); return }
        guard admission.admit(timestamp: rgbPTS, writerBusy: false) else { dropped(.cadence); return }
        writerBusy = true
        let pair = Pair(video: video.sampleBuffer, depth: depth.depthData, rgbPTS: rgbPTS, depthPTS: depthPTS,
                        observedExposure: CMTimeGetSeconds(device.exposureDuration), observedISO: Double(device.iso),
                        observedGDCSupported: device.isGeometricDistortionCorrectionSupported,
                        observedGDCEnabled: device.isGeometricDistortionCorrectionEnabled,
                        observedZoomFactor: Double(device.videoZoomFactor))
        let index = framesSaved, remainingBytes = configuration.maximumBytes - bytes
        writerQueue.async {
            let result: Result<(SavedFrame, FrameRecord), Error> = Result {
                try autoreleasepool { try self.write(pair, index: index, remainingBytes: remainingBytes) }
            }
            self.eventQueue.async {
                self.writerBusy = false
                switch result {
                case .success(let (frame, _)):
                    self.framesSaved += 1; self.segmentFrames += 1; self.bytes += frame.byteCount
                    if self.firstPTS == nil { self.firstPTS = frame.rgbTimestamp }
                    self.lastPTS = frame.rgbTimestamp
                    self.callbacks.onSaved(frame)
                    if self.framesSaved >= self.configuration.maximumFrames { self.reachedLimit("The recording reached its frame storage limit.") }
                case .failure(let error):
                    if let error = error as? HandheldDepthFrameCodec.StorageLimit {
                        self.dropped(.storageLimit); self.reachedLimit(error.localizedDescription)
                    } else {
                        self.failure = error.localizedDescription; self.recording = false
                        self.callbacks.onFailure(error.localizedDescription)
                    }
                }
                self.finishDrainsIfIdle()
            }
        }
    }

    private func write(_ pair: Pair, index: Int, remainingBytes: Int64) throws -> (SavedFrame, FrameRecord) {
        guard let rgb = CMSampleBufferGetImageBuffer(pair.video),
              let image = imageContext.createCGImage(CIImage(cvPixelBuffer: rgb), from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(rgb), height: CVPixelBufferGetHeight(rgb))) else {
            throw HandheldDepthFrameCodec.RecorderError("The camera colour frame could not be saved.")
        }
        let attachments = CMCopyDictionaryOfAttachments(allocator: kCFAllocatorDefault, target: pair.video,
                                                        attachmentMode: kCMAttachmentMode_ShouldPropagate) as? [String: Any] ?? [:]
        var properties: [CFString: Any] = [:]
        if let exif = attachments[kCGImagePropertyExifDictionary as String] { properties[kCGImagePropertyExifDictionary] = exif }
        let data = try HandheldDepthFrameCodec.encode(image: image, depth: pair.depth, properties: properties)
        let name = String(format: "%04d.heic", index), url = folder.appendingPathComponent(name)
        let depthName = String(format: "%04d.depth.plist", index)
        // Calibration is a sample-buffer attachment; its propagation mode must not decide
        // whether the original per-frame camera matrix survives into the saved capture.
        let intrinsicData = CMGetAttachment(pair.video, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
                                            attachmentModeOut: nil) as? Data
        var intrinsics: [Float]?
        if let intrinsicData, intrinsicData.count == MemoryLayout<simd_float3x3>.size {
            var matrix = matrix_identity_float3x3
            _ = withUnsafeMutableBytes(of: &matrix) { intrinsicData.copyBytes(to: $0) }
            intrinsics = [matrix.columns.0.x, matrix.columns.0.y, matrix.columns.0.z,
                          matrix.columns.1.x, matrix.columns.1.y, matrix.columns.1.z,
                          matrix.columns.2.x, matrix.columns.2.y, matrix.columns.2.z]
        }
        // The saved image uses the whole pixel buffer. The clean aperture describes its valid
        // display region; it is not an instruction to crop again or to rescale a still-photo K.
        var geometry: [String: Any] = [
            "storedRegion": "full-pixel-buffer", "cleanApertureOrigin": "top-left",
            "observedDeviceGeometricDistortionCorrectionSupported": pair.observedGDCSupported,
            "observedDeviceGeometricDistortionCorrectionEnabled": pair.observedGDCEnabled,
            "observedDeviceVideoZoomFactor": pair.observedZoomFactor
        ]
        if let format = CMSampleBufferGetFormatDescription(pair.video) {
            let size = CMVideoFormatDescriptionGetDimensions(format)
            let aperture = CMVideoFormatDescriptionGetCleanAperture(format, originIsAtTopLeft: true)
            geometry["formatDimensions"] = [Int(size.width), Int(size.height)]
            geometry["cleanAperture"] = [aperture.origin.x, aperture.origin.y, aperture.width, aperture.height]
        }
        let exactDepth = try HandheldDepthFrameCodec.exactDepthRepresentation(pair.depth, rgbTimestamp: pair.rgbPTS,
                                                                            depthTimestamp: pair.depthPTS,
                                                                            rgbWidth: image.width, rgbHeight: image.height,
                                                                            rgbIntrinsics: intrinsics, rgbGeometry: geometry)
        let exif = attachments[kCGImagePropertyExifDictionary as String] as? [String: Any]
        let record = FrameRecord(index: index, filename: name, depthFilename: depthName, rgbTimestamp: pair.rgbPTS, depthTimestamp: pair.depthPTS,
                                 rgbWidth: image.width, rgbHeight: image.height,
                                 depthWidth: CVPixelBufferGetWidth(pair.depth.depthDataMap), depthHeight: CVPixelBufferGetHeight(pair.depth.depthDataMap),
                                 exposureSeconds: exif?[kCGImagePropertyExifExposureTime as String] as? Double,
                                 iso: (exif?[kCGImagePropertyExifISOSpeedRatings as String] as? [Double])?.first,
                                 rgbIntrinsicsColumnMajor: intrinsics,
                                 observedDeviceExposureSeconds: pair.observedExposure, observedDeviceISO: pair.observedISO,
                                 depthFiltered: pair.depth.isDepthDataFiltered, depthAccuracy: pair.depth.depthDataAccuracy.rawValue,
                                 depthQuality: pair.depth.depthDataQuality.rawValue, bytes: Int64(data.count + exactDepth.count))
        var metadata = try JSONEncoder().encode(record); metadata.append(0x0a)
        let committedBytes = try HandheldDepthFrameCodec.commit(image: data, exactDepth: exactDepth, metadata: metadata,
                                                                folder: folder, index: index, remainingBytes: remainingBytes)
        return (SavedFrame(index: index, framesSaved: index + 1, url: url, rgbTimestamp: pair.rgbPTS,
                           depthTimestamp: pair.depthPTS, byteCount: committedBytes), record)
    }
    private func dropped(_ reason: Drop, sensorReason: Int? = nil) {
        drops[reason.rawValue, default: 0] += 1
        if let sensorReason { drops[reason.rawValue + ".reason." + String(sensorReason), default: 0] += 1 }
        callbacks.onDrop(reason)
    }
    private func reachedLimit(_ message: String) {
        recording = false
        guard !limitReached else { return }
        limitReached = true; callbacks.onLimitReached(message)
    }
    private func summary() -> Summary {
        let elapsed = (lastPTS ?? 0) - (firstPTS ?? 0)
        return Summary(framesSaved: framesSaved, bytes: bytes, firstPTS: firstPTS, lastPTS: lastPTS,
                       effectiveSavedFPS: segmentFrames > 1 && elapsed > 0 ? Double(segmentFrames - 1) / elapsed : nil,
                       drops: drops, runtimeConfiguration: runtime, failure: failure, limitReached: limitReached)
    }
    private func finishDrainsIfIdle() {
        guard !writerBusy else { return }
        let snapshot = summary()
        let waiting = drains; drains.removeAll()
        for continuation in waiting { continuation.resume(returning: snapshot) }
    }
}
#endif
