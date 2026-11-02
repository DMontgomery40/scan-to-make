// swift-tools-version: 6.0
// Counterpart's shared Swift code for the iPhone, iPad and (later) Mac apps: the domain model,
// the one source of status words, the formatters, pairing and the companion API client.
// Domain/transport code plus the native Project Settings form. `swift test --package-path packages/CounterpartKit`.
import PackageDescription

let package = Package(
    name: "CounterpartKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CounterpartKit", targets: ["CounterpartKit"])],
    targets: [
        .target(name: "CounterpartKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(
            name: "CounterpartKitTests",
            dependencies: ["CounterpartKit"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
