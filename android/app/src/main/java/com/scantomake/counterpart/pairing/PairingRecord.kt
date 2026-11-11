package com.scantomake.counterpart.pairing

import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI

/** The address rules every request follows. Port of CounterpartKit `CompanionAddress`. A base is "https://host[:port]". */
object CompanionAddress {
    private val tailscaleHost = Pattern("""(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net""")
    private val ipv4 = Pattern("""[0-9]{1,3}(\.[0-9]{1,3}){3}""")
    private val pin = Pattern("[a-f0-9]{64}")

    fun validPin(value: String?): Boolean = pin.matches(value)

    private class Parts(val scheme: String?, val host: String?, val port: Int?, val authority: String)

    private fun components(value: String?): Parts? {
        if (value == null || value.length > 300) return null
        val uri = try { URI(value) } catch (_: Exception) { return null }
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        val path = uri.rawPath ?: ""
        if (path.isNotEmpty() && path != "/") return null
        val authority = uri.rawAuthority ?: return null
        return Parts(uri.scheme, uri.host, if (uri.port == -1) null else uri.port, authority)
    }

    /** An unpinned companion: Tailscale Serve, a `*.ts.net` name on 443. */
    fun companionBaseURL(value: String?): String? {
        val c = components(value) ?: return null
        if (c.scheme != "https" || c.port != null || !tailscaleHost.matches(c.host)) return null
        return "https://${c.authority}"
    }

    /** A companion pinned by certificate or public key: IP addresses, `.local` names and single-label names. */
    fun pinnedBaseURL(value: String?, pin: String?): String? {
        if (!validPin(pin)) return null
        val c = components(value) ?: return null
        if (c.scheme != "https") return null
        val host = c.host?.lowercase() ?: return null
        if (host.isEmpty()) return null
        val address = ipv4.matches(host) || host.contains(":")
        if (!address && !host.endsWith(".local") && host.contains(".")) return null
        return "https://${c.authority}"
    }

    /** Pairing link v2 addresses: 1–8 distinct pinnable origins (no path or trailing slash), in order. */
    fun pinnedAddresses(value: List<String>?, pin: String?): List<String>? {
        if (value == null || value.size !in 1..8) return null
        val seen = HashSet<String>()
        for (address in value) {
            if (pinnedBaseURL(address, pin) == null || address.endsWith("/") || !seen.add(address.lowercase())) return null
        }
        return value
    }

    /** Failures that say nothing about the companion move on to its next address. */
    fun tryNext(after: String): Boolean = after in setOf("network", "timeout", "certificate", "certificate-changed")

    /** Host and port of a base made by this object. */
    fun hostPort(base: String): Pair<String, Int> {
        val uri = URI(base)
        return (uri.host ?: "") to (if (uri.port == -1) 443 else uri.port)
    }
}

/**
 * This phone's pairing with one Mac. The JSON object is kept whole, so a field this version doesn't use
 * survives being read and written back. Port of CounterpartKit `PairingRecord`.
 */
data class PairingRecord(val fields: Map<String, JsonElement>) {
    companion object {
        const val PROTOCOL_VERSION = "0.1.0"
        private val tokenPattern = Pattern("[A-Za-z0-9_-]{43}")
        private val uuidPattern = Pattern("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        val allScopes = setOf("generation:health", "generation:create", "projects:read", "projects:write", "captures:read",
            "captures:import", "prepared-jobs:read", "prepared-jobs:prepare", "prints:approve", "printer-handoff:use")
    }

    val baseUrl: String? get() = fields["baseUrl"].str
    val activeUrl: String? get() = fields["activeUrl"].str
    val deviceId: String? get() = fields["deviceId"].str
    val token: String? get() = fields["token"].str
    val expiresAtMs: Double get() = fields["expiresAt"].num ?: 0.0
    val scopes: List<String> get() = fields["scopes"].arr?.mapNotNull { it.str } ?: emptyList()
    val certificateSha256: String? get() = fields["certificateSha256"].str
    val publicKeySha256: String? get() = fields["publicKeySha256"].str
    val addresses: List<String>? get() = fields["addresses"].arr?.mapNotNull { it.str }
    /** The pin in force: the public key (v2) or the certificate (v1), or null for Tailscale Serve. */
    val pin: String? get() = publicKeySha256 ?: certificateSha256

