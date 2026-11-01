import Foundation
import CoreGraphics
import CoreVideo
import ImageIO
import RealityKit
import CoreImage

public let photoExtensions: Set<String> = ["heic", "heif", "jpg", "jpeg", "png"]

/// Photos in a folder, in name order (capture order for the phone's numbered files).
public func photos(in folder: URL) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        .filter { photoExtensions.contains($0.pathExtension.lowercased()) }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
}

/// Loads one handheld photo as a `PhotogrammetrySample`: pixels in the stored (sensor) orientation, EXIF and
/// TIFF metadata, embedded depth in metres, and camera calibration when the photo carries it.
/// Gravity is always cleared: the object turns in the hand, so the phone's gravity says nothing about it.
public func loadSample(_ url: URL) throws -> PhotogrammetrySample {
    var sample: PhotogrammetrySample
    if let loaded = try? PhotogrammetrySample(contentsOf: url) {
        sample = loaded
    } else {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw HandheldError.io("can't read \(url.path)") }
        sample = PhotogrammetrySample(id: nextSampleID(), image: try pixelBuffer(from: image))
        sample.metadata = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]) ?? [:]
    }
    sample.gravity = nil
    if sample.depthDataMap == nil, let depth = embeddedDepth(in: url) { sample.depthDataMap = depth.pixelBuffer() }
    return sample
}

private let idLock = NSLock()
nonisolated(unsafe) private var idCounter = 1_000_000
private func nextSampleID() -> Int { idLock.lock(); defer { idLock.unlock() }; idCounter += 1; return idCounter }

public func pixelBuffer(from image: CGImage) throws -> CVPixelBuffer {
    var out: CVPixelBuffer?
    CVPixelBufferCreate(nil, image.width, image.height, kCVPixelFormatType_32BGRA,
                        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
    guard let buffer = out else { throw HandheldError.io("can't allocate \(image.width)x\(image.height)") }
    CVPixelBufferLockBaseAddress(buffer, []); defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: image.width, height: image.height, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return buffer
}

/// Vision's Metal path needs IOSurface-backed pixels; photos decoded from JPEG sometimes aren't.
public func ioSurfaceBacked(_ buffer: CVPixelBuffer) throws -> CVPixelBuffer {
    if CVPixelBufferGetIOSurface(buffer) != nil { return buffer }
    let image = CIImage(cvPixelBuffer: buffer)
    var out: CVPixelBuffer?
    CVPixelBufferCreate(nil, CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), kCVPixelFormatType_32BGRA,
                        [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
    guard let copy = out else { throw HandheldError.io("can't allocate an IOSurface buffer") }
    CIContext().render(image, to: copy)
    return copy
}
