package com.scantomake.counterpart.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Text
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.McpUpdate
import com.scantomake.counterpart.api.PrinterDestination
import com.scantomake.counterpart.api.PrinterPrintRoute
import com.scantomake.counterpart.api.choosePrinterMcp
import com.scantomake.counterpart.api.printerPrintRoute
import com.scantomake.counterpart.api.updatePrinterMcp
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.core.bool
import com.scantomake.counterpart.core.jsonOf
import com.scantomake.counterpart.core.obj
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The phone edits the same printer-owned preferences as the desktop; no local preference copy. */
@Composable
fun PrinterSettingsControls(printer: PrinterDestination, state: AppState) {
    val client = Counterpart.instance.companion
    val scope = rememberCoroutineScope()
    val events by state.mcpUpdateEvents.collectAsState()
    val unheard by state.mcpUnheard.collectAsState()
    val capabilities by state.capabilities.collectAsState()
    var route by remember(printer.id, printer.backend) { mutableStateOf<PrinterPrintRoute?>(null) }
    var routeLoading by remember(printer.id, printer.backend) { mutableStateOf(true) }
    var routeProblem by remember(printer.id, printer.backend) { mutableStateOf<String?>(null) }
    var routeReload by remember { mutableStateOf(0) }
    var busy by remember(printer.id) { mutableStateOf(false) }
    var problem by remember(printer.id) { mutableStateOf<String?>(null) }
    var update by remember(printer.mcpId) { mutableStateOf<McpUpdate?>(null) }
    var eventFloor by remember(printer.mcpId) { mutableStateOf(events[printer.mcpId]?.seq ?: -1) }
    val updateEvent = events[printer.mcpId]?.takeIf { it.seq > eventFloor }

    LaunchedEffect(printer.id, printer.backend, routeReload) {
        routeLoading = true; routeProblem = null
        try { route = client.printerPrintRoute(printer.id) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { routeProblem = e.message ?: "Couldn't read the connection." }
        finally { routeLoading = false }
    }

    fun change(operation: suspend () -> Unit) {
        if (busy) return
        busy = true; problem = null
        scope.launch {
            try { operation() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { problem = e.message ?: "The companion couldn't save that change." }
            finally { busy = false }
        }
    }

    fun updateMcp(fresh: Boolean) {
        val mcpId = printer.mcpId ?: return
        eventFloor = events[mcpId]?.seq ?: -1
        update = null
        state.noteMcpUpdate(mcpId, null)
        change {
            update = client.updatePrinterMcp(mcpId, fresh).also { state.noteMcpUpdate(mcpId, it.state) }
            state.loadPrinters()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        McpCopiesPanel(printer.id, state)
        printer.capabilities?.server?.let { Text("${it.name} ${it.version}", color = Palette.secondary, fontSize = 12.sp) }
        val currentRoute = route
        if (routeLoading) Text("Reading the connection…", color = Palette.secondary, fontSize = 12.sp)
        if (currentRoute != null) {
            Text("Connection", fontSize = 13.sp)
            currentRoute.choices.forEach { id ->
                val detail = currentRoute.options?.firstOrNull { it.id == id }
                SecondaryButton((if (currentRoute.route == id) "✓ " else "") + currentRoute.label(id), Modifier.fillMaxWidth(),
                    enabled = !busy && !routeLoading && currentRoute.available(id) && currentRoute.route != id) {
                    change { route = client.printerPrintRoute(printer.id, id); state.loadPrinters() }
                }
                if (detail?.available == false) detail.reason?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
                if (currentRoute.route == id) detail?.controls?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
            }
        }
        routeProblem?.let {
            Text(it, color = Palette.needsYou, fontSize = 12.sp)
            TextButton(onClick = { routeReload++ }, enabled = !busy) { Text("Read Connection Again") }
        }
        printer.mcps?.takeIf { it.size > 1 }?.let { choices ->
            Text("Printer MCP", fontSize = 13.sp)
            choices.distinctBy { it.backend }.forEach { choice ->
                SecondaryButton((if (choice.backend == printer.backend) "✓ " else "") + choice.backend,
                    Modifier.fillMaxWidth(), enabled = !busy && choice.backend != printer.backend) {
                    change { state.catalog.value = client.choosePrinterMcp(printer.id, choice.backend).catalog }
                }
            }
        }
        if (printer.mcpId != null && !capabilities.contains("mcpCopies")) {
            SecondaryButton(if (printer.capabilities?.update != null) "Update Printer Software" else "Check for Updates",
                Modifier.fillMaxWidth(), enabled = !busy) { updateMcp(false) }
            if (update?.state == "unresolved" && updateEvent == null)
                SecondaryButton("Install a Fresh Copy", Modifier.fillMaxWidth(), enabled = !busy) { updateMcp(true) }
            // Events carry the completed/failed result. Never poll by replaying a mutation after an uncertain send.
            // A wait or an update under way whose event never came says so (PRD §8.10), and Update stays pressable.
            if (printer.mcpId in unheard) Text(AppState.MCP_UNHEARD, color = Palette.secondary, fontSize = 12.sp)
            else if (updateEvent != null) {
                Text(updateEvent.title, color = if (updateEvent.type.endsWith("failed")) Palette.failed else Palette.secondary, fontSize = 13.sp)
                if (updateEvent.body.isNotBlank()) Text(updateEvent.body, color = Palette.secondary, fontSize = 12.sp)
            } else update?.let { Text(it.words, color = Palette.secondary, fontSize = 12.sp) }
        }
        problem?.let { Text(it, color = Palette.failed, fontSize = 13.sp) }
    }
}


/** Q9: the same words as iPhone, iPad and the Mac (CounterpartKit `SettingsSchema.autoUpdateMcps`) and Linux (`domain.ts`); Linux's `domain.test.ts` fails if they differ. */
const val AUTO_UPDATE_MCPS_LABEL = "Keep printer software up to date"
const val AUTO_UPDATE_MCPS_WORDS = "Counterpart updates its printer software by itself when nothing is printing or being designed, and tells you afterwards."

/**
 * Q9, `general.autoUpdateMcps`: one switch for all the computer's printer software, under Printers' printer software,
 * as on iPhone and iPad (Settings → Printer software), the Mac (Settings → Printers) and Linux (Printer tools). Not inside
 * [McpCopiesPanel], which is drawn once per printer. Shown only when the computer sends the key: an older companion has no
 * automatic updates, and one whose settings can't be read shows nothing rather than a guess.
 */
@Composable
fun AutoUpdateMcpsSwitch() {
    val client = Counterpart.instance.companion
    val scope = rememberCoroutineScope()
    var on by remember { mutableStateOf<Boolean?>(null) }
    var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        on = try { client.settings()["general"].obj?.get("autoUpdateMcps").bool }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { null }
    }
    val value = on ?: return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().testTag("auto-update-mcps").toggleable(value = value, enabled = !saving, role = Role.Switch) { next ->
            saving = true; problem = null
            scope.launch {
                try { on = client.changeSettings(jsonOf("general" to jsonOf("autoUpdateMcps" to next)))["general"].obj?.get("autoUpdateMcps").bool ?: next }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { problem = e.message ?: "Your computer couldn’t save that change." }
                finally { saving = false }
            }
        }, verticalAlignment = Alignment.CenterVertically) {
            Text(AUTO_UPDATE_MCPS_LABEL, Modifier.weight(1f))
            Switch(checked = value, onCheckedChange = null, enabled = !saving)
        }
        Text(AUTO_UPDATE_MCPS_WORDS, color = Palette.secondary, fontSize = 12.sp)
        problem?.let { Text(it, color = Palette.failed, fontSize = 12.sp) }
    }
}

