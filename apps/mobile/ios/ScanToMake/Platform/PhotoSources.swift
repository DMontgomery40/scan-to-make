import UIKit
import PhotosUI
import UniformTypeIdentifiers
import CounterpartKit

/// A photo picked or taken on this phone: its bytes and file extension.
struct PickedPhoto: Sendable {
    var data: Data
    var ext: String
}

/// The system photo picker and camera, presented from whatever is on screen. Photos never pass through a
/// path the user can't see: they go from the picker or camera straight to the cache or the Mac.
@MainActor enum PhotoSources {
    static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.sorted { ($0.activationState == .foregroundActive ? 0 : 1) < ($1.activationState == .foregroundActive ? 0 : 1) }.flatMap(\.windows)
        var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }

    /// Up to `limit` photos from the library (HEIC, JPEG or PNG). Empty when cancelled.
    static func pick(limit: Int) async throws -> [PickedPhoto] {
        guard let presenter = topViewController() else { throw CompanionError(code: "busy", message: "Close the current sheet first.") }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = max(1, min(limit, 24))
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        let delegate = PickerDelegate()
        picker.delegate = delegate
        picker.presentationController?.delegate = delegate
        let results: [PHPickerResult] = await withCheckedContinuation { continuation in
            delegate.done = { continuation.resume(returning: $0) }
            presenter.present(picker, animated: true)
        }
        var photos: [PickedPhoto] = []
        for result in results {
            for (type, ext) in [(UTType.heic, "heic"), (.jpeg, "jpg"), (.png, "png")] where result.itemProvider.hasItemConformingToTypeIdentifier(type.identifier) {
                if let data = try? await load(result.itemProvider, type), !data.isEmpty, data.count <= CompanionClient.photoLimit {
                    photos.append(PickedPhoto(data: data, ext: ext))
                }
                break
            }
        }
        return photos
    }

    private static func load(_ provider: NSItemProvider, _ type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
                if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
            }
        }
    }

    /// One photo from the camera, as JPEG. Nil when cancelled.
    static func takePhoto() async throws -> PickedPhoto? {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            throw CompanionError(code: "no-camera", message: "This device has no camera. Choose photos instead.")
        }
        guard let presenter = topViewController() else { throw CompanionError(code: "busy", message: "Close the current sheet first.") }
        let camera = UIImagePickerController()
        camera.sourceType = .camera
        let delegate = CameraDelegate()
        camera.delegate = delegate
        camera.presentationController?.delegate = delegate
        let image: UIImage? = await withCheckedContinuation { continuation in
            delegate.done = { continuation.resume(returning: $0) }
            presenter.present(camera, animated: true)
        }
        guard let jpeg = image?.jpegData(compressionQuality: 0.9), !jpeg.isEmpty else { return nil }
        return PickedPhoto(data: jpeg, ext: "jpg")
    }

    /// A close-up's file name: `closeup-<ms>-<8 hex>.<ext>`.
    static func closeupName(_ ext: String) -> String {
        "closeup-\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8).lowercased()).\(ext)"
    }
}

private final class PickerDelegate: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    var done: (([PHPickerResult]) -> Void)?
    private var answered = false
    // Keeps itself alive while the picker is up.
    private var keepAlive: PickerDelegate?
    override init() { super.init(); keepAlive = self }
    private func finish(_ results: [PHPickerResult]) {
        guard !answered else { return }
        answered = true
        done?(results); done = nil; keepAlive = nil
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        finish(results)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish([]) }
}

private final class CameraDelegate: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
    var done: ((UIImage?) -> Void)?
    private var answered = false
    private var keepAlive: CameraDelegate?
    override init() { super.init(); keepAlive = self }
    private func finish(_ image: UIImage?) {
        guard !answered else { return }
        answered = true
        done?(image); done = nil; keepAlive = nil
    }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        finish(info[.originalImage] as? UIImage)
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(nil)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }
}
