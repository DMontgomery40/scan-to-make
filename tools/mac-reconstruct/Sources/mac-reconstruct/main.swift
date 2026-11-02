import Foundation
import RealityKit
import CoreVideo
import HandheldKit

// Rebuilds a model with Apple's PhotogrammetrySession on the Mac, where detail levels above the iPhone's
// `.reduced` are available (WWDC23 10191, WWDC24 10107).
//
//   mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]
//       An Object Capture photo folder (walk-around scan).
//   mac-reconstruct samples <images-folder> <output.usdz> [reduced|medium|full|raw]
//       Handheld photos (a Scan in hand capture an earlier phone build saved): the camera stays still and the
//       object turns in the hand. Each photo becomes a PhotogrammetrySample with its embedded depth and EXIF and
//       no gravity. Apple's own object masking finds the object; there is no mask of our own (KAN-217).
//       `--save-masks <dir>` is still accepted (the companion passes it) and writes nothing.
//
// Prints one JSON line per progress step and a final {"done":…} or {"error":…} line.

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

func fail(_ message: String) -> Never { emit(["error": message]); exit(1) }

let usage = """
usage: mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]
       mac-reconstruct samples <images-folder> <output.usdz> [reduced|medium|full|raw]

"""
var args = Array(CommandLine.arguments.dropFirst())
let samplesMode = args.first == "samples"
if samplesMode { args.removeFirst() }
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]; args.removeSubrange(i...(i + 1)); return value
}
_ = option("--save-masks")   // the companion still passes it; there are no masks to save
// Diagnostics for tests: switch off Apple's own object masking, or drop the photos' depth.
let noObjectMasking = args.contains("--no-object-masking"); args.removeAll { $0 == "--no-object-masking" }
let noDepth = args.contains("--no-depth"); args.removeAll { $0 == "--no-depth" }
guard args.count >= 2 else { FileHandle.standardError.write(Data(usage.utf8)); exit(2) }

let input = URL(fileURLWithPath: args[0], isDirectory: true)
let output = URL(fileURLWithPath: args[1])
let details: [String: PhotogrammetrySession.Request.Detail] = ["reduced": .reduced, "medium": .medium, "full": .full, "raw": .raw]
let detail = details[args.count > 2 ? args[2] : "full"] ?? .full

guard PhotogrammetrySession.isSupported else { fail("Photogrammetry isn't supported on this Mac.") }

var configuration = PhotogrammetrySession.Configuration()
configuration.sampleOrdering = .sequential      // photos are in capture order
configuration.featureSensitivity = .normal
configuration.isObjectMaskingEnabled = !noObjectMasking   // the object, not what's around it

let started = Date()

do {
    let session: PhotogrammetrySession
    if samplesMode {
        let files = try photos(in: input)
        guard !files.isEmpty else { fail("No photos in \(input.path).") }
        // A mirrored photo set rebuilds a mirror-image object: refuse it before anything is built.
        if let mirrored = files.first(where: { isMirrored(orientation: orientation(of: $0)) }) {
            emit(["error": "mirrored-photos", "file": mirrored.lastPathComponent]); exit(4)
        }
        emit(["samples": files.count, "stage": "reconstructing"])
        // Loaded lazily: a few hundred full-resolution photos don't need to sit in memory together.
        let samples = AnySequence<PhotogrammetrySample> {
            var iterator = files.makeIterator()
            return AnyIterator<PhotogrammetrySample> {
                while let file = iterator.next() {
                    do {
                        var sample = try loadSample(file)
                        if noDepth { sample.depthDataMap = nil }
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
        case .processingCancelled:
            fail("cancelled")
        default:
            break
        }
    }
} catch {
    fail(String(describing: error))
}
