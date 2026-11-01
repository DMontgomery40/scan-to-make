// Decodes every QR code in an image with Apple's Vision framework (what the iPhone camera uses).
// Usage: swift qr_decode.swift image.png   -> one payload per line
import Foundation
import Vision
import CoreImage

guard CommandLine.arguments.count == 2, let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("usage: qr_decode.swift image.png\n".data(using: .utf8)!)
    exit(2)
}
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(ciImage: image).perform([request])
let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
for payload in Set(payloads).sorted() { print(payload) }
exit(payloads.isEmpty ? 1 : 0)
