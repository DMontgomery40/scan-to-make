package com.scantomake.counterpart.app

import com.scantomake.counterpart.api.mcpCopies

import android.content.Context
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.CounterpartEvent
import com.scantomake.counterpart.api.EventUpdate
import com.scantomake.counterpart.api.KnownProjects
import com.scantomake.counterpart.api.MacLink
import com.scantomake.counterpart.api.PrinterCatalog
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.eventStream
import com.scantomake.counterpart.pairing.PairingFreshness
import com.scantomake.counterpart.pairing.PairingStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The projects and printers the paired Mac has, kept current while the app is open: the event long poll when the
 * Mac serves it, and a refresh every 30 s otherwise. Port of the iPhone app's `AppModel` + `ProjectsStore`.
 */
class AppState(private val app: Counterpart) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /** What this phone keeps of the computer's projects (docs/design/overhaul/on-device-library.md). */
    val library by lazy { LibraryFill(app, scope) }

    val status = MutableStateFlow<PairingStatus?>(null)
    val projects = MutableStateFlow<List<Project>>(emptyList())
    val loaded = MutableStateFlow(false)
    val error = MutableStateFlow<CompanionException?>(null)
    val catalog = MutableStateFlow<PrinterCatalog?>(null)
    /** Whether the computer is answering: the one value Home and the starters read (`MacLink`). */
    val link = MutableStateFlow<MacLink>(MacLink.Checking)

    /** The computer replied, so nothing is wrong with the connection any more. */
    private fun answered() {
        link.value = link.value.answered()
        error.value?.let { if (it.isUnreachable || it.needsPairing) error.value = null }
    }

    /** A request failed. Only "didn't answer" and "pair again" are the whole app's problem and show in the banner. */
    fun requestFailed(failure: CompanionException) {
        if (failure.isUnreachable || failure.needsPairing) { link.value = link.value.failed(failure); error.value = failure } else answered()
    }
    val capabilities = MutableStateFlow<Set<String>>(emptySet())
    val sending = MutableStateFlow<Set<String>>(emptySet())
    val sendFailures = MutableStateFlow<Map<String, String>>(emptyMap())
    val macName = MutableStateFlow(app.prefs.getString(MAC_NAME_KEY, null))
    val eventsSupported = MutableStateFlow<Boolean?>(null)
    val mcpCopies = MutableStateFlow<List<com.scantomake.counterpart.api.McpPackageCopies>?>(null)
    val mcpCopiesProblem = MutableStateFlow<String?>(null)
    val mcpUpdateEvents = MutableStateFlow<Map<String, CounterpartEvent>>(emptyMap())
    data class McpUpdateAttempt(val printerId: String, val mcpId: String, val eventFloor: Int,
        val result: com.scantomake.counterpart.api.McpUpdate? = null, val problem: String? = null)
    // Keep the original operation ID when its screen leaves composition or the copy mapping changes.
    val mcpUpdateAttempts = MutableStateFlow<Map<String, McpUpdateAttempt>>(emptyMap())
    /** A project to open, from a notification tap. */
    val route = MutableStateFlow<String?>(null)
    /** A `scantomake://pair` link waiting for the pairing screen. */
    val pendingLink = MutableStateFlow<String?>(null)

    // What this phone already has (board X100): a page opens from it while the computer isn't answering, relaunch too.
    /** When the computer last answered with each project. */
    val heard = MutableStateFlow<Map<String, Long>>(emptyMap())
    private var known: KnownProjects? = null
    private val knownFile get() = java.io.File(app.filesDir, "known-projects.json")
    private val knownMac: String? get() = status.value?.takeIf { it.state == PairingStatus.State.Paired }?.baseUrl

    private var following: Job? = null
    private var foreground = false

    init {
        readStatus()
        restoreKnown()
        scope.launch {
            app.pairingStore.changes.collect {
                readStatus()
                reset()
                // Pairing can remove its screen before that screen calls onPaired.
                // The visible app, not the departing screen, owns its subscription.
                if (foreground) startFollowing()
            }
        }
    }

    val needsMac: Boolean get() = status.value?.state != PairingStatus.State.Paired

    fun readStatus() {
        val read = try { app.pairingStore.status() } catch (_: Exception) { null }
        status.value = read ?: PairingStatus.disconnected
        // Only a pairing that was read says which computer's library to keep; a failed read clears nothing.
        library.paired(read)
    }

    fun project(id: String) = projects.value.firstOrNull { it.id == id }

    /** Before the first list arrives: the projects this phone last heard from this computer. */
    fun restoreKnown() {
        val mac = knownMac ?: return
        if (projects.value.isNotEmpty()) return
        val saved = KnownProjects.decode(runCatching { knownFile.readText() }.getOrNull(), mac) ?: return
        known = saved; projects.value = saved.projects; heard.value = saved.heard
        library.fill(saved.projects, fromComputer = false)
    }

    private fun remember(change: (KnownProjects, Long) -> KnownProjects) {
        val mac = knownMac ?: return
        val now = System.currentTimeMillis()
        val next = change(known?.takeIf { it.mac == mac } ?: KnownProjects(mac), now)
        known = next; heard.value = next.heard
        scope.launch(Dispatchers.IO) { runCatching { knownFile.writeText(next.encode()) } }
    }
    fun printerName(p: Project): String? = p.print?.destination?.name ?: catalog.value?.resolved(p.printerDestinationId)?.name
    fun words(p: Project) = ProjectWords(p, sending = p.id in sending.value, localScan = Media.captureFinished(app, p.id), printerName = printerName(p))
    val anyRunning: Boolean get() = projects.value.any { words(it).busy } || sending.value.isNotEmpty()

    /** Keeps the credential alive when the app opens and each time it comes back. */
    suspend fun keepFresh() {
        readStatus()
        if (PairingFreshness.keep(app.pairing) == PairingFreshness.PairAgain) readStatus()
    }

    suspend fun load() {
        if (!loaded.value) restoreKnown()
        try {
            val listed = app.companion.list()
            projects.value = listed
            error.value = null; link.value = link.value.answered()
            library.fill(listed, fromComputer = true)
            remember { k, now -> k.heard(listed, now) }
        } catch (e: CancellationException) { throw e } catch (e: CompanionException) {
            // The list couldn't be read: the banner says why, whatever the reason.
            if (e.code != "cancelled") { link.value = link.value.failed(e); error.value = e }
        } catch (e: Exception) { requestFailed(CompanionException.unreachable) }
        loaded.value = true
    }

    /** A project refresh tells the link what happened, as the list load does: an answer, a refusal (still an answer),
     *  pairing lost, or no answer at all. */
    suspend fun reload(id: String): CompanionException? = try {
        val latest = app.companion.get(id)
        show(latest); answered(); remember { k, now -> k.heard(latest, now) }; null
    } catch (e: CompanionException) {
        if (e.code != "cancelled") requestFailed(e)
        if (e.code == "not-found") remove(id)
        e
    }

    fun show(p: Project) {
        projects.update { list -> if (list.any { it.id == p.id }) list.map { if (it.id == p.id) p else it } else listOf(p) + list }
    }

    fun remove(id: String) { projects.update { list -> list.filterNot { it.id == id } }; remember { k, _ -> k.forget(id) } }

    suspend fun loadPrinters() { try { catalog.value = app.companion.printers() } catch (_: Exception) {}; loadMcpCopies() }
    suspend fun loadMcpCopies() {
        if (!capabilities.value.contains("mcpCopies")) { mcpCopies.value = null; return }
        try { mcpCopies.value = app.companion.mcpCopies(); mcpCopiesProblem.value = null }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { mcpCopiesProblem.value = "Couldn’t refresh the printer software copies." }
    }

    suspend fun loadCapabilities() {
        val health = try { app.companion.health() } catch (_: Exception) { return }
        capabilities.value = health.capabilities
        loadMcpCopies()
        health.name?.let { if (it != macName.value) { app.prefs.edit().putString(MAC_NAME_KEY, it).apply(); macName.value = it } }
    }

    fun reset() {
        following?.cancel(); following = null
        projects.value = emptyList(); loaded.value = false; error.value = null; catalog.value = null; link.value = MacLink.Checking
        capabilities.value = emptySet(); eventsSupported.value = null; sendFailures.value = emptyMap()
        mcpUpdateAttempts.value = emptyMap()
        mcpUpdateEvents.value = emptyMap(); mcpCopies.value = null; mcpCopiesProblem.value = null
        known = null; heard.value = emptyMap()
        restoreKnown()
    }

    /** Projects whose page or Printing screen is showing, counted (a push then a pop never loses one). */
    val onScreen = MutableStateFlow<Map<String, Int>>(emptyMap())
    fun showing(id: String, visible: Boolean) = onScreen.update { now ->
        val count = (now[id] ?: 0) + if (visible) 1 else -1
        if (count > 0) now + (id to count) else now - id
    }

    /** Starts following the Mac while the app is visible: one consumer for every screen. */
    fun startFollowing() {
        foreground = true
        if (following?.isActive == true || needsMac) return
        following = scope.launch {
            keepFresh()
            if (needsMac) return@launch
            load(); loadPrinters(); loadCapabilities()
            if (eventsSupported.value != false) {
                try {
                    eventStream(app.companion).collect { update ->
                        eventsSupported.value = true; answered()
                        when (update) {
                            EventUpdate.Resync -> { load(); loadPrinters() }
                            is EventUpdate.Event -> {
                                val e = update.event
                                // In the foreground it shows unless its project's page or Printing screen is showing
                                // (PRD §9.2: suppress only what the app already shows). Either way it's seen once.
                                if (e.projectId != null && e.projectId in onScreen.value) Notifications.markSeen(app, e.id, e.seq)
                                else Notifications.post(app, e)
                                val pid = e.projectId
                                if (pid != null) { if (e.type == "project.deleted") remove(pid) else reload(pid) }
                                else if (e.type.startsWith("mcp.update.")) {
                                    e.data?.mcpId?.let { mcpUpdateEvents.value = mcpUpdateEvents.value + (it to e) }
                                    loadPrinters()
                                }
                            }
                        }
                    }
                } catch (e: CancellationException) { throw e } catch (e: CompanionException) {
                    if (e.isUnsupported) eventsSupported.value = false
                    if (e.needsPairing) { requestFailed(e); return@launch }
                } catch (_: Exception) {}
            }
            while (true) { delay(if (anyRunning) 5_000 else 30_000); load() }
        }
    }

    fun stopFollowing() { foreground = false; following?.cancel(); following = null }

    /** Sends a new project's files after its sheet has closed. The project shows Sending until they land. */
    fun sendInBackground(id: String, body: suspend () -> Unit) {
        if (id in sending.value) return
        sending.update { it + id }
        sendFailures.update { it - id }
        scope.launch {
            try { body() } catch (e: CancellationException) { throw e } catch (e: CompanionException) {
                if (e.code != "cancelled") sendFailures.update { it + (id to e.message) }
            } catch (e: Exception) {
                sendFailures.update { it + (id to CompanionException.unreachable.message) }
            } finally {
                sending.update { it - id }
                reload(id)
            }
        }
    }

    fun forgetMac() {
        try { app.pairing.forget() } catch (_: Exception) {}
        app.prefs.edit().remove(MAC_NAME_KEY).apply(); macName.value = null
        readStatus()
    }

    fun printing(destinationId: String): Project? = projects.value.firstOrNull {
        (it.print?.destinationId ?: it.print?.destination?.id ?: it.printerDestinationId) == destinationId &&
            words(it).phase in setOf(ProjectPhase.Printing, ProjectPhase.Preparing)
    }

    companion object {
        const val MAC_NAME_KEY = "CounterpartMacName"
        fun of(context: Context) = (context.applicationContext as Counterpart).state
    }
}
