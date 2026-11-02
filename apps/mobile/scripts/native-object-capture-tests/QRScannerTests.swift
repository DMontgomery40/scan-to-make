import Foundation

// VisionKit's camera is the boundary: controller state and error delivery are controlled here.
@MainActor protocol DataScannerViewControllerDelegate: AnyObject {
    func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable)
}
extension DataScannerViewControllerDelegate {
    func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {}
}
@MainActor final class DataScannerViewController {
    enum ScanningUnavailable: Error { case cameraRestricted }
    static var isAvailable = true
    var isScanning = false
    var shouldFail = false
    func startScanning() throws {
        if shouldFail { throw ScanningUnavailable.cameraRestricted }
        isScanning = true
    }
    func stopScanning() { isScanning = false }
}
enum RecognizedItem {
    struct Barcode { let payloadStringValue: String? }
    case barcode(Barcode), text
}
@MainActor struct QRScanner {
    var armed: Bool
    var found: (String) -> Void
    var unavailable: () -> Void
    struct Context { let coordinator: Coordinator }
    // QR_METHODS
}

@main struct QRScannerTests {
    @MainActor static func main() async {
        var failures: [String] = []
        func check(_ condition: Bool, _ message: String) {
            if condition { print("PASS " + message) } else { print("FAIL " + message); failures.append(message) }
        }
        func drain() async { await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } } }
        var errors = 0
        var scanner = QRScanner(armed: true, found: { _ in }, unavailable: { errors += 1 })
        let coordinator = scanner.makeCoordinator(), camera = DataScannerViewController()
        camera.shouldFail = true
        scanner.updateUIViewController(camera, context: .init(coordinator: coordinator))
        await drain()
        check(errors == 1, "startup failure reaches the camera-unavailable UI")
        scanner.updateUIViewController(camera, context: .init(coordinator: coordinator))
        coordinator.dataScanner(camera, becameUnavailableWithError: .cameraRestricted)
        await drain()
        check(errors == 1, "one failed controller reports only once")
        QRScanner.dismantleUIViewController(camera, coordinator: coordinator)

        let healthy = scanner.makeCoordinator(), healthyCamera = DataScannerViewController()
        scanner.updateUIViewController(healthyCamera, context: .init(coordinator: healthy))
        await drain()
        check(healthyCamera.isScanning && errors == 1, "a fresh retry starts normally without repeating the prior error")
        healthy.dataScanner(healthyCamera, becameUnavailableWithError: .cameraRestricted)
        await drain()
        check(errors == 2, "running scanner interruption reaches the UI")
        QRScanner.dismantleUIViewController(healthyCamera, coordinator: healthy)

        let dismissed = scanner.makeCoordinator(), dismissedCamera = DataScannerViewController()
        dismissedCamera.shouldFail = true
        scanner.updateUIViewController(dismissedCamera, context: .init(coordinator: dismissed))
        QRScanner.dismantleUIViewController(dismissedCamera, coordinator: dismissed)
        await drain()
        check(errors == 2, "a queued error cannot affect a dismissed scanner")

        let inactive = scanner.makeCoordinator(), inactiveCamera = DataScannerViewController()
        scanner.armed = false
        scanner.updateUIViewController(inactiveCamera, context: .init(coordinator: inactive))
        inactive.dataScanner(inactiveCamera, becameUnavailableWithError: .cameraRestricted)
        await drain()
        check(errors == 2 && !inactiveCamera.isScanning, "background suspension is not reported as a camera failure")
        scanner.armed = true
        DataScannerViewController.isAvailable = false
        scanner.updateUIViewController(inactiveCamera, context: .init(coordinator: inactive))
        await drain()
        check(errors == 3, "restricted camera availability is visible instead of an idle black scanner")
        DataScannerViewController.isAvailable = true
        let suspended = scanner.makeCoordinator(), suspendedCamera = DataScannerViewController()
        suspendedCamera.shouldFail = true
        scanner.updateUIViewController(suspendedCamera, context: .init(coordinator: suspended))
        scanner.armed = false
        scanner.updateUIViewController(suspendedCamera, context: .init(coordinator: suspended))
        await drain()
        check(errors == 3, "backgrounding suppresses a queued failure")
        scanner.armed = true
        scanner.updateUIViewController(suspendedCamera, context: .init(coordinator: suspended))
        await drain()
        check(errors == 4, "returning to a still-failed camera reports the failure again")
        guard failures.isEmpty else { fatalError(failures.joined(separator: "; ")) }
    }
}
