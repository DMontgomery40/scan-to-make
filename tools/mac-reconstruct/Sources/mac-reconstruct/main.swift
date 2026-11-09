import Foundation
import RealityKit
import CoreVideo
import HandheldKit

// Rebuilds a model with Apple's PhotogrammetrySession on the Mac, where detail levels above the iPhone's
// `.reduced` are available (WWDC23 10191, WWDC24 10107).
//
//   mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]
//       An Object Capture photo folder (walk-around scan): the iPhone's own HEICs, each carrying its LiDAR depth,
//       gravity and the capture box, which PhotogrammetrySession reads itself. Before building it prints
//       {"images":N,"depth":D,"featureSensitivity":…,"ignoreBoundingBox":…}: how many photos carry depth, which is
//       where the model's real-world size comes from, and the two settings that differ from Apple's defaults.
//       Defaults unchanged: --feature normal|high sets featureSensitivity (default high; the companion reruns a failed
//       rebuild once at normal); diagnostics only:
//       --honor-box lets Apple's capture box trim the model (ignoreBoundingBox = false; default true).
//   mac-reconstruct stl <model.usdz> <output.stl> [--render <overview.png>] [--remove-support]
//       Writes the model's triangles as a binary STL in millimetres, Z up, centred and resting on z = 0
//       (PhotogrammetrySession writes metres, Y up). --render also draws the model for the project page; a model
//       that can't be drawn still gets its STL, and the {"done":…} line names the picture only when there is one.
//       --remove-support cuts away the surface the object stood on (a rig's plate, a patch of table) when there is
//       one, stands the object where it stood, and draws the cut model; {"done":…} then carries "support".
//   mac-reconstruct samples <images-folder> <output.usdz> [reduced|medium|full|raw]
//                   [--masks <dir> | --no-masks] [--save-masks <dir> [--masks-only]]
//       Handheld photos: the camera stays still and the object turns in the hand. Each photo becomes a
//       PhotogrammetrySample with its embedded depth and EXIF, no gravity, and an object mask. Masks come from
//       <dir>/<photo-name>.png when given, otherwise from Vision on this Mac (the object without the hand or room).
//
// Prints one JSON line per progress step and a final {"done":…} or {"error":…} line.

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

func fail(_ message: String) -> Never { emit(["error": message]); exit(1) }

let usage = """
usage: mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw] [--feature normal|high] [--honor-box]
       mac-reconstruct stl <model.usdz> <output.stl> [--render <overview.png>] [--remove-support]
       mac-reconstruct samples <images-folder> <output.usdz> [reduced|medium|full|raw] [--masks <dir> | --no-masks] [--save-masks <dir> [--masks-only]]

"""
var args = Array(CommandLine.arguments.dropFirst())
if args.first == "stl" {
    var render: String?
    if let i = args.firstIndex(of: "--render"), i + 1 < args.count { render = args[i + 1]; args.removeSubrange(i...(i + 1)) }
    let cutSupport = args.contains("--remove-support"); args.removeAll { $0 == "--remove-support" }
    guard args.count == 3 else { FileHandle.standardError.write(Data(usage.utf8)); exit(2) }
    do {
        let model = URL(fileURLWithPath: args[1]), stl = URL(fileURLWithPath: args[2])
        let summary = try writeSTL(model: model, to: stl, removeSupport: cutSupport)
        var done: [String: Any] = ["done": args[2], "triangles": summary.triangles, "vertices": summary.vertices,
                                   "sizeMm": [summary.sizeMm.x, summary.sizeMm.y, summary.sizeMm.z].map { ($0 * 10).rounded() / 10 }]
        if let support = summary.support {
            done["support"] = ["tiltDegrees": (support.tiltDegrees * 10).rounded() / 10, "areaMm2": Int(support.supportAreaMm2.rounded()),
                               "trianglesBefore": support.trianglesBefore, "trianglesAfter": support.trianglesAfter]
        }
        if let render {
            // The picture shows what prints: the cut STL when the support went, else the model with its textures.
            do { try renderOverview(model: summary.support == nil ? model : stl, to: URL(fileURLWithPath: render), zUp: summary.support != nil); done["render"] = render }
            catch { FileHandle.standardError.write(Data("render: \(error)\n".utf8)) }
        }
        emit(done)
        exit(0)
    } catch { fail(String(describing: error)) }
}
let samplesMode = args.first == "samples"
if samplesMode { args.removeFirst() }
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]; args.removeSubrange(i...(i + 1)); return value
}
let maskFolder = option("--masks").map { URL(fileURLWithPath: $0, isDirectory: true) }
let saveMasks = option("--save-masks").map { URL(fileURLWithPath: $0, isDirectory: true) }
let noMasks = args.contains("--no-masks"); args.removeAll { $0 == "--no-masks" }
let masksOnly = args.contains("--masks-only"); args.removeAll { $0 == "--masks-only" }
// Diagnostics for tests: switch off Apple's own object masking, or drop the photos' depth.
let noObjectMasking = args.contains("--no-object-masking"); args.removeAll { $0 == "--no-object-masking" }
let noDepth = args.contains("--no-depth"); args.removeAll { $0 == "--no-depth" }
// An Object Capture folder only: the two settings that differ from Apple's defaults (the companion's retry uses --feature).
let featureOption = option("--feature")
let honorBox = args.contains("--honor-box"); args.removeAll { $0 == "--honor-box" }
let featureSensitivities: [String: PhotogrammetrySession.Configuration.FeatureSensitivity] = ["normal": .normal, "high": .high]
if samplesMode && (featureOption != nil || honorBox) { FileHandle.standardError.write(Data(usage.utf8)); exit(2) }
if let featureOption, featureSensitivities[featureOption] == nil { FileHandle.standardError.write(Data(usage.utf8)); exit(2) }
guard args.count >= 2 else { FileHandle.standardError.write(Data(usage.utf8)); exit(2) }

