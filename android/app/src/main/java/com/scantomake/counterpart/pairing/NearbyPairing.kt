package com.scantomake.counterpart.pairing

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.isPlainText
import com.scantomake.counterpart.core.jsonOf
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.net.HttpRequest
import com.scantomake.counterpart.net.HttpTransport
import com.scantomake.counterpart.net.NearbySeen
import com.scantomake.counterpart.net.TransportException
import com.scantomake.counterpart.net.TrustPolicy
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import java.net.Inet4Address
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

/** A Mac advertising Counterpart on this Wi-Fi. The advert is only a hint; the matching 6-digit code is the proof. */
data class NearbyMac(val name: String, val publicKeySha256: String?)

/** A nearby session waiting for Allow on the Mac. */
data class NearbyStarted(val code: String, val publicKeySha256: String, val baseUrl: String, val expiresAtMs: Double)

/**
 * The phone's half of nearby pairing (journey.md §3.4, `@scan-to-make/contracts/nearby-pairing`). Port of
 * CounterpartKit `NearbyPairing`, with Android's NsdManager in place of NWBrowser: browse `_scantomake._tcp`,
 * resolve one to an IPv4 address, commit to a fresh key, reveal it, show the code, wait for Allow, then pair
 * through the ordinary v2 path pinned to the same key.
 */
class NearbyPairing(context: Context, private val client: PairingClient, private val transport: HttpTransport) {
    companion object { const val SERVICE_TYPE = "_scantomake._tcp" }

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val found = ConcurrentHashMap<String, NsdServiceInfo>()
    private var listener: NsdManager.DiscoveryListener? = null
    private var lock: WifiManager.MulticastLock? = null

    /** Macs seen within `timeoutMs`. Browsing keeps running, so `pair` also finds Macs that appear later. */
    suspend fun browse(timeoutMs: Long = 3_000): List<NearbyMac> {
        stopBrowsing()
        found.clear()
        lock = wifi.createMulticastLock("counterpart-nearby").apply { setReferenceCounted(false); acquire() }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) { found[info.serviceName] = info }
            override fun onServiceLost(info: NsdServiceInfo) { found.remove(info.serviceName) }
        }
        listener = l
        try { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l) } catch (_: Exception) {
            throw PairingException(PairingException.Code.LocalNetwork)
        }
        delay(timeoutMs.coerceIn(500, 10_000))
        return list
    }

    val list: List<NearbyMac> get() = found.keys.sortedWith(String.CASE_INSENSITIVE_ORDER).map { NearbyMac(it, null) }

    fun stopBrowsing() {
        listener?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        listener = null
        lock?.let { try { it.release() } catch (_: Exception) {} }
        lock = null
    }

    @Suppress("DEPRECATION")
    private suspend fun resolve(info: NsdServiceInfo): String = withTimeout(8_000) {
        suspendCancellableCoroutine { continuation ->
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    if (continuation.isActive) continuation.resume("")
                }
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val hosts = if (Build.VERSION.SDK_INT >= 34) serviceInfo.hostAddresses else listOfNotNull(serviceInfo.host)
                    val v4 = hosts.firstOrNull { it is Inet4Address }
                    val url = v4?.let { CompanionAddress.pinnedBaseURL("https://${it.hostAddress}:${serviceInfo.port}", "0".repeat(64)) } ?: ""
                    if (continuation.isActive) continuation.resume(url)
                }
            })
        }
    }.ifEmpty { throw PairingException(PairingException.Code.Network) }

    /**
     * Pairs with `mac`: shows the code through `onCode`, waits for Allow (about two minutes at most), then pairs
     * pinned to the key this phone saw.
     */
    suspend fun pair(mac: NearbyMac, deviceName: String, onCode: (NearbyStarted) -> Unit): PairingStatus {
        val info = found[mac.name]
        if (info == null || !isPlainText(deviceName, 80)) throw PairingException(PairingException.Code.InvalidInvitation)
        val base = resolve(info)
        val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val seen = NearbySeen()
        // Commit to the key before the Mac's nonce exists.
        val opened = post(base, "/v1/pair/nearby", jsonOf("commit" to NearbyCrypto.base64URL(NearbyCrypto.commit(key)!!), "deviceName" to deviceName), seen, 10_000)
        val nonce = NearbyCrypto.bytes(opened["nonce"].str)
        val session = opened["session"].str
        val expiresAt = opened["expiresAt"].num
        if (nonce == null || !Pattern("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(session) || expiresAt == null) {
            throw PairingException(PairingException.Code.InvalidResponse)
        }
        val revealed = post(base, "/v1/pair/nearby/reveal", jsonOf("session" to session, "key" to NearbyCrypto.base64URL(key)), seen, 10_000)
        val s = seen.key
        val code = if (s != null) NearbyCrypto.code(s, key, nonce) else null
        if (revealed["status"].str != "waiting" || s == null || code == null) throw PairingException(PairingException.Code.InvalidResponse)
        val started = NearbyStarted(code, Hex.string(s), base, expiresAt)
        onCode(started)

        // Wait for Allow. A dropped wait keeps the session on the Mac: ask again, but not forever.
        var dropped = 0
        while (true) {
            val answer = try {
                post(base, "/v1/pair/nearby/result", jsonOf("session" to session, "key" to NearbyCrypto.base64URL(key)), seen, 40_000).also { dropped = 0 }
            } catch (e: PairingException) {
                if (e.code == PairingException.Code.Network || e.code == PairingException.Code.Timeout) {
                    dropped += 1
                    if (dropped < 3) continue
                }
                throw e
            }
            when (answer["status"].str) {
                "waiting" -> if (answer["expiresAt"].num != null) continue else throw PairingException(PairingException.Code.InvalidResponse)
                "denied" -> throw PairingException(PairingException.Code.NearbyDenied)
                "allowed" -> {
                    val text = answer["link"].str
                    val link = try { text?.takeIf { it.toByteArray().size <= 4096 }?.let { PairingLink.parse(it) } } catch (_: Exception) { null }
                    if (link !is PairingLink.V2 || link.publicKeySha256 != started.publicKeySha256) throw PairingException(PairingException.Code.InvalidResponse)
                    // The link came over the connection pinned to S; a different key means a broken Mac.
                    stopBrowsing()
                    return client.pair(PairingInvitation.from(link), deviceName)
                }
                else -> throw PairingException(PairingException.Code.InvalidResponse)
            }
        }
    }

    private suspend fun post(base: String, path: String, body: JsonObject, seen: NearbySeen, timeoutMs: Long): JsonObject {
        val request = HttpRequest("POST", base + path, emptyMap(), WireJson.encodeToString(JsonObject.serializer(), body).toByteArray(), "application/json", timeoutMs)
        val reply = try { transport.send(request, TrustPolicy.Nearby(base, seen), 16_384, 45_000) } catch (e: TransportException) {
            throw PairingClient.error(if (e.code == "too-large") "invalid-response" else e.code)
        }
        if (reply.status != 200) throw PairingException(when (reply.status) {
            401 -> PairingException.Code.NearbyExpired
            403 -> PairingException.Code.Forbidden
            429 -> PairingException.Code.RateLimited
            else -> PairingException.Code.Unavailable
        })
        return parseObject(reply.body) ?: JsonObject(emptyMap())
    }
}
