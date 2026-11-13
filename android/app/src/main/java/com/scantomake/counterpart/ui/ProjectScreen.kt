package com.scantomake.counterpart.ui

import androidx.compose.foundation.clickable

import androidx.compose.ui.semantics.semantics

import androidx.compose.ui.semantics.contentDescription

import androidx.compose.ui.semantics.Role

import androidx.compose.foundation.selection.selectable

import com.scantomake.counterpart.api.canLocate

import com.scantomake.counterpart.api.photoPicture
import com.scantomake.counterpart.api.Still
import com.scantomake.counterpart.api.KnownProjects
import com.scantomake.counterpart.api.MacLink
import com.scantomake.counterpart.api.still

import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.ScanLineage

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.AskSizesForm
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Format
import com.scantomake.counterpart.api.NoteAttempt
import com.scantomake.counterpart.api.PrintConfirmation
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.MainAction
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectStatus
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.ProjectConversation
import com.scantomake.counterpart.api.showingDesign
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.Media
import com.scantomake.counterpart.core.str
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/** A project (PRD §5.3): its model, what the Mac is doing or asking, and what you can do next. */
@Composable
fun ProjectScreen(id: String, back: () -> Unit, print: () -> Unit, printing: () -> Unit, scan: () -> Unit,
                  makeFromScan: () -> Unit = {}, open: (String) -> Unit = {}) {
    val context = LocalContext.current
    val app = Counterpart.instance
    val state = AppState.of(context)
    val scope = rememberCoroutineScope()
    val projects by state.projects.collectAsState()
    val failures by state.sendFailures.collectAsState()
    val sending by state.sending.collectAsState()
    val project = projects.firstOrNull { it.id == id }
    // The computer isn't answering: the page shows what this phone already had and says so; Print and Send wait (X100).
    val link by state.link.collectAsState()
    val heard by state.heard.collectAsState()
    val away = link == MacLink.NotAnswering
    // While this shows, its notifications aren't posted again (the page already shows the change).
    DisposableEffect(id) { state.showing(id, true); onDispose { state.showing(id, false) } }
    var working by remember { mutableStateOf<String?>(null) }
    /** Free to act: nothing running here, and the computer answering (X100, one fact from AppState.link). */
    val idle = working == null && !away
    var problem by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var askText by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var pendingCamera by remember { mutableStateOf<File?>(null) }
    var forAsk by remember { mutableStateOf(true) }
    // The size fields as they stand, with the question they belong to: read by every answer the card sends.
    var askSizes by remember { mutableStateOf<Pair<String, AskSizesForm>?>(null) }
    // The numbers that go with the caliper photo, taken when its button is pressed (the fields can't change meanwhile).
    var photoSizes by remember { mutableStateOf(listOf<AskSizesForm.Answer>()) }
    var askProblem by remember { mutableStateOf<String?>(null) }
    val messagePhotos = remember { mutableStateOf(listOf<File>()) }
    var noteAttempt by remember { mutableStateOf<NoteAttempt?>(null) }
    // An earlier design on the stage (#616): its own pictures and state; the project's actions wait for the newest.
    var viewingDesign by remember(id) { mutableStateOf<String?>(null) }

    LaunchedEffect(id) { state.library.opened(id); if (state.reload(id)?.code == "not-found") back() }
    // The link came back (the event stream's recovery): the page reads the project again by itself.
    // Keyed on the link itself (review B1): a recovery through Checking or a new pairing still reloads once it answers.
    var wasAway by remember { mutableStateOf(false) }
    LaunchedEffect(link) { if (away) wasAway = true else if (wasAway && link == MacLink.Connected) { wasAway = false; state.reload(id) } }

    fun run(kind: String, body: suspend () -> Unit) {
        // Nothing that needs the computer runs while it isn't answering: its control is disabled and the page says why.
        if (working != null || away) return
        working = kind; problem = null
        scope.launch {
            try { body() } catch (e: CompanionException) { if (e.code != "cancelled") problem = e.message } catch (e: Exception) { problem = CompanionException.unreachable.message }
            finally { working = null }
        }
    }

    /** Photos for an Ask go straight up and answer it; photos for a change wait for the note. */
    fun gotPhotos(files: List<File>) {
        if (files.isEmpty()) return
        if (forAsk) run("ask") {
            val names = Media.sendPhotos(app.uploader, id, files, forMessage = true)
            state.show(app.companion.answerAsk(id, photoNames = names, sizes = photoSizes))
        } else messagePhotos.value = messagePhotos.value + files
    }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = pendingCamera; pendingCamera = null
        if (ok && f != null && f.length() > 0) gotPhotos(listOf(f)) else f?.delete()
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(12)) { uris -> gotPhotos(uris.mapNotNull { Media.keep(context, it) }) }
    val pickModel = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) run("model") {
            for (uri in uris) {
                val (name, bytes) = withContext(Dispatchers.IO) { Media.readModel(context, uri) }
                state.show(app.companion.addModelFile(id, name, bytes))
            }
        }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back) { Icon(CIcons.Back, "Back") }
            Text(project?.let { ProjectWords.title(it) } ?: "", Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1)
            Box {
                IconButton(onClick = { menu = true }) { Icon(CIcons.Gear, "More") }
                DropdownMenu(menu, { menu = false }) {
                    if (project != null) {
                        DropdownMenuItem({ Text(if (project.isArchived) "Show on Home" else "Hide from Home") }, enabled = !away && viewingDesign == null, onClick = {
                            menu = false
                            run("archive") {
                                val p = if (project.settings?.archived != null) app.companion.setArchived(id, !project.isArchived)
                                else app.companion.setStatus(id, if (project.isArchived) ProjectStatus.NotPrinted else ProjectStatus.Archived)
                                if (p != null) state.show(p) else state.reload(id)
                            }
                        })
                        // The project's status waits until the newest design is shown again (#616).
                        if (viewingDesign == null) ProjectStatus.choices.forEach { s ->
                            DropdownMenuItem({ Text("Status: ${s.label}" + if (project.projectStatus == s) "  ✓" else "") }, enabled = !away, onClick = {
                                menu = false; run("status") { app.companion.setStatus(id, s)?.let(state::show) ?: state.reload(id) }
                            })
                        }
                        if (project.canMakeFromScan) DropdownMenuItem({ Text(ScanLineage.ACTION) }, enabled = !away && viewingDesign == null, onClick = { menu = false; makeFromScan() })
                        if (project.current != null) DropdownMenuItem({ Text("Duplicate") }, enabled = !away && viewingDesign == null, onClick = { menu = false; run("dup") { state.show(app.companion.duplicate(id)) } })
                        DropdownMenuItem({ Text("Delete Project", color = Palette.failed) }, enabled = !away && viewingDesign == null, onClick = { menu = false; confirmDelete = true })
                    }
                }
            }
        }
        if (project == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Loading…", color = Palette.secondary) }; return@Column }
        val words = state.words(project)
        val version = project.versions?.firstOrNull { it.id == viewingDesign }
        // The design asked for went (a new pass, another client): the page shows the newest again.
        LaunchedEffect(version == null) { if (version == null) viewingDesign = null }
        val shown = remember(project, version?.id) { project.showingDesign(version?.id) }
        val shownWords = if (version == null) words else ProjectWords(shown)
        /** Free for the project's own actions: idle, and the newest design on the stage. Every send or answer on this
         *  page goes to the newest design, so all of them wait while an earlier one is shown (the Mac's `blocked`). */
        val acts = idle && version == null
        val scroll = rememberScrollState()
        Column(Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // The project's pictures (PRD §5.4): what will print in its spool, the two together, what was scanned. The
            // computer draws each once; a row of labels under the stage chooses one (none for one, a scrolling row for many).
            val gallery = remember(shown) { ProjectGallery.of(shown) }
            var chosen by remember(id, version?.id) { mutableStateOf<String?>(null) }
            val entry = gallery.entries.firstOrNull { it.id == chosen } ?: gallery.first
            Box(Modifier.fillMaxWidth().aspectRatio(1.1f).clip(RoundedCornerShape(28.dp))) {
                // With nothing in the gallery yet (photos sent, no model): the subject the computer cut out, as on its card.
                // The one stage picture (review B1/S7 on #539): this entry's own picture, or that it is coming, or that it can't be had.
                val photo = shown.photoPicture()
                StagePicture(shown,
                    still = entry?.let(shown::still) ?: photo?.let { Still.Picture(it) } ?: if (shownWords.busy) Still.Waiting else Still.NotAvailable,
                    label = entry?.label ?: if (photo != null) "Your photo" else words.title,
                    unavailableLine = when { entry == null -> "Nothing to show yet."; entry.kind == ProjectGallery.Kind.Plate -> "No picture of this plate came with the file."; else -> "Your computer couldn't draw a picture of this." },
                    modifier = Modifier.fillMaxSize())
                val draftCapsule = shownWords.phase == ProjectPhase.Ready && shown.current?.draft != null
                StatusCapsule(shownWords.phase, text = if (draftCapsule) Project.Draft.CAPSULE else null,
                    modifier = Modifier.padding(12.dp).testTag("status-capsule"), icon = if (draftCapsule) CIcons.Warning else null)
                entry?.sizeText()?.let { Text(it, Modifier.align(Alignment.BottomStart).padding(12.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(8.dp, 4.dp), fontSize = 12.sp) }
                // On the picture, with the same dark backing as the size and status chips, so it reads on either stage.
                if (version == null && entry?.kind == ProjectGallery.Kind.Part && project.canLocate) Text("See It Together",
                    Modifier.align(Alignment.BottomEnd).padding(12.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.62f))
                        .clickable(enabled = idle, role = Role.Button) { run("locate") { state.show(app.companion.locate(id)) } }
                        .padding(14.dp, 8.dp), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
            if (gallery.entries.size > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).semantics { contentDescription = "Pictures" },
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                gallery.entries.forEach { item ->
                    val selected = item.id == entry?.id
                    Text(item.label, Modifier.clip(RoundedCornerShape(50)).background(if (selected) Color.White else Color.White.copy(alpha = 0.10f))
                        .selectable(selected = selected, role = Role.Tab) { chosen = item.id }.padding(14.dp, 8.dp),
                        color = if (selected) Color.Black else Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
                }
            }
            if (version != null) ViewingEarlierDesignBar(project, version) { viewingDesign = null }
            // #788: the design on the stage is a draft: the plain line and the printer MCP's reasons as given.
            shown.current?.draft?.let { DraftDesignNote(it) }
            // Under What you scanned (design §3.3): make something else from this scan, on any project the computer has a
            // scan for, whatever its kind; where this one's scan came from; what else was made from it.
            val lineage = ScanLineage(project, projects)
            if (project.canMakeFromScan) SecondaryButton(ScanLineage.ACTION, Modifier.fillMaxWidth().testTag("make-from-scan"), enabled = acts, color = Palette.filament) { makeFromScan() }
            lineage.fromLine?.let { line ->
                Text(line, Modifier.fillMaxWidth().testTag("scan-from").clickable(enabled = lineage.from?.exists == true, role = Role.Button) { lineage.from?.let { open(it.id) } },
                    color = if (lineage.from?.exists == true) Palette.filament else Palette.secondary, fontSize = 14.sp)
            }
            // One project made from it opens at a tap; several are a list to choose from, newest first (as on the
            // iPhone and the Mac), never just the newest.
            lineage.madeLine?.let { line ->
                var choosing by remember { mutableStateOf(false) }
                Box {
                    Text(line, Modifier.fillMaxWidth().testTag("scan-made").clickable(role = Role.Button) {
                        lineage.made.singleOrNull()?.let { open(it.id) } ?: run { choosing = true }
                    }, color = Palette.filament, fontSize = 14.sp)
                    DropdownMenu(choosing, { choosing = false }) {
                        lineage.made.forEach { made ->
                            DropdownMenuItem({ Text(made.title) }, modifier = Modifier.testTag("scan-made-${made.id}"), onClick = { choosing = false; open(made.id) })
                        }
                    }
                }
            }
            Text(words.status, fontSize = 17.sp)
            if (away) Row(Modifier.fillMaxWidth().testTag("project-away"), verticalAlignment = Alignment.CenterVertically) {
                Text(KnownProjects.awayLine(heard[id]), Modifier.weight(1f), color = Palette.secondary, fontSize = 14.sp)
                TextButton({ scope.launch { state.reload(id) } }, Modifier.testTag("project-away-retry")) { Text("Try Again") }
            }
            ProjectPlates(project, working != null || away || version != null,
                select = { plate -> run("plate") { state.show(app.companion.selectPlate(id, plate.fileIndex, plate.plateIndex)) } },
                print = { plate -> run("plate") {
                    if (!plate.selected) state.show(app.companion.selectPlate(id, plate.fileIndex, plate.plateIndex))
                    print()
                } })
            if (project.kind == "published" && project.canSelectPlate) SecondaryButton("Import More Model Files", Modifier.fillMaxWidth(), enabled = acts) {
                pickModel.launch(arrayOf("*/*"))
            }
            if (words.phase == ProjectPhase.Working) {
                val pass = project.runningPass
                val stages = pass?.stages ?: emptyList()
                LinearProgressIndicator(Modifier.fillMaxWidth(), color = Palette.working)
                Text(listOfNotNull(pass?.currentStage?.words, pass?.estimate?.let { Format.about(maxOf(60.0, it.endsAtMs / 1000 - (if (away) heard[id] ?: System.currentTimeMillis() else System.currentTimeMillis()) / 1000.0)) }).joinToString(" · ")
                    .ifEmpty { ProjectWords.PUT_DOWN }, color = Palette.secondary, fontSize = 13.sp)
                if (stages.isNotEmpty()) Text("Step ${stages.indexOfLast { it.endedAtMs == null }.let { if (it < 0) stages.size else it + 1 }} of ${maxOf(stages.size, if (project.capture.isNullOrEmpty()) 3 else 4)}", color = Palette.secondary, fontSize = 12.sp)
            }
            failures[id]?.let { f ->
                GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(f, color = Palette.failed)
                    SecondaryButton("Send to Your Computer", Modifier.fillMaxWidth().testTag("send-again"), enabled = acts) { state.sendInBackground(id) { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) } }
                } }
            }
            if (ProjectWords.watchable(project, words.phase)) PrimaryButton("Watch the Print", Modifier.fillMaxWidth(), icon = CIcons.Printer, onClick = printing)

            project.printConfirmation?.let { PrintConfirmationCard(project, it, enabled = acts) { body -> run("confirm") { state.show(app.companion.answerPrintConfirmation(id, body)) } } }

            // A reconstruction review replaces the generic Ask controls: Best Guess, words and photos
            // cannot approve it (the companion refuses them), only the explicit preview answer counts.
            val review = project.reconstructionReview
            if (review != null) ReconstructionReviewCard(project, review, busy = working != null || version != null,
                loadPreview = { app.companion.reconstructionPreview(id, review.id) },
                answer = { body -> run("review") {
                    try { state.show(app.companion.answerReconstruction(id, review.id, body)) }
                    catch (e: CompanionException) { state.reload(id); throw e }
                } })

            // The Mac's question.
            project.openAsk?.takeIf { review == null }?.let { ask ->
                GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Icon(CIcons.Hand, null, tint = Palette.needsYou); Spacer(Modifier.width(8.dp)); Text("Your computer asks", fontWeight = FontWeight.SemiBold) }
                    Text(ask.question)
                    if (ask.type != "choice" && ask.type != "file") AskPhoto(project, ask)
                    // A size question: its numbers, prefilled, with Confirm as the one obvious action. Words and a
                    // caliper photo stay below for whatever the numbers don't say.
                    val sizes = AskSizesForm.of(ask)?.let { asked -> askSizes?.takeIf { it.first == ask.id }?.second ?: asked }
                    if (sizes != null) AskSizesCard(sizes, enabled = acts, changed = { askSizes = ask.id to it; askProblem = null }) { answer ->
                        run("ask") { state.show(app.companion.answerAsk(id, text = askText.trim().ifBlank { null }, sizes = answer)); askText = "" }
                    }
                    // One answer carries everything the card holds: the numbers as they stand go with words or a photo.
                    // Null when a filled field isn't a number, and then nothing is sent.
                    fun carried(): List<AskSizesForm.Answer>? = when (val c = sizes?.carried) {
                        is AskSizesForm.Carried.Sizes -> c.sizes
                        AskSizesForm.Carried.Invalid -> { askProblem = AskSizesForm.invalidWords; null }
                        AskSizesForm.Carried.None, null -> emptyList()
                    }
                    askProblem?.let { Text(it, color = Palette.failed, fontSize = 13.sp) }
                    // A kind this build doesn't know: the question and this sentence, and no answer at all, because any
                    // answer offered here could consume the question wrongly.
                    if (!AskSizesForm.answerable(ask.kind))
                        Text("Update Counterpart on this phone to answer this kind of question here.", color = Palette.secondary, fontSize = 13.sp, modifier = Modifier.testTag("ask-update"))
                    else when (ask.type) {
                        "choice" -> ask.options?.forEach { o ->
                            SecondaryButton(o.label + (o.detail?.let { " · $it" } ?: ""), Modifier.fillMaxWidth(), enabled = acts) {
                                run("ask") { state.show(app.companion.choosePublishedPlate(id, ask.id, o.id)) }
                            }
                        }
                        "file" -> {
                            ask.url?.let { url -> SecondaryButton("Open the Model Page", Modifier.fillMaxWidth()) { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
                            PrimaryButton("Choose the Model File", Modifier.fillMaxWidth(), enabled = acts) { pickModel.launch(arrayOf("*/*")) }
                        }
                        else -> {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                SecondaryButton(if (sizes != null) "Caliper Photo" else "Take a Photo", Modifier.weight(1f), enabled = acts, icon = CIcons.Camera) {
                                    photoSizes = carried() ?: return@SecondaryButton
                                    forAsk = true; val (f, uri) = Media.newPhotoTarget(context); pendingCamera = f; takePhoto.launch(uri)
                                }
                                if (sizes == null) SecondaryButton("Choose", Modifier.weight(1f), enabled = acts, icon = CIcons.Photo) {
                                    photoSizes = emptyList(); forAsk = true; pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                }
                            }
                            if ("text" in ask.answers || ask.answers.isEmpty()) {
                                OutlinedTextField(askText, { askText = it }, Modifier.fillMaxWidth().testTag("ask-text"), placeholder = { Text(if (sizes != null) "Anything the numbers don't say" else "Or tell it in words") })
                                if (askText.isNotBlank()) SecondaryButton("Send Answer", Modifier.fillMaxWidth(), enabled = acts) {
                                    val numbers = carried() ?: return@SecondaryButton
                                    run("ask") { state.show(app.companion.answerAsk(id, text = askText.trim(), sizes = numbers)); askText = "" }
                                }
                            }
                            // A size is confirmed or measured, never guessed.
                            if (sizes == null) SecondaryButton("Make Your Best Guess", Modifier.fillMaxWidth(), enabled = acts, icon = CIcons.Wand) {
                                run("ask") { state.show(app.companion.answerAsk(id, bestGuess = true)) }
                            }
                        }
                    }
                } }
            }

            // Did it fit?
            if (ProjectAction.ItWorks in words.actions) DidItFitCard(project, enabled = acts,
                itWorks = { run("fit") { app.companion.setStatus(id, ProjectStatus.Works)?.let(state::show) ?: state.reload(id) } },
                needsChanges = { run("fit") { app.companion.setStatus(id, ProjectStatus.NeedsChanges)?.let(state::show) ?: state.reload(id) } })

            // One filled control on the page, the one `words.page` leads with; everything else is plain.
            val page = words.page
            val retry: () -> Unit = { run("retry") { state.show(app.companion.start(id)) } }
            if (page.main == MainAction.Retry) PrimaryButton("Try Again", Modifier.fillMaxWidth().testTag("retry"), icon = CIcons.Refresh, enabled = acts, onClick = retry)
            // Print once, under what it is here ("Print the last version", "Print Again", "Print Another"), and never while a change is being made.
            page.printWords?.let { printWords ->
                if (page.printIsMain) PrimaryButton(printWords, Modifier.fillMaxWidth().testTag("print"), icon = CIcons.Printer, enabled = acts, onClick = print)
                else SecondaryButton(printWords, Modifier.fillMaxWidth().testTag("print"), icon = CIcons.Printer, enabled = acts, onClick = print)
                page.printNote?.let { Text(it, color = Palette.secondary, fontSize = 13.sp) }
            }
            if (ProjectAction.FinishSending in words.actions && id !in sending) PrimaryButton("Send to Your Computer", Modifier.fillMaxWidth().testTag("finish-sending"), enabled = acts) {
                state.sendInBackground(id) { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) }
            }
            if (ProjectAction.Scan in words.actions) {
                val label = if (Media.captureFinished(context, id)) "Scan Again" else "Scan It"
                if (page.main == MainAction.Scan) PrimaryButton(label, Modifier.fillMaxWidth(), icon = CIcons.Cube, onClick = scan)
                else SecondaryButton(label, Modifier.fillMaxWidth(), icon = CIcons.Cube, onClick = scan)
            }
            if (ProjectAction.MakeIt in words.actions) SecondaryButton("Make It", Modifier.fillMaxWidth(), enabled = acts) { run("start") { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) } }
            if (ProjectAction.Retry in words.actions && page.main != MainAction.Retry) SecondaryButton("Try Again", Modifier.fillMaxWidth().testTag("retry"), icon = CIcons.Refresh, enabled = acts, onClick = retry)

            // Ask for changes: a new pass with your words (and photos).
            if (ProjectAction.Correct in words.actions) GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Ask for changes", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), minLines = 2, placeholder = { Text("Make the hole 2 mm wider…") })
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    SecondaryButton("Add Photo", enabled = acts, icon = CIcons.Camera) {
                        forAsk = false; val (f, uri) = Media.newPhotoTarget(context); pendingCamera = f; takePhoto.launch(uri)
                    }
                    if (messagePhotos.value.isNotEmpty()) Text("${messagePhotos.value.size} photo(s)", color = Palette.secondary)
                }
                // Sends the typed note; not a page action, so it stays plain beside the page's one filled control.
                SecondaryButton("Send Changes", Modifier.fillMaxWidth().testTag("send-changes"), enabled = note.isNotBlank() && working == null && version == null, icon = CIcons.Send) {
                    run("correct") {
                        val attempt = NoteAttempt.of(noteAttempt, note.trim(), messagePhotos.value.map { it.path }).also { noteAttempt = it }
                        val names = Media.sendPhotos(app.uploader, id, messagePhotos.value, forMessage = true)
                        state.show(app.companion.correct(id, note.trim(), names.ifEmpty { null }, attempt.id))
                        noteAttempt = null; note = ""; messagePhotos.value = emptyList()
                    }
                }
            } }

            problem?.let { Text(it, color = Palette.failed) }

            // Earlier designs and prints (#616 slice 1): what you have, and what was never printed. Two or more designs only.
            // Opening one goes back up to the stage it is shown on, with its bar under it.
            DesignHistorySection(project, enabled = idle, select = { viewingDesign = it; scope.launch { scroll.animateScrollTo(0) } }, answer = { versionId, status ->
                run("design") { app.companion.setStatus(id, status, versionId = versionId)?.let(state::show) ?: state.reload(id) }
            })

            // What changed.
            project.current?.changes?.takeIf { it.isNotEmpty() }?.let { changes ->
                SectionTitle("What changed")
                changes.forEach { c ->
                    Row { Text(c.tag.replaceFirstChar { it.uppercase() }, color = Palette.filament, fontSize = 13.sp, modifier = Modifier.width(80.dp)); Text(c.text + (c.toleranceMm?.let { " (±$it mm)" } ?: ""), fontSize = 14.sp) }
                }
            }
            project.credit?.let { credit ->
                val designer = credit["designer"].str
                val site = credit["site"].str
                if (designer != null || site != null) Text(listOfNotNull(designer?.let { "by $it" }, site?.let { "on $it" }).joinToString(" "), color = Palette.secondary)
            }
            // A project made from another: that one's conversation first, read-only, then this one's request (#613).
            InheritedConversation(remember(project, projects) { ProjectConversation(project, projects) }, open)
            project.instructions?.takeIf { it.isNotBlank() }?.let { SectionTitle("You asked"); Text(it, color = Palette.secondary) }
            // The scan as one strip and its count, never every frame (David, Nov 9).
            ScanStrip(project)
            Text("Sent: " + ProjectWords.sentLine(project), color = Palette.secondary, fontSize = 13.sp)
            Spacer(Modifier.height(24.dp))
        }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false },
        title = { Text("Delete this project?") }, text = { Text("Its model and files are deleted from your computer too.") },
        confirmButton = { TextButton({ confirmDelete = false; run("delete") { app.companion.delete(id); state.remove(id); back() } }) { Text("Delete", color = Palette.failed) } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel") } })
}

