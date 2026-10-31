import Foundation
import Security

/// One local, non-synchronizing generic-password namespace owned by this app.
/// UI saves a key first, then sends only its reference to modelAccess.set.
public struct ModelKeychain: ModelCredentialStore {
    public init() {}
    private func query(_ reference: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.scantomake.model-access",
         kSecAttrAccount as String: reference.uuidString.lowercased(),
         kSecAttrSynchronizable as String: false,
         kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecItemNotFound: throw ModelAccessError.credentialMissing
        case errSecInteractionNotAllowed, errSecAuthFailed: throw ModelAccessError.credentialLocked
        default: throw ModelAccessError.credentialUnavailable
        }
    }
    public func save(_ secret: String, for choice: ModelAccessChoice) throws {
        try choice.validate()
        guard let reference = choice.keychainReference else { throw ModelAccessError.invalidChoice }
        try ModelWorkerEnvironment.validateSecret(secret)
        var item = query(reference)
        item[kSecValueData as String] = try JSONEncoder().encode(ModelCredential(choice: choice, secret: secret))
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        try check(SecItemAdd(item as CFDictionary, nil))
    }
    public func read(_ reference: UUID) throws -> ModelCredential {
        var item = query(reference)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        try check(SecItemCopyMatching(item as CFDictionary, &result))
        guard let data = result as? Data,
              let saved = try? JSONDecoder().decode(ModelCredential.self, from: data),
              saved.version == 1, saved.choice.keychainReference == reference else { throw ModelAccessError.credentialUnavailable }
        return saved
    }
    public func remove(_ reference: UUID) throws {
        let status = SecItemDelete(query(reference) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
}