let input = URL(fileURLWithPath: args[0], isDirectory: true)
let output = URL(fileURLWithPath: args[1])
let details: [String: PhotogrammetrySession.Request.Detail] = ["reduced": .reduced, "medium": .medium, "full": .full, "raw": .raw]
let detail = details[args.count > 2 ? args[2] : "full"] ?? .full

guard PhotogrammetrySession.isSupported else { fail("Photogrammetry isn't supported on this Mac.") }

var configuration = PhotogrammetrySession.Configuration()
configuration.isObjectMaskingEnabled = !noObjectMasking   // the object, not what's around it
if samplesMode {
    configuration.sampleOrdering = .sequential  // the handheld recorder's photos are adjacent, in capture order
    configuration.featureSensitivity = .normal
} else {
    // An Object Capture folder, Apple's way: its own per-photo camera, depth, gravity and capture box, its own masks.
    // .high: Apple's setting "for challenging images" (dim 1/60 s rig frames, a plain backdrop). The ordering stays
    // Apple's default: on David's rig scan, .sequential with .high placed 5–7 of 24 photos and left part of the sign
    // in three runs, against 9 of 24 and the same front of the sign in three runs unordered.
    configuration.featureSensitivity = featureSensitivities[featureOption ?? "high"]!
    // Apple's capture box is not trusted to trim the object: on David's rig scan it was fitted to the script on the
    // base and cut the letters. Apple's object masking (on above) still separates the object from the room.
    configuration.ignoreBoundingBox = !honorBox
}

let started = Date()

