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
import com.scantomake.counterpart.api.PrintStrength
import com.scantomake.counterpart.api.PrinterFilament
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.SliceEstimate
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The print sheet (PRD §5.5): printer, quality, strength, filament, estimate, Print. */
@Composable
fun PrintSheetScreen(id: String, close: () -> Unit, printing: () -> Unit) {
    val app = Counterpart.instance
    val state = AppState.of(LocalContext.current)
    val scope = rememberCoroutineScope()
    val projects by state.projects.collectAsState()
    val catalog by state.catalog.collectAsState()
    val project = projects.firstOrNull { it.id == id } ?: return
    var destinationId by remember { mutableStateOf(project.printerDestinationId ?: catalog?.defaultDestinationId) }
    var quality by remember { mutableStateOf(PrintQuality.Standard) }
    var strength by remember { mutableStateOf(PrintStrength.Standard) }
    var filaments by remember { mutableStateOf<List<PrinterFilament>?>(null) }
    var colour by remember { mutableStateOf<PrintColour?>(null) }
    var estimate by remember { mutableStateOf<SliceEstimate?>(null) }
    var estimating by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var checked by remember { mutableStateOf(false) }
    val uncertain = ProjectWords(project).actions.contains(ProjectAction.PrintChecked)
    val destination = catalog?.destination(destinationId)

    LaunchedEffect(Unit) { if (catalog == null) state.loadPrinters() }
    LaunchedEffect(destinationId) {
        filaments = null; colour = null
        try {
            if (destinationId != null && destinationId != project.printerDestinationId) state.show(app.companion.selectPrinter(id, destinationId!!))
            val list = app.companion.filaments(id)
            filaments = list
            colour = list.firstOrNull { it.suggested == true }?.let { PrintColour.Auto }
        } catch (_: Exception) { filaments = emptyList() }
    }
    LaunchedEffect(destinationId, quality, strength) {
        estimate = null; estimating = true
        try { estimate = app.companion.estimate(id, destinationId, quality, strength) } catch (_: Exception) {} finally { estimating = false }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close) { Icon(CIcons.Close, "Close") }
            Text("Print ${ProjectWords.title(project)}", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SectionTitle("Printer")
            catalog?.destinations?.forEach { d ->
                val selected = d.id == (destinationId ?: catalog?.defaultDestinationId)
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.card)
                    .border(2.dp, if (selected) Palette.filament else Color.Transparent, RoundedCornerShape(16.dp)).clickable { destinationId = d.id }.padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(CIcons.Printer, null, tint = if (selected) Palette.filament else Palette.secondary); Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) { Text(d.name, fontWeight = FontWeight.Medium); Text("${d.modelName} · ${d.stateWords}", color = Palette.secondary, fontSize = 12.sp) }
                }
            } ?: Text("Reading the printers on your Mac…", color = Palette.secondary)

            if (destination?.capabilities?.quality != false) {
                SectionTitle("Quality")
                Segmented(PrintQuality.entries.map { it.title }, PrintQuality.entries.indexOf(quality)) { quality = PrintQuality.entries[it] }
            }
            if (destination?.capabilities?.strength != false) {
                SectionTitle("Strength")
                Segmented(PrintStrength.entries.map { it.title }, PrintStrength.entries.indexOf(strength)) { strength = PrintStrength.entries[it] }
            }
            Text(String.format(java.util.Locale.US, "%.2f mm layers · %d walls · %d%% infill", quality.layerHeightMm, strength.walls, strength.infill), color = Palette.secondary, fontSize = 12.sp)

            SectionTitle("Filament")
            val list = filaments
            when {
                list == null -> Text("Asking the printer what's loaded…", color = Palette.secondary)
                list.isEmpty() -> Text("The printer's own setting is used.", color = Palette.secondary)
                else -> Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    list.forEach { f ->
                        val selected = (colour as? PrintColour.Tray)?.filament?.slot == f.slot || (colour == PrintColour.Auto && f.suggested == true)
                        Column(Modifier.clickable { colour = PrintColour.Tray(f) }.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.size(36.dp).clip(CircleShape).background(hexColor(f.colour)).border(3.dp, if (selected) Palette.filament else Color.White.copy(alpha = 0.25f), CircleShape))
                            Text(f.slotLabel, fontSize = 11.sp); Text(f.material, fontSize = 11.sp, color = Palette.secondary)
                        }
                    }
                }
            }

            GlassCard(Modifier.fillMaxWidth()) {
                if (estimating) Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(18.dp), color = Palette.filament, strokeWidth = 2.dp); Text("  Slicing for an estimate…", color = Palette.secondary) }
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
        }
        PrimaryButton(if (working) "Sending to the printer…" else "Print", Modifier.fillMaxWidth().padding(16.dp), enabled = !working && (!uncertain || checked), icon = CIcons.Printer) {
            working = true; problem = null
            scope.launch {
                try {
                    state.show(app.companion.print(id, PrintChoice(colour, quality, strength, checked)))
                    printing()
                } catch (e: CompanionException) { problem = e.message } catch (e: Exception) { problem = CompanionException.unreachable.message } finally { working = false }
            }
        }
    }
}

