import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Reads the depth map embedded in a HEIC/JPEG the way `AVCapturePhotoOutput` writes it (`embedsDepthDataInPhoto`).
/// Disparity is converted to depth in metres. Returns nil when the photo has no depth.
public func embeddedDepth(in url: URL) -> DepthImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    for type in [kCGImageAuxiliaryDataTypeDepth, kCGImageAuxiliaryDataTypeDisparity] {
        guard let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, type) as? [AnyHashable: Any],
              let depthData = try? AVDepthData(fromDictionaryRepresentation: info) else { continue }
        let metric = depthData.depthDataType == kCVPixelFormatType_DepthFloat32
            ? depthData : depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        return DepthImage(buffer: metric.depthDataMap)
    }
    return nil
}

/// What a synthetic photo says about the camera, written the way an iPhone writes it.
public struct PhotoCamera {
    /// Focal length in pixels at the photo's width.
    public var focalPixels: Double
    /// Physical sensor width in millimetres; with `focalPixels` it gives EXIF FocalLength.
    public var sensorWidthMm: Double = 9.30
    /// EXIF orientation tag (1 = as stored, 6 = rotate 90° clockwise to view, as iPhone portrait photos are).
    public var orientation: UInt32 = 1
    public init(focalPixels: Double, orientation: UInt32 = 1) { self.focalPixels = focalPixels; self.orientation = orientation }
}

/// Writes a HEIC with EXIF focal length and, when given, a DepthFloat32 depth map as auxiliary data,
/// matching what `AVCapturePhotoOutput` produces with depth delivery on. No gravity, pose or bounding box.
public func writePhoto(_ image: CGImage, depth: DepthImage?, camera: PhotoCamera, to url: URL) throws {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.heic.identifier as CFString, 1, nil) else {
        throw HandheldError.io("can't create \(url.path)")
    }
    let width = Double(image.width), height = Double(image.height)
    let focalMm = camera.focalPixels * camera.sensorWidthMm / width
    let diagonal = (width * width + height * height).squareRoot()
    let exif: [CFString: Any] = [
        kCGImagePropertyExifFocalLength: focalMm,
        kCGImagePropertyExifFocalLenIn35mmFilm: Int((43.27 * camera.focalPixels / diagonal).rounded()),
        kCGImagePropertyExifFocalPlaneXResolution: width / (camera.sensorWidthMm / 10),
        kCGImagePropertyExifFocalPlaneYResolution: width / (camera.sensorWidthMm / 10),
        kCGImagePropertyExifFocalPlaneResolutionUnit: 3,
        kCGImagePropertyExifPixelXDimension: image.width,
        kCGImagePropertyExifPixelYDimension: image.height,
    ]
    let properties: [CFString: Any] = [
        kCGImagePropertyOrientation: camera.orientation,
        kCGImagePropertyExifDictionary: exif,
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFOrientation: camera.orientation],
        kCGImageDestinationLossyCompressionQuality: 0.92,
    ]
    CGImageDestinationAddImage(dest, image, properties as CFDictionary)
    if let depth {
        var bytes = Data(count: depth.width * depth.height * 4)
        bytes.withUnsafeMutableBytes { raw in depth.metres.withUnsafeBytes { raw.copyMemory(from: $0) } }
        let description: [CFString: Any] = [
            "Width" as CFString: depth.width, "Height" as CFString: depth.height,
            "BytesPerRow" as CFString: depth.width * 4,
            "PixelFormat" as CFString: kCVPixelFormatType_DepthFloat32,
            "Orientation" as CFString: camera.orientation,
        ]
        let metadata = CGImageMetadataCreateMutable()
        let ns = "http://ns.apple.com/depthData/1.0/" as CFString
        CGImageMetadataRegisterNamespaceForPrefix(metadata, ns, "depthData" as CFString, nil)
        for (key, value) in [("Accuracy", "absolute"), ("Filtered", "true"), ("Quality", "high"), ("DepthDataVersion", "65538")] {
            CGImageMetadataSetValueWithPath(metadata, nil, "depthData:\(key)" as CFString, value as CFString)
        }
        let info: [CFString: Any] = [
            kCGImageAuxiliaryDataInfoData: bytes as CFData,
            kCGImageAuxiliaryDataInfoDataDescription: description,
            kCGImageAuxiliaryDataInfoMetadata: metadata,
        ]
        // Round-trip through AVDepthData so the stored form is the one AVFoundation itself writes.
        let depthData = try AVDepthData(fromDictionaryRepresentation: info as [AnyHashable: Any])
        var type: NSString?
        guard let stored = depthData.dictionaryRepresentation(forAuxiliaryDataType: &type), let type else {
            throw HandheldError.io("depth didn't serialise")
        }
        CGImageDestinationAddAuxiliaryDataInfo(dest, type as CFString, stored as CFDictionary)
    }
    guard CGImageDestinationFinalize(dest) else { throw HandheldError.io("can't write \(url.path)") }
}
