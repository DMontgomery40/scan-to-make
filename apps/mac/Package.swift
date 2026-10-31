// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AgentKit", platforms: [.macOS(.v13)], products: [.library(name: "AgentKit", targets: ["AgentKit"])], targets: [.target(name: "AgentKit", path: "AgentKit"), .testTarget(name: "AgentKitTests", dependencies: ["AgentKit"], path: "Tests", exclude: ["runtime.test.mjs"])])
