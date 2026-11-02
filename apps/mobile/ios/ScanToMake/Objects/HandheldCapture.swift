import Foundation

/// A Scan in hand capture saved on this phone before Scan in hand was switched off (KAN-217 P0: its LiDAR
/// session left the phone's camera black). The phone no longer records one: walking around the object, with a
/// flip for its underside, is the scan. A finished capture still on the phone can still be sent, and the Mac
/// rebuilds it (MacConnection.sendHandheld).
enum HandheldCapture {
    /// One folder per object: Documents/HandheldCaptures/<object id>/0000.heic … plus `finished` when complete.
    static func folder(_ objectId: String) -> URL {
        URL.documentsDirectory.appending(path: "HandheldCaptures/\(objectId)", directoryHint: .isDirectory)
    }
    /// A capture that finished on this phone, so a send cut short can resume.
    static func finished(_ objectId: String) -> Bool {
        FileManager.default.fileExists(atPath: folder(objectId).appending(path: "finished").path)
    }
}
