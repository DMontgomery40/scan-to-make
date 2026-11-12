package com.scantomake.counterpart.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.scantomake.counterpart.api.LibraryPlan
import com.scantomake.counterpart.api.OnDeviceLibrary
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.pairing.PairingStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * Fills the phone's library without being asked (iOS `LibraryFiller`; docs/design/overhaul/on-device-library.md): every
 * project's picture whenever the list loads or changes, three at a time, on any link; models of opened and recent projects
 * on an unmetered link; a scan only when the person keeps everything. A metered link is Android's own
 * `NET_CAPABILITY_NOT_METERED` being absent (cellular, a metered Wi-Fi, a hotspot).
 */
class LibraryFill(private val app: Counterpart, private val scope: CoroutineScope) {
    /** Null in tests that build a client without one: then nothing is kept and nothing fills. */
    private val library: OnDeviceLibrary? get() = app.companion.library
    val usage = MutableStateFlow(0L)
    val keep = MutableStateFlow(library?.keep ?: OnDeviceLibrary.Keep.Models)
    /** Files being fetched now: a new list adds to them and never cancels one in flight (an event reload is constant). */
    private val inFlight = mutableSetOf<String>()
    private var last: Pair<List<Project>, Boolean>? = null
    private val opened = mutableSetOf<String>()

    private fun metered(): Boolean {
        val connectivity = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return true
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /** Which computer's library, from a pairing that was read: another computer's is cleared. Nothing else clears it
     *  here: a refused or unreadable credential is not a person forgetting the computer (board X96). */
    fun paired(status: PairingStatus?) {
        val library = library ?: return
        // The computer by its pin (the saved list's key), also while its credential is expired (#720).
        if (status != null && status.state != PairingStatus.State.Disconnected) (status.pin?.let { "pin:$it" } ?: status.baseUrl)?.let(library::use)
        usage.value = library.usage
    }

    /** Settings → Forget: everything kept goes. */
    fun forgot() { library?.unpair(); opened.clear(); last = null; usage.value = 0 }

    fun choose(choice: OnDeviceLibrary.Keep) {
        val library = library ?: return
        library.keep = choice; keep.value = choice
        app.prefs.edit().putString(OnDeviceLibrary.Keep.PREFS_KEY, choice.name).apply()
        scope.launch(Dispatchers.IO) { library.evict(); usage.value = library.usage }
        last?.let { fill(it.first, it.second) }
    }

    fun opened(id: String) {
        library?.opened(id)
        if (opened.add(id)) last?.let { fill(it.first, it.second) }
    }

    fun clear() { library?.clear(); usage.value = 0 }

    /** The list loaded or changed; `fromComputer` when it came from the computer now, so a missing project is deleted. */
    fun fill(projects: List<Project>, fromComputer: Boolean) {
        last = projects to fromComputer
        val library = library ?: return
        if (!library.isActive || projects.isEmpty()) return
        scope.launch(Dispatchers.IO) {
            if (fromComputer) library.prune(projects.map { it.id }.toSet())
            val everOpened = opened + projects.filter { library.lastOpened(it.id) != null }.map { it.id }
            val metered = metered()
            val wants = LibraryPlan.wants(projects, everOpened, library.keep)
                .filter { LibraryPlan.fetches(it, library.keep, metered) }
                .filter { library.file(it.project.id, it.name, it.project.mediaVersion) == null && !library.isTooLarge(it.project.id, it.name, it.project.mediaVersion) }
                .filter { synchronized(inFlight) { inFlight.add("${it.project.id}#${it.name}#${it.project.mediaVersion}") } }
            if (wants.isEmpty()) return@launch
            wants.map { want ->
                launch { lane.withPermit {
                    try { runCatching { app.companion.download(want.project, want.name) } }
                    finally { synchronized(inFlight) { inFlight.remove("${want.project.id}#${want.name}#${want.project.mediaVersion}") } }
                } }
            }.forEach { it.join() }
            library.evict()
            usage.value = library.usage
        }
    }

    /** At most three files at once, across every fill. */
    private val lane = Semaphore(3)
}
