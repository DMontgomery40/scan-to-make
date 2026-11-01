import Foundation
#if canImport(ControlKit)
import ControlKit
#endif

/// What Settings and the menu-bar popover say about Scan to Make on this Mac: the control socket's
/// `status.get` and `devices.list`, and the address the iPhone reaches it at.
protocol MacStatusSource: Sendable {
    func status() async throws -> ControlStatus
    func devices() async throws -> [ControlDevice]
    func removeDevice(_ id: String) async throws
    /// The host (and port) paired iPhones use, from this Mac's own settings; nil if it can't be read.
    func address() -> String?
}

/// The control socket, a fresh client per call; the address from the pairing settings on disk.
struct SocketMacStatus: MacStatusSource {
    let path: String
    let settings: URL
    func status() async throws -> ControlStatus { try await ControlClient(socketPath:path).status() }
    func devices() async throws -> [ControlDevice] { try await ControlClient(socketPath:path).devices() }
    func removeDevice(_ id: String) async throws { try await ControlClient(socketPath:path).removeDevice(id) }
    func address() -> String? {
        // Only `configuration.host` is read; nothing else in the file is decoded.
        struct File: Decodable { struct Configuration: Decodable { let host: String? }; let configuration: Configuration? }
        guard let data = try? Data(contentsOf:settings) else { return nil }
        return (try? JSONDecoder().decode(File.self, from:data))?.configuration?.host
    }
}

@MainActor final class MacStatusModel: ObservableObject {
    enum Connection: Equatable { case checking, running, notRunning }

    @Published private(set) var connection = Connection.checking
    @Published private(set) var devices: [ControlDevice] = []
    @Published private(set) var address: String?
    @Published private(set) var version: String?
    /// One sentence about a removal that didn't go through.
    @Published private(set) var problem: String?
    private let source: any MacStatusSource

    init(source: any MacStatusSource) { self.source = source }

    func refresh() async {
        do {
            let status = try await source.status()
            let devices = try await source.devices()
            connection = .running
            version = status.companionVersion
            self.devices = devices
            address = source.address()
        } catch {
            connection = .notRunning
            devices = []
            address = nil
        }
    }

    /// Unpairs one iPhone. Returns whether it went through.
    @discardableResult func remove(_ id: String) async -> Bool {
        problem = nil
        do {
            try await source.removeDevice(id)
            devices.removeAll { $0.deviceId == id }
            return true
        } catch {
            problem = "That iPhone couldn’t be removed. Try again."
            return false
        }
    }
}
