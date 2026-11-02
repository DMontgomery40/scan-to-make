import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Metric depth in metres (0 or NaN = no reading). Row 0 is the top row of the raw image buffer.
public struct DepthImage {
    public var width: Int
    public var height: Int
    public var metres: [Float]

    public init(width: Int, height: Int, metres: [Float]) {
        self.width = width; self.height = height; self.metres = metres
    }

    /// Reads DepthFloat32/16 or DisparityFloat32/16 (disparity is converted to depth as 1/d).
    public init?(buffer: CVPixelBuffer) {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let known: [OSType] = [kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DepthFloat16,
                               kCVPixelFormatType_DisparityFloat32, kCVPixelFormatType_DisparityFloat16]
        guard known.contains(format) else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        width = CVPixelBufferGetWidth(buffer); height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!
        let half = format == kCVPixelFormatType_DepthFloat16 || format == kCVPixelFormatType_DisparityFloat16
        let disparity = format == kCVPixelFormatType_DisparityFloat32 || format == kCVPixelFormatType_DisparityFloat16
        var values = [Float](repeating: 0, count: width * height)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes)
            for x in 0..<width {
                var v: Float = half ? Float(row.advanced(by: x * 2).assumingMemoryBound(to: Float16.self).pointee)
                                    : row.advanced(by: x * 4).assumingMemoryBound(to: Float.self).pointee
                if disparity { v = v > 0 ? 1 / v : 0 }
                values[y * width + x] = v.isFinite ? v : 0
            }
        }
        metres = values
    }

    /// A DepthFloat32 buffer, the format `PhotogrammetrySample.depthDataMap` takes.
    public func pixelBuffer() -> CVPixelBuffer {
        var out: CVPixelBuffer?
        CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_DepthFloat32,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
        let buffer = out!
        CVPixelBufferLockBaseAddress(buffer, []); defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!
        metres.withUnsafeBytes { src in
            for y in 0..<height { memcpy(base.advanced(by: y * rowBytes), src.baseAddress!.advanced(by: y * width * 4), width * 4) }
        }
        return buffer
    }

    /// Depth at a position given as a fraction of the image (0…1, top-left origin); 0 when there's no reading.
    public func at(u: Double, v: Double) -> Float {
        let x = min(width - 1, max(0, Int(u * Double(width)))), y = min(height - 1, max(0, Int(v * Double(height))))
        return metres[y * width + x]
    }
}

public enum HandheldError: Error, CustomStringConvertible {
    case io(String)
    case unsupported(String)
    public var description: String {
        switch self { case .io(let s), .unsupported(let s): return s }
    }
}
