import Foundation
import RealityKit

// Rebuilds a model from an Object Capture photo folder with Apple's PhotogrammetrySession on the Mac,
// where detail levels above the iPhone's `.reduced` are available (WWDC23 10191, WWDC24 10107).
// Usage: mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]
// Prints one JSON line per progress step and a final {"done":…} or {"error":…} line.

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]\n".utf8))
    exit(2)
}
let input = URL(fileURLWithPath: args[1], isDirectory: true)
let output = URL(fileURLWithPath: args[2])
let details: [String: PhotogrammetrySession.Request.Detail] = ["reduced": .reduced, "medium": .medium, "full": .full, "raw": .raw]
let detail = details[args.count > 3 ? args[3] : "full"] ?? .full

guard PhotogrammetrySession.isSupported else { emit(["error": "Photogrammetry isn't supported on this Mac."]); exit(1) }

var configuration = PhotogrammetrySession.Configuration()
configuration.sampleOrdering = .sequential      // Object Capture photos are in capture order
configuration.featureSensitivity = .normal
configuration.isObjectMaskingEnabled = true    // the object, not the table it stands on

let started = Date()
do {
    let session = try PhotogrammetrySession(input: input, configuration: configuration)
    try session.process(requests: [.modelFile(url: output, detail: detail)])
    for try await out in session.outputs {
        switch out {
        case .requestProgress(_, let fraction):
            emit(["progress": (fraction * 100).rounded() / 100])
        case .requestComplete(_, .modelFile(let url)):
            emit(["done": url.path, "seconds": Int(Date().timeIntervalSince(started))])
        case .requestError(_, let error):
            emit(["error": String(describing: error)])
            exit(1)
        case .processingComplete:
            exit(0)
        case .invalidSample(let id, let reason):
            emit(["skipped": id, "reason": reason])
        case .processingCancelled:
            emit(["error": "cancelled"]); exit(1)
        default:
            break
        }
    }
} catch {
    emit(["error": String(describing: error)])
    exit(1)
}
