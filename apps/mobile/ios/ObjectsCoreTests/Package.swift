// swift-tools-version:5.9
// Tests the phone's object words (pure Foundation) on the Mac: `swift test --package-path apps/mobile/ios/ObjectsCoreTests`.
import PackageDescription
let package = Package(
    name: "ObjectsCore",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "ObjectsCore", path: "Sources/ObjectsCore"),
        .testTarget(name: "ObjectsCoreTests", dependencies: ["ObjectsCore"], path: "Tests/ObjectsCoreTests"),
    ]
)
