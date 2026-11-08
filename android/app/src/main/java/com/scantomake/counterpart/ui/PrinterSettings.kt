package com.scantomake.counterpart.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.contentDescription
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
        state.noteMcpUpdate(mcpId, false)
        change {
            update = client.updatePrinterMcp(mcpId, fresh).also { state.noteMcpUpdate(mcpId, it.state == "waiting") }
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
            // A wait whose event never came says so (PRD §8.10), and Update stays pressable.
            if (printer.mcpId in unheard) Text(AppState.MCP_UNHEARD, color = Palette.secondary, fontSize = 12.sp)
            else if (updateEvent != null) {
                Text(updateEvent.title, color = if (updateEvent.type.endsWith("failed")) Palette.failed else Palette.secondary, fontSize = 13.sp)
                if (updateEvent.body.isNotBlank()) Text(updateEvent.body, color = Palette.secondary, fontSize = 12.sp)
            } else update?.let { Text(it.words, color = Palette.secondary, fontSize = 12.sp) }
        }
        problem?.let { Text(it, color = Palette.failed, fontSize = 13.sp) }
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
        state.noteMcpUpdate(id, false)
        state.scope.launch {
            try {
                val result = Counterpart.instance.companion.updatePrinterMcp(id, fresh)
                if (state.mcpUpdateAttempts.value[id] === attempt) {
                    state.mcpUpdateAttempts.value = state.mcpUpdateAttempts.value + (id to attempt.copy(result = result))
                    state.noteMcpUpdate(id, result.state == "waiting")
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
        packages?.filter { pkg -> pkg.uses.any { it.printerId == printerId } }?.forEach { pkg ->
          // One group per MCP: TalkBack reads its heading first, and its Move and Update buttons stay inside it.
          Column(Modifier.fillMaxWidth().testTag("mcp-package-${pkg.`package`}").semantics { isTraversalGroup = true },
              verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(pkg.label, fontSize = 14.sp, modifier = Modifier.semantics { heading() })
            pkg.appCopy?.let { Text("Counterpart’s copy ${it.version ?: "version unknown"}", fontSize = 12.sp) }
            pkg.uses.filter { it.printerId == printerId }.forEach { Text(it.words, fontSize = 12.sp) }
            if (capabilities.contains("mcpUpdates")) {
                // In the order the uses above are listed, each titled by its printers, MCP and copy.
                pkg.moves.filter { move -> pkg.uses.any { it.printerId == printerId && it.mcpId == move.mcpId } }.forEach { move ->
                    SecondaryButton(move.title, Modifier.fillMaxWidth(), enabled = busy == null && readProblem == null) { update(move.mcpId, true) }
                }
                if (pkg.appCopy != null) SecondaryButton("Update Counterpart’s copy", Modifier.fillMaxWidth()
                    .semantics { contentDescription = "Update Counterpart’s copy of ${pkg.label}" }, enabled = busy == null && readProblem == null) { update(pkg.appMcpId, false) }
            }
            // An update or Move started on another phone, the Mac or Linux: its events show here too (#357's deferred P2).
            (pkg.uses.filter { it.printerId == printerId }.map { it.mcpId } + pkg.appMcpId).distinct()
                .filter { id -> attempts[id]?.printerId != printerId }
                .mapNotNull { id -> events[id]?.let { id to it } }.forEach { (id, event) ->
                    Text(if (id in unheard) AppState.MCP_UNHEARD else event.body.takeIf { it.isNotBlank() } ?: event.title, fontSize = 12.sp,
                        color = if (event.type.endsWith("failed")) Palette.failed else Palette.secondary)
                }
            Text("Moving updates Counterpart’s copy and uses it for the named printers. Your copy is left untouched.", color = Palette.secondary, fontSize = 12.sp)
          }
        }
        // Events are authoritative even when the accepted mutation's HTTP reply never arrived.
        attempts.values.filter { it.printerId == printerId }.forEach { attempt ->
            val event = events[attempt.mcpId]?.takeIf { it.seq > attempt.eventFloor }
            // A wait whose event never came says so (PRD §8.10); the Move and Update stay pressable.
            val words = if (attempt.mcpId in unheard) AppState.MCP_UNHEARD else event?.body?.takeIf { it.isNotBlank() } ?: event?.title ?: attempt.result?.words
            words?.let { Text(it, fontSize = 12.sp) }
            if (event == null) attempt.problem?.let { Text(it, color = Palette.failed, fontSize = 12.sp) }
        }
        readProblem?.let { Text(it, color = Palette.failed, fontSize = 12.sp) }
        if (!capabilities.contains("mcpCopies")) Text("Update Counterpart on your computer to see each printer’s software copy.", color = Palette.secondary, fontSize = 12.sp)
    }
}