private fun Modifier.fillMaxHeight() = this.then(Modifier.fillMaxSize())

/** The printer MCP's own question, answered here (PR 5 field types) or on the Mac. */
@Composable
fun PrintConfirmationCard(project: Project, confirmation: PrintConfirmation, enabled: Boolean = true, answer: (kotlinx.serialization.json.JsonObject) -> Unit) {
    val content = remember(confirmation.id) { mutableStateMapOf<String, JsonElement?>() }
    val now = System.currentTimeMillis()
    GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(CIcons.Printer, null, tint = Palette.needsYou); Spacer(Modifier.width(8.dp)); Text("Your printer asks", fontWeight = FontWeight.SemiBold) }
        Text(confirmation.message)
        if (!confirmation.isRenderable) Text("Answer this on your computer, or don't print.", color = Palette.secondary)
        else confirmation.fields.forEach { f ->
            when (f.kind) {
                "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text(f.label); f.description?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) } }
                    Switch(checked = (content[f.name] as? JsonPrimitive)?.content == "true", onCheckedChange = { content[f.name] = JsonPrimitive(it) })
                }
                "string" -> if (f.enumValues != null) Column {
                    Text(f.label)
                    f.enumValues.forEach { v ->
                        val chosen = ((content[f.name] ?: f.initialValue) as? JsonPrimitive)?.content == v
                        TextButton({ content[f.name] = JsonPrimitive(v) }) { Text((if (chosen) "● " else "○ ") + f.displayName(v)) }
                    }
                } else OutlinedTextField(((content[f.name] ?: f.initialValue) as? JsonPrimitive)?.content ?: "", { content[f.name] = if (it.isEmpty()) JsonNull else JsonPrimitive(it) },
                    Modifier.fillMaxWidth(), label = { Text(f.label) })
                else -> OutlinedTextField(((content[f.name] ?: f.initialValue) as? JsonPrimitive)?.content ?: "", { text ->
                    content[f.name] = if (text.isEmpty()) JsonNull else text.toDoubleOrNull()?.let { if (f.kind == "integer" && it == Math.rint(it)) JsonPrimitive(it.toLong()) else JsonPrimitive(it) } ?: JsonPrimitive(text)
                }, Modifier.fillMaxWidth(), label = { Text(f.label) })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (confirmation.isRenderable) PrimaryButton("Print", Modifier.weight(1f).testTag("print-confirmation-accept"), enabled = enabled && confirmation.canAccept(content, now)) {
                confirmation.response("accept", content, System.currentTimeMillis())?.let(answer)
            }
            SecondaryButton("Don't Print", Modifier.weight(1f).testTag("print-confirmation-cancel"), enabled = enabled) { confirmation.response("cancel", emptyMap(), System.currentTimeMillis())?.let(answer) }
        }
    } }
}

