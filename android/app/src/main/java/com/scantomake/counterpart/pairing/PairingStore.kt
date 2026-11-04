package com.scantomake.counterpart.pairing

import com.scantomake.counterpart.core.Base64Url
import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.Pattern
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.isPlainText
import com.scantomake.counterpart.core.parseObject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.security.SecureRandom

/** Where the pairing secrets live: the Android Keystore-backed store in the app; an in-memory one in tests. */
interface SecureStore {
    fun read(account: String): ByteArray?
    fun write(account: String, data: ByteArray)
    /** Adds the item only if there is none; false when one already exists. */
    fun add(account: String, data: ByteArray): Boolean
    fun delete(account: String)
}

class MemoryStore(initial: Map<String, ByteArray> = emptyMap()) : SecureStore {
    private val items = HashMap(initial)
    @Synchronized override fun read(account: String) = items[account]
    @Synchronized override fun write(account: String, data: ByteArray) { items[account] = data }
    @Synchronized override fun add(account: String, data: ByteArray): Boolean {
        if (items.containsKey(account)) return false
        items[account] = data; return true
    }
    @Synchronized override fun delete(account: String) { items.remove(account) }
}

/** A pairing failure, with the code the screens turn into words (`PairingWords`). Codes are CounterpartKit's. */
class PairingException(val code: Code) : Exception(code.wire) {
    enum class Code(val wire: String) {
        SecureStorage("secure-storage"), InvalidInvitation("invalid-invitation"), ExpiredInvitation("expired-invitation"),
        UnsupportedInvitation("unsupported-invitation"), InvalidDeviceName("invalid-device-name"),
        Unauthorized("unauthorized"), Forbidden("forbidden"), RateLimited("rate-limited"), WrongHost("wrong-host"), Unavailable("unavailable"),
        Network("network"), Timeout("timeout"), Certificate("certificate"), CertificateChanged("certificate-changed"), InvalidResponse("invalid-response"),
        PairingRequired("pairing-required"), PairingChanged("pairing-changed"), Busy("busy"), Cancelled("cancelled"),
        NearbyDenied("nearby-denied"), NearbyExpired("nearby-expired"), LocalNetwork("local-network");
        companion object { fun of(wire: String): Code = entries.firstOrNull { it.wire == wire } ?: Network }
    }
    companion object {
        fun of(link: PairingLinkError) = PairingException(when (link) {
            PairingLinkError.Invalid -> Code.InvalidInvitation
            PairingLinkError.Expired -> Code.ExpiredInvitation
            PairingLinkError.Unsupported -> Code.UnsupportedInvitation
        })
    }
}

/**
 * The paired Mac's record and this install's identity. Port of CounterpartKit `PairingStore`: account `current`
 * holds the record (JSON), `installation` this install's stable 43-character identity.
 */
class PairingStore(private val store: SecureStore, private val chosenName: () -> String? = { null }, private val systemName: () -> String = { "Android phone" }) {
    private val installationPattern = Pattern("[A-Za-z0-9_-]{43}")
    private val _changes = MutableStateFlow(0)
    /** Bumped whenever a different pairing is saved or the pairing is forgotten. */
    val changes: StateFlow<Int> = _changes

    fun read(): PairingRecord? {
        val data = try { store.read("current") } catch (_: Exception) { throw PairingException(PairingException.Code.SecureStorage) } ?: return null
        val fields = if (data.size < 8192) parseObject(data) else null
        val record = fields?.let { PairingRecord(it) } ?: throw PairingException(PairingException.Code.SecureStorage)
        if (!record.isValid) throw PairingException(PairingException.Code.SecureStorage)
        return record
    }

    fun status(nowMs: Long = System.currentTimeMillis()): PairingStatus = PairingStatus.of(read(), nowMs)

