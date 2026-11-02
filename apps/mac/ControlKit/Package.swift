// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ControlKit", platforms: [.macOS(.v14)],
    products: [.library(name: "ControlKit", targets: ["ControlKit"])],
    dependencies: [.package(name: "AgentKit", path: ".."), .package(path: "../../../packages/CounterpartKit")],
    targets: [.target(name: "ControlKit", dependencies: [.product(name: "AgentKit", package: "AgentKit"), .product(name: "CounterpartKit", package: "CounterpartKit")]), .testTarget(name: "ControlKitTests", dependencies: ["ControlKit", .product(name: "CounterpartKit", package: "CounterpartKit")])]
)
