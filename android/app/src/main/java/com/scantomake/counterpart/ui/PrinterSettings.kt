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
        change { update = client.updatePrinterMcp(mcpId, fresh); state.loadPrinters() }
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
        if (printer.mcpId != null) {
            SecondaryButton(if (printer.capabilities?.update != null) "Update Printer Software" else "Check for Updates",
                Modifier.fillMaxWidth(), enabled = !busy) { updateMcp(false) }
            if (update?.state == "unresolved" && updateEvent == null)
                SecondaryButton("Install a Fresh Copy", Modifier.fillMaxWidth(), enabled = !busy) { updateMcp(true) }
            // Events carry the completed/failed result. Never poll by replaying a mutation after an uncertain send.
            if (updateEvent != null) {
                Text(updateEvent.title, color = if (updateEvent.type.endsWith("failed")) Palette.failed else Palette.secondary, fontSize = 13.sp)
                if (updateEvent.body.isNotBlank()) Text(updateEvent.body, color = Palette.secondary, fontSize = 12.sp)
            } else update?.let { Text(it.words, color = Palette.secondary, fontSize = 12.sp) }
        }
        problem?.let { Text(it, color = Palette.failed, fontSize = 13.sp) }
    }
}
