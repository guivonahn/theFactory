// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FactoryMenuBar",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "FactoryMenuBar", targets: ["FactoryMenuBar"])],
    targets: [
        .executableTarget(name: "FactoryMenuBar")
    ]
)
