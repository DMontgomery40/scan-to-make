// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "DepthCapture", platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "DepthCapture", targets: ["DepthCapture"])],
    targets: [.target(name: "DepthCapture"), .testTarget(name: "DepthCaptureTests", dependencies: ["DepthCapture"])])