/// Object masks for handheld photos, written as PNGs next to nothing else, so a run can be checked afterwards.
func prepareMasks(for files: [URL], in folder: URL) async throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    if maskFolder == nil {
        guard ObjectMasker.isSupported else { emit(["error": "needs-macos-27"]); exit(3) }
        // Vision fetches its model on first use; say so only when that actually takes a while.
        if await ObjectMasker.needsDownload() {
            let notice = Task { try await Task.sleep(for: .seconds(2)); emit(["stage": "downloading"]) }
            try await ObjectMasker.download()
            notice.cancel()
        }
    }
    let masker = ObjectMasker()
    for (index, file) in files.enumerated() {
        let sample = try loadSample(file)
        if isMirrored(orientation: orientation(of: sample)) { emit(["error": "mirrored-photos", "file": file.lastPathComponent]); exit(4) }
        let width = CVPixelBufferGetWidth(sample.image), height = CVPixelBufferGetHeight(sample.image)
        let target = folder.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".png")
        var note: [String: Any] = ["stage": "masking", "done": index + 1, "total": files.count]
        if let maskFolder {
            let supplied = maskFolder.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".png")
            let mask = try GrayImage(contentsOf: supplied).resized(width: width, height: height).thresholded()
            try mask.writePNG(to: target)
        } else {
            let depth = sample.depthDataMap.flatMap { DepthImage(buffer: $0) }
            let result = try await masker.mask(image: sample.image, depth: depth)
            try result.mask.writePNG(to: target)
            note["method"] = result.method; note["handJoints"] = result.handJoints; note["excluded"] = result.excludedPoints
            note["coverage"] = (Double(result.mask.onCount) / Double(width * height) * 1000).rounded() / 1000
            if result.mask.onCount == 0 { note["empty"] = file.lastPathComponent }
        }
        emit(note)
    }
}

do {
    let session: PhotogrammetrySession
    if samplesMode {
        let files = try photos(in: input)
        guard !files.isEmpty else { fail("No photos in \(input.path).") }
        var masks: URL? = nil
        if !noMasks {
            let folder = saveMasks ?? FileManager.default.temporaryDirectory.appendingPathComponent("mac-reconstruct-masks-\(UUID().uuidString)")
            try await prepareMasks(for: files, in: folder)
            masks = folder
            if masksOnly { emit(["done": folder.path, "seconds": Int(Date().timeIntervalSince(started))]); exit(0) }
        }
        emit(["samples": files.count, "masked": masks != nil, "stage": "reconstructing"])
        // Loaded lazily: a few hundred full-resolution photos don't need to sit in memory together.
        let samples = AnySequence<PhotogrammetrySample> {
            var iterator = files.makeIterator()
            return AnyIterator<PhotogrammetrySample> {
                while let file = iterator.next() {
                    do {
                        var sample = try loadSample(file)
                        if noDepth { sample.depthDataMap = nil }
                        if let masks {
                            let mask = try GrayImage(contentsOf: masks.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".png"))
                            if mask.onCount == 0 { emit(["skipped": file.lastPathComponent, "reason": "no object found"]); continue }
                            sample.objectMask = mask.pixelBuffer()
                        }
                        return sample
                    } catch {
                        emit(["skipped": file.lastPathComponent, "reason": String(describing: error)])
                    }
                }
                return nil
            }
        }
        session = try PhotogrammetrySession(input: samples, configuration: configuration)
    } else {
        // Apple: "If your source images contain depth data, RealityKit uses it to calculate the real-world size of
        // the scanned object." Say how many do, so the size's source is on record.
        let files = try photos(in: input)
        guard !files.isEmpty else { fail("No photos in \(input.path).") }
        emit(["images": files.count, "depth": files.filter { embeddedDepth(in: $0) != nil }.count, "stage": "reconstructing",
              "featureSensitivity": featureOption ?? "high",
              "ignoreBoundingBox": configuration.ignoreBoundingBox])
        session = try PhotogrammetrySession(input: input, configuration: configuration)
    }
    try session.process(requests: [.modelFile(url: output, detail: detail)])
    for try await out in session.outputs {
        switch out {
        case .requestProgress(_, let fraction):
            emit(["progress": (fraction * 100).rounded() / 100])
        case .requestComplete(_, .modelFile(let url)):
            emit(["done": url.path, "seconds": Int(Date().timeIntervalSince(started))])
        case .requestError(_, let error):
            fail(String(describing: error))
        case .processingComplete:
            exit(0)
        case .invalidSample(let id, let reason):
            emit(["skipped": id, "reason": reason])
        case .skippedSample(let id):
            emit(["skipped": id, "reason": "not used"])
        case .stitchingIncomplete:
            emit(["warning": "stitching-incomplete"])
        case .automaticDownsampling:
            emit(["warning": "downsampled"])
        case .processingCancelled:
            fail("cancelled")
        default:
            break
        }
    }
} catch {
    fail(String(describing: error))
}
