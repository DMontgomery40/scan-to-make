import Foundation
import AppKit
import Vision
import simd
import HandheldKit

// Synthetic handheld captures for testing `mac-reconstruct samples` against a known model.
//
//   turntable-synth render <model.usdz> <background-photo> <hand-photo> <out-dir> [--per-pass 30] [--orientation 1|6]
//       A fixed camera (the iPhone's field of view, 2016×1512) watches the model turn through three passes:
//       upright, upside down, and on its side, with hand wobble. A still real photo sits 0.8 m behind it, and in
//       half the frames a real hand (cut out of <hand-photo>) holds it. Writes frames/*.heic with embedded depth
//       (DepthFloat32 640×480, planar metres) and EXIF focal length but no gravity or pose, as the phone will,
//       plus ground truth: truth-object/*.png, truth-hand/*.png and truth.json.
//   turntable-synth score <out-dir> <masks-dir>
//       Compares masks with the ground truth: IoU with the object and how much of the hand they include.
//   turntable-synth overlay <images-dir> <masks-dir> <out.png> [--every N]
//       A contact sheet of masks over the stored pixels (the orientation the masks are in).

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); fflush(stdout)
}

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let value = args[i + 1]; args.removeSubrange(i...(i + 1)); return value
}

// The iPhone's camera: fx 2932.9 px at 4032 px wide (measured from an Object Capture photo's calibration).
let phoneCamera = Pinhole(width: 2016, height: 1512, fx: 2932.86 / 2)
let depthCamera = phoneCamera.scaled(toWidth: 640)
let backgroundDepth: Float = 0.8
let objectDistance: Float = 0.25

/// The hand from a real photo of a hand holding an object: person segmentation minus the held object.
func handCutout(from url: URL) async throws -> (image: CGImage, holeCentre: CGPoint, holeSize: CGFloat) {
    let photo = try loadStoredImage(url)
    let buffer = try pixelBuffer(from: photo)
    let handler = VNImageRequestHandler(cvPixelBuffer: buffer, options: [:])
    let person = VNGeneratePersonSegmentationRequest(); person.qualityLevel = .accurate
    try handler.perform([person])
    guard let personMask = person.results?.first?.pixelBuffer else { throw HandheldError.io("no person in \(url.path)") }
    let personGray = GrayImage(buffer: personMask).resized(width: photo.width, height: photo.height)
    let object = try await ObjectMasker().mask(image: buffer, depth: nil).mask
    // Grow the object a little so its rim doesn't stay on the hand.
    var grown = object
    let r = max(4, photo.width / 200)
    for y in 0..<object.height { for x in 0..<object.width where object[x, y] > 127 {
        if x % 2 == 0 && y % 2 == 0 { for dy in -r...r { for dx in -r...r {
            let nx = x + dx, ny = y + dy
            if nx >= 0, ny >= 0, nx < object.width, ny < object.height { grown[nx, ny] = 255 }
        } } }
    } }
    var canvas = Canvas.from(photo)
    var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
    for y in 0..<photo.height { for x in 0..<photo.width {
        let i = (y * photo.width + x) * 4
        // Person segmentation leaves a faint haze over the background; keep only the confident part, softly edged.
        let a = grown[x, y] > 127 ? 0 : max(0, min(255, (Int(personGray[x, y]) - 115) * 255 / 50))
        for c in 0..<3 { canvas.rgba[i + c] = UInt8(Int(canvas.rgba[i + c]) * a / 255) }
        canvas.rgba[i + 3] = UInt8(a)
        if object[x, y] > 127 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) }
    } }
    guard minX <= maxX else { throw HandheldError.io("no held object found in \(url.path)") }
    return (canvas.cgImage(opaque: false), CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2), CGFloat(max(maxX - minX, maxY - minY)))
}