/** "Did it fit?" after a finished print (PRD §5.4), on the project and on the finished Printing screen alike. */
@Composable
fun DidItFitCard(project: Project, enabled: Boolean, itWorks: () -> Unit, needsChanges: () -> Unit) {
    GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(ProjectWords.outcomeQuestion(project), fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton("It Works", Modifier.weight(1f), enabled = enabled, onClick = itWorks)
            SecondaryButton("Needs Changes", Modifier.weight(1f), enabled = enabled, onClick = needsChanges)
        }
    } }
}

/** A size question's fields: one row per size the computer asked about, in its words, prefilled, and one button.
 *  What is sent is `AskSizesForm`'s rule, the same as on every other client. */
@Composable
fun AskSizesCard(form: AskSizesForm, enabled: Boolean, changed: (AskSizesForm) -> Unit, send: (List<AskSizesForm.Answer>) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        form.fields.forEach { field ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(field.label.replaceFirstChar { it.uppercase() }, fontWeight = FontWeight.Medium)
                    Text(AskSizesForm.source(field), color = Palette.secondary, fontSize = 12.sp)
                }
                OutlinedTextField(field.text, { changed(form.with(field.id, it)) }, Modifier.width(120.dp).testTag("ask-size-${field.id}"),
                    singleLine = true, suffix = { Text("mm") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
            }
        }
        val answer = form.answer
        if (answer == null) Text(AskSizesForm.invalidWords, color = Palette.secondary, fontSize = 13.sp)
        PrimaryButton(if (form.unchanged) "Confirm These Sizes" else "Send These Sizes", Modifier.fillMaxWidth().testTag("ask-sizes-confirm"), enabled = enabled && answer != null) {
            answer?.let(send)
        }
    }
}

/** #788: a design that isn't finished: the plain line, then the printer MCP's reasons word for word (two, then Show all). */
@Composable
private fun DraftDesignNote(draft: Project.Draft) {
    var expanded by remember(draft) { mutableStateOf(false) }
    GlassCard(Modifier.fillMaxWidth().testTag("draft-design")) { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("⚠ " + Project.Draft.LINE, Modifier.testTag("draft-design-line"), color = Palette.needsYou, fontWeight = FontWeight.SemiBold)
        draft.shown(expanded).forEach { reason -> Text("•  $reason", Modifier.testTag("draft-design-reason"), color = Palette.secondary, fontSize = 14.sp) }
        if (draft.collapses) Text(if (expanded) "Show fewer" else "Show all ${draft.reasons.size}",
            Modifier.testTag("draft-design-more").clickable(role = Role.Button) { expanded = !expanded },
            color = Palette.filament, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    } }
}
