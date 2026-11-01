import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// An 8-bit single-channel image (masks). Row 0 is the top row of the raw image buffer.
public struct GrayImage: Equatable {
    public var width: Int
    public var height: Int
    public var pixels: [UInt8]

    public init(width: Int, height: Int, fill: UInt8 = 0) {
        self.width = width; self.height = height
        pixels = [UInt8](repeating: fill, count: width * height)
    }

    public subscript(x: Int, y: Int) -> UInt8 {
        get { pixels[y * width + x] }
        set { pixels[y * width + x] = newValue }
    }

    /// Reads a one-component 8-bit, 16-bit half or 32-bit float buffer (float values 0…1).
    public init(buffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        width = CVPixelBufferGetWidth(buffer); height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let isFloat = format == kCVPixelFormatType_OneComponent32Float
        let isHalf = format == kCVPixelFormatType_OneComponent16Half
        pixels = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes)
            for x in 0..<width {
                if isFloat || isHalf {
                    let v = isHalf ? Float(row.advanced(by: x * 2).assumingMemoryBound(to: Float16.self).pointee)
                                   : row.advanced(by: x * 4).assumingMemoryBound(to: Float.self).pointee
                    pixels[y * width + x] = UInt8(max(0, min(255, (v * 255).rounded())))
                } else {
                    pixels[y * width + x] = row.advanced(by: x).assumingMemoryBound(to: UInt8.self).pointee
                }
            }
        }
    }

    /// A OneComponent8 pixel buffer, the format `PhotogrammetrySample.objectMask` takes.
    public func pixelBuffer() -> CVPixelBuffer {
        var out: CVPixelBuffer?
        CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_OneComponent8,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
        let buffer = out!
        CVPixelBufferLockBaseAddress(buffer, []); defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let base = CVPixelBufferGetBaseAddress(buffer)!
        pixels.withUnsafeBytes { src in
            for y in 0..<height { memcpy(base.advanced(by: y * rowBytes), src.baseAddress!.advanced(by: y * width), width) }
        }
        return buffer
    }

    /// Nearest-neighbour resize (masks stay binary).
    public func resized(width w: Int, height h: Int) -> GrayImage {
        if w == width && h == height { return self }
        var out = GrayImage(width: w, height: h)
        for y in 0..<h {
            let sy = min(height - 1, y * height / h)
            for x in 0..<w { out.pixels[y * w + x] = pixels[sy * width + min(width - 1, x * width / w)] }
        }
        return out
    }

    public func thresholded(_ level: UInt8 = 127) -> GrayImage {
        var out = self
        for i in out.pixels.indices { out.pixels[i] = out.pixels[i] > level ? 255 : 0 }
        return out
    }

    public var onCount: Int { pixels.reduce(0) { $0 + ($1 > 127 ? 1 : 0) } }

    public func cgImage() -> CGImage {
        let data = Data(pixels) as CFData
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                       space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                       provider: CGDataProvider(data: data)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    public func writePNG(to url: URL) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw HandheldError.io("can't write \(url.path)")
        }
        CGImageDestinationAddImage(dest, cgImage(), nil)
        guard CGImageDestinationFinalize(dest) else { throw HandheldError.io("can't write \(url.path)") }
    }

    /// Reads any PNG/JPEG as 8-bit grey (alpha is ignored; use a black-and-white mask).
    public init(contentsOf url: URL) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw HandheldError.io("can't read \(url.path)") }
        width = image.width; height = image.height
        pixels = [UInt8](repeating: 0, count: width * height)
        let w = width, h = height
        pixels.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
    }

    /// Keeps only the 4-connected component that contains `seed`, or the largest one when `seed` is off the mask.
    public func keepingComponent(containing seed: (x: Int, y: Int)?) -> GrayImage {
        var labels = [Int32](repeating: 0, count: width * height)
        var sizes: [Int] = [0]
        var stack: [Int] = []
        for start in 0..<(width * height) where pixels[start] > 127 && labels[start] == 0 {
            let label = Int32(sizes.count); var size = 0
            labels[start] = label; stack.append(start)
            while let i = stack.popLast() {
                size += 1
                let x = i % width, y = i / width
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < width && ny < height {
                    let n = ny * width + nx
                    if pixels[n] > 127 && labels[n] == 0 { labels[n] = label; stack.append(n) }
                }
            }
            sizes.append(size)
        }
        guard sizes.count > 1 else { return self }
        var keep = Int32(sizes.indices.dropFirst().max { sizes[$0] < sizes[$1] }!)
        if let seed, seed.x >= 0, seed.y >= 0, seed.x < width, seed.y < height, labels[seed.y * width + seed.x] != 0 {
            keep = labels[seed.y * width + seed.x]
        }
        var out = GrayImage(width: width, height: height)
        for i in labels.indices where labels[i] == keep { out.pixels[i] = 255 }
        return out
    }

    /// Each 4-connected blob as its own mask.
    public func components() -> [GrayImage] {
        var labels = [Int32](repeating: 0, count: width * height)
        var groups: [[Int]] = []
        var stack: [Int] = []
        for start in 0..<(width * height) where pixels[start] > 127 && labels[start] == 0 {
            let label = Int32(groups.count + 1); var members: [Int] = []
            labels[start] = label; stack.append(start)
            while let i = stack.popLast() {
                members.append(i)
                let x = i % width, y = i / width
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < width && ny < height {
                    let n = ny * width + nx
                    if pixels[n] > 127 && labels[n] == 0 { labels[n] = label; stack.append(n) }
                }
            }
            groups.append(members)
        }
        return groups.map { members in
            var out = GrayImage(width: width, height: height)
            for i in members { out.pixels[i] = 255 }
            return out
        }
    }

    /// Grows the mask by `radius` pixels (square neighbourhood, separable).
    public func dilated(by radius: Int) -> GrayImage {
        var rows = GrayImage(width: width, height: height)
        for y in 0..<height {
            var last = -Int.max / 2
            for x in 0..<width { if self[x, y] > 127 { last = x }; if x - last <= radius { rows[x, y] = 255 } }
            last = Int.max / 2
            for x in stride(from: width - 1, through: 0, by: -1) { if self[x, y] > 127 { last = x }; if last - x <= radius { rows[x, y] = 255 } }
        }
        var out = GrayImage(width: width, height: height)
        for x in 0..<width {
            var last = -Int.max / 2
            for y in 0..<height { if rows[x, y] > 127 { last = y }; if y - last <= radius { out[x, y] = 255 } }
            last = Int.max / 2
            for y in stride(from: height - 1, through: 0, by: -1) { if rows[x, y] > 127 { last = y }; if last - y <= radius { out[x, y] = 255 } }
        }
        return out
    }

    /// The mask's bounding box as fractions of the image, grown by `margin` of its size on each side.
    public func bounds(scaledTo size: (Int, Int), grownBy margin: Double) -> CGRect? {
        var minX = Int.max, maxX = -1, minY = Int.max, maxY = -1
        for y in 0..<height { for x in 0..<width where self[x, y] > 127 {
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        } }
        guard maxX >= 0 else { return nil }
        let w = Double(maxX - minX + 1), h = Double(maxY - minY + 1)
        let x0 = max(0, (Double(minX) - w * margin) / Double(width)), y0 = max(0, (Double(minY) - h * margin) / Double(height))
        let x1 = min(1, (Double(maxX + 1) + w * margin) / Double(width)), y1 = min(1, (Double(maxY + 1) + h * margin) / Double(height))
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// Whether any mask pixel lies within `radius` pixels of a point given as a fraction of the image.
    public func touches(u: Double, v: Double, radius: Double) -> Bool {
        let cx = u * Double(width), cy = v * Double(height), r = Int(radius.rounded(.up))
        for y in max(0, Int(cy) - r)...min(height - 1, max(0, Int(cy) + r)) {
            for x in max(0, Int(cx) - r)...min(width - 1, max(0, Int(cx) + r)) where self[x, y] > 127 {
                if hypot(Double(x) + 0.5 - cx, Double(y) + 0.5 - cy) <= radius { return true }
            }
        }
        return false
    }

    /// The pixel deepest inside the mask (largest chamfer distance to the background, in thirds of a pixel).
    public func deepestInteriorPoint() -> (x: Int, y: Int, depth: Int32)? {
        let big = Int32.max / 4
        var d = pixels.map { $0 > 127 ? big : 0 }
        let w = width, h = height
        for y in 0..<h { for x in 0..<w where d[y * w + x] > 0 {
            var v = d[y * w + x]
            v = min(v, x > 0 ? d[y * w + x - 1] + 3 : 3, y > 0 ? d[(y - 1) * w + x] + 3 : 3)
            if x > 0 && y > 0 { v = min(v, d[(y - 1) * w + x - 1] + 4) }
            if x < w - 1 && y > 0 { v = min(v, d[(y - 1) * w + x + 1] + 4) }
            d[y * w + x] = v
        } }
        for y in stride(from: h - 1, through: 0, by: -1) { for x in stride(from: w - 1, through: 0, by: -1) where d[y * w + x] > 0 {
            var v = d[y * w + x]
            v = min(v, x < w - 1 ? d[y * w + x + 1] + 3 : 3, y < h - 1 ? d[(y + 1) * w + x] + 3 : 3)
            if x < w - 1 && y < h - 1 { v = min(v, d[(y + 1) * w + x + 1] + 4) }
            if x > 0 && y < h - 1 { v = min(v, d[(y + 1) * w + x - 1] + 4) }
            d[y * w + x] = v
        } }
        guard let best = d.indices.max(by: { d[$0] < d[$1] }), d[best] > 0 else { return nil }
        return (best % w, best / w, d[best])
    }
}

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