@Composable
fun McpCopiesPanel(printerId: String, state: AppState) {
    val packages by state.mcpCopies.collectAsState()
    val readProblem by state.mcpCopiesProblem.collectAsState()
    val capabilities by state.capabilities.collectAsState()
    val events by state.mcpUpdateEvents.collectAsState()
    var busy by remember { mutableStateOf<String?>(null) }
    val attempts by state.mcpUpdateAttempts.collectAsState()
    val unheard by state.mcpUnheard.collectAsState()
    LaunchedEffect(printerId) { state.loadCapabilities(); state.loadMcpCopies() }
    fun update(id: String, fresh: Boolean) {
        if (busy != null) return
        busy = id
        val attempt = AppState.McpUpdateAttempt(printerId, id, events[id]?.seq ?: -1)
        state.mcpUpdateAttempts.value = state.mcpUpdateAttempts.value + (id to attempt)
        state.noteMcpUpdate(id, null)
        state.scope.launch {
            try {
                val result = Counterpart.instance.companion.updatePrinterMcp(id, fresh)
                if (state.mcpUpdateAttempts.value[id] === attempt) {
                    state.mcpUpdateAttempts.value = state.mcpUpdateAttempts.value + (id to attempt.copy(result = result))
                    state.noteMcpUpdate(id, result.state)
                    state.loadMcpCopies()
                }
            }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (state.mcpUpdateAttempts.value[id] === attempt)
                    state.mcpUpdateAttempts.value = state.mcpUpdateAttempts.value +
                        (id to attempt.copy(problem = e.message ?: "Couldn’t update the printer software."))
            }
            finally { busy = null }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // #775 (David, Nov 12: "messy af looking, double entries, confusing wording"): one quiet row per MCP, the same words
        // as the iPhone, iPad, Mac and Linux (`McpPackageCopies.row`).
        fun running(id: String): Boolean {
            if (id in unheard) return false
            if (busy == id) return true
            val attempt = attempts[id]
            val state = events[id]?.takeIf { attempt == null || it.seq > attempt.eventFloor }?.type?.removePrefix("mcp.update.") ?: attempt?.result?.state
            return state == "started" || state == "waiting"
        }
        packages?.filter { pkg -> pkg.uses.any { it.printerId == printerId } }?.forEach { pkg ->
          val row = pkg.row(printerId)
          // One group per MCP: TalkBack reads its heading first, and its Use Counterpart’s and Update buttons stay inside it.
          Column(Modifier.fillMaxWidth().testTag("mcp-package-${pkg.`package`}").semantics { isTraversalGroup = true },
              verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                Text(row.name, fontSize = 14.sp, modifier = Modifier.weight(1f).semantics { heading() })
                row.version?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
            }
            row.status?.let { Text(it, fontSize = 12.sp, color = if (row.update != null) Palette.filament else Palette.secondary) }
            // While it updates, its progress (below) stands in place of the button.
            if (row.update != null && capabilities.contains("mcpUpdates") && !running(pkg.appMcpId))
                SecondaryButton("Update", Modifier.fillMaxWidth().semantics { contentDescription = "Update ${row.name}" },
                    enabled = busy == null && readProblem == null) { update(pkg.appMcpId, false) }
            Text(row.usedBy, color = Palette.secondary, fontSize = 12.sp)
            row.others.forEach { other ->
                Text(other.words, fontSize = 12.sp)
                if (capabilities.contains("mcpUpdates") && !running(other.mcpId))
                    SecondaryButton(other.button, Modifier.fillMaxWidth().semantics { contentDescription = other.label },
                        enabled = busy == null && readProblem == null) { update(other.mcpId, true) }
                Text(other.footnote, color = Palette.secondary, fontSize = 12.sp)
            }
            // An update or Move started on another phone, the Mac or Linux: its events show here too (#357's deferred P2).
            (pkg.uses.filter { it.printerId == printerId }.map { it.mcpId } + pkg.appMcpId).distinct()
                .filter { id -> attempts[id]?.printerId != printerId }
                .mapNotNull { id -> events[id]?.let { id to it } }.forEach { (id, event) ->
                    Text(if (id in unheard) AppState.MCP_UNHEARD else event.body.takeIf { it.isNotBlank() } ?: event.title, fontSize = 12.sp,
                        color = if (event.type.endsWith("failed")) Palette.failed else Palette.secondary)
                }
          }
        }
        // Events are authoritative even when the accepted mutation's HTTP reply never arrived.
        attempts.values.filter { it.printerId == printerId }.forEach { attempt ->
            val event = events[attempt.mcpId]?.takeIf { it.seq > attempt.eventFloor }
            // A wait or an update under way whose event never came says so (PRD §8.10); Move and Update stay pressable.
            val words = if (attempt.mcpId in unheard) AppState.MCP_UNHEARD else event?.body?.takeIf { it.isNotBlank() } ?: event?.title ?: attempt.result?.words
            words?.let { Text(it, fontSize = 12.sp) }
            if (event == null) attempt.problem?.let { Text(it, color = Palette.failed, fontSize = 12.sp) }
        }
        readProblem?.let { Text(it, color = Palette.failed, fontSize = 12.sp) }
        if (!capabilities.contains("mcpCopies")) Text("Update Counterpart on your computer to see its printer software here.", color = Palette.secondary, fontSize = 12.sp)
    }
}
