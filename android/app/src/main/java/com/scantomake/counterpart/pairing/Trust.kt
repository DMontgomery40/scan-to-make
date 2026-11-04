package com.scantomake.counterpart.pairing

import com.scantomake.counterpart.core.Base64Url
import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.Pattern
import java.util.Base64

/**
 * Certificate pinning for the companion. Port of CounterpartKit `CompanionTrust`: a pinned companion is
 * trusted by its exact certificate (`certificateSha256`, v1) or public key (`publicKeySha256`, the SHA-256
 * of its DER SubjectPublicKeyInfo, v2), on its own host and port, and never any other way.
 */
object CompanionTrust {
    private class Element(val tag: Int, val start: Int, val end: Int)

    /** The certificate's SubjectPublicKeyInfo exactly as encoded, or null if unreadable (same walk as the Swift). */
    fun subjectPublicKeyInfo(der: ByteArray): ByteArray? {
        val b = der
        fun element(limit: Int, offset: Int): Element? {
            if (offset >= limit || limit - offset < 2) return null
            val tag = b[offset].toInt() and 0xff
            var i = offset + 1
            var size = b[i].toInt() and 0xff; i += 1
            if (size and 0x80 != 0) {
                val count = size and 0x7f
                if (count == 0 || count > 4 || count > limit - i) return null
                size = 0
                repeat(count) { size = (size shl 8) or (b[i].toInt() and 0xff); i += 1 }
                if (size < 0) return null
            }
            if (size > limit - i) return null
            return Element(tag, i, i + size)
        }
        if (b.isEmpty()) return null
        val certificate = element(b.size, 0) ?: return null
        if (certificate.tag != 0x30) return null
        val tbs = element(certificate.end, certificate.start) ?: return null
        if (tbs.tag != 0x30) return null
        val limit = tbs.end
        var at = tbs.start
        val first = element(limit, at) ?: return null
        if (first.tag == 0xa0) at = first.end
        repeat(5) {
            val field = element(limit, at) ?: return null
            at = field.end
        }
        val from = at
        val key = element(limit, at) ?: return null
        if (key.tag != 0x30) return null
        return b.copyOfRange(from, key.end)
    }

    /** Host names compare without case; an IPv6 literal compares with or without its brackets. */
    fun sameHost(a: String, b: String): Boolean = a.trim('[', ']').equals(b.trim('[', ']'), ignoreCase = true)

    /** SHA-256 of a certificate's SubjectPublicKeyInfo, lowercase hex. */
    fun publicKeySha256(certificate: ByteArray): String? = subjectPublicKeyInfo(certificate)?.let(Hex::sha256)

    /** The decision for a pinned record, from what the server presented. True to trust it. */
    fun accepts(record: PairingRecord, host: String, port: Int, leafCertificate: ByteArray?): Boolean {
        val pin = record.pin ?: return false
        val base = record.requestBaseURL ?: return false
        val der = leafCertificate ?: return false
        val (expectedHost, expectedPort) = CompanionAddress.hostPort(base)
        val actual = if (port == 0 || port == -1) 443 else port
        if (actual != expectedPort || !sameHost(host, expectedHost)) return false
        val pinned = if (record.publicKeySha256 != null) subjectPublicKeyInfo(der) else der
        return pinned?.let(Hex::sha256) == pin
    }
}

/**
 * Nearby pairing v1 (`@scan-to-make/contracts/nearby-pairing`, test vector
 * `packages/contracts/fixtures/nearby-pairing-v1.json`). Port of CounterpartKit `NearbyCrypto`.
 */
object NearbyCrypto {
    private fun tagged(tag: String, parts: List<ByteArray>): ByteArray {
        var input = tag.toByteArray(Charsets.US_ASCII) + byteArrayOf(0)
        for (part in parts) input += part
        return input
    }

    /** SHA-256("scantomake nearby v1 commit" || 0x00 || key): sent before the phone sees the nonce. */
    fun commit(key: ByteArray): ByteArray? = if (key.size != 32) null else Hex.sha256Bytes(tagged("scantomake nearby v1 commit", listOf(key)))

    /** Six digits: the first 8 bytes of SHA-256(tag || 0 || S || key || nonce), big-endian, mod 1,000,000. */
    fun code(publicKeySha256: ByteArray, key: ByteArray, nonce: ByteArray): String? {
        if (publicKeySha256.size != 32 || key.size != 32 || nonce.size != 32) return null
        val digest = Hex.sha256Bytes(tagged("scantomake nearby v1 code", listOf(publicKeySha256, key, nonce)))
        var value = java.math.BigInteger.ZERO
        for (i in 0 until 8) value = value.shiftLeft(8).or(java.math.BigInteger.valueOf((digest[i].toInt() and 0xff).toLong()))
        return "%06d".format(value.mod(java.math.BigInteger.valueOf(1_000_000)).toLong())
    }

    fun base64URL(data: ByteArray): String = Base64Url.encode(data)

    private val canonical = Pattern("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")

    /** Exactly 32 bytes from canonical unpadded base64url, or null. */
    fun bytes(text: String?): ByteArray? {
        if (!canonical.matches(text) || text == null) return null
        return try { Base64.getUrlDecoder().decode(text).takeIf { it.size == 32 } } catch (_: Exception) { null }
    }

    /** "482913" → "482 913", the same on both screens. */
    fun display(code: String): String = if (code.length != 6) code else "${code.take(3)} ${code.takeLast(3)}"

    /**
     * Trust on first use for one nearby session: the first certificate on `base`'s host and port fixes S;
     * after that only that public key is accepted. Returns S when accepted, null to refuse.
     */
    fun trust(host: String, port: Int, leafCertificate: ByteArray?, base: String, seen: ByteArray?): ByteArray? {
        val (expectedHost, expectedPort) = CompanionAddress.hostPort(base)
        val actual = if (port == 0 || port == -1) 443 else port
        if (actual != expectedPort || !CompanionTrust.sameHost(host, expectedHost)) return null
        val spki = leafCertificate?.let(CompanionTrust::subjectPublicKeyInfo) ?: return null
        val key = Hex.sha256Bytes(spki)
        return if (seen == null || seen.contentEquals(key)) key else null
    }
}
