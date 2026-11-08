package com.scantomake.counterpart.app

import com.scantomake.counterpart.api.mcpCopies

import android.content.Context
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.CounterpartEvent
import com.scantomake.counterpart.api.EventUpdate
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

    val status = MutableStateFlow<PairingStatus?>(null)
    val projects = MutableStateFlow<List<Project>>(emptyList())
    val loaded = MutableStateFlow(false)
    val error = MutableStateFlow<CompanionException?>(null)
    val catalog = MutableStateFlow<PrinterCatalog?>(null)
    val reachable = MutableStateFlow<Boolean?>(null)
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
    /**
     * PRD §8.10: an update that says it waits, then hears nothing more from the companion for this long, says so. The
     * companion ends every wait within a minute; past this its event went missing (a restart). The Mac's and iPhone's clock.
     */
    var mcpWaitLimitMs = 90_000L
    /** Installs whose wait heard nothing more: their words become [MCP_UNHEARD], until the next word about them. */
    val mcpUnheard = MutableStateFlow<Set<String>>(emptySet())
    private val mcpWaits = mutableMapOf<String, Job>()

    /** Every change of an install's update state, from an event or an Update reply: a wait starts its clock, anything else stops it. */
    fun noteMcpUpdate(mcpId: String, waiting: Boolean) {
        mcpWaits.remove(mcpId)?.cancel()
        mcpUnheard.update { it - mcpId }
        if (!waiting) return
        mcpWaits[mcpId] = scope.launch {
            delay(mcpWaitLimitMs)
            mcpWaits.remove(mcpId)
            mcpUnheard.update { it + mcpId }
        }
    }
    /** A project to open, from a notification tap. */
    val route = MutableStateFlow<String?>(null)
    /** A `scantomake://pair` link waiting for the pairing screen. */
    val pendingLink = MutableStateFlow<String?>(null)

    private var following: Job? = null
    private var foreground = false

    init {
        readStatus()
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

    fun readStatus() { status.value = try { app.pairingStore.status() } catch (_: Exception) { PairingStatus.disconnected } }

    fun project(id: String) = projects.value.firstOrNull { it.id == id }
    fun printerName(p: Project): String? = p.print?.destination?.name ?: catalog.value?.destination(p.printerDestinationId)?.name
    fun words(p: Project) = ProjectWords(p, sending = p.id in sending.value, printerName = printerName(p))
    val anyRunning: Boolean get() = projects.value.any { words(it).busy } || sending.value.isNotEmpty()

    /** Keeps the credential alive when the app opens and each time it comes back. */
    suspend fun keepFresh() {
        readStatus()
        if (PairingFreshness.keep(app.pairing) == PairingFreshness.PairAgain) readStatus()
    }

    suspend fun load() {
        try {
            projects.value = app.companion.list()
            error.value = null; reachable.value = true
        } catch (e: CancellationException) { throw e } catch (e: CompanionException) {
            if (e.code != "cancelled") { error.value = e; if (e.isUnreachable) reachable.value = false }
        } catch (e: Exception) { error.value = CompanionException.unreachable; reachable.value = false }
        loaded.value = true
    }

    suspend fun reload(id: String): CompanionException? = try {
        show(app.companion.get(id)); null
    } catch (e: CompanionException) {
        if (e.code == "not-found") remove(id)
        e
    }

    fun show(p: Project) {
        projects.update { list -> if (list.any { it.id == p.id }) list.map { if (it.id == p.id) p else it } else listOf(p) + list }
    }

    fun remove(id: String) { projects.update { list -> list.filterNot { it.id == id } } }

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
        projects.value = emptyList(); loaded.value = false; error.value = null; catalog.value = null; reachable.value = null
        capabilities.value = emptySet(); eventsSupported.value = null; sendFailures.value = emptyMap()
        mcpUpdateAttempts.value = emptyMap()
        mcpWaits.values.forEach { it.cancel() }; mcpWaits.clear(); mcpUnheard.value = emptySet()
        mcpUpdateEvents.value = emptyMap(); mcpCopies.value = null; mcpCopiesProblem.value = null
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
                        eventsSupported.value = true; reachable.value = true
                        when (update) {
                            EventUpdate.Resync -> { load(); loadPrinters() }
                            is EventUpdate.Event -> {
                                val e = update.event
                                // Seen here in the foreground: the background check must not post it again.
                                Notifications.markSeen(app, e.id, e.seq)
                                val pid = e.projectId
                                if (pid != null) { if (e.type == "project.deleted") remove(pid) else reload(pid) }
                                else if (e.type.startsWith("mcp.update.")) {
                                    e.data?.mcpId?.let { mcpUpdateEvents.value = mcpUpdateEvents.value + (it to e); noteMcpUpdate(it, e.type == "mcp.update.waiting") }
                                    loadPrinters()
                                }
                            }
                        }
                    }
                } catch (e: CancellationException) { throw e } catch (e: CompanionException) {
                    if (e.isUnsupported) eventsSupported.value = false
                    if (e.needsPairing) { error.value = e; return@launch }
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
        const val MCP_UNHEARD = "Counterpart didn’t say whether this updated. Try Update again."
        const val MAC_NAME_KEY = "CounterpartMacName"
        fun of(context: Context) = (context.applicationContext as Counterpart).state
    }
}
