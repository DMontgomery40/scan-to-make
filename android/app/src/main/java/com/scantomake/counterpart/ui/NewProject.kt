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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
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

    fun kind(): String? = job ?: if (scanned) "copy" else null

    /** The draft this screen made, kept so coming back finishes the same one rather than making another. */
    suspend fun draft(): Project {
        if (draftId.isNotEmpty()) {
            try {
                val saved = app.companion.get(draftId)
                if (saved.state == Project.State.New) {
                    if (text.isNotBlank() && saved.instructions != text.trim()) return app.companion.updateDraft(saved.id, text.trim())
                    return saved
                }
            } catch (e: CompanionException) { if (e.code != "not-found") throw e }
        }
        val created = if (link != null) {
            state.loadCapabilities()
            if ("publishedModels" !in state.capabilities.value) throw CompanionException("published-models-unavailable", "Update Counterpart on your Mac to get the designer’s file.")
            app.companion.create(text, "published", link)
        } else app.companion.create(text, kind())
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

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close, enabled = working != "make") { Icon(CIcons.Close, "Close") }
            Text("New Project", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("What do you need?", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), minLines = 3, maxLines = 6,
                placeholder = { Text(if (job == "copy") "Copy this. Close up the bottom." else "A hook for my stroller handle…") })
            Text("Describe it, scan it, or both. Your Mac can look up published sizes, like a phone or a mic. Paste a MakerWorld or Printables link to print a published model.",
                color = Palette.secondary, fontSize = 13.sp)
            if (link != null) GlassCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) { Icon(CIcons.Link, null, tint = Palette.filament); Text("  " + (Uri.parse(link).host ?: "Published model"), fontWeight = FontWeight.SemiBold) }
                    Text("Your Mac will get the designer’s file and keep its credit.", color = Palette.secondary, fontSize = 13.sp)
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
        val canSend = text.isNotBlank() || scanned
        PrimaryButton(if (working == "make") "Sending…" else "Send to ${macName ?: "your Mac"}", Modifier.fillMaxWidth().padding(20.dp, 8.dp),
            enabled = working == null, icon = CIcons.Upload) {
            if (!canSend) { problem = "Describe what to make, or add a scan."; return@PrimaryButton }
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
fun SourceTile(icon: ImageVector, title: String, detail: String, tint: Color, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Column(modifier.alpha(if (enabled) 1f else 0.45f).clip(RoundedCornerShape(22.dp)).background(Palette.glass).clickable(enabled = enabled, onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(26.dp))
        Spacer(Modifier.height(4.dp))
        Text(title, fontWeight = FontWeight.SemiBold)
        Text(detail, color = Palette.secondary, fontSize = 12.sp)
    }
}
