package com.scantomake.counterpart.app

import android.app.Application
import android.os.Build
import android.provider.Settings
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.OnDeviceLibrary
import com.scantomake.counterpart.api.ProjectUploader
import com.scantomake.counterpart.net.PinnedTransport
import com.scantomake.counterpart.pairing.NearbyPairing
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingStore
import java.io.File

/** The app's long-lived objects, one per process (the iPhone app's `AppModel` holds the same). */
class Counterpart : Application() {
    lateinit var pairingStore: PairingStore
    lateinit var pairing: PairingClient
    lateinit var companion: CompanionClient
    lateinit var nearby: NearbyPairing
    lateinit var uploader: ProjectUploader
    lateinit var state: AppState

    val prefs by lazy { getSharedPreferences("counterpart", MODE_PRIVATE) }

    override fun onCreate() {
        super.onCreate()
        instance = this
        val transport = PinnedTransport()
        pairingStore = PairingStore(KeystoreStore(this), chosenName = { prefs.getString(DEVICE_NAME_KEY, null) }, systemName = ::systemDeviceName)
        pairing = PairingClient(pairingStore, transport)
        companion = CompanionClient(pairing, transport, deviceModel = deviceModel(), deviceName = userAssignedName(), cache = File(cacheDir, "Objects"),
            library = OnDeviceLibrary(File(noBackupFilesDir, "Library")).also { library ->
                library.keep = prefs.getString(OnDeviceLibrary.Keep.PREFS_KEY, null)?.let { runCatching { OnDeviceLibrary.Keep.valueOf(it) }.getOrNull() } ?: OnDeviceLibrary.Keep.Models
            })
        nearby = NearbyPairing(this, pairing, transport)
        uploader = ProjectUploader(companion)
        state = AppState(this)
        Notifications.createChannels(this)
        EventCheckWorker.schedule(this)
    }

    /** "Pixel 8": the Mac's device list shows it (`X-Scan-Device-Model`). */
    fun deviceModel(): String? {
        val model = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).distinct()
            .joinToString(" ").replace(Regex("[^A-Za-z0-9,._ -]"), "").trim().take(64)
        return model.ifEmpty { null }
    }

    /** The phone's own name ("David's Pixel"), when Android has one. */
    fun userAssignedName(): String? {
        prefs.getString(DEVICE_NAME_KEY, null)?.let { return it }
        return try { Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) } catch (_: Exception) { null }
            ?.trim()?.takeIf { it.isNotEmpty() && it.length <= 70 }
    }

    private fun systemDeviceName(): String = userAssignedName() ?: deviceModel() ?: "Android phone"

    companion object {
        const val DEVICE_NAME_KEY = "CounterpartDeviceName"
        lateinit var instance: Counterpart
            private set
    }
}
