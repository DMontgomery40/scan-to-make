package com.scantomake.counterpart.ui

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
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectStatus
import com.scantomake.counterpart.api.ProjectWords
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
fun ProjectScreen(id: String, back: () -> Unit, print: () -> Unit, printing: () -> Unit, scan: () -> Unit) {
    val context = LocalContext.current
    val app = Counterpart.instance
    val state = AppState.of(context)
    val scope = rememberCoroutineScope()
    val projects by state.projects.collectAsState()
    val failures by state.sendFailures.collectAsState()
    val sending by state.sending.collectAsState()
    val project = projects.firstOrNull { it.id == id }
    // While this shows, its notifications aren't posted again (the page already shows the change).
    DisposableEffect(id) { state.showing(id, true); onDispose { state.showing(id, false) } }
    var working by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var askText by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var pendingCamera by remember { mutableStateOf<File?>(null) }
    var forAsk by remember { mutableStateOf(true) }
    val messagePhotos = remember { mutableStateOf(listOf<File>()) }
    var noteAttempt by remember { mutableStateOf<NoteAttempt?>(null) }

    LaunchedEffect(id) { if (state.reload(id)?.code == "not-found") back() }

    fun run(kind: String, body: suspend () -> Unit) {
        if (working != null) return
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
            state.show(app.companion.answerAsk(id, photoNames = names))
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
                        DropdownMenuItem({ Text(if (project.isArchived) "Show on Home" else "Hide from Home") }, onClick = {
                            menu = false
                            run("archive") {
                                val p = if (project.settings?.archived != null) app.companion.setArchived(id, !project.isArchived)
                                else app.companion.setStatus(id, if (project.isArchived) ProjectStatus.NotPrinted else ProjectStatus.Archived)
                                if (p != null) state.show(p) else state.reload(id)
                            }
                        })
                        ProjectStatus.choices.forEach { s ->
                            DropdownMenuItem({ Text("Status: ${s.label}" + if (project.projectStatus == s) "  ✓" else "") }, onClick = {
                                menu = false; run("status") { app.companion.setStatus(id, s)?.let(state::show) ?: state.reload(id) }
                            })
                        }
                        if (project.current != null) DropdownMenuItem({ Text("Duplicate") }, onClick = { menu = false; run("dup") { state.show(app.companion.duplicate(id)) } })
                        DropdownMenuItem({ Text("Delete Project", color = Palette.failed) }, onClick = { menu = false; confirmDelete = true })
                    }
                }
            }
        }
        if (project == null) { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Loading…", color = Palette.secondary) }; return@Column }
        val words = state.words(project)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            // The model's renders, else what was sent.
            val renders = project.current?.renders?.map { "renders/" + it.substringAfterLast('/') } ?: emptyList()
            val pictures = renders.ifEmpty { project.photos.take(6).map { "photos/$it" } }
            Box(Modifier.fillMaxWidth().aspectRatio(1.1f).clip(RoundedCornerShape(28.dp))) {
                if (pictures.size <= 1) ProjectImage(project, pictures.firstOrNull(), Modifier.fillMaxSize(), ContentScale.Fit)
                else Row(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
                    pictures.forEach { ProjectImage(project, it, Modifier.fillMaxHeight().aspectRatio(1.1f), ContentScale.Fit) }
                }
                StatusCapsule(words.phase, modifier = Modifier.padding(12.dp))
                words.size?.let { Text(it, Modifier.align(Alignment.BottomStart).padding(12.dp).clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(8.dp, 4.dp), fontSize = 12.sp) }
            }
            Text(words.status, fontSize = 17.sp)
            ProjectPlates(project, working != null,
                select = { plate -> run("plate") { state.show(app.companion.selectPlate(id, plate.fileIndex, plate.plateIndex)) } },
                print = { plate -> run("plate") {
                    if (!plate.selected) state.show(app.companion.selectPlate(id, plate.fileIndex, plate.plateIndex))
                    print()
                } })
            if (project.kind == "published" && project.canSelectPlate) SecondaryButton("Import More Model Files", Modifier.fillMaxWidth(), enabled = working == null) {
                pickModel.launch(arrayOf("*/*"))
            }
            if (words.phase == ProjectPhase.Working) {
                val pass = project.runningPass
                val stages = pass?.stages ?: emptyList()
                LinearProgressIndicator(Modifier.fillMaxWidth(), color = Palette.working)
                Text(listOfNotNull(pass?.currentStage?.words, pass?.estimate?.let { Format.about(maxOf(60.0, it.endsAtMs / 1000 - System.currentTimeMillis() / 1000.0)) }).joinToString(" · ")
                    .ifEmpty { ProjectWords.PUT_DOWN }, color = Palette.secondary, fontSize = 13.sp)
                if (stages.isNotEmpty()) Text("Step ${stages.indexOfLast { it.endedAtMs == null }.let { if (it < 0) stages.size else it + 1 }} of ${maxOf(stages.size, if (project.capture.isNullOrEmpty()) 3 else 4)}", color = Palette.secondary, fontSize = 12.sp)
            }
            failures[id]?.let { f ->
                GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(f, color = Palette.failed)
                    SecondaryButton("Send to Your Computer", Modifier.fillMaxWidth()) { state.sendInBackground(id) { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) } }
                } }
            }
            if (ProjectWords.watchable(project, words.phase)) PrimaryButton("Watch the Print", Modifier.fillMaxWidth(), icon = CIcons.Printer, onClick = printing)

            project.printConfirmation?.let { PrintConfirmationCard(project, it) { body -> run("confirm") { state.show(app.companion.answerPrintConfirmation(id, body)) } } }

            // A reconstruction review replaces the generic Ask controls: Best Guess, words and photos
            // cannot approve it (the companion refuses them), only the explicit preview answer counts.
            val review = project.reconstructionReview
            if (review != null) ReconstructionReviewCard(project, review, busy = working != null,
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
                    val sizes = AskSizesForm.of(ask)
                    if (sizes != null) AskSizesCard(sizes, ask.id, enabled = working == null) { answer ->
                        run("ask") { state.show(app.companion.answerAsk(id, text = askText.trim().ifBlank { null }, sizes = answer)); askText = "" }
                    }
                    if (ask.kind != null && ask.kind !in AskSizesForm.knownKinds)
                        Text("Update Counterpart on this phone to answer this kind of question here.", color = Palette.secondary, fontSize = 13.sp, modifier = Modifier.testTag("ask-update"))
                    when (ask.type) {
                        "choice" -> ask.options?.forEach { o ->
                            SecondaryButton(o.label + (o.detail?.let { " · $it" } ?: ""), Modifier.fillMaxWidth(), enabled = working == null) {
                                run("ask") { state.show(app.companion.choosePublishedPlate(id, ask.id, o.id)) }
                            }
                        }
                        "file" -> {
                            ask.url?.let { url -> SecondaryButton("Open the Model Page", Modifier.fillMaxWidth()) { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
                            PrimaryButton("Choose the Model File", Modifier.fillMaxWidth(), enabled = working == null) { pickModel.launch(arrayOf("*/*")) }
                        }
                        else -> {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                SecondaryButton(if (sizes != null) "Caliper Photo" else "Take a Photo", Modifier.weight(1f), enabled = working == null, icon = CIcons.Camera) {
                                    forAsk = true; val (f, uri) = Media.newPhotoTarget(context); pendingCamera = f; takePhoto.launch(uri)
                                }
                                if (sizes == null) SecondaryButton("Choose", Modifier.weight(1f), enabled = working == null, icon = CIcons.Photo) {
                                    forAsk = true; pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                }
                            }
                            if ("text" in ask.answers || ask.answers.isEmpty()) {
                                OutlinedTextField(askText, { askText = it }, Modifier.fillMaxWidth().testTag("ask-text"), placeholder = { Text(if (sizes != null) "Anything the numbers don't say" else "Or tell it in words") })
                                if (askText.isNotBlank()) SecondaryButton("Send Answer", Modifier.fillMaxWidth(), enabled = working == null) {
                                    run("ask") { state.show(app.companion.answerAsk(id, text = askText.trim())); askText = "" }
                                }
                            }
                            // A size is confirmed or measured, never guessed.
                            if (sizes == null) SecondaryButton("Make Your Best Guess", Modifier.fillMaxWidth(), enabled = working == null, icon = CIcons.Wand) {
                                run("ask") { state.show(app.companion.answerAsk(id, bestGuess = true)) }
                            }
                        }
                    }
                } }
            }

            // Did it fit?
            if (ProjectAction.ItWorks in words.actions) DidItFitCard(project, enabled = working == null,
                itWorks = { run("fit") { app.companion.setStatus(id, ProjectStatus.Works)?.let(state::show) ?: state.reload(id) } },
                needsChanges = { run("fit") { app.companion.setStatus(id, ProjectStatus.NeedsChanges)?.let(state::show) ?: state.reload(id) } })

            if (ProjectAction.Print in words.actions || ProjectAction.PrintChecked in words.actions) PrimaryButton("Print", Modifier.fillMaxWidth(), icon = CIcons.Printer, enabled = working == null, onClick = print)
            if (ProjectAction.FinishSending in words.actions && id !in sending) PrimaryButton("Send to Your Computer", Modifier.fillMaxWidth(), enabled = working == null) {
                state.sendInBackground(id) { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) }
            }
            if (ProjectAction.Scan in words.actions) SecondaryButton(if (Media.captureFinished(context, id)) "Scan Again" else "Scan It", Modifier.fillMaxWidth(), icon = CIcons.Cube, onClick = scan)
            if (ProjectAction.MakeIt in words.actions) PrimaryButton("Make It", Modifier.fillMaxWidth(), enabled = working == null) { run("start") { state.show(Media.sendProject(context, app.uploader, app.companion, id, emptyList())) } }
            if (ProjectAction.Retry in words.actions) SecondaryButton("Try Again", Modifier.fillMaxWidth(), icon = CIcons.Refresh, enabled = working == null) { run("retry") { state.show(app.companion.start(id)) } }

            // Ask for changes: a new pass with your words (and photos).
            if (ProjectAction.Correct in words.actions) GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Ask for changes", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), minLines = 2, placeholder = { Text("Make the hole 2 mm wider…") })
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    SecondaryButton("Add Photo", enabled = working == null, icon = CIcons.Camera) {
                        forAsk = false; val (f, uri) = Media.newPhotoTarget(context); pendingCamera = f; takePhoto.launch(uri)
                    }
                    if (messagePhotos.value.isNotEmpty()) Text("${messagePhotos.value.size} photo(s)", color = Palette.secondary)
                }
                PrimaryButton("Send Changes", Modifier.fillMaxWidth(), enabled = note.isNotBlank() && working == null, icon = CIcons.Send) {
                    run("correct") {
                        val attempt = NoteAttempt.of(noteAttempt, note.trim()).also { noteAttempt = it }
                        val names = Media.sendPhotos(app.uploader, id, messagePhotos.value, forMessage = true)
                        state.show(app.companion.correct(id, note.trim(), names.ifEmpty { null }, attempt.id))
                        noteAttempt = null; note = ""; messagePhotos.value = emptyList()
                    }
                }
            } }

            problem?.let { Text(it, color = Palette.failed) }

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
fun PrintConfirmationCard(project: Project, confirmation: PrintConfirmation, answer: (kotlinx.serialization.json.JsonObject) -> Unit) {
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
            if (confirmation.isRenderable) PrimaryButton("Print", Modifier.weight(1f), enabled = confirmation.canAccept(content, now)) {
                confirmation.response("accept", content, System.currentTimeMillis())?.let(answer)
            }
            SecondaryButton("Don't Print", Modifier.weight(1f)) { confirmation.response("cancel", emptyMap(), System.currentTimeMillis())?.let(answer) }
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
fun AskSizesCard(initial: AskSizesForm, askId: String, enabled: Boolean, send: (List<AskSizesForm.Answer>) -> Unit) {
    var form by remember(askId) { mutableStateOf(initial) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        form.fields.forEach { field ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(field.label.replaceFirstChar { it.uppercase() }, fontWeight = FontWeight.Medium)
                    Text(AskSizesForm.source(field.from), color = Palette.secondary, fontSize = 12.sp)
                }
                OutlinedTextField(field.text, { form = form.with(field.id, it) }, Modifier.width(120.dp).testTag("ask-size-${field.id}"),
                    singleLine = true, suffix = { Text("mm") },
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
            }
        }
        val answer = form.answer
        if (answer == null) Text("Enter each size in millimetres, or leave one empty if you don't know it.", color = Palette.secondary, fontSize = 13.sp)
        PrimaryButton(if (form.unchanged) "Confirm These Sizes" else "Send These Sizes", Modifier.fillMaxWidth().testTag("ask-sizes-confirm"), enabled = enabled && answer != null) {
            answer?.let(send)
        }
    }
}
