// SPDX-License-Identifier: MIT
import Foundation
import RealityKit
import ModelIO
import ReconstructCore

func log(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }

@main struct Runner {
    @MainActor static func main() async {
        if CommandLine.arguments.dropFirst().elementsEqual(["--help"]) { print(Options.usage); return }
        do {
            let options = try Options.parse(Array(CommandLine.arguments.dropFirst()))
            #if !arch(arm64)
            throw Failure("Unsupported hardware: Apple silicon required")
            #endif
            guard #available(macOS 14, *), PhotogrammetrySession.isSupported else { throw Failure("Requires macOS 14+ and supported Apple silicon hardware") }
            try await run(options)
        } catch { log("error: \(error)"); exit(2) }
    }
    @MainActor static func run(_ o: Options) async throws {
        let start = ContinuousClock.now
        let input = URL(fileURLWithPath: o.input).resolvingSymlinksInPath().standardizedFileURL
        let records = try images(in: input)
        let output = URL(fileURLWithPath: o.output).standardizedFileURL
        let report = URL(fileURLWithPath: output.path + ".report.json")
        let obj = o.objDirectory.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL }
        let destinations = [output, report] + (obj.map { [$0] } ?? [])
        for url in destinations {
            let resolved = url.resolvingSymlinksInPath().path
            guard !FileManager.default.fileExists(atPath: url.path), resolved != input.path, !resolved.hasPrefix(input.path + "/") else { throw Failure("Output exists or overlaps input: \(url.path)") }
        }
        guard Set(destinations.map(\.path)).count == destinations.count,
              !destinations.contains(where: { a in destinations.contains(where: { b in a != b && a.path.hasPrefix(b.path + "/") }) }) else { throw Failure("Output destinations overlap") }
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let obj { try FileManager.default.createDirectory(at: obj, withIntermediateDirectories: true) }
        var config = PhotogrammetrySession.Configuration()
        config.sampleOrdering = o.ordering == "sequential" ? .sequential : .unordered
        config.featureSensitivity = o.sensitivity == "high" ? .high : .normal
        config.isObjectMaskingEnabled = o.masking
        let detail: PhotogrammetrySession.Request.Detail
        switch o.detail { case "preview": detail = .preview; case "reduced": detail = .reduced; case "full": detail = .full; case "raw": detail = .raw; default: detail = .medium }
        let session = try PhotogrammetrySession(input: input, configuration: config)
        var timedOut = false
        let timer = Task { @MainActor in
            try await Task.sleep(nanoseconds: UInt64(o.timeoutSeconds * 1_000_000_000))
            timedOut = true; log("Wall-clock limit reached; cancelling session"); session.cancel()
            // Bound a framework that fails to acknowledge cancellation as well.
            try await Task.sleep(nanoseconds: 10_000_000_000)
            log("Cancellation grace expired; partial outputs are not successful results"); exit(124)
        }
        defer { timer.cancel() }
        var requests: [PhotogrammetrySession.Request] = [.modelFile(url: output, detail: detail)]
        if let obj { requests.append(.modelFile(url: obj, detail: detail)) }
        try session.process(requests: requests)
        var completed = 0; var finished = false; var warnings = Set<String>()
        do {
            for try await event in session.outputs {
                switch event {
                case .requestProgress(_, let fraction): log(String(format: "progress %.1f%%", fraction * 100))
                case .requestComplete: completed += 1
                case .requestError(_, let error): throw error
                case .processingComplete: finished = true
                case .processingCancelled: throw Failure(timedOut ? "Wall-clock limit exceeded" : "Session cancelled")
                case .invalidSample(let id, let reason): warnings.insert("invalidSample \(id): \(reason)"); log("invalidSample \(id): \(reason)")
                case .skippedSample(let id): warnings.insert("skippedSample \(id)"); log("skippedSample \(id)")
                case .automaticDownsampling: warnings.insert("automaticDownsampling"); log("automaticDownsampling")
                default: break
                }
                if finished { break }
            }
        } catch { session.cancel(); if timedOut { throw Failure("Wall-clock limit exceeded") }; throw error }
        guard !timedOut, finished, completed == requests.count else { throw Failure("Reconstruction did not complete every request") }
        guard try images(in: input) == records else { throw Failure("Input images changed during reconstruction") }
        var outputs = [try describe(output, name: output.lastPathComponent)]
        if let obj {
            let entries = try FileManager.default.contentsOfDirectory(at: obj, includingPropertiesForKeys: [.isRegularFileKey])
            guard entries.contains(where: { $0.pathExtension.lowercased() == "obj" }) else { throw Failure("API did not produce requested OBJ") }
            for file in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                outputs.append(try describe(file, name: obj.lastPathComponent + "/" + file.lastPathComponent))
            }
        }
        let payload = Payload(os: ProcessInfo.processInfo.operatingSystemVersionString, images: records, options: o, outputs: outputs, warnings: Array(warnings))
        let elapsed = start.duration(to: .now).components
        let result = try Report(payload: payload, elapsedSeconds: Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18)
        let data = try canonical(result)
        try data.write(to: report, options: [.withoutOverwriting])
        print(String(decoding: data, as: UTF8.self))
    }
    static func describe(_ url: URL, name: String) throws -> OutputRecord {
        var vertices: Int?; var triangles: Int?
        if ["usdz", "obj"].contains(url.pathExtension.lowercased()) {
            let asset = MDLAsset(url: url)
            let meshes = asset.childObjects(of: MDLMesh.self) as? [MDLMesh] ?? []
            if !meshes.isEmpty {
                vertices = meshes.reduce(0) { $0 + $1.vertexCount }
                var count = 0; var allTriangles = true
                for mesh in meshes { for sub in mesh.submeshes as? [MDLSubmesh] ?? [] {
                    if sub.geometryType == .triangles { count += sub.indexCount / 3 } else { allTriangles = false }
                } }
                if allTriangles { triangles = count }
            }
        }
        return OutputRecord(name: name, sha256: try fileDigest(url), vertices: vertices, triangles: triangles)
    }
}
