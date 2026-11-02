import Foundation
import Security
import CryptoKit

/// Certificate pinning for the companion. A pinned companion is trusted by its exact certificate
/// (`certificateSha256`, v1) or public key (`publicKeySha256`, the SHA-256 of its DER
/// SubjectPublicKeyInfo, v2), on its own host and port, and never any other way.
public enum CompanionTrust {
    /// The certificate's SubjectPublicKeyInfo exactly as encoded: Certificate, tbsCertificate, then
    /// [0] version (optional), serial, signature, issuer, validity, subject, and the key. Nil if unreadable.
    public static func subjectPublicKeyInfo(_ der: Data) -> Data? {
        let b = [UInt8](der)
        func element(_ limit: Int, _ offset: Int) -> (tag: UInt8, start: Int, end: Int)? {
            guard offset < limit, limit - offset >= 2 else { return nil }
            let tag = b[offset]
            var i = offset + 1
            var size = Int(b[i]); i += 1
            if size & 0x80 != 0 {
                let count = size & 0x7f
                guard count != 0, count <= 4, count <= limit - i else { return nil }
                size = 0
                for _ in 0..<count { size = (size << 8) | Int(b[i]); i += 1 }
            }
            guard size <= limit - i else { return nil }
            return (tag, i, i + size)
        }
        guard !b.isEmpty, let certificate = element(b.count, 0), certificate.tag == 0x30,
              let tbs = element(certificate.end, certificate.start), tbs.tag == 0x30 else { return nil }
        let limit = tbs.end
        var at = tbs.start
        guard let first = element(limit, at) else { return nil }
        if first.tag == 0xa0 { at = first.end }
        for _ in 0..<5 {
            guard let field = element(limit, at) else { return nil }
            at = field.end
        }
        let from = at
        guard let key = element(limit, at), key.tag == 0x30 else { return nil }
        return der.subdata(in: der.startIndex + from ..< der.startIndex + key.end)
    }

    /// SHA-256 of a certificate's SubjectPublicKeyInfo, lowercase hex.
    public static func publicKeySha256(certificate der: Data) -> String? {
        subjectPublicKeyInfo(der).map(Hex.sha256)
    }

    /// The decision for a pinned record, from what the server presented. True to trust it.
    public static func accepts(record: PairingRecord, host: String, port: Int, leafCertificate der: Data?) -> Bool {
        guard let pin = record.pin, let base = record.requestBaseURL, let der else { return false }
        let expected = base.port ?? 443, actual = port == 0 ? 443 : port
        guard actual == expected, host.caseInsensitiveCompare(base.host ?? "") == .orderedSame else { return false }
        let pinned = record.publicKeySha256 != nil ? subjectPublicKeyInfo(der) : der
        return pinned.map(Hex.sha256) == pin
    }

    /// The leaf certificate a TLS challenge presents.
    public static func leaf(_ trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }
}

/// Nearby pairing v1 (`@scan-to-make/contracts/nearby-pairing`, test vector
/// `packages/contracts/fixtures/nearby-pairing-v1.json`). The phone finds the Mac over Bonjour, both
/// screens show the same 6-digit code, and the user clicks Allow on the Mac.
public enum NearbyCrypto {
    private static func tagged(_ tag: String, _ parts: [Data]) -> Data {
        var input = Data(tag.utf8); input.append(0)
        for part in parts { input.append(part) }
        return input
    }

    /// SHA-256("scantomake nearby v1 commit" || 0x00 || key): sent before the phone sees the nonce.
    public static func commit(key: Data) -> Data? {
        guard key.count == 32 else { return nil }
        return Data(SHA256.hash(data: tagged("scantomake nearby v1 commit", [key])))
    }

    /// Six digits from SHA-256("scantomake nearby v1 code" || 0x00 || S || key || nonce): the first
    /// 8 bytes, big-endian, mod 1,000,000. S is the SHA-256 of the SubjectPublicKeyInfo the phone saw.
    public static func code(publicKeySha256: Data, key: Data, nonce: Data) -> String? {
        guard publicKeySha256.count == 32, key.count == 32, nonce.count == 32 else { return nil }
        let digest = [UInt8](SHA256.hash(data: tagged("scantomake nearby v1 code", [publicKeySha256, key, nonce])))
        let value = digest.prefix(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        return String(format: "%06llu", value % 1_000_000)
    }

    public static func base64URL(_ data: Data) -> String { Base64URL.encode(data) }

    /// Exactly 32 bytes from canonical unpadded base64url, or nil.
    public static func bytes(_ text: String?) -> Data? {
        guard Pattern("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]").matches(text), let text else { return nil }
        let standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
        guard let data = Data(base64Encoded: standard), data.count == 32 else { return nil }
        return data
    }

    /// "482913" → "482 913", the same on both screens.
    public static func display(_ code: String) -> String {
        guard code.count == 6 else { return code }
        return "\(code.prefix(3)) \(code.suffix(3))"
    }

    /// Trust on first use for one nearby session: the first certificate on `base`'s host and port fixes S;
    /// after that only that public key is accepted. Returns S when accepted, nil to refuse.
    public static func trust(host: String, port: Int, leafCertificate der: Data?, base: URL, seen: Data?) -> Data? {
        let expected = base.port ?? 443, actual = port == 0 ? 443 : port
        guard actual == expected, host.caseInsensitiveCompare(base.host ?? "") == .orderedSame,
              let der, let spki = CompanionTrust.subjectPublicKeyInfo(der) else { return nil }
        let key = Data(SHA256.hash(data: spki))
        return seen == nil || seen == key ? key : nil
    }
}
