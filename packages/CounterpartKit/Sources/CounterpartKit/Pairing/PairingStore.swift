import Foundation
import Security
#if canImport(UIKit)
import UIKit
#endif

/// Where the pairing secrets live. The Keychain in the app; an in-memory double in tests.
public protocol SecureStore: Sendable {
    /// The item's data, nil when there is none. Throws `PairingError.secureStorage` when it can't be read.
    func read(_ account: String) throws -> Data?
    /// Replaces or adds the item.
    func write(_ account: String, _ data: Data) throws
    /// Adds the item only if there is none; false when one already exists.
    func add(_ account: String, _ data: Data) throws -> Bool
    func delete(_ account: String) throws
}

/// The Keychain items every version of the iPhone app has used, byte for byte: generic passwords in
/// service `org.scantomake.companion.v1`, account `current` (the pairing record, JSON) and `installation`
/// (this install's stable identity), never synchronized, readable only when unlocked on this device. No
/// access group is named, so the app's default group applies and an installed app upgrades in place.
public struct KeychainStore: SecureStore {
    public static let service = "org.scantomake.companion.v1"
    public init() {}

    public static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: kCFBooleanFalse!]
    }

    public func read(_ account: String) throws -> Data? {
        var query = Self.query(account)
        query[kSecReturnData as String] = true
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw PairingError(.secureStorage, status: status) }
        return value as? Data
    }

    public func write(_ account: String, _ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(Self.query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(Self.query(account).merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PairingError(.secureStorage, status: status) }
    }

    public func add(_ account: String, _ data: Data) throws -> Bool {
        var query = Self.query(account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem { return false }
        guard status == errSecSuccess else { throw PairingError(.secureStorage, status: status) }
        return true
    }

    public func delete(_ account: String) throws {
        let status = SecItemDelete(Self.query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError(.secureStorage, status: status) }
    }
}

/// An in-memory `SecureStore` for tests and previews.
public final class MemoryStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    public var failReads = false
    public init(_ items: [String: Data] = [:]) { self.items = items }
    public func read(_ account: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        if failReads { throw PairingError(.secureStorage) }
        return items[account]
    }
    public func write(_ account: String, _ data: Data) throws { lock.lock(); items[account] = data; lock.unlock() }
    public func add(_ account: String, _ data: Data) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard items[account] == nil else { return false }
        items[account] = data
        return true
    }
    public func delete(_ account: String) throws { lock.lock(); items[account] = nil; lock.unlock() }
}

/// A pairing failure, with the code the screens turn into words (`PairingWords`).
public struct PairingError: Error, Equatable, Sendable {
    public enum Code: String, Sendable {
        case secureStorage = "secure-storage", invalidInvitation = "invalid-invitation", expiredInvitation = "expired-invitation"
        case unsupportedInvitation = "unsupported-invitation", invalidDeviceName = "invalid-device-name"
        case unauthorized, forbidden, rateLimited = "rate-limited", wrongHost = "wrong-host", unavailable
        case network, timeout, certificate, certificateChanged = "certificate-changed", invalidResponse = "invalid-response"
        case pairingRequired = "pairing-required", pairingChanged = "pairing-changed", busy, cancelled
        case nearbyDenied = "nearby-denied", nearbyExpired = "nearby-expired", localNetwork = "local-network"
    }
    public var code: Code
    public var status: OSStatus?
    public init(_ code: Code, status: OSStatus? = nil) { self.code = code; self.status = status }
    public init(_ link: PairingLinkError) {
        switch link {
        case .invalid: self.init(.invalidInvitation)
        case .expired: self.init(.expiredInvitation)
        case .unsupported: self.init(.unsupportedInvitation)
        }
    }
}

/// The paired Mac's record and this install's identity, kept in a `SecureStore`.
public final class PairingStore: @unchecked Sendable {
    public static let changed = Notification.Name("CounterpartPairingChanged")
    public static let deviceNameKey = "CounterpartDeviceName"
    static let installationPattern = Pattern("[A-Za-z0-9_-]{43}")

