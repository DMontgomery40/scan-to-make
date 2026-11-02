import SwiftUI
import VisionKit
import AVFoundation

/// Reads the pairing QR code with VisionKit's `DataScannerViewController` (live camera, system
/// highlighting). It only scans while `armed`; one camera at a time.
struct QRScanner: UIViewControllerRepresentable {
    var armed: Bool
    var found: (String) -> Void
    var unavailable: () -> Void

    /// DataScanner needs a supported device with camera access; the Simulator has neither.
    @MainActor static var isSupported: Bool { DataScannerViewController.isSupported }
    @MainActor static var isAvailable: Bool { DataScannerViewController.isAvailable }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
                                                isPinchToZoomEnabled: true, isGuidanceEnabled: false, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.found = found
        context.coordinator.unavailable = unavailable
        context.coordinator.armed = armed
        if armed, !scanner.isScanning {
            guard DataScannerViewController.isAvailable else { context.coordinator.reportUnavailable(); return }
            do { try scanner.startScanning() } catch { context.coordinator.reportUnavailable() }
        }
        if !armed, scanner.isScanning { scanner.stopScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        coordinator.dismantled = true
        if scanner.isScanning { scanner.stopScanning() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(found: found, unavailable: unavailable) }

    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var found: (String) -> Void
        var unavailable: () -> Void
        var armed = false
        var dismantled = false
        private var failureReported = false
        init(found: @escaping (String) -> Void, unavailable: @escaping () -> Void) {
            self.found = found; self.unavailable = unavailable
        }

        func reportUnavailable() {
            guard armed, !dismantled, !failureReported else { return }
            failureReported = true
            // A representable update must finish before its owner changes the view hierarchy.
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.dismantled else { return }
                guard self.armed else { self.failureReported = false; return }
                self.unavailable()
            }
        }

        private func use(_ items: [RecognizedItem]) {
            for item in items {
                if case .barcode(let code) = item, let text = code.payloadStringValue, !text.isEmpty { found(text); return }
            }
        }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) { use(addedItems) }
        func dataScanner(_ scanner: DataScannerViewController, didTapOn item: RecognizedItem) { use([item]) }
        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            reportUnavailable()
        }
    }
}

/// Whether the camera may be used, asking once with the reason in Info.plist.
enum CameraAccess {
    case allowed, denied, unavailable

    static func current() async -> CameraAccess {
        guard await QRScanner.isSupported else { return .unavailable }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .allowed
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
        default: return .denied
        }
    }
}