func render() async throws {
    let perPass = Int(option("--per-pass") ?? "30") ?? 30
    let orientation = UInt32(option("--orientation") ?? "1") ?? 1
    guard args.count >= 5 else { throw HandheldError.io("usage: turntable-synth render <model.usdz> <background> <hand-photo> <out-dir>") }
    let modelURL = URL(fileURLWithPath: args[1]), backgroundURL = URL(fileURLWithPath: args[2])
    let handURL = URL(fileURLWithPath: args[3]), out = URL(fileURLWithPath: args[4], isDirectory: true)
    let fm = FileManager.default
    for sub in ["frames", "truth-object", "truth-hand"] { try fm.createDirectory(at: out.appendingPathComponent(sub), withIntermediateDirectories: true) }

    let renderer = ModelRenderer(modelURL: modelURL, camera: phoneCamera)
    let background = try loadStoredImage(backgroundURL)
    let hand = try await handCutout(from: handURL)
    try writePNG(hand.image, to: out.appendingPathComponent("hand-cutout.png"))

    // Fill the frame with the background (centre crop).
    let scale = max(Double(phoneCamera.width) / Double(background.width), Double(phoneCamera.height) / Double(background.height))
    let bw = Double(background.width) * scale, bh = Double(background.height) * scale
    let backgroundRect = CGRect(x: (Double(phoneCamera.width) - bw) / 2, y: (Double(phoneCamera.height) - bh) / 2, width: bw, height: bh)

    let passes: [(name: String, base: simd_float4x4)] = [
        ("upright", rotation(0.25, [1, 0, 0])),
        ("upside-down", rotation(0.25, [1, 0, 0]) * rotation(.pi, [1, 0, 0])),
        ("on-its-side", rotation(0.25, [1, 0, 0]) * rotation(.pi / 2, [0, 0, 1])),
    ]
    var frames: [[String: Any]] = []
    var index = 0
    for (p, pass) in passes.enumerated() {
        for k in 0..<perPass {
            let t = Double(k) / Double(perPass)
            let turn = 2 * .pi * t + Double(p) * 0.4
            let wobble = rotation(0.10 * sin(2 * .pi * t * 3 + Double(p)), [1, 0, 0]) * rotation(0.08 * cos(2 * .pi * t * 2), [0, 0, 1])
            let drift = SIMD3<Float>(Float(0.004 * sin(2 * .pi * t * 2)), Float(0.003 * cos(2 * .pi * t * 3)), -objectDistance + Float(0.008 * sin(2 * .pi * t)))
            let transform = translation(drift) * wobble * rotation(turn, [0, 1, 0]) * pass.base

            var canvas = Canvas(width: phoneCamera.width, height: phoneCamera.height)
            canvas.draw(background, in: backgroundRect)
            let model = renderer.render(transform: transform)
            let modelCanvas = Canvas.from(model)
            canvas.draw(model, in: CGRect(x: 0, y: 0, width: phoneCamera.width, height: phoneCamera.height))

            var object = GrayImage(width: phoneCamera.width, height: phoneCamera.height)
            var minX = Int.max, maxX = 0, minY = Int.max, maxY = 0
            for y in 0..<object.height { for x in 0..<object.width where modelCanvas.alpha(x: x, y: y) > 127 {
                object[x, y] = 255; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            } }
            var handMask = GrayImage(width: phoneCamera.width, height: phoneCamera.height)
            let holding = k % 10 >= 3 && k % 10 < 8
            if holding, minX <= maxX {
                // Scale the cut-out so its held object matches this frame's model, and line the two up.
                let size = CGFloat(max(maxX - minX, maxY - minY))
                let s = size / hand.holeSize * CGFloat(1 + 0.05 * sin(Double(k)))
                let centre = CGPoint(x: CGFloat(minX + maxX) / 2 + CGFloat(6 * sin(Double(k))), y: CGFloat(minY + maxY) / 2)
                let rect = CGRect(x: centre.x - hand.holeCentre.x * s, y: centre.y - hand.holeCentre.y * s,
                                  width: CGFloat(hand.image.width) * s, height: CGFloat(hand.image.height) * s)
                canvas.draw(hand.image, in: rect)
                var handLayer = Canvas(width: phoneCamera.width, height: phoneCamera.height)
                handLayer.draw(hand.image, in: rect)
                for y in 0..<handMask.height { for x in 0..<handMask.width where handLayer.alpha(x: x, y: y) > 127 {
                    handMask[x, y] = 255; object[x, y] = 0
                } }
            }

            // Depth: model by rasterising its mesh, the still photo at 0.8 m, the hand just in front of the model.
            var depth = renderer.mesh.depth(transform: transform, camera: depthCamera)
            let nearest = depth.filter { $0 > 0 }.min() ?? objectDistance
            let handSmall = handMask.resized(width: depthCamera.width, height: depthCamera.height)
            for i in depth.indices {
                if handSmall.pixels[i] > 127 { depth[i] = nearest - 0.01 } else if depth[i] == 0 { depth[i] = backgroundDepth }
            }

            let name = String(format: "%04d", index)
            try writePhoto(canvas.cgImage(), depth: DepthImage(width: depthCamera.width, height: depthCamera.height, metres: depth),
                           camera: PhotoCamera(focalPixels: phoneCamera.fx, orientation: orientation),
                           to: out.appendingPathComponent("frames/\(name).heic"))
            try object.writePNG(to: out.appendingPathComponent("truth-object/\(name).png"))
            try handMask.writePNG(to: out.appendingPathComponent("truth-hand/\(name).png"))
            frames.append(["name": name, "pass": pass.name, "hand": holding, "objectPixels": object.onCount, "handPixels": handMask.onCount])
            emit(["frame": name, "pass": pass.name, "hand": holding])
            index += 1
        }
    }
    let truth: [String: Any] = [
        "model": modelURL.path, "background": backgroundURL.path, "handPhoto": handURL.path,
        "image": [phoneCamera.width, phoneCamera.height], "fx": phoneCamera.fx, "depth": [depthCamera.width, depthCamera.height],
        "objectDistanceM": objectDistance, "backgroundDepthM": backgroundDepth, "orientation": orientation, "frames": frames,
    ]
    try JSONSerialization.data(withJSONObject: truth, options: [.prettyPrinted, .sortedKeys]).write(to: out.appendingPathComponent("truth.json"))
}