    private let store: SecureStore
    private let defaults: UserDefaults
    private let systemName: () -> String

    public init(store: SecureStore = KeychainStore(), defaults: UserDefaults = .standard, systemName: (() -> String)? = nil) {
        self.store = store
        self.defaults = defaults
        self.systemName = systemName ?? PairingStore.deviceModelName
    }

    /// The stored record, nil when there is none. Throws when it can't be read or isn't valid.
    public func read() throws -> PairingRecord? {
        guard let data = try store.read("current") else { return nil }
        guard data.count < 8192, let fields = JSONValue.object(from: data) else { throw PairingError(.secureStorage) }
        let record = PairingRecord(fields: fields)
        guard record.isValid else { throw PairingError(.secureStorage) }
        return record
    }

    public func status(now: Date = Date()) throws -> PairingStatus { PairingStatus(try read(), now: now) }

    /// Saves a record. `notify` is false when it is still the same pairing (a refresh or another address),
    /// so requests in flight carry on.
    public func save(_ record: PairingRecord, notify: Bool) throws {
        guard record.isValid, let data = JSONValue.data(record.fields) else { throw PairingError(.invalidResponse) }
        try store.write("current", data)
        if notify { NotificationCenter.default.post(name: Self.changed, object: nil) }
    }

    public func disconnect() throws {
        try store.delete("current")
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    /// This install's identity, independent of the current Mac credential. Forgetting a Mac must not make
    /// the next pairing look like a different phone. It never syncs; a companion stores only its hash.
    public func installationKey() throws -> String {
        if let data = try store.read("installation") {
            guard data.count == 43, let key = String(data: data, encoding: .utf8), Self.installationPattern.matches(key) else {
                throw PairingError(.secureStorage, status: errSecDecode)
            }
            return key
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PairingError(.secureStorage) }
        let key = Base64URL.encode(Data(bytes))
        if try store.add("installation", Data(key.utf8)) { return key }
        return try installationKey()
    }

    /// The name the Mac shows for this phone: the one chosen here, else the device's name. iOS usually
    /// reports a generic name, so "iPhone" gets a short hash of the install to tell phones apart.
    public func deviceName() throws -> String {
        if let chosen = defaults.string(forKey: Self.deviceNameKey), isPlainText(chosen, max: 80) { return chosen }
        var name = systemName()
        if !isPlainText(name, max: 70) { name = "iPhone" }
        if ["iPhone", "iPad", "iPod touch"].contains(name) {
            let key = try installationKey()
            return "\(name) (\(Hex.sha256(Data(key.utf8)).prefix(4).uppercased()))"
        }
        return name
    }

    /// The phone's own name ("David's iPhone"), or nil when iOS reports only the generic "iPhone" (the app
    /// lacks the user-assigned device name entitlement). Never the hashed fallback: the Mac then uses the model.
    public func userAssignedName() -> String? {
        if let chosen = defaults.string(forKey: Self.deviceNameKey), isPlainText(chosen, max: 80) { return chosen }
        let name = systemName()
        guard isPlainText(name, max: 70), !["iPhone", "iPad", "iPod touch"].contains(name) else { return nil }
        return name
    }

    public func setDeviceName(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isPlainText(trimmed, max: 80) else { throw PairingError(.invalidDeviceName) }
        defaults.set(trimmed, forKey: Self.deviceNameKey)
        return trimmed
    }

    static func deviceModelName() -> String {
        #if canImport(UIKit) && !os(watchOS)
        return MainActorName.value
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }
}

#if canImport(UIKit) && !os(watchOS)
/// `UIDevice.name` read once on the main thread, at first use.
enum MainActorName {
    static let value: String = {
        if Thread.isMainThread { return MainActor.assumeIsolated { UIDevice.current.name } }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { UIDevice.current.name } }
    }()
}
#endif
