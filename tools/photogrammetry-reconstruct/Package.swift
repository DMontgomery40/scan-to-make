// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "PhotogrammetryReconstruct", platforms: [.macOS(.v14)],
    products: [.executable(name: "photogrammetry-reconstruct", targets: ["Reconstruct"])],
    targets: [.target(name: "ReconstructCore"), .executableTarget(name: "Reconstruct", dependencies: ["ReconstructCore"]),
              .testTarget(name: "ReconstructCoreTests", dependencies: ["ReconstructCore"])])