@Composable
fun Segmented(options: List<String>, selected: Int, choose: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.card).padding(3.dp)) {
        options.forEachIndexed { i, o ->
            Box(Modifier.weight(1f).clip(RoundedCornerShape(11.dp)).background(if (i == selected) Palette.filament else Color.Transparent).clickable { choose(i) }.padding(vertical = 10.dp),
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
    var frame by remember { mutableStateOf<CompanionClient.CameraFrame?>(null) }
    var image by remember { mutableStateOf<ImageBitmap?>(null) }
    var cameraProblem by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var confirmStop by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    LaunchedEffect(id) {
        // A snapshot every 3 s while this screen shows (the companion shares one camera read between viewers).
        while (true) {
            try {
                val next = app.companion.camera(projectId = id, fullScreen = true, previous = frame)
                if (next !== frame) { frame = next; image = ImageCache.decode(next.jpeg) }
                cameraProblem = null
            } catch (e: CompanionException) {
                cameraProblem = e.message
                if (e.code == "no-camera" || e.isUnsupported) break
            } catch (_: Exception) {}
            now = System.currentTimeMillis()
            delay(3_000)
        }
    }
    LaunchedEffect(id) { while (true) { state.reload(id); delay(10_000) } }

    fun control(action: CompanionClient.PrintControl) {
        working = true; problem = null
        scope.launch {
            try { state.show(app.companion.control(id, action)) } catch (e: CompanionException) { problem = e.message } catch (e: Exception) { problem = CompanionException.unreachable.message }
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
                    ?: Text(cameraProblem ?: "Asking $printer for a photo…", color = Palette.secondary)
                frame?.capturedAtMs?.let { Text("$printer · ${Format.ago(it, now)}", Modifier.align(Alignment.BottomStart).padding(10.dp)
                    .clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(8.dp, 4.dp), fontSize = 12.sp) }
            }
            StatusCapsule(words.phase, if (live?.state == "paused") "Paused" else null)
            Text(words.line, fontSize = 17.sp)
            job?.progress?.let { LinearProgressIndicator({ (it / 100).toFloat() }, Modifier.fillMaxWidth().height(8.dp), color = Palette.okGreen) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                InfoTile("Done", Format.percent(job?.progress) ?: "–", CIcons.Printer, Modifier.weight(1f))
                InfoTile("Left", Format.duration(job?.remainingSec) ?: "–", CIcons.Clock, Modifier.weight(1f))
                InfoTile("Layer", job?.layer?.let { l -> job.totalLayers?.let { "$l of $it" } ?: "$l" } ?: "–", CIcons.Layers, Modifier.weight(1f))
            }
            Iso.parse(live?.endsAt)?.let { Text("Ends about ${Format.clock(it)}", color = Palette.secondary) }
            live?.temps?.let { t ->
                Text(listOfNotNull(t.nozzle?.let { "Nozzle ${Format.temperature(it.actual)}" }, t.bed?.let { "Bed ${Format.temperature(it.actual)}" }).joinToString(" · "), color = Palette.secondary, fontSize = 13.sp)
            }
            live?.problems?.forEach { Text("${it.code}\n${it.message}", color = Palette.needsYou, fontSize = 13.sp) }
            p.printConfirmation?.let { PrintConfirmationCard(p, it) { body -> scope.launch { try { state.show(app.companion.answerPrintConfirmation(id, body)) } catch (e: CompanionException) { problem = e.message } } } }
            problem?.let { Text(it, color = Palette.failed) }
        }
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (live?.state == "paused") {
                PrimaryButton("Resume", Modifier.weight(1f), enabled = !working && destination?.canResume != false, icon = CIcons.Play) { control(CompanionClient.PrintControl.Resume) }
            } else {
                SecondaryButton("Pause", Modifier.weight(1f), enabled = !working && destination?.canPause != false, icon = CIcons.Pause) { control(CompanionClient.PrintControl.Pause) }
            }
            SecondaryButton("Stop", Modifier.weight(1f), enabled = !working && destination?.canCancel != false, icon = CIcons.Stop, color = Palette.failed) { confirmStop = true }
        }
    }
    if (confirmStop) AlertDialog(onDismissRequest = { confirmStop = false }, title = { Text("Stop the print?") },
        text = { Text("The printer stops now. You can't resume it.") },
        confirmButton = { TextButton({ confirmStop = false; control(CompanionClient.PrintControl.Cancel) }) { Text("Stop Print", color = Palette.failed) } },
        dismissButton = { TextButton({ confirmStop = false }) { Text("Keep Printing") } })
}
