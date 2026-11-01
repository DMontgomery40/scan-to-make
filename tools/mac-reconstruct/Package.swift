// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "mac-reconstruct",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(name: "mac-reconstruct", path: "Sources/mac-reconstruct"),
        .executableTarget(name: "model-look", path: "Sources/model-look"),
    ],
    swiftLanguageModes: [.v5]
)
