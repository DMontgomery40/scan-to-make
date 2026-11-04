package com.scantomake.counterpart.pairing

import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import java.io.ByteArrayOutputStream
import kotlin.math.abs

/** Why a pairing invitation can't be used. The codes match `@scan-to-make/contracts/pairing-link`. */
enum class PairingLinkError(val code: String) {
    Invalid("invalid-invitation"), Expired("expired-invitation"), Unsupported("unsupported-invitation");
}

class PairingLinkException(val error: PairingLinkError) : Exception(error.code)

/**
 * The `scantomake://pair` link a companion shows as a QR code, versions 1 and 2. A rule-for-rule port of
 * `packages/CounterpartKit/.../PairingLink.swift` (itself a port of `packages/contracts/src/pairing-link.ts`);
 * `packages/contracts/fixtures/pairing-link-vectors.json` holds all three to the same answers (see the unit tests).
 *
 * - v1: `v=1&u=<https base URL>&c=<code>&e=<expiresAt ms>[&f=<certificate SHA-256>]`
 * - v2: `v=2&c=<code>&e=<expiresAt ms>&k=<public key SHA-256>&a=<origin>[&a=<origin>…][&n=<name>]`
 *
 * Unknown keys are ignored within a known version; a repeated single key is invalid.
 */
sealed class PairingLink {
    data class V1(val baseUrl: String, override val code: String, override val expiresAt: Long, val certificateSha256: String?) : PairingLink()
    data class V2(val addresses: List<String>, override val code: String, override val expiresAt: Long, val publicKeySha256: String, val name: String?) : PairingLink()

    abstract val code: String
    abstract val expiresAt: Long

    companion object {
        const val MAX_ADDRESSES = 8
        const val MAX_NAME = 63
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

        val codePattern = Pattern("[A-Za-z0-9_-]{32}")
        val sha256 = Pattern("[a-f0-9]{64}")
        private val v1URL = Pattern("""https://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?/?""", caseInsensitive = true)
        // iOS accepts a companion's own certificate only on IP addresses, .local names and single-label names.
        val pinnableURL = Pattern("""https://(\[[0-9a-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:[0-9]{1,5})?/?""", caseInsensitive = true)
        private val pinnableOrigin = Pattern("""https://(\[[0-9a-f:.]+\]|[0-9]{1,3}(\.[0-9]{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:[0-9]{1,5})?""", caseInsensitive = true)
        // Without a pin, the companion is reached through Tailscale Serve: a *.ts.net name on 443.
        val tailscaleURL = Pattern("""https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net/?""", caseInsensitive = true)
        private val expiresDigits = Pattern("[0-9]{1,16}")
        private val versionDigits = Pattern("[1-9][0-9]{0,8}")
        private val prefix = Regex("^scantomake://pair\\?", RegexOption.IGNORE_CASE)

        fun isPairingLink(text: String): Boolean = prefix.containsMatchIn(text)

        /** Parses a link. `expired` is reported only when `now` (Unix milliseconds) is given. */
        fun parse(text: String, now: Long? = null): PairingLink {
            val params = read(text)
            val version = params["v"]
            if (version == null || version.size != 1) throw PairingLinkException(PairingLinkError.Invalid)
            if (version[0] != "1" && version[0] != "2") {
                throw PairingLinkException(if (versionDigits.matches(version[0])) PairingLinkError.Unsupported else PairingLinkError.Invalid)
            }
            val v = if (version[0] == "1") 1 else 2
            val single = if (v == 1) listOf("v", "u", "c", "e", "f") else listOf("v", "c", "e", "k", "n")
            if (single.any { (params[it]?.size ?: 0) > 1 }) throw PairingLinkException(PairingLinkError.Invalid)
            fun one(key: String) = params[key]?.firstOrNull()
            val expiresAt = one("e")?.let { if (expiresDigits.matches(it)) it.toLongOrNull() else null }
            val link = if (v == 1) V1(one("u") ?: "", one("c") ?: "", expiresAt ?: -1, one("f"))
            else V2(params["a"] ?: emptyList(), one("c") ?: "", expiresAt ?: -1, one("k") ?: "", one("n"))
            return check(link, now)
        }

        /** Form-decoded parameters in order, keeping every value of a repeated key. */
        private fun read(text: String): Map<String, List<String>> {
            val mark = text.indexOf('?')
            if (!isPairingLink(text) || mark < 0) throw PairingLinkException(PairingLinkError.Invalid)
            val params = LinkedHashMap<String, MutableList<String>>()
            for (pair in text.substring(mark + 1).split("&")) {
                val split = pair.indexOf('=')
                val key: String
                val value: String
                if (split >= 0) {
                    key = pair.substring(0, split)
                    value = percentDecode(pair.substring(split + 1).replace('+', ' ')) ?: throw PairingLinkException(PairingLinkError.Invalid)
                } else { key = pair; value = "" }
                params.getOrPut(key) { mutableListOf() }.add(value)
            }
            return params
        }

        /** Foundation's `removingPercentEncoding`: nil for a stray `%` or bytes that aren't UTF-8. */
        fun percentDecode(text: String): String? {
            val out = ByteArrayOutputStream()
            var i = 0
            val bytes = text.toByteArray(Charsets.UTF_8)
            while (i < bytes.size) {
                val b = bytes[i]
                if (b == '%'.code.toByte()) {
                    if (i + 2 >= bytes.size) return null
                    val hi = Character.digit(bytes[i + 1].toInt().toChar(), 16)
                    val lo = Character.digit(bytes[i + 2].toInt().toChar(), 16)
                    if (hi < 0 || lo < 0) return null
                    out.write(hi * 16 + lo); i += 3
                } else { out.write(b.toInt()); i += 1 }
            }
            val decoder = Charsets.UTF_8.newDecoder()
            return try { decoder.decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString() } catch (_: Exception) { null }
        }

        private fun check(link: PairingLink, now: Long?): PairingLink {
            if (link.expiresAt <= 0 || link.expiresAt > MAX_SAFE_INTEGER) throw PairingLinkException(PairingLinkError.Invalid)
            when (link) {
                is V1 -> {
                    if (!v1URL.matches(link.baseUrl)) throw PairingLinkException(PairingLinkError.Invalid)
                    if (link.certificateSha256 != null && !sha256.matches(link.certificateSha256)) throw PairingLinkException(PairingLinkError.Invalid)
                    if (now != null && link.expiresAt <= now) throw PairingLinkException(PairingLinkError.Expired)
                    if (!codePattern.matches(link.code)) throw PairingLinkException(PairingLinkError.Invalid)
                    val ok = if (link.certificateSha256 != null) pinnableURL.matches(link.baseUrl) else tailscaleURL.matches(link.baseUrl)
                    if (!ok) throw PairingLinkException(PairingLinkError.Invalid)
                }
                is V2 -> {
                    val ok = codePattern.matches(link.code) && sha256.matches(link.publicKeySha256) &&
                        link.addresses.size in 1..MAX_ADDRESSES &&
                        link.addresses.map { it.lowercase() }.toSet().size == link.addresses.size &&
                        link.addresses.all { pinnableOrigin.matches(it) } &&
                        (link.name?.let(::validName) ?: true)
                    if (!ok) throw PairingLinkException(PairingLinkError.Invalid)
                    if (now != null && link.expiresAt <= now) throw PairingLinkException(PairingLinkError.Expired)
                }
            }
            return link
        }

        /** 1–63 UTF-16 code units (as JavaScript counts them), no control characters. */
        fun validName(name: String): Boolean =
            name.length in 1..MAX_NAME && name.none { it.code < 0x20 || it.code == 0x7f }
    }
}

