package com.scantomake.counterpart.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Format
import com.scantomake.counterpart.api.Iso
import com.scantomake.counterpart.api.PrintChoice
import com.scantomake.counterpart.api.PrintColour
import com.scantomake.counterpart.api.PrintQuality
import com.scantomake.counterpart.api.PrintPauses
import com.scantomake.counterpart.api.PrintStrength
import com.scantomake.counterpart.api.PrinterFilament
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.SliceEstimate
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Under Quality and Strength for a designer's file (its printer's MCP says it carries its own settings, Nov 5). */
fun designerSettingsWords(project: Project, quality: PrintQuality, strength: PrintStrength): String? =
    if (project.current?.ownSettings != true) null
    else if (quality == PrintQuality.Standard && strength == PrintStrength.Standard) "Prints with the designer’s settings saved in this file."
    else "Changes the designer’s settings saved in this file."

/** The print sheet (PRD §5.5): printer, quality, strength, filament, estimate, Print. */
@Composable
fun PrintSheetScreen(id: String, close: () -> Unit, printing: () -> Unit) {
    val app = Counterpart.instance
    val state = AppState.of(LocalContext.current)
    val scope = rememberCoroutineScope()
    val projects by state.projects.collectAsState()
    val catalog by state.catalog.collectAsState()
    val capabilities by state.capabilities.collectAsState()
    val project = projects.firstOrNull { it.id == id } ?: return
    // Keep the exact plate the person opened; the server also checks this at dispatch.
    val expectedPlate = remember(id) { project.selectedPlate?.id }
    val plateChanged = project.selectedPlate?.id != expectedPlate
    var destinationId by remember { mutableStateOf(project.printerDestinationId ?: catalog?.defaultDestinationId) }
    var quality by remember { mutableStateOf(PrintQuality.Standard) }
    var strength by remember { mutableStateOf(PrintStrength.Standard) }
    var copies by remember { mutableStateOf(1) }
    var copiesPicked by remember { mutableStateOf(false) }
    var pauseText by remember { mutableStateOf("") }
    var filaments by remember { mutableStateOf<List<PrinterFilament>?>(null) }
    var colour by remember { mutableStateOf<PrintColour?>(null) }
    var estimate by remember { mutableStateOf<SliceEstimate?>(null) }
    var estimating by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var checked by remember { mutableStateOf(false) }
    var selectingPrinter by remember { mutableStateOf(false) }
    var printerProblem by remember { mutableStateOf<String?>(null) }
    var sliceRefusal by remember { mutableStateOf<String?>(null) }
    val uncertain = ProjectWords(project).actions.contains(ProjectAction.PrintChecked)
    val destination = catalog?.destination(destinationId)
    val offersQuality = !project.slicedOriginal && destination?.capabilities?.quality == true
    val offersStrength = !project.slicedOriginal && destination?.capabilities?.strength == true
    val offersCopies = !project.slicedOriginal && "printCopies" in capabilities && destination?.capabilities?.copies == true
    val offersPauses = !project.slicedOriginal && destination?.capabilities?.layerPauses == true
    val selectedQuality = if (offersQuality) quality else PrintQuality.Standard
    val selectedStrength = if (offersStrength) strength else PrintStrength.Standard
    val selectedCopies = if (project.slicedOriginal) 1 else if (offersCopies && copiesPicked) copies else null
    val pauseLayers = if (offersPauses) PrintPauses.parse(pauseText, estimate?.layers) else emptyList()
    // Every choice Print makes: the estimate slices exactly these, and Print sends that file (Nov 5). Pauses are
    // checked against the layer count only at Print, so a new count never re-slices.
    val estimatePauses = if (offersPauses) PrintPauses.parse(pauseText, null) else emptyList()
    val estimateChoice = PrintChoice(colour, selectedQuality, selectedStrength, copies = selectedCopies, pauseBeforeLayers = estimatePauses ?: emptyList())
    val readyToSlice = destinationId != null && !selectingPrinter && printerProblem == null && filaments != null && estimatePauses != null
    val shownSlice = estimate?.shownSlice?.takeIf { !estimating }

    LaunchedEffect(Unit) { if (catalog == null) state.loadPrinters() }
    LaunchedEffect(destinationId) {
        filaments = null; colour = null; selectingPrinter = true; printerProblem = null
        try {
            if (destinationId != null && destinationId != project.printerDestinationId) state.show(app.companion.selectPrinter(id, destinationId!!))
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { printerProblem = e.message ?: "The printer couldn't be selected." }
        finally { selectingPrinter = false }
        if (printerProblem != null) return@LaunchedEffect
        try {
            val list = app.companion.filaments(id)
            filaments = list
            colour = list.firstOrNull { it.suggested == true }?.let { PrintColour.Auto }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { filaments = emptyList() }
    }
    LaunchedEffect(estimateChoice.estimateBody(destinationId).toString(), readyToSlice, project.mediaVersion, project.selectedPlate?.id) {
        estimate = null; sliceRefusal = null; estimating = readyToSlice
        if (!readyToSlice) return@LaunchedEffect
        try {
            delay(600) // typing pause layers slices once, after the last keystroke
            estimate = app.companion.estimate(id, destinationId, estimateChoice)
        }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        // HTTPS exposes slicer refusals as invalid-state; retain the companion's own words.
        catch (e: CompanionException) { sliceRefusal = e.message }
        catch (_: Exception) { sliceRefusal = CompanionException.unreachable.message }
        finally { estimating = false }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close) { Icon(CIcons.Close, "Close") }
            Text("Print ${ProjectWords.title(project)}", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SectionTitle("Printer")
            project.selectedPlate?.let { Text(it.name, fontWeight = FontWeight.SemiBold) }
            if (plateChanged) Text("The selected plate changed. Close this sheet and open Print again.", color = Palette.needsYou)
            catalog?.destinations?.forEach { d ->
                val selected = d.id == (destinationId ?: catalog?.defaultDestinationId)
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.card)
                    .border(2.dp, if (selected) Palette.filament else Color.Transparent, RoundedCornerShape(16.dp)).clickable(enabled = !working) { destinationId = d.id }.padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(CIcons.Printer, null, tint = if (selected) Palette.filament else Palette.secondary); Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) { Text(d.name, fontWeight = FontWeight.Medium); Text("${d.modelName} · ${d.stateWords}", color = Palette.secondary, fontSize = 12.sp) }
                }
            } ?: Text("Reading your printers…", color = Palette.secondary)

            if (project.slicedOriginal) Text("Uses the quality, strength, copies and pauses saved in this sliced file. Import an editable 3MF to change them.", color = Palette.secondary)
            if (offersQuality) {
                SectionTitle("Quality")
                Segmented(PrintQuality.entries.map { it.title }, PrintQuality.entries.indexOf(quality), enabled = !working) { quality = PrintQuality.entries[it] }
            }
            if (offersStrength) {
                SectionTitle("Strength")
                Segmented(PrintStrength.entries.map { it.title }, PrintStrength.entries.indexOf(strength), enabled = !working) { strength = PrintStrength.entries[it] }
            }
            // A designer's file (its printer's MCP says it carries its own settings): Standard sends nothing (Nov 5).
            if (offersQuality || offersStrength) designerSettingsWords(project, quality, strength)?.let { Text(it, color = Palette.secondary, fontSize = 13.sp) }
            estimate?.ownSettingsUpdate?.let { Text(it, color = Palette.secondary, fontSize = 13.sp) }
            if (offersQuality || offersStrength) estimate?.let { e ->
                // The slice's own settings, as the printer MCP reported them.
                val parts = listOfNotNull(e.layerHeightMm?.let { String.format(java.util.Locale.US, "%.2f mm layers", it) },
                    e.wallLoops?.let { "$it walls" }, e.infillPercent?.let { String.format(java.util.Locale.US, "%.0f%% infill", it) })
                if (parts.isNotEmpty()) Text(parts.joinToString(" · "), color = Palette.secondary, fontSize = 12.sp)
            }
            if (offersCopies) {
                SectionTitle("Copies")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { copies--; copiesPicked = true }, enabled = copies > 1 && !working) { Text("−", fontSize = 22.sp) }
                    Text(if (copiesPicked) "$copies" else "Printer setting", modifier = Modifier.weight(1f))
                    TextButton(onClick = { copies++; copiesPicked = true }, enabled = copies < 64 && !working) { Text("+", fontSize = 22.sp) }
                }
                if (!copiesPicked) TextButton(onClick = { copies = 1; copiesPicked = true }, enabled = !working) { Text("Use one copy") }
            }
            if (offersPauses) {
                SectionTitle("Pause")
                OutlinedTextField(value = pauseText, onValueChange = { if (it.length <= 160) pauseText = it },
                    modifier = Modifier.fillMaxWidth(), label = { Text("Before layers") }, placeholder = { Text("2, 15, 30") },
                    singleLine = true, enabled = !working, isError = pauseLayers == null)
                Text("The printer pauses before each layer so you can insert magnets or nuts, then Resume. Leave empty for no added pauses.", color = Palette.secondary, fontSize = 12.sp)
                if (pauseLayers == null) Text(estimate?.layers?.let { "Enter up to 16 layers, from 2 to $it, separated by commas." }
                    ?: "Enter up to 16 whole layer numbers from 2 to 100000, separated by commas.", color = Palette.failed, fontSize = 12.sp)
            }

            SectionTitle("Filament")
            val list = filaments
            when {
                list == null -> Text("Asking the printer what's loaded…", color = Palette.secondary)
                list.isEmpty() -> Text("The printer's own setting is used.", color = Palette.secondary)
                else -> Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    list.forEach { f ->
                        val selected = (colour as? PrintColour.Tray)?.filament?.slot == f.slot || (colour == PrintColour.Auto && f.suggested == true)
                        Column(Modifier.clickable(enabled = !working) { colour = PrintColour.Tray(f) }.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.size(36.dp).clip(CircleShape).background(hexColor(f.colour)).border(3.dp, if (selected) Palette.filament else Color.White.copy(alpha = 0.25f), CircleShape))
                            Text(f.slotLabel, fontSize = 11.sp); Text(f.material, fontSize = 11.sp, color = Palette.secondary)
                        }
                    }
                }
            }

            SectionTitle("What will print")
            WhatWillPrint(estimate, estimating, destination?.backend)
            GlassCard(Modifier.fillMaxWidth()) {
                if (estimating) Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(18.dp), color = Palette.filament, strokeWidth = 2.dp); Text("  Slicing to show you…", color = Palette.secondary) }
                else estimate?.let { e ->
                    Column {
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Format.duration(e.seconds)?.let { Text("⏱ $it") }; Format.grams(e.grams)?.let { Text("⚖ $it") }; e.layers?.let { Text("$it layers") }
                        }
                        e.slicerWarning?.let { Text(it, color = Palette.needsYou, fontSize = 13.sp) }
                    }
                } ?: Text("No estimate from the printer yet.", color = Palette.secondary)
            }
            if (uncertain) Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked, { checked = it })
                Text("The last print may have reached the printer. I checked: it isn't printing this.", fontSize = 14.sp)
            }
            problem?.let { Text(it, color = Palette.failed) }
            printerProblem?.let { Text(it, color = Palette.failed) }
            sliceRefusal?.let { Text(it, color = Palette.failed) }
        }
        PrimaryButton(if (working) "Sending to the printer…" else "Print", Modifier.fillMaxWidth().padding(16.dp),
            enabled = !working && !selectingPrinter && printerProblem == null && destination != null && !plateChanged &&
                pauseLayers != null && sliceRefusal == null && shownSlice != null && (!uncertain || checked), icon = CIcons.Printer) {
            working = true; problem = null
            scope.launch {
                try {
                    state.show(app.companion.print(id, PrintChoice(colour, selectedQuality, selectedStrength, checked, selectedCopies,
                        pauseBeforeLayers = pauseLayers ?: emptyList(), sliceSha256 = shownSlice), expectedPlate))
                    printing()
                } catch (e: CompanionException) { problem = e.message } catch (e: Exception) { problem = CompanionException.unreachable.message } finally { working = false }
            }
        }
    }
}

