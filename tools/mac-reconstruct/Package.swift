// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "mac-reconstruct",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "HandheldKit", path: "Sources/HandheldKit"),
        .executableTarget(name: "mac-reconstruct", dependencies: ["HandheldKit"], path: "Sources/mac-reconstruct"),
        .executableTarget(name: "model-look", path: "Sources/model-look"),
        .executableTarget(name: "model-compare", path: "Sources/model-compare"),
        .executableTarget(name: "turntable-synth", dependencies: ["HandheldKit"], path: "Sources/turntable-synth"),
        .testTarget(name: "HandheldKitTests", dependencies: ["HandheldKit"], path: "Tests/HandheldKitTests"),
    ],
    swiftLanguageModes: [.v5]
)