func score() throws {
    guard args.count >= 3 else { throw HandheldError.io("usage: turntable-synth score <out-dir> <masks-dir>") }
    let out = URL(fileURLWithPath: args[1]), masks = URL(fileURLWithPath: args[2])
    let names = try FileManager.default.contentsOfDirectory(atPath: out.appendingPathComponent("truth-object").path).filter { $0.hasSuffix(".png") }.sorted()
    var ious: [Double] = [], handShares: [Double] = [], worst: [(String, Double)] = []
    for name in names {
        let truth = try GrayImage(contentsOf: out.appendingPathComponent("truth-object/\(name)")).thresholded()
        let hand = try GrayImage(contentsOf: out.appendingPathComponent("truth-hand/\(name)")).thresholded()
        let predicted = try GrayImage(contentsOf: masks.appendingPathComponent(name)).resized(width: truth.width, height: truth.height).thresholded()
        var both = 0, either = 0, handIn = 0
        for i in truth.pixels.indices {
            let t = truth.pixels[i] > 127, p = predicted.pixels[i] > 127
            if t && p { both += 1 }
            if t || p { either += 1 }
            if p && hand.pixels[i] > 127 { handIn += 1 }
        }
        let iou = either == 0 ? 1 : Double(both) / Double(either)
        ious.append(iou); worst.append((name, iou))
        if hand.onCount > 0 { handShares.append(Double(handIn) / Double(hand.onCount)) }
    }
    worst.sort { $0.1 < $1.1 }
    func r(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }
    emit([
        "frames": names.count,
        "meanIoU": r(ious.reduce(0, +) / Double(max(1, ious.count))), "minIoU": r(ious.min() ?? 0),
        "worst": worst.prefix(5).map { "\($0.0)=\(r($0.1))" },
        "framesWithHand": handShares.count,
        "meanHandIncluded": r(handShares.reduce(0, +) / Double(max(1, handShares.count))), "maxHandIncluded": r(handShares.max() ?? 0),
    ])
}

func overlay() throws {
    let every = Int(option("--every") ?? "1") ?? 1
    guard args.count >= 4 else { throw HandheldError.io("usage: turntable-synth overlay <images-dir> <masks-dir> <out.png>") }
    let files = try photos(in: URL(fileURLWithPath: args[1]))
    let masks = URL(fileURLWithPath: args[2])
    let tile = 400
    var tiles: [CGImage] = []
    for (i, file) in files.enumerated() where i % every == 0 {
        let maskURL = masks.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".png")
        guard FileManager.default.fileExists(atPath: maskURL.path) else { continue }
        let stored = try loadStoredImage(file)
        let th = tile * stored.height / stored.width
        var canvas = Canvas(width: tile, height: th)
        canvas.draw(stored, in: CGRect(x: 0, y: 0, width: tile, height: th))
        let mask = try GrayImage(contentsOf: maskURL).resized(width: tile, height: th)
        for p in mask.pixels.indices where mask.pixels[p] > 127 {
            canvas.rgba[p * 4] = UInt8(min(255, Int(canvas.rgba[p * 4]) / 2 + 128))
            canvas.rgba[p * 4 + 1] = canvas.rgba[p * 4 + 1] / 2
            canvas.rgba[p * 4 + 2] = canvas.rgba[p * 4 + 2] / 2
        }
        tiles.append(canvas.cgImage())
    }
    guard let first = tiles.first else { throw HandheldError.io("no masks to show") }
    let columns = min(6, tiles.count), rows = (tiles.count + columns - 1) / columns
    var sheet = Canvas(width: columns * tile, height: rows * first.height)
    for (i, t) in tiles.enumerated() {
        sheet.draw(t, in: CGRect(x: (i % columns) * tile, y: (i / columns) * first.height, width: tile, height: first.height))
    }
    try writePNG(sheet.cgImage(), to: URL(fileURLWithPath: args[3]))
}

do {
    switch args.first {
    case "render": try await render()
    case "score": try score()
    case "overlay": try overlay()
    default:
        FileHandle.standardError.write(Data("usage: turntable-synth render|score|overlay …\n".utf8)); exit(2)
    }
} catch {
    emit(["error": String(describing: error)]); exit(1)
}