/**
 * The printer MCP's pictures of the exact sliced file Print sends (Nov 5), never a design render or a thumbnail the
 * file carried along. While it slices, or when the installed MCP can't draw them, the reason.
 */
@Composable
private fun WhatWillPrint(estimate: SliceEstimate?, estimating: Boolean, mcp: String?) {
    val preview = estimate?.preview?.takeIf { estimate.shownSlice != null && !estimating }
    val pictures = remember(preview?.sha256) {
        preview?.views?.map { view ->
            view to runCatching { android.util.Base64.decode(view.png, android.util.Base64.DEFAULT) }.getOrNull()
                ?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
        }.orEmpty()
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            preview != null -> {
                pictures.forEach { (view, image) ->
                    image?.let {
                        Image(it, view.label, Modifier.fillMaxWidth().aspectRatio(view.width.toFloat() / view.height.coerceAtLeast(1))
                            .clip(RoundedCornerShape(14.dp)).background(Color.White), contentScale = ContentScale.Fit)
                    }
                    Text(view.label, color = Palette.secondary, fontSize = 12.sp)
                }
                Text("Drawn from the sliced file Print sends.", color = Palette.secondary, fontSize = 11.sp)
            }
            estimating -> Text("Slicing it to show you…", color = Palette.secondary)
            estimate != null -> Text("Update ${mcp?.takeIf { it.isNotBlank() } ?: "your printer service"} in Settings → Printers so Counterpart can show you what will print.",
                color = Palette.needsYou)
            else -> Text("Nothing to show yet.", color = Palette.secondary)
        }
    }
}

