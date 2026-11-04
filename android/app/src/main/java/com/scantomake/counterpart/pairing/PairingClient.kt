package com.scantomake.counterpart.pairing

import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.isPlainText
import com.scantomake.counterpart.core.jsonOf
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.net.HttpRequest
import com.scantomake.counterpart.net.HttpTransport
import com.scantomake.counterpart.net.TransportException
import com.scantomake.counterpart.net.TrustPolicy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.atomic.AtomicInteger

/**
 * Pairing with a companion and keeping that pairing. Port of CounterpartKit `PairingClient`: pair from an
 * invitation (v1 at one address, v2 at each address in order with the public-key pin), check the stored
 * credential (moving to whichever of the Mac's addresses answers), and refresh it (`POST /v1/auth/refresh`).
 */
class PairingClient(val store: PairingStore, private val transport: HttpTransport, private val now: () -> Long = System::currentTimeMillis) {
    /** One queue of pairing calls, so a refresh never meets a pairing or a check halfway. */
    private val gate = Mutex()
    /** Bumped by `forget`: work that began before it never writes afterwards. */
    private val generation = AtomicInteger(0)

    companion object {
        const val LIFETIME_LIMIT_MS = 31.0 * 86_400_000
        const val MAX_REPLY = 16_384
        private const val JSON = "application/json"

        fun check(status: Int) {
            if (status == 200) return
            throw PairingException(when (status) {
                401 -> PairingException.Code.Unauthorized
                403 -> PairingException.Code.Forbidden
                429 -> PairingException.Code.RateLimited
                in 300..399 -> PairingException.Code.WrongHost
                else -> PairingException.Code.Unavailable
            })
        }

        fun error(code: String) = PairingException(PairingException.Code.of(code))

        fun sameCompanion(previous: PairingRecord, invitation: PairingRecord): Boolean {
            if (invitation.publicKeySha256 != null || previous.publicKeySha256 != null) {
                return previous.publicKeySha256 != null && previous.publicKeySha256 == invitation.publicKeySha256
            }
            if (invitation.certificateSha256 != null || previous.certificateSha256 != null) {
                return previous.certificateSha256 != null && previous.certificateSha256 == invitation.certificateSha256
            }
            return previous.baseUrl == invitation.baseUrl
        }
    }

    private fun body(o: JsonObject) = WireJson.encodeToString(JsonObject.serializer(), o).toByteArray()

    /** Pairs with an invitation, under `deviceName`, and stores the new record. */
    suspend fun pair(invitation: PairingInvitation, deviceName: String): PairingStatus =
        try { gate.withLock { pairNow(invitation, deviceName) } } catch (e: CancellationException) { throw PairingException(PairingException.Code.Cancelled) }

    /** Forgets the paired Mac at once. A call still answering never brings the pairing back. */
    fun forget() {
        synchronized(this) {
            generation.incrementAndGet()
            store.disconnect()
        }
    }

    private suspend fun save(record: PairingRecord, notify: Boolean, started: Int) {
        if (!currentCoroutineContext().isActive) throw PairingException(PairingException.Code.Cancelled)
        synchronized(this) {
            if (generation.get() != started) throw PairingException(PairingException.Code.PairingChanged)
            try { store.save(record, notify) } catch (_: Exception) { throw PairingException(PairingException.Code.SecureStorage) }
        }
    }