    fun isExpired(nowMs: Long = System.currentTimeMillis()): Boolean = expiresAtMs <= nowMs
    fun has(scope: String): Boolean = scope in scopes

    /** Where requests go: the last address that answered (`activeUrl`) or `baseUrl`, pinned or not. */
    val requestBaseURL: String?
        get() {
            publicKeySha256?.let { return CompanionAddress.pinnedBaseURL(activeUrl ?: baseUrl, it) }
            certificateSha256?.let { return CompanionAddress.pinnedBaseURL(baseUrl, it) }
            return CompanionAddress.companionBaseURL(baseUrl)
        }

    /** The addresses to try: the last one that answered, then the rest in order. */
    val attemptOrder: List<String>
        get() {
            val first = activeUrl ?: baseUrl ?: return emptyList()
            return listOf(first) + (addresses ?: emptyList()).filter { it != first }
        }

    fun with(key: String, value: JsonElement?): PairingRecord =
        PairingRecord(if (value == null) fields - key else fields + (key to value))

    /** Same Mac, device, token, protocol and pin. Which listed address answered last doesn't matter. */
    fun isSamePairing(other: PairingRecord?): Boolean {
        if (other == null) return false
        return listOf("baseUrl", "deviceId", "token", "protocolVersion", "certificateSha256", "publicKeySha256", "addresses")
            .all { fields[it] == other.fields[it] }
    }

    /** Whether the record can be used at all (shape, pins, addresses, token, scopes), not whether it is current. */
    val isValid: Boolean
        get() {
            fields["certificateSha256"]?.let { if (!CompanionAddress.validPin(it.str)) return false }
            if (!validAddresses || requestBaseURL == null) return false
            if (fields["protocolVersion"].str != PROTOCOL_VERSION) return false
            if (!uuidPattern.matches(deviceId)) return false
            if (!tokenPattern.matches(token)) return false
            val expires = fields["expiresAt"].num ?: return false
            if (expires <= 0) return false
            return validScopes
        }

    private val validAddresses: Boolean
        get() {
            val key = fields["publicKeySha256"] ?: return fields["addresses"] == null && fields["activeUrl"] == null
            val raw = fields["addresses"].arr?.map { it.str ?: "\u0000" }
            val list = CompanionAddress.pinnedAddresses(raw, key.str) ?: return false
            return fields["certificateSha256"] == null && CompanionAddress.validPin(key.str) &&
                baseUrl?.let { it in list } == true && (fields["activeUrl"] == null || activeUrl?.let { it in list } == true)
        }

    private val validScopes: Boolean
        get() {
            val raw = fields["scopes"].arr ?: return false
            if (raw.size !in 2..10) return false
            val seen = HashSet<String>()
            for (item in raw) {
                val scope = item.str ?: return false
                if (scope !in allScopes || !seen.add(scope)) return false
            }
            return "generation:health" in seen
        }

    fun toJson(): JsonObject = JsonObject(fields)
}

fun stringArray(list: List<String>): JsonArray = JsonArray(list.map { JsonPrimitive(it) })

/** What the app may know about the pairing. Never holds the token. */
data class PairingStatus(
    val state: State,
    val baseUrl: String? = null,
    val activeUrl: String? = null,
    val deviceId: String? = null,
    val expiresAtMs: Double? = null,
    /** The computer's pin (its public key or certificate hash; not a secret): who it is, wherever it answers from. */
    val pin: String? = null,
) {
    enum class State { Disconnected, Paired, Expired }

    /** The host the phone talks to now, for "Address in use". */
    val host: String? get() = (activeUrl ?: baseUrl)?.let { try { URI(it).host } catch (_: Exception) { null } }

    companion object {
        val disconnected = PairingStatus(State.Disconnected)
        fun of(record: PairingRecord?, nowMs: Long = System.currentTimeMillis()): PairingStatus {
            if (record == null) return disconnected
            return PairingStatus(if (record.isExpired(nowMs)) State.Expired else State.Paired, record.baseUrl, record.activeUrl,
                record.deviceId, record.expiresAtMs, record.pin)
        }
    }
}
