package com.scantomake.counterpart.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.MainActivity
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.PublishedModelLink
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.Media
import kotlinx.coroutines.launch
import java.io.File

/**
 * New (PRD §5.2): say what you need, show it, and send. The text is kept whatever you do; a scan returns here
 * attached; Send creates the project at once and the files follow while the project shows Sending.
 */
@Composable
fun NewProjectScreen(job: String?, close: () -> Unit, started: (String) -> Unit, scan: (String) -> Unit) {
    val context = LocalContext.current
    val app = Counterpart.instance
    val state = AppState.of(context)
    val prefs = app.prefs
    val scope = rememberCoroutineScope()
    val macName by state.macName.collectAsState()
    var text by remember { mutableStateOf(MainActivity.sharedText?.also { MainActivity.sharedText = null } ?: prefs.getString("CounterpartNewDraft", "") ?: "") }
    // Kept across the trip to the scan screen (Navigation disposes this screen meanwhile).
    var photoPaths by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(listOf<String>()) }
    val photos = remember { mutableStateListOf<File>().apply { addAll(photoPaths.map(::File).filter { it.exists() }) } }
    LaunchedEffect(photos.size) { photoPaths = photos.map { it.path } }
    var working by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var draftId by remember { mutableStateOf(prefs.getString("CounterpartNewDraftId", "") ?: "") }
    var scanned by remember { mutableStateOf(false) }
    var scanUse by remember { mutableStateOf(job) }
    var dimensionSource by remember { mutableStateOf("lookup") }
    var measuredLongest by remember { mutableStateOf("") }
    var measuredMiddle by remember { mutableStateOf("") }
    var measuredShortest by remember { mutableStateOf("") }
    var pendingCamera by remember { mutableStateOf<File?>(null) }
    val link = PublishedModelLink.find(text)

    LaunchedEffect(text) { prefs.edit().putString("CounterpartNewDraft", text).apply() }
    LaunchedEffect(draftId) { scanned = draftId.isNotEmpty() && Media.captureFinished(context, draftId) }

    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = pendingCamera; pendingCamera = null
        if (ok && f != null && f.length() > 0) photos.add(f) else f?.delete()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(24)) { uris: List<Uri> ->
        uris.take(24 - photos.size).forEach { uri -> Media.keep(context, uri)?.let(photos::add) }
    }

    fun chosenKind(): String? = scanUse?.takeIf { it != "later" } ?: job
    fun kind(): String? = chosenKind()

    fun measuredValues(): List<Pair<String, Double>> = listOf("longest" to measuredLongest, "middle" to measuredMiddle, "shortest" to measuredShortest).mapNotNull { (edge, value) ->
        value.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it > 0 && it <= 10_000 }?.let { edge to it }
    }
    fun measuredValid(): Boolean {
        val typed = listOf(measuredLongest, measuredMiddle, measuredShortest).count { it.isNotBlank() }
        return typed > 0 && measuredValues().size == typed
    }
    fun effectiveText(): String {
        val base = text.trim()
        if (!scanned || scanUse != "fit" || base.isEmpty()) return base
        val dimension = when (dimensionSource) {
            "measured" -> "- Dimensions I measured on the real object: " +
                measuredValues().joinToString(", ") { "${it.first} ${it.second} mm" } +
                ". Treat these as the exact overall size. If the scan differs by more than 2 mm or 2%, ask before designing anything fit-critical."
            "scan" -> "- Dimensions: use the scan's measured size, say the clearance you allowed, and mark every fit-critical size as estimated."
            else -> "- Dimensions: identify the exact product and variant from the scan and photos, look up the manufacturer's published dimensions, and ask me to confirm the product and size before designing anything that depends on them. If you cannot identify it exactly, ask for caliper measurements or a photo with calipers instead of silently using the scan's size."
        }
        return listOf(base, "", "Fit brief:",
            "- The scanned object is the thing the printed part must fit, hold, mount or adapt to. Do not print a copy of the scanned object itself.",
            dimension).joinToString("\n")
    }

    /** The draft this screen made, kept so coming back finishes the same one rather than making another. */
    suspend fun draft(): Project {
        if (draftId.isNotEmpty()) {
            try {
                val saved = app.companion.get(draftId)
                if (saved.state == Project.State.New) {
                    val wanted = effectiveText(); val wantedKind = chosenKind()
                    if ((wanted.isNotBlank() && saved.instructions != wanted) || (wantedKind != null && saved.kind != wantedKind)) {
                        val updated = app.companion.updateDraft(saved.id, wanted, wantedKind)
                        if (wantedKind != null && updated.kind != wantedKind) throw CompanionException("needs-update", "Update Counterpart on your computer so a scan can become a fit instead of a copy.")
                        return updated
                    }
                    return saved
                }
            } catch (e: CompanionException) { if (e.code != "not-found") throw e }
        }
        val created = if (link != null) {
            state.loadCapabilities()
            if ("publishedModels" !in state.capabilities.value) throw CompanionException("published-models-unavailable", "Update Counterpart on your computer to get the designer’s file.")
            app.companion.create(text, "published", link)
        } else app.companion.create(effectiveText(), kind())
        draftId = created.id
        prefs.edit().putString("CounterpartNewDraftId", created.id).apply()
        state.show(created)
        return created
    }

    fun run(kind: String, body: suspend () -> Unit) {
        if (working != null) return
        working = kind; problem = null
        scope.launch {
            try { body() } catch (e: CompanionException) { if (e.code != "cancelled") problem = e.message } catch (e: Exception) { problem = CompanionException.unreachable.message }
            finally { working = null }
        }
    }

    // Continue on a fit takes you to the words it still needs.
    val describeFocus = remember { FocusRequester() }
    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close, enabled = working != "make") { Icon(CIcons.Close, "Close") }
            Text("New Project", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // After a scan the screen opens on its question, first and whole (U5): nothing half-hidden above it.
            if (scanned) {
                Text("What should this scan become?", fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.testTag("scan-use"))
                ScanUseChoice("Copy this object", "Clean up the scan and print the same thing.", scanUse == "copy", "scan-use-copy") { scanUse = "copy" }
                ScanUseChoice("Make something that fits this", "A holder, mount, case or adapter. The scan is what it must fit, not the print.", scanUse == "fit", "scan-use-fit") { scanUse = "fit" }
                ScanUseChoice("Just save this scan", "Keep its shape with this project and decide later.", scanUse == "later", "scan-use-later") { scanUse = "later" }
                if (scanUse == "fit") GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Exact size", fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("Look up", Modifier.weight(1f).testTag("fit-size-lookup"), enabled = working == null) { dimensionSource = "lookup" }
                        SecondaryButton("I measured", Modifier.weight(1f).testTag("fit-size-measured"), enabled = working == null) { dimensionSource = "measured" }
                        SecondaryButton("Use scan", Modifier.weight(1f).testTag("fit-size-scan"), enabled = working == null) { dimensionSource = "scan" }
                    }
                    when (dimensionSource) {
                        "measured" -> {
                            Text("Measure the outside of the real thing. Leave a side blank if you don't know it.", color = Palette.secondary, fontSize = 13.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedTextField(measuredLongest, { measuredLongest = it }, Modifier.weight(1f).testTag("fit-size-longest"), label = { Text("Longest mm") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                                OutlinedTextField(measuredMiddle, { measuredMiddle = it }, Modifier.weight(1f).testTag("fit-size-middle"), label = { Text("Middle mm") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                                OutlinedTextField(measuredShortest, { measuredShortest = it }, Modifier.weight(1f).testTag("fit-size-shortest"), label = { Text("Shortest mm") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                            }
                        }
                        "scan" -> Text("Uses the scan's size as an estimate. Best for loose holders; your computer says the clearance it allowed.", color = Palette.secondary, fontSize = 13.sp)
                        else -> Text("Your computer identifies it, finds the maker's published size, and asks “I found this exact size — is that right?” before designing to it.", color = Palette.secondary, fontSize = 13.sp)
                    }
                    SecondaryButton("Add a caliper photo", Modifier.fillMaxWidth().testTag("fit-caliper-photo"), enabled = working == null && photos.size < 24, icon = CIcons.Camera) {
                        val (file, uri) = Media.newPhotoTarget(context); pendingCamera = file; takePhoto.launch(uri)
                    }
                } }
                if (scanUse == "later") Text("Nothing is sent or printed yet. This screen keeps the scan, so you can choose here later.", color = Palette.secondary, fontSize = 13.sp)
            }
            Text("What do you need?", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().focusRequester(describeFocus).testTag("describe"), minLines = 3, maxLines = 6,
                placeholder = { Text(if (job == "copy") "Copy this. Close up the bottom." else "A hook for my stroller handle…") })
            Text("Describe it, scan it, or both. Your computer can look up published sizes, like a phone or a mic. Paste a MakerWorld or Printables link to print a published model.",
                color = Palette.secondary, fontSize = 13.sp)
            if (link != null) GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) { Icon(CIcons.Link, null, tint = Palette.filament); Text("  " + (Uri.parse(link).host ?: "Published model"), fontWeight = FontWeight.SemiBold) }
                    Text("Your computer will get the designer’s file and keep its credit.", color = Palette.secondary, fontSize = 13.sp)
                }
            }
            Text("Show it", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SourceTile(CIcons.Cube, "Scan it", "Walk around it. First version.", Palette.filament, Modifier.weight(1f), enabled = working == null && link == null) {
                    run("scan") { val d = draft(); scan(d.id) }
                }
                SourceTile(CIcons.Camera, "Take photos", if (photos.size < 24) "A few angles is plenty." else "24 photos is the most.", Color(0xFFBF5AF2), Modifier.weight(1f),
                    enabled = working == null && photos.size < 24) {
                    val (file, uri) = Media.newPhotoTarget(context); pendingCamera = file; takePhoto.launch(uri)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SourceTile(CIcons.Photo, "From Photos", "Pick what you have.", Palette.okGreen, Modifier.weight(1f), enabled = working == null && photos.size < 24) {
                    pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                Spacer(Modifier.weight(1f))
            }
            if (scanned || photos.isNotEmpty()) {
                Text("Added", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (scanned) Chip(CIcons.Cube, "Scan · ${Media.captureFrames(context, draftId).size} frames")
                    photos.toList().forEach { f ->
                        Box {
                            val bmp = remember(f) { ImageCache.decode(f, 300) }
                            if (bmp != null) androidx.compose.foundation.Image(bmp, null, Modifier.size(72.dp).clip(RoundedCornerShape(12.dp)),
                                contentScale = androidx.compose.ui.layout.ContentScale.Crop)
                            Icon(CIcons.Close, "Remove", Modifier.align(Alignment.TopEnd).size(22.dp).clip(RoundedCornerShape(11.dp)).background(Color.Black.copy(alpha = 0.6f))
                                .clickable(enabled = working == null) { photos.remove(f); f.delete() }.padding(3.dp))
                        }
                    }
                }
            }
            problem?.let { Text(it, color = Palette.failed) }
        }
        val missing = when {
            scanned && scanUse == null -> "Choose whether to copy it, make something that fits it, or save the scan."
            scanned && scanUse == "fit" && text.isBlank() -> "Say what it should hold, mount or adapt to."
            scanned && scanUse == "fit" && dimensionSource == "measured" && !measuredValid() -> "Enter at least one measurement in millimetres."
            !scanned && text.isBlank() -> "Describe what to make, or add a scan."
            else -> null
        }
        // After a scan the button is greyed out and says what to do until a use is chosen, then names that use's
        // action: an instruction never looks like the action (U5).
        val describeFirst = scanned && scanUse == "fit" && text.isBlank()
        val sendLabel = when {
            working == "make" -> if (scanUse == "later") "Saving…" else "Sending…"
            scanned && scanUse == null -> "Choose what this scan becomes"
            scanned && scanUse == "copy" -> "Copy this object"
            describeFirst -> "Continue"
            scanned && scanUse == "later" -> "Save this scan"
            else -> "Send to ${macName ?: "your computer"}"
        }
        // Upload only when it sends: not while it asks for a choice or words, and not for saving.
        val sendIcon = if (scanned && (scanUse == null || scanUse == "later" || describeFirst)) null else CIcons.Upload
        PrimaryButton(sendLabel, Modifier.fillMaxWidth().padding(20.dp, 8.dp).testTag("send"),
            enabled = working == null && !(scanned && scanUse == null), icon = sendIcon) {
            if (describeFirst) { describeFocus.requestFocus(); return@PrimaryButton }
            if (missing != null) { problem = missing; return@PrimaryButton }
            if (scanned && scanUse == "later") { close(); return@PrimaryButton }
            run("make") {
                val d = draft()
                val chosen = photos.toList()
                prefs.edit().remove("CounterpartNewDraft").remove("CounterpartNewDraftId").apply()
                state.sendInBackground(d.id) { state.show(Media.sendProject(context, app.uploader, app.companion, d.id, chosen)) }
                started(d.id)
            }
        }
    }
}

@Composable
fun ScanUseChoice(title: String, detail: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Palette.glass).clickable(onClick = onClick).padding(14.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(detail, color = Palette.secondary, fontSize = 12.sp)
        }
        if (selected) Icon(CIcons.Check, null, tint = Palette.filament)
    }
}

@Composable
fun SourceTile(icon: ImageVector, title: String, detail: String, tint: Color, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Column(modifier.alpha(if (enabled) 1f else 0.45f).clip(RoundedCornerShape(22.dp)).background(Palette.glass).clickable(enabled = enabled, onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(26.dp))
        Spacer(Modifier.height(4.dp))
        Text(title, fontWeight = FontWeight.SemiBold)
        Text(detail, color = Palette.secondary, fontSize = 12.sp)
    }
}