/**
 * A parsed invitation, from a QR code, a pairing link or the older JSON invitation. v2 (`addresses` and a
 * public-key pin) pairs at each address in order; v1 at `baseUrl`, pinned to its certificate when it has one.
 */
data class PairingInvitation(
    val baseUrl: String,
    val code: String,
    val expiresAt: Long,
    val certificateSha256: String? = null,
    val addresses: List<String>? = null,
    val publicKeySha256: String? = null,
    val name: String? = null,
) {
    /** The invitation names a Mac on the local network (pinned). */
    val isLocal: Boolean get() = certificateSha256 != null || publicKeySha256 != null

    companion object {
        fun from(link: PairingLink): PairingInvitation = when (link) {
            is PairingLink.V1 -> PairingInvitation(link.baseUrl, link.code, link.expiresAt, certificateSha256 = link.certificateSha256)
            is PairingLink.V2 -> PairingInvitation(link.addresses[0], link.code, link.expiresAt, addresses = link.addresses,
                publicKeySha256 = link.publicKeySha256, name = link.name)
        }

        /** What the camera or a link gave: a `scantomake://pair` link, or the older JSON invitation. `now` is Unix ms. */
        fun parse(value: String, now: Long = System.currentTimeMillis()): PairingInvitation {
            val text = value.trim()
            if (text.startsWith("{")) return legacy(text, now)
            if (!PairingLink.isPairingLink(text)) throw PairingLinkException(PairingLinkError.Invalid)
            return from(PairingLink.parse(text, now))
        }

        private fun legacy(text: String, now: Long): PairingInvitation {
            val invalid = PairingLinkException(PairingLinkError.Invalid)
            val o = parseObject(text) ?: throw invalid
            if (o["version"].num != 1.0) throw invalid
            val url = o["baseUrl"].str ?: throw invalid
            val code = o["code"].str ?: throw invalid
            val expires = o["expiresAt"].num ?: throw invalid
            if (Math.rint(expires) != expires || abs(expires) > PairingLink.MAX_SAFE_INTEGER.toDouble()) throw invalid
            var pin: String? = null
            if (o.containsKey("certificateSha256")) {
                val p = o["certificateSha256"].str
                if (p == null || !PairingLink.sha256.matches(p)) throw invalid
                pin = p
            }
            if (expires.toLong() <= now) throw PairingLinkException(PairingLinkError.Expired)
            if (url.isEmpty() || !PairingLink.codePattern.matches(code)) throw invalid
            if (pin != null && !PairingLink.pinnableURL.matches(url)) throw invalid
            if (pin == null && !PairingLink.tailscaleURL.matches(url)) throw invalid
            return PairingInvitation(url, code, expires.toLong(), certificateSha256 = pin)
        }
    }
}