@Composable
fun Segmented(options: List<String>, selected: Int, enabled: Boolean = true, choose: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.card).padding(3.dp)) {
        options.forEachIndexed { i, o ->
            Box(Modifier.weight(1f).clip(RoundedCornerShape(11.dp)).background(if (i == selected) Palette.filament else Color.Transparent).clickable(enabled = enabled) { choose(i) }.padding(vertical = 10.dp),
                contentAlignment = Alignment.Center) { Text(o, color = if (i == selected) Color.Black else Color.White, fontWeight = FontWeight.Medium) }
        }
    }
}

fun hexColor(hex: String?): Color {
    val digits = (hex ?: "").removePrefix("#")
    val v = digits.take(6).toLongOrNull(16) ?: return Color.Gray
    return Color(0xFF000000 or v)
}

/** The Printing screen: the printer's camera, progress, time left, and Pause, Resume, Stop. */
@Composable
fun PrintingScreen(id: String, back: () -> Unit, project: () -> Unit) {
    val app = Counterpart.instance
    val state = AppState.of(LocalContext.current)
    val scope = rememberCoroutineScope()
    val projects by state.projects.collectAsState()
    val catalog by state.catalog.collectAsState()
    val p = projects.firstOrNull { it.id == id }
    val printEnded = p?.printEnded == true
    val followPrint = p != null && !printEnded
    var frame by remember { mutableStateOf<CompanionClient.CameraFrame?>(null) }
    var image by remember { mutableStateOf<ImageBitmap?>(null) }
    var cameraProblem by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var confirmStop by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    LaunchedEffect(id, followPrint) {
        if (!followPrint) return@LaunchedEffect
        // Ending the print cancels this effect, including an outstanding camera request.
        while (true) {
            try {
                val next = app.companion.camera(projectId = id, fullScreen = true, previous = frame)
                currentCoroutineContext().ensureActive()
                if (next !== frame) { frame = next; image = ImageCache.decode(next.jpeg) }
                cameraProblem = null
            } catch (e: CancellationException) { throw e
            } catch (e: CompanionException) {
                cameraProblem = e.message
                if (e.code == "no-camera" || e.isUnsupported) break
            } catch (_: Exception) {}
            now = System.currentTimeMillis()
            delay(3_000)
        }
    }
    LaunchedEffect(id, followPrint) {
        // Refresh once on entry; active prints retain the fallback alongside the shared event stream.
        do { state.reload(id); if (followPrint) delay(10_000) } while (followPrint)
    }
    LaunchedEffect(id, printEnded) { if (printEnded) confirmStop = false }

    fun control(action: CompanionClient.PrintControl) {
        val latest = state.projects.value.firstOrNull { it.id == id } ?: return
        if (working || latest.printEnded) return
        working = true; problem = null
        scope.launch {
            try { state.show(app.companion.control(id, action)) }
            catch (e: CancellationException) { throw e }
            catch (e: CompanionException) { problem = e.message }
            catch (e: Exception) { problem = CompanionException.unreachable.message }
            finally { working = false }
        }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back) { Icon(CIcons.Back, "Back") }
            Text(p?.let { ProjectWords.title(it) } ?: "Printing", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1)
            TextButton(onClick = project) { Text("Project") }
        }
        if (p == null) return@Column
        val words = state.words(p)
        val live = p.print?.live
        val job = live?.job
        val printer = state.printerName(p) ?: "your printer"
        val destination = catalog?.destination(p.print?.destinationId ?: p.printerDestinationId)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(RoundedCornerShape(24.dp)).stage(), contentAlignment = Alignment.Center) {
                image?.let { Image(it, "Camera photo from $printer", Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                    ?: Text(if (printEnded) "No camera photo saved for this print." else cameraProblem ?: "Asking $printer for a photo…", color = Palette.secondary)
                frame?.capturedAtMs?.let { Text(if (printEnded) "Last camera photo from $printer" else "$printer · ${Format.ago(it, now)}", Modifier.align(Alignment.BottomStart).padding(10.dp)
                    .clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(8.dp, 4.dp), fontSize = 12.sp) }
            }
            StatusCapsule(words.phase, if (!printEnded && live?.state == "paused") "Paused" else null)
            Text(words.line, fontSize = 17.sp)
            job?.progress?.let { LinearProgressIndicator({ (it / 100).toFloat() }, Modifier.fillMaxWidth().height(8.dp), color = Palette.okGreen) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                InfoTile("Done", Format.percent(job?.progress) ?: "–", CIcons.Printer, Modifier.weight(1f))
                if (!printEnded) InfoTile("Left", Format.duration(job?.remainingSec) ?: "–", CIcons.Clock, Modifier.weight(1f))
                InfoTile("Layer", job?.layer?.let { l -> job.totalLayers?.let { "$l of $it" } ?: "$l" } ?: "–", CIcons.Layers, Modifier.weight(1f))
            }
            if (!printEnded) Iso.parse(live?.endsAt)?.let { Text("Ends about ${Format.clock(it)}", color = Palette.secondary) }
            if (!printEnded) live?.temps?.let { t ->
                Text(listOfNotNull(t.nozzle?.let { "Nozzle ${Format.temperature(it.actual)}" }, t.bed?.let { "Bed ${Format.temperature(it.actual)}" }).joinToString(" · "), color = Palette.secondary, fontSize = 13.sp)
            }
            live?.problems?.forEach { Text("${it.code}\n${it.message}", color = Palette.needsYou, fontSize = 13.sp) }
            if (!printEnded) p.printConfirmation?.let { PrintConfirmationCard(p, it) { body -> scope.launch { try { state.show(app.companion.answerPrintConfirmation(id, body)) } catch (e: CompanionException) { problem = e.message } } } }
            problem?.let { Text(it, color = Palette.failed) }
        }
        if (!printEnded) Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (live?.state == "paused") {
                PrimaryButton("Resume", Modifier.weight(1f), enabled = !working && destination?.canResume != false, icon = CIcons.Play) { control(CompanionClient.PrintControl.Resume) }
            } else {
                SecondaryButton("Pause", Modifier.weight(1f), enabled = !working && destination?.canPause != false, icon = CIcons.Pause) { control(CompanionClient.PrintControl.Pause) }
            }
            SecondaryButton("Stop", Modifier.weight(1f), enabled = !working && destination?.canCancel != false, icon = CIcons.Stop, color = Palette.failed) { confirmStop = true }
        }
    }
    if (confirmStop && !printEnded) AlertDialog(onDismissRequest = { confirmStop = false }, title = { Text("Stop the print?") },
        text = { Text("The printer stops now. You can't resume it.") },
        confirmButton = { TextButton({ confirmStop = false; control(CompanionClient.PrintControl.Cancel) }) { Text("Stop Print", color = Palette.failed) } },
        dismissButton = { TextButton({ confirmStop = false }) { Text("Keep Printing") } })
}