    /** `notify` is false when it is still the same pairing (a refresh or another address). */
    fun save(record: PairingRecord, notify: Boolean) {
        if (!record.isValid) throw PairingException(PairingException.Code.InvalidResponse)
        store.write("current", WireJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), record.toJson()).toByteArray())
        if (notify) _changes.value += 1
    }

    fun disconnect() {
        store.delete("current")
        _changes.value += 1
    }

    /** This install's identity, independent of the current Mac credential. A companion stores only its hash. */
    fun installationKey(): String {
        store.read("installation")?.let { data ->
            val key = String(data, Charsets.UTF_8)
            if (data.size != 43 || !installationPattern.matches(key)) throw PairingException(PairingException.Code.SecureStorage)
            return key
        }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val key = Base64Url.encode(bytes)
        if (store.add("installation", key.toByteArray())) return key
        return installationKey()
    }

    /** The name the Mac shows for this phone: the one chosen here, else the device's own name. */
    fun deviceName(): String {
        chosenName()?.let { if (isPlainText(it, 80)) return it.trim() }
        var name = systemName()
        if (!isPlainText(name, 70)) name = "Android phone"
        if (name == "Android phone") return "$name (${Hex.sha256(installationKey().toByteArray()).take(4).uppercase()})"
        return name.trim()
    }
}

/** Pairing failures in plain words: what happened, and the one thing to do about it. Port of `PairingWords`. */
object PairingWords {
    const val expired = "That code expired. Show a new one on your Mac: click the Counterpart icon in the menu bar → Add a phone."
    const val unreachable = "Your phone can’t reach your Mac. Are they on the same Wi-Fi, or is your VPN on?"

    fun message(code: PairingException.Code): String = when (code) {
        PairingException.Code.InvalidInvitation -> "That isn’t a Counterpart code. Point at the code in Counterpart on your Mac."
        PairingException.Code.ExpiredInvitation -> expired
        PairingException.Code.UnsupportedInvitation -> "That code is from a newer Counterpart. Update the app on this phone, then scan it again."
        PairingException.Code.Unauthorized -> "Your Mac turned this phone down, or the code was already used. Show a new code on your Mac and scan it."
        PairingException.Code.Forbidden -> "Your Mac turned this phone down. Show a new code and scan it."
        PairingException.Code.RateLimited -> "Too many tries. Wait a minute, then scan a new code from your Mac."
        PairingException.Code.CertificateChanged -> "This Mac looks different from last time. Pair again to be safe."
        PairingException.Code.Certificate -> "Your phone couldn’t check that this is your Mac. Show a new code on your Mac and scan it."
        PairingException.Code.WrongHost -> "That code sent your phone somewhere else, so nothing was shared. Scan the code on your Mac again."
        PairingException.Code.Network, PairingException.Code.Timeout -> unreachable
        PairingException.Code.Unavailable -> "Your Mac is busy right now. Try again in a moment."
        PairingException.Code.SecureStorage -> "This phone couldn’t store the pairing. Unlock it and try again."
        PairingException.Code.PairingRequired -> "Pair this phone with your Mac again."
        PairingException.Code.PairingChanged -> "Your Mac changed while this was running. Try again."
        PairingException.Code.InvalidResponse -> "Your Mac answered in a way this app doesn’t understand. Update Counterpart on both, then pair again."
        PairingException.Code.InvalidDeviceName -> "Give this phone a name between 1 and 80 characters."
        PairingException.Code.NearbyDenied -> "Your Mac said no to this phone. If that was a mistake, try again and click Allow on your Mac."
        PairingException.Code.NearbyExpired -> "That took too long, so nothing was paired. Try again, then click Allow on your Mac."
        PairingException.Code.LocalNetwork -> "Counterpart can’t look on your Wi-Fi. Check that Wi-Fi is on and this phone is on the same network as your Mac."
        PairingException.Code.Cancelled -> "Cancelled. Nothing changed."
        PairingException.Code.Busy -> "Still working on the last request. Try again in a moment."
    }

    fun failure(error: Throwable): String {
        val code = when (error) {
            is PairingException -> error.code
            is PairingLinkException -> PairingException.of(error.error).code
            else -> return "Pairing didn’t finish. Show a new code on your Mac and scan it."
        }
        if (code == PairingException.Code.Network || code == PairingException.Code.Timeout) {
            return "$unreachable If you use a VPN or Private DNS, turn it off and try again."
        }
        return message(code)
    }
}
