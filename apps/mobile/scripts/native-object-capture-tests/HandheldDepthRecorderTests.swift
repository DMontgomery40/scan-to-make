import Foundation
import AVFoundation
import CoreGraphics
import ImageIO

@main struct HandheldDepthRecorderTests {
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw NSError(domain: "HandheldDepthRecorderTests", code: 1,
                                        userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    /// Fully synthetic public test input; no retained photos or fabricated sensor calibration.
    static func genericCodecChecks() throws {
        let values: [Float] = (0..<(16 * 12)).map { 0.25 + Float($0) / 10000 }
        let bytes = values.withUnsafeBytes { Data($0) }
        let metadata = CGImageMetadataCreateMutable()
        CGImageMetadataRegisterNamespaceForPrefix(metadata, "http://ns.apple.com/depthData/1.0/" as CFString, "depthData" as CFString, nil)
        for (key, value) in [("Accuracy", "absolute"), ("Filtered", "false"), ("Quality", "high"), ("DepthDataVersion", "65538")] {
            CGImageMetadataSetValueWithPath(metadata, nil, "depthData:\(key)" as CFString, value as CFString)
        }
        let description: [String: Any] = ["Width": 16, "Height": 12, "BytesPerRow": 64,
                                          "PixelFormat": kCVPixelFormatType_DepthFloat32, "Orientation": 1]
        let depth = try AVDepthData(fromDictionaryRepresentation: [kCGImageAuxiliaryDataInfoData: bytes,
                                                                  kCGImageAuxiliaryDataInfoDataDescription: description,
                                                                  kCGImageAuxiliaryDataInfoMetadata: metadata])
        let exact = try HandheldDepthFrameCodec.exactDepthRepresentation(depth, rgbTimestamp: 2.5, depthTimestamp: 2.5,
                                                                        rgbWidth: 64, rgbHeight: 48)
        let restored = try HandheldDepthFrameCodec.restoreExactDepth(from: exact)
        try require(restored.cameraCalibrationData == nil, "Codec invented missing sensor calibration")
        try require(!restored.isDepthDataFiltered, "Codec invented filtered depth")
        let map = restored.depthDataMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        for y in 0..<12 {
            let row = CVPixelBufferGetBaseAddress(map)!.advanced(by: y * CVPixelBufferGetBytesPerRow(map)).assumingMemoryBound(to: Float.self)
            for x in 0..<16 { try require(row[x] == values[y * 16 + x], "Synthetic exact-depth value changed") }
        }
        CVPixelBufferUnlockBaseAddress(map, .readOnly)
        var payload = try PropertyListSerialization.propertyList(from: exact, options: [], format: nil) as! [String: Any]
        var missingBytes = payload["data"] as! Data
        missingBytes.withUnsafeMutableBytes {
            $0.storeBytes(of: Float.nan, toByteOffset: 0, as: Float.self)
            $0.storeBytes(of: Float.infinity, toByteOffset: 4, as: Float.self)
        }
        payload["data"] = missingBytes
        let missing = try HandheldDepthFrameCodec.restoreExactDepth(from: PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0))
        let missingAgain = try HandheldDepthFrameCodec.restoreExactDepth(from: HandheldDepthFrameCodec.exactDepthRepresentation(missing, rgbTimestamp: 2.5, depthTimestamp: 2.5, rgbWidth: 64, rgbHeight: 48))
        let missingMap = missingAgain.depthDataMap
        CVPixelBufferLockBaseAddress(missingMap, .readOnly)
        let missingRow = CVPixelBufferGetBaseAddress(missingMap)!.assumingMemoryBound(to: Float.self)
        try require(missingRow[0].isNaN && missingRow[1].isInfinite, "Synthetic missing depth was filled")
        CVPixelBufferUnlockBaseAddress(missingMap, .readOnly)
        payload["schemaVersion"] = 99
        var rejected = false
        do { _ = try HandheldDepthFrameCodec.restoreExactDepth(from: PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0)) }
        catch { rejected = true }
        try require(rejected, "Unsupported sidecar version was accepted")
        try checkColour(depth: depth)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let context = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 256,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.5, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        let image = try HandheldDepthFrameCodec.encode(image: context.makeImage()!, depth: depth, properties: [:])
        let imageURL = folder.appendingPathComponent("0000.heic")
        try image.write(to: imageURL)
        var legacy = false
        do { _ = try HandheldDepthFrameCodec.recover(in: folder) }
        catch is HandheldDepthFrameCodec.LegacyCapture { legacy = true }
        try require(legacy, "Legacy HEIC-only input was not identified")
        try Data("{}\n".utf8).write(to: folder.appendingPathComponent("capture-frames.jsonl"))
        var damagedStreamRejected = false
        do { _ = try HandheldDepthFrameCodec.recover(in: folder) }
        catch is HandheldDepthFrameCodec.LegacyCapture { }
        catch { damagedStreamRejected = true }
        try require(damagedStreamRejected, "A damaged stream with a journal was reclassified as legacy")
        try require((try Data(contentsOf: imageURL)) == image, "Damaged-stream recovery deleted retained input")
        let orphanFolder = folder.appendingPathComponent("orphan")
        try FileManager.default.createDirectory(at: orphanFolder, withIntermediateDirectories: true)
        try exact.write(to: orphanFolder.appendingPathComponent("0000.depth.plist"))
        let recovered = try HandheldDepthFrameCodec.recover(in: orphanFolder)
        try require(recovered.framesSaved == 0 && recovered.bytes == Int64(exact.count), "Orphan recovery invented a committed frame or lost its byte budget")
        let preserved = try FileManager.default.contentsOfDirectory(at: orphanFolder.appendingPathComponent("interrupted-pairs"), includingPropertiesForKeys: nil)
        try require(preserved.count == 1 && (try Data(contentsOf: preserved[0].appendingPathComponent("0000.depth.plist"))) == exact, "Orphan payload was not preserved")
        print("PASS synthetic exact depth, missing samples, schema validation, legacy discrimination and orphan recovery")
    }

    static func checkColour(depth original: AVDepthData) throws {
        // Four coloured quadrants reveal any unintended transpose, rotation, or reflection.
        let ctx = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 256,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        for (rect, color) in [(CGRect(x: 0, y: 0, width: 32, height: 24), CGColor(red: 1, green: 0, blue: 0, alpha: 1)),
                              (CGRect(x: 32, y: 0, width: 32, height: 24), CGColor(red: 0, green: 1, blue: 0, alpha: 1)),
                              (CGRect(x: 0, y: 24, width: 32, height: 24), CGColor(red: 0, green: 0, blue: 1, alpha: 1)),
                              (CGRect(x: 32, y: 24, width: 32, height: 24), CGColor(red: 1, green: 1, blue: 0, alpha: 1))] {
            ctx.setFillColor(color); ctx.fill(rect)
        }
        let pattern = ctx.makeImage()!
        let encoded = try HandheldDepthFrameCodec.encode(image: pattern, depth: original, properties: [:])
        let patternSource = CGImageSourceCreateWithData(encoded as CFData, nil)!
        let result = CGImageSourceCreateImageAtIndex(patternSource, 0, nil)!
        let out = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 256,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        out.draw(result, in: CGRect(x: 0, y: 0, width: 64, height: 48))
        let expected = ctx.data!.assumingMemoryBound(to: UInt8.self), actual = out.data!.assumingMemoryBound(to: UInt8.self)
        for (x,y) in [(8,8), (56,8), (8,40), (56,40)] {
            for channel in 0..<3 { try require(abs(Int(expected[y*256+x*4+channel])-Int(actual[y*256+x*4+channel])) < 24, "HEIC writer rotated, mirrored, or materially changed quadrant colour") }
        }
        let props = CGImageSourceCopyPropertiesAtIndex(patternSource, 0, nil)! as NSDictionary
        try require((props[kCGImagePropertyOrientation] as? Int) == 1, "Writer did not declare native orientation")
        print("PASS unrotated/unmirrored colour round trip")
    }

    static func main() throws {
        var admission = HandheldFrameAdmission(targetFPS: 10)
        try require(admission.admit(timestamp: 1, writerBusy: false), "First usable synchronized frame was rejected")
        try require(!admission.admit(timestamp: 1.02, writerBusy: false), "Recorder exceeded configured save cadence")
        try require(!admission.admit(timestamp: 1.1, writerBusy: true), "Busy writer admitted another frame")
        try require(admission.admit(timestamp: 1.1, writerBusy: false), "Backpressure incorrectly advanced the frame clock")
        try require(!admission.admit(timestamp: .nan, writerBusy: false), "Invalid sensor timestamp was accepted")
        try require(!admission.admit(timestamp: 0.9, writerBusy: false), "Nonmonotonic sensor timestamp was accepted")
        print("PASS cadence, backpressure, and sensor-clock admission")
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let imageBytes = Data([1,2,3]), depthBytes = Data([4,5]), metadataBytes = Data([10])
        var limited = false
        do { _ = try HandheldDepthFrameCodec.commit(image: imageBytes, exactDepth: depthBytes, metadata: metadataBytes, folder: scratch, index: 0, remainingBytes: 5) }
        catch is HandheldDepthFrameCodec.StorageLimit { limited = true }
        try require(limited && (try FileManager.default.contentsOfDirectory(atPath: scratch.path)).isEmpty, "Storage limit left partial data")
        let committedBytes = try HandheldDepthFrameCodec.commit(image: imageBytes, exactDepth: depthBytes, metadata: metadataBytes, folder: scratch, index: 0, remainingBytes: 6)
        try require(committedBytes == 6, "Storage budget omitted part of the capture pair")
        try require((try Data(contentsOf: scratch.appendingPathComponent("0000.heic"))) == imageBytes && (try Data(contentsOf: scratch.appendingPathComponent("0000.depth.plist"))) == depthBytes, "Pair commit lost a payload")
        var refusedOverwrite = false
        do { _ = try HandheldDepthFrameCodec.commit(image: Data([9]), exactDepth: depthBytes, metadata: metadataBytes, folder: scratch, index: 0, remainingBytes: 99) }
        catch { refusedOverwrite = true }
        try require(refusedOverwrite && (try Data(contentsOf: scratch.appendingPathComponent("0000.heic"))) == imageBytes, "Existing capture was overwritten or removed")
        try FileManager.default.removeItem(at: scratch.appendingPathComponent("capture-frames.jsonl"))
        try FileManager.default.createDirectory(at: scratch.appendingPathComponent("capture-frames.jsonl"), withIntermediateDirectories: false)
        var rolledBack = false
        do { _ = try HandheldDepthFrameCodec.commit(image: imageBytes, exactDepth: depthBytes, metadata: metadataBytes, folder: scratch, index: 1, remainingBytes: 99) }
        catch { rolledBack = true }
        try require(rolledBack && !FileManager.default.fileExists(atPath: scratch.appendingPathComponent("0001.heic").path) && !FileManager.default.fileExists(atPath: scratch.appendingPathComponent("0001.depth.plist").path), "Failed journal commit left an apparently complete frame")
        try require(!(try FileManager.default.contentsOfDirectory(atPath: scratch.path)).contains(where: { $0.hasSuffix("partial") }), "Writer leaked temporary payloads")
        print("PASS paired-file budget, no-overwrite, and failed-commit rollback")
        try genericCodecChecks()
        guard CommandLine.arguments.count > 1 else {
            print("PASS generic recorder checks; optional retained sensor fixture was not requested")
            return
        }
        let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil)!
        var original: AVDepthData?
        for type in [kCGImageAuxiliaryDataTypeDepth, kCGImageAuxiliaryDataTypeDisparity] {
            if let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, type) as? [AnyHashable: Any] {
                original = try AVDepthData(fromDictionaryRepresentation: info); break
            }
        }
        guard let original, let calibration = original.cameraCalibrationData else { fatalError("Fixture must contain real sensor calibration") }
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let data = try HandheldDepthFrameCodec.encode(image: image, depth: original, properties: [:])
        let decoded = CGImageSourceCreateWithData(data as CFData, nil)!
        var restored: AVDepthData?
        for type in [kCGImageAuxiliaryDataTypeDepth, kCGImageAuxiliaryDataTypeDisparity] {
            if let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(decoded, 0, type) as? [AnyHashable: Any] {
                restored = try AVDepthData(fromDictionaryRepresentation: info); break
            }
        }
        guard let restored, let recovered = restored.cameraCalibrationData else { fatalError("Round trip lost calibration") }
        try require(recovered.intrinsicMatrix == calibration.intrinsicMatrix, "Round trip changed intrinsics")
        try require(recovered.intrinsicMatrixReferenceDimensions == calibration.intrinsicMatrixReferenceDimensions, "Round trip changed calibration dimensions")
        try require(recovered.lensDistortionLookupTable == calibration.lensDistortionLookupTable, "Round trip lost distortion LUT")
        try require(recovered.inverseLensDistortionLookupTable == calibration.inverseLensDistortionLookupTable, "Round trip lost inverse distortion LUT")
        try require(recovered.lensDistortionCenter == calibration.lensDistortionCenter, "Round trip changed distortion centre")
        try require(restored.isDepthDataFiltered == original.isDepthDataFiltered && restored.depthDataAccuracy == original.depthDataAccuracy, "Round trip invented depth quality metadata")
        let sidecar = try HandheldDepthFrameCodec.exactDepthRepresentation(original, rgbTimestamp: 123.25, depthTimestamp: 123.25,
                                                                           rgbWidth: image.width, rgbHeight: image.height)
        let recoveryFolder = scratch.appendingPathComponent("recovery")
        try FileManager.default.createDirectory(at: recoveryFolder, withIntermediateDirectories: true)
        _ = try HandheldDepthFrameCodec.commit(image: data, exactDepth: sidecar, metadata: Data("{}\n".utf8), folder: recoveryFolder, index: 0, remainingBytes: Int64.max)
        let orphanData = Data([7,8,9])
        try orphanData.write(to: recoveryFolder.appendingPathComponent("0001.depth.plist"))
        let recoveredCapture = try HandheldDepthFrameCodec.recover(in: recoveryFolder)
        try require(recoveredCapture.framesSaved == 1, "Recovery lost the committed prefix")
        try require(!FileManager.default.fileExists(atPath: recoveryFolder.appendingPathComponent("0001.depth.plist").path), "Orphan sidecar prevents resuming at the next index")
        let preservedRoot = recoveryFolder.appendingPathComponent("interrupted-pairs")
        let preservedFolders = try FileManager.default.contentsOfDirectory(at: preservedRoot, includingPropertiesForKeys: nil)
        try require(preservedFolders.count == 1 && (try Data(contentsOf: preservedFolders[0].appendingPathComponent("0001.depth.plist"))) == orphanData, "Recovery did not preserve interrupted input")
        _ = try HandheldDepthFrameCodec.commit(image: data, exactDepth: sidecar, metadata: Data("{}\n".utf8), folder: recoveryFolder, index: 1, remainingBytes: Int64.max)
        try require((try HandheldDepthFrameCodec.recover(in: recoveryFolder)).framesSaved == 2, "Recovered capture could not append")
        let legacyFolder = scratch.appendingPathComponent("legacy")
        try FileManager.default.createDirectory(at: legacyFolder, withIntermediateDirectories: true)
        try data.write(to: legacyFolder.appendingPathComponent("0000.heic"))
        var legacyDetected = false
        do { _ = try HandheldDepthFrameCodec.recover(in: legacyFolder) }
        catch is HandheldDepthFrameCodec.LegacyCapture { legacyDetected = true }
        try require(legacyDetected, "Legacy capture was silently mixed with the new stream")
        let mismatchedFolder = scratch.appendingPathComponent("mismatched")
        try FileManager.default.createDirectory(at: mismatchedFolder, withIntermediateDirectories: true)
        let wrongDimensions = try HandheldDepthFrameCodec.exactDepthRepresentation(original, rgbTimestamp: 1, depthTimestamp: 1, rgbWidth: image.width + 1, rgbHeight: image.height)
        _ = try HandheldDepthFrameCodec.commit(image: data, exactDepth: wrongDimensions, metadata: Data(), folder: mismatchedFolder, index: 0, remainingBytes: Int64.max)
        var mismatchDetected = false
        do { _ = try HandheldDepthFrameCodec.recover(in: mismatchedFolder) } catch { mismatchDetected = true }
        try require(mismatchDetected && FileManager.default.fileExists(atPath: mismatchedFolder.appendingPathComponent("0000.heic").path), "Invalid recovery was accepted or deleted its input")
        print("PASS recovery, preserved orphan, resume append, legacy separation, and mismatched-pair rejection")
        let exact = try HandheldDepthFrameCodec.restoreExactDepth(from: sidecar)
        guard let exactCalibration = exact.cameraCalibrationData else { fatalError("Sidecar lost calibration") }
        try require(exactCalibration.intrinsicMatrix == calibration.intrinsicMatrix, "Exact sidecar changed intrinsics")
        try require(exactCalibration.intrinsicMatrixReferenceDimensions == calibration.intrinsicMatrixReferenceDimensions, "Exact sidecar changed calibration dimensions")
        try require(exactCalibration.lensDistortionLookupTable == calibration.lensDistortionLookupTable && exactCalibration.inverseLensDistortionLookupTable == calibration.inverseLensDistortionLookupTable, "Exact sidecar lost calibration LUTs")
        try require(exactCalibration.lensDistortionCenter == calibration.lensDistortionCenter, "Exact sidecar changed distortion centre")
        let a = original.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32).depthDataMap
        let b = exact.depthDataMap
        try require(CVPixelBufferGetWidth(a) == CVPixelBufferGetWidth(b) && CVPixelBufferGetHeight(a) == CVPixelBufferGetHeight(b), "Depth dimensions changed")
        CVPixelBufferLockBaseAddress(a, .readOnly); CVPixelBufferLockBaseAddress(b, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(a, .readOnly); CVPixelBufferUnlockBaseAddress(b, .readOnly) }
        var maxDifference: Float = 0
        for y in 0..<CVPixelBufferGetHeight(a) {
            let pa = CVPixelBufferGetBaseAddress(a)!.advanced(by: y * CVPixelBufferGetBytesPerRow(a)).assumingMemoryBound(to: Float.self)
            let pb = CVPixelBufferGetBaseAddress(b)!.advanced(by: y * CVPixelBufferGetBytesPerRow(b)).assumingMemoryBound(to: Float.self)
            for x in 0..<CVPixelBufferGetWidth(a) {
                try require(pa[x].isFinite == pb[x].isFinite, "Missing depth was filled or valid depth was lost")
                if pa[x].isFinite { maxDifference = max(maxDifference, abs(pa[x] - pb[x])) }
            }
        }
        try require(maxDifference == 0, "Lossless sidecar changed metric depth")
        print("PASS every depth pixel, real calibration and metric-depth sidecar round trip; maximum difference \(maxDifference) m")
        // Inject missing samples only in a private test copy of the sensor dictionary; original fixture is untouched.
        var missingPayload = try PropertyListSerialization.propertyList(from: sidecar, options: [], format: nil) as! [String: Any]
        var missingBytes = missingPayload["data"] as! Data
        missingBytes.withUnsafeMutableBytes { bytes in
            bytes.storeBytes(of: Float.nan, toByteOffset: 0, as: Float.self)
            bytes.storeBytes(of: Float.infinity, toByteOffset: 4, as: Float.self)
        }
        missingPayload["data"] = missingBytes
        let missingInput = try HandheldDepthFrameCodec.restoreExactDepth(from: PropertyListSerialization.data(fromPropertyList: missingPayload, format: .binary, options: 0))
        let missingOutput = try HandheldDepthFrameCodec.restoreExactDepth(from: HandheldDepthFrameCodec.exactDepthRepresentation(missingInput, rgbTimestamp: 1, depthTimestamp: 1, rgbWidth: image.width, rgbHeight: image.height))
        let missingMap = missingOutput.depthDataMap
        CVPixelBufferLockBaseAddress(missingMap, .readOnly)
        let missingValues = CVPixelBufferGetBaseAddress(missingMap)!.assumingMemoryBound(to: Float.self)
        try require(missingValues[0].isNaN && missingValues[1].isInfinite, "Missing samples were invented or filled")
        CVPixelBufferUnlockBaseAddress(missingMap, .readOnly)
        missingPayload["schemaVersion"] = 99
        var rejectedUnknownVersion = false
        do { _ = try HandheldDepthFrameCodec.restoreExactDepth(from: PropertyListSerialization.data(fromPropertyList: missingPayload, format: .binary, options: 0)) }
        catch { rejectedUnknownVersion = true }
        try require(rejectedUnknownVersion, "Unknown depth schema was silently accepted")
        print("PASS missing/invalid depth remains missing; unsupported sidecar is rejected")
        try checkColour(depth: original)
    }
}