    private suspend fun pairNow(invitation: PairingInvitation, deviceName: String): PairingStatus {
        val started = generation.get()
        if (!Pattern("[A-Za-z0-9_-]{32}").matches(invitation.code) || !isPlainText(deviceName, 80)) {
            throw PairingException(PairingException.Code.InvalidInvitation)
        }
        val installation: String
        val snapshot: PairingRecord?
        try { installation = store.installationKey(); snapshot = try { store.read() } catch (_: PairingException) { null } }
        catch (_: Exception) { throw PairingException(PairingException.Code.SecureStorage) }

        val key = invitation.publicKeySha256
        if (key == null) {
            // v1: one address, its certificate pin (or Tailscale Serve).
            val pin = invitation.certificateSha256
            val url = (if (pin != null) CompanionAddress.pinnedBaseURL(invitation.baseUrl, pin) else CompanionAddress.companionBaseURL(invitation.baseUrl))
                ?: throw PairingException(PairingException.Code.InvalidInvitation)
            val pending = HashMap<String, JsonElement>()
            pending["baseUrl"] = JsonPrimitive(url)
            if (pin != null) pending["certificateSha256"] = JsonPrimitive(pin)
            try {
                return pairAt(PairingRecord(pending), invitation.code, deviceName, installation, snapshot, started)
            } catch (e: TransportException) {
                throw error(if (e.code == "too-large") "invalid-response" else e.code)
            }
        }
        // v2: each address in order, pinned to the public key; the one that answers becomes baseUrl.
        val list = if (CompanionAddress.validPin(key)) CompanionAddress.pinnedAddresses(invitation.addresses, key) else null
        if (list == null) throw PairingException(PairingException.Code.InvalidInvitation)
        var failure: String? = null
        for ((index, address) in list.withIndex()) {
            val pending = PairingRecord(mapOf("addresses" to stringArray(list), "publicKeySha256" to JsonPrimitive(key), "baseUrl" to JsonPrimitive(address)))
            try {
                return pairAt(pending, invitation.code, deviceName, installation, snapshot, started)
            } catch (e: TransportException) {
                val code = if (e.code == "too-large") "invalid-response" else e.code
                // An unreachable address beats another server's certificate as the reason to report.
                if (failure == null || code == "network" || code == "timeout") failure = code
                val remaining = index < list.size - 1
                if (remaining && CompanionAddress.tryNext(code)) continue
                throw error(if (remaining) code else failure ?: code)
            }
        }
        throw error(failure ?: "network")
    }

    private suspend fun pairAt(pending: PairingRecord, code: String, name: String, installation: String, snapshot: PairingRecord?, started: Int): PairingStatus {
        val base = pending.requestBaseURL ?: throw PairingException(PairingException.Code.InvalidInvitation)
        val headers = HashMap<String, String>()
        // The previous token only goes to the same trusted Mac: it lets that Mac replace this phone's earlier row.
        if (snapshot != null && sameCompanion(snapshot, pending)) {
            val token = snapshot.token
            val device = snapshot.deviceId
            if (token != null && device != null) { headers["Authorization"] = "Bearer $token"; headers["X-Scan-Device"] = device }
        }
        val request = HttpRequest("POST", "$base/v1/pair", headers,
            body(jsonOf("code" to code, "deviceName" to name, "installationKey" to installation)), JSON, 10_000)
        val reply = transport.send(request, TrustPolicy.Pending(pending), MAX_REPLY, 15_000)
        return acceptPairing(reply, pending, started)
    }

    private suspend fun acceptPairing(reply: HttpReply, pending: PairingRecord, started: Int): PairingStatus {
        check(reply.status)
        val fields = parseObject(reply.body)?.toMutableMap() ?: throw PairingException(PairingException.Code.InvalidResponse)
        // The address, pin and address list come from the invitation, never the response.
        for (k in listOf("certificateSha256", "publicKeySha256", "addresses", "activeUrl")) fields.remove(k)
        for (k in listOf("baseUrl", "certificateSha256", "publicKeySha256", "addresses")) pending.fields[k]?.let { fields[k] = it }
        val record = PairingRecord(fields)
        val nowMs = now().toDouble()
        if (!record.isValid || record.expiresAtMs <= nowMs || record.expiresAtMs > nowMs + LIFETIME_LIMIT_MS) {
            throw PairingException(PairingException.Code.InvalidResponse)
        }
        save(record, true, started)
        return PairingStatus.of(record, now())
    }

    /** Checks the stored credential at the Mac's addresses in order (`GET /healthz`). */
    suspend fun check(): PairingStatus = gate.withLock { checkNow() }

