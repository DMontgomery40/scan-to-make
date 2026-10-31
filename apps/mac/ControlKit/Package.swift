// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ControlKit", platforms: [.macOS(.v13)],
    products: [.library(name: "ControlKit", targets: ["ControlKit"])],
    dependencies: [.package(name: "AgentKit", path: "..")],
    targets: [.target(name: "ControlKit", dependencies: [.product(name: "AgentKit", package: "AgentKit")]), .testTarget(name: "ControlKitTests", dependencies: ["ControlKit"])]
)
