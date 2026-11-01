import Foundation
import AVFoundation
import ImageIO

/// Read the lossless RGB-D sidecar written by the phone. HEIC auxiliary depth may be quantized;
/// once an exact companion exists, corrupt data must fail rather than silently substitute that depth.
public func exactDepth(for image: URL) throws -> AVDepthData? {
    let url = image.deletingPathExtension().appendingPathExtension("depth.plist")
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count <= 8 * 1024 * 1024,
          let payload = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
          payload["schemaVersion"] as? Int == 1,
          payload["auxiliaryDataType"] as? String == kCGImageAuxiliaryDataTypeDepth as String,
          payload["depthUnit"] as? String == "metres", payload["byteOrder"] as? String == "little-endian",
          payload["invalidDepth"] as? String == "nonfinite",
          let rgbPTS = payload["rgbTimestamp"] as? Double, rgbPTS.isFinite,
          let depthPTS = payload["depthTimestamp"] as? Double, depthPTS.isFinite,
          let bytes = payload["data"] as? Data,
          let description = payload["description"] as? [AnyHashable: Any],
          let xmp = payload["metadataXMP"] as? Data,
          let metadata = CGImageMetadataCreateFromXMPData(xmp as CFData) else {
        throw HandheldError.io("Invalid exact depth for \(image.lastPathComponent).")
    }
    guard let source = CGImageSourceCreateWithURL(image as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
          let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
          let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
          payload["rgbWidth"] as? Int == width, payload["rgbHeight"] as? Int == height,
          (properties[kCGImagePropertyOrientation as String] as? Int ?? 1) == 1 else {
        throw HandheldError.io("The image and exact depth metadata disagree for \(image.lastPathComponent).")
    }
    let depth = try AVDepthData(fromDictionaryRepresentation: [
        kCGImageAuxiliaryDataInfoData: bytes,
        kCGImageAuxiliaryDataInfoDataDescription: description,
        kCGImageAuxiliaryDataInfoMetadata: metadata
    ])
    guard depth.depthDataType == kCVPixelFormatType_DepthFloat32, depth.cameraCalibrationData != nil else {
        throw HandheldError.io("Missing metric depth or calibration for \(image.lastPathComponent).")
    }
    return depth
}
