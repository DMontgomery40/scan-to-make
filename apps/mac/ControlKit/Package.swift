// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ControlKit", platforms: [.macOS(.v13)],
    products: [.library(name: "ControlKit", targets: ["ControlKit"])],
    targets: [.target(name: "ControlKit"), .testTarget(name: "ControlKitTests", dependencies: ["ControlKit"])]
)