    private suspend fun checkNow(): PairingStatus {
        val started = generation.get()
        val snapshot = current()
        var failure: String? = null
        val order = snapshot.attemptOrder
        for ((index, address) in order.withIndex()) {
            val attempt = if (address == snapshot.baseUrl) snapshot.with("activeUrl", null) else snapshot.with("activeUrl", JsonPrimitive(address))
            val base = attempt.requestBaseURL
            val token = attempt.token
            val device = attempt.deviceId
            if (base == null || token == null || device == null) throw PairingException(PairingException.Code.SecureStorage)
            val request = HttpRequest("GET", "$base/healthz", mapOf("Authorization" to "Bearer $token", "X-Scan-Device" to device), timeoutMs = 10_000)
            val reply = try { transport.send(request, TrustPolicy.Record(attempt), MAX_REPLY, 15_000) } catch (e: TransportException) {
                val code = if (e.code == "too-large") "invalid-response" else e.code
                if (failure == null || code == "network" || code == "timeout") failure = code
                val remaining = index < order.size - 1
                if (remaining && CompanionAddress.tryNext(code)) continue
                throw error(if (remaining) code else failure ?: code)
            }
            check(reply.status)
            val latest = try { store.read() } catch (_: Exception) { throw PairingException(PairingException.Code.PairingChanged) }
            if (latest != snapshot) throw PairingException(PairingException.Code.PairingChanged)
            if (parseObject(reply.body)?.get("protocolVersion").str != PairingRecord.PROTOCOL_VERSION) throw PairingException(PairingException.Code.InvalidResponse)
            if (attempt != snapshot) save(attempt, false, started)
            return PairingStatus.of(attempt, now())
        }
        throw error(failure ?: "network")
    }

    /** Asks the Mac for another full lifetime of the same credential. Only the expiry and scopes change. */
    suspend fun refresh(): PairingStatus = gate.withLock { refreshNow() }

    private suspend fun refreshNow(): PairingStatus {
        val started = generation.get()
        val snapshot = current()
        val base = snapshot.requestBaseURL
        val token = snapshot.token
        val device = snapshot.deviceId
        if (base == null || token == null || device == null) throw PairingException(PairingException.Code.SecureStorage)
        val request = HttpRequest("POST", "$base/v1/auth/refresh", mapOf("Authorization" to "Bearer $token", "X-Scan-Device" to device),
            ByteArray(0), null, 10_000)
        val reply = try { transport.send(request, TrustPolicy.Record(snapshot), MAX_REPLY, 15_000) } catch (e: TransportException) {
            throw error(if (e.code == "too-large") "invalid-response" else e.code)
        }
        check(reply.status)
        val json = parseObject(reply.body) ?: throw PairingException(PairingException.Code.InvalidResponse)
        val latest = try { store.read() } catch (_: Exception) { throw PairingException(PairingException.Code.PairingChanged) }
        if (latest == null || latest != snapshot) throw PairingException(PairingException.Code.PairingChanged)
        val record = latest.with("expiresAt", json["expiresAt"]).with("scopes", json["scopes"])
        val nowMs = now().toDouble()
        if (json["protocolVersion"] != snapshot.fields["protocolVersion"] || json["deviceId"] != snapshot.fields["deviceId"] ||
            json["token"] != snapshot.fields["token"] || !record.isValid ||
            record.expiresAtMs <= nowMs || record.expiresAtMs > nowMs + LIFETIME_LIMIT_MS) throw PairingException(PairingException.Code.InvalidResponse)
        save(record, false, started)
        return PairingStatus.of(record, now())
    }

    private fun current(): PairingRecord {
        val record = try { store.read() } catch (_: Exception) { throw PairingException(PairingException.Code.SecureStorage) }
        if (record == null || record.isExpired(now())) throw PairingException(PairingException.Code.PairingRequired)
        return record
    }
}

/** Keeps the paired Mac's credential alive: a credential lasts 30 days; under 20 days left, ask for another 30. */
enum class PairingFreshness {
    Fresh, Refreshed, Skipped, PairAgain;

    companion object {
        const val REFRESH_WITHIN_MS = 20.0 * 86_400_000

        suspend fun keep(client: PairingClient, nowMs: Long = System.currentTimeMillis()): PairingFreshness {
            val status = try { client.store.status(nowMs) } catch (_: Exception) { return Skipped }
            if (status.state == PairingStatus.State.Expired) return PairAgain
            val expires = status.expiresAtMs
            if (status.state != PairingStatus.State.Paired || expires == null) return Skipped
            if (expires - nowMs > REFRESH_WITHIN_MS) return Fresh
            return try { client.refresh(); Refreshed } catch (e: PairingException) {
                if (e.code in setOf(PairingException.Code.Unauthorized, PairingException.Code.Forbidden, PairingException.Code.PairingRequired)) PairAgain else Skipped
            } catch (_: Exception) { Skipped }
        }
    }
}
