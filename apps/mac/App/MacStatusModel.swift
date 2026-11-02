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
    @discardableResult func remove(_ id: String) async -> Bool { await remove([id]) }

    /// Unpairs a row: the device and every older pairing with its name. Returns whether all of them went.
    @discardableResult func remove(_ ids: [String]) async -> Bool {
        problem = nil
        var failed = false
        for id in ids {
            do {
                try await source.removeDevice(id)
                devices.removeAll { $0.deviceId == id }
            } catch {
                failed = true
            }
        }
        if failed { problem = "That phone couldn’t be removed. Try again." }
        return !failed
    }

    /// One row per phone or iPad (Settings → Phones and iPads).
    /// One row per phone, from the pairings with a stable identity.
    var groups: [DeviceGroup] { DeviceGroup.groups(devices.filter { $0.legacy != true }) }
    /// Pairings from before stable identity, when the companion marks them: listed apart, never as connected.
    var legacy: [ControlDevice] { devices.filter { $0.legacy == true }.sorted { $0.seenAt > $1.seenAt } }
}

/// One row in Settings → Phones and iPads. Re-pairing the same installation keeps one device on a current
/// companion; re-pairs from before that live on as separate credentials with the same name, and are shown in the
/// row of the pairing that replaced them, removed with it, and counted.
struct DeviceGroup: Identifiable, Equatable {
    let primary: ControlDevice
    /// Every device id in the group, the primary first.
    let ids: [String]
    var id: String { primary.deviceId }
    var older: Int { ids.count - 1 }
    /// When the older pairings were last used, for the row that offers to remove them.
    var olderSeenAt: Double = 0

    static func == (a: DeviceGroup, b: DeviceGroup) -> Bool { a.ids == b.ids && a.primary.seenAt == b.primary.seenAt }

    /// One row per phone. A pairing that hasn't been used since a newer one with the same name (and model) paired
    /// is shown under that row as an older pairing, never removed with it: Remove takes only the row's own
    /// pairing, and older ones go only when the person asks for exactly that. Most recently seen first.
    static func groups(_ devices: [ControlDevice]) -> [DeviceGroup] {
        func name(_ device: ControlDevice) -> String { device.deviceName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        var owner: [String: String] = [:] // device id -> the device whose row it joins
        for device in devices {
            let newer = devices.filter { $0.deviceId != device.deviceId && name($0) == name(device) && $0.pairedAt > device.pairedAt
                                         && device.seenAt <= $0.pairedAt && (device.model == nil || $0.model == nil || device.model == $0.model) }
            if let replacement = newer.max(by: { $0.pairedAt < $1.pairedAt }) { owner[device.deviceId] = replacement.deviceId }
        }
        func root(_ id: String) -> String { var id = id; var hops = 0; while let next = owner[id], hops < 64 { id = next; hops += 1 }; return id }
        let byRoot = Dictionary(grouping: devices) { root($0.deviceId) }
        return byRoot.compactMap { rootId, members -> DeviceGroup? in
            guard let primary = members.first(where: { $0.deviceId == rootId }) else { return nil }
            let rest = members.filter { $0.deviceId != rootId }.sorted { $0.seenAt > $1.seenAt }
            return DeviceGroup(primary: primary, ids: [rootId] + rest.map(\.deviceId), olderSeenAt: rest.first?.seenAt ?? 0)
        }
        .sorted { $0.primary.seenAt > $1.primary.seenAt }
    }

    /// "iPhone", "iPad": from the hardware model when the phone sends it, else from its name.
    var kind: String {
        let model = primary.model?.lowercased() ?? ""
        if model.hasPrefix("ipad") || (model.isEmpty && primary.deviceName.lowercased().contains("ipad")) { return "iPad" }
        return "iPhone"
    }

    /// Seen within five minutes on evidence of a request: connected now. Otherwise when it was last heard from.
    func connectedNow(at now: Date) -> Bool {
        guard primary.legacy != true, let seen = primary.lastSeenAt else { return false }
        return now.timeIntervalSince1970 * 1000 - seen < 5 * 60_000
    }

    /// "iPhone · connected now · paired Oct 30", "iPad · last seen yesterday · paired Oct 31".
    func detail(at now: Date, calendar: Calendar = .current) -> String {
        let paired = Date(timeIntervalSince1970: primary.pairedAt / 1000).formatted(.dateTime.month(.abbreviated).day())
        let seen: String
        if connectedNow(at: now) {
            seen = "connected now"
        } else {
            let day = Date(timeIntervalSince1970: primary.seenAt / 1000)
            if calendar.isDate(day, inSameDayAs: now) { seen = "last seen today" }
            else if calendar.isDate(day, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) { seen = "last seen yesterday" }
            else { seen = "last seen \(day.formatted(.dateTime.month(.abbreviated).day()))" }
        }
        return "\(kind) · \(seen) · paired \(paired)"
    }
}
