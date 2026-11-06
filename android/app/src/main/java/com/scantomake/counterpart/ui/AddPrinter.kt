package com.scantomake.counterpart.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.ObtainStep
import com.scantomake.counterpart.api.PrinterCandidate
import com.scantomake.counterpart.api.PrinterCheckResult
import com.scantomake.counterpart.api.PrinterDiscovery
import com.scantomake.counterpart.api.PrinterForm
import com.scantomake.counterpart.api.PrinterSetupOptions
import com.scantomake.counterpart.api.addPrinter
import com.scantomake.counterpart.api.checkPrinter
import com.scantomake.counterpart.api.discoverPrinters
import com.scantomake.counterpart.api.obtainControl
import com.scantomake.counterpart.api.obtainUntilAnswered
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Add a printer (PRD §5.8, §6.1): the computer's Add printer… on Android. What the MCPs found comes first, one tap
 * each and filled in from discovery; the form asks only what discovery can't know (an access code or API key). Every
 * brand, field, label and hint is the printer MCPs' own; Check and Add are the companion's `printers.check` and
 * `printers.add`, the same calls the Mac and Linux make.
 */
@Composable
fun AddPrinterScreen(back: () -> Unit, added: () -> Unit) {
    val client = Counterpart.instance.companion
    val scope = rememberCoroutineScope()
    var discovery by remember { mutableStateOf<PrinterDiscovery?>(null) }
    var looking by remember { mutableStateOf(true) }
    var problem by remember { mutableStateOf<String?>(null) }
    var form by remember { mutableStateOf<PrinterForm?>(null) }
    var prefilled by remember { mutableStateOf(false) }
    var check by remember { mutableStateOf<PrinterCheckResult?>(null) }
    var checking by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<String?>(null) }
    var obtaining by remember { mutableStateOf<ObtainStep?>(null) }
    var obtainJob by remember { mutableStateOf<Job?>(null) }
    val folderModels = remember { mutableStateMapOf<String, String>() }
    val options = discovery?.options

    LaunchedEffect(Unit) {
        try { discovery = client.discoverPrinters(); problem = null }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { problem = e.message ?: "Counterpart couldn't look for printers. You can still enter the details." }
        finally { looking = false }
    }

    fun stopObtaining() { obtainJob?.cancel(); obtainJob = null; obtaining = null }
    fun edit(value: PrinterForm) {
        // A changed printer drops the last check, and stops asking for a key for the old one.
        val old = form
        if (old != null && (old.host != value.host || old.port != value.port || old.printerType != value.printerType || old.backend != value.backend)) stopObtaining()
        if (old != value) check = null
        form = value; problem = null
    }
    fun start(value: PrinterForm) {
        var next = value
        prefilled = value.host.isNotEmpty()
        val types = options?.types.orEmpty()
        if (!prefilled && types.isNotEmpty() && types.none { it.printerType == next.printerType }) next = next.copy(printerType = types.first().printerType)
        val backends = options?.type(next.printerType)?.backends.orEmpty()
        if (backends.isNotEmpty() && next.backend !in backends) next = next.copy(backend = backends.first())
        val models = options?.models?.get(next.backend).orEmpty()
        if (options?.type(next.printerType)?.serial == true && next.model == null && models.size == 1) next = next.copy(model = models.first().value)
        stopObtaining(); check = null; problem = null; form = next
    }
    fun save(value: PrinterForm, id: String) {
        if (saving != null) return
        saving = id; problem = null
        scope.launch {
            try {
                val result = client.addPrinter(value)
                stopObtaining(); added()
                done = when {
                    result.destinationId == null -> "Saved. It shows in Printers once printing is set up on your computer."
                    result.sameAs != null -> "Added. It's the same printer as one you have, so Counterpart can use either MCP: choose in its printer settings."
                    value.folder == null && check?.reached != true -> "Added. Counterpart couldn't reach it yet; it shows as Offline until it can."
                    else -> "Added."
                }
                form = null
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { problem = e.message ?: "Counterpart couldn't add the printer. Try again." }
            finally { saving = null }
        }
    }

    Column(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { if (form != null && done == null) { stopObtaining(); form = null } else { stopObtaining(); back() } }) { Icon(CIcons.Back, "Back") }
            Text(if (form != null) form?.name ?: options?.type(form!!.printerType)?.label ?: "Printer" else "Add a printer",
                fontWeight = FontWeight.SemiBold, fontSize = 17.sp, modifier = Modifier.semantics { heading() })
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val editing = form
            when {
                done != null -> {
                    GlassCard(Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(CIcons.Check, null, tint = Palette.okGreen); Spacer(Modifier.width(10.dp))
                            Text(done!!, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("add-printer-added"))
                        }
                    }
                    PrimaryButton("Done", Modifier.fillMaxWidth().testTag("add-printer-done")) { back() }
                }
                editing != null && options != null -> PrinterFormFields(editing, options, prefilled, ::edit, obtaining,
                    startObtaining = { field ->
                        stopObtaining()
                        val asked = editing
                        obtainJob = scope.launch {
                            try {
                                val last = client.obtainUntilAnswered(asked, field) { obtaining = it }
                                if (last.status == "approved" && last.value != null) form = form?.copy(secret = last.value)
                            } catch (e: CancellationException) { throw e }
                            catch (e: Exception) { obtaining = ObtainStep(status = "failed", message = e.message ?: "Counterpart couldn't ask for it. Enter it instead.") }
                        }
                    },
                    check = check, checking = checking, saving = saving, problem = problem,
                    runCheck = {
                        checking = true; problem = null
                        val value = editing
                        scope.launch {
                            try { val result = client.checkPrinter(value); if (form == value) check = result }
                            catch (e: CancellationException) { throw e }
                            catch (e: Exception) { if (form == value) problem = e.message ?: "Counterpart couldn't run the check. Try again." }
                            finally { checking = false }
                        }
                    },
                    add = { save(editing, "form") })
                else -> {
                    SectionTitle("Found")
                    if (looking) Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.width(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(10.dp))
                        Text("Looking for printers…", color = Palette.secondary)
                    } else if (discovery?.found.isNullOrEmpty()) Text("No printers found on your computer's network.", color = Palette.secondary)
                    discovery?.found?.forEach { candidate ->
                        CandidateCard(candidate, options, folderModels[candidate.id], { folderModels[candidate.id] = it }, saving,
                            setUp = { start(prefilledForm(candidate)) },
                            addFolder = { save(PrinterForm(folder = candidate.folder, model = folderModels[candidate.id] ?: candidate.fill?.get("BAMBU_MODEL")), candidate.id) })
                    }
                    if (discovery?.network == "unavailable") Text("Your computer couldn't listen for printers on this network (another app may be using it). Enter the address instead.", color = Palette.secondary, fontSize = 12.sp)
                    problem?.let { Text(it, color = Palette.needsYou, fontSize = 13.sp) }
                    options?.updates?.forEach { Text(it.message, color = Palette.filament, fontSize = 13.sp) }
                    SecondaryButton("Enter Details", Modifier.fillMaxWidth().testTag("add-printer-manual"), enabled = !options?.types.isNullOrEmpty()) { start(PrinterForm()) }
                    Text("Each printer MCP lists the printers it can drive and the settings it needs. Your computer keeps them in that MCP's settings; nothing stays on this phone.",
                        color = Palette.secondary, fontSize = 12.sp)
                }
            }
        }
    }
}

private fun prefilledForm(candidate: PrinterCandidate) = PrinterForm(backend = candidate.backend, printerType = candidate.printerType, host = candidate.host ?: "",
    port = candidate.port, serial = candidate.serial ?: "", model = candidate.model, name = candidate.name)

private fun label(backend: String) = if (backend == "bambu-printer-mcp") "bambu-printer-mcp" else "mcp-3D-printer-server"

@Composable
private fun CandidateCard(candidate: PrinterCandidate, options: PrinterSetupOptions?, chosenModel: String?, chooseModel: (String) -> Unit,
                          saving: String?, setUp: () -> Unit, addFolder: () -> Unit) {
    val tappable = !candidate.added && candidate.folder == null
    GlassCard(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).then(if (tappable) Modifier.clickable(onClick = setUp).testTag("add-printer-found-${candidate.id}") else Modifier)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(candidate.name, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (candidate.added) Text("Added", color = Palette.secondary, fontSize = 13.sp)
                else if (tappable) Text("Set Up", color = Palette.filament, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Text(listOfNotNull(candidate.host, label(candidate.backend), candidate.folder).joinToString(" · "), color = Palette.secondary, fontSize = 13.sp)
            if (candidate.folder != null && !candidate.added) {
                candidate.missing?.takeIf { it.isNotEmpty() }?.let { Text("Its settings lack ${it.joinToString(", ")}.", color = Palette.secondary, fontSize = 12.sp) }
                if (candidate.needsModel) ChoiceField("Model", chosenModel, options?.models?.get(candidate.backend).orEmpty().map { it.value to it.label }, chooseModel, "add-printer-folder-model")
                PrimaryButton(if (saving == candidate.id) "Adding…" else "Add", Modifier.fillMaxWidth().testTag("add-printer-folder-${candidate.id}"),
                    enabled = saving == null && (!candidate.needsModel || chosenModel != null), onClick = addFolder)
            }
        }
    }
}

/** The chosen MCP's own fields, in its words. Only what discovery couldn't fill is left to type. */
@Composable
private fun PrinterFormFields(form: PrinterForm, options: PrinterSetupOptions, prefilled: Boolean, edit: (PrinterForm) -> Unit,
                              obtaining: ObtainStep?, startObtaining: (String) -> Unit, check: PrinterCheckResult?, checking: Boolean,
                              saving: String?, problem: String?, runCheck: () -> Unit, add: () -> Unit) {
    val context = LocalContext.current
    val type = options.type(form.printerType)
    val models = options.models[form.backend].orEmpty()
    val secretMissing = type?.secret?.required == true && form.secret.isEmpty()
    val ready = form.host.isNotBlank() && (type?.serial != true || (form.serial.isNotBlank() && form.model != null)) && !secretMissing

    SectionTitle("Printer")
    if (prefilled) Text("Filled in from what ${label(form.backend)} found on the network.", color = Palette.secondary, fontSize = 12.sp)
    ChoiceField("Brand", form.printerType, options.types.map { it.printerType to it.label }, { value ->
        edit(form.copy(printerType = value, backend = options.type(value)?.backends?.firstOrNull() ?: form.backend, model = null, slicer = null))
    }, "add-printer-brand")
    if (type?.serial == true) ChoiceField(type.field("model")?.label ?: "Model", form.model, models.map { it.value to it.label }, { edit(form.copy(model = it)) }, "add-printer-model")
    TextSetting("host", type?.field("host")?.label ?: "Address", form.host, type?.field("host")?.hint,
        if (type?.field("host")?.input == "url") KeyboardType.Uri else KeyboardType.Ascii) { edit(form.copy(host = it)) }
    if (type?.field("port") != null) TextSetting("port", type.field("port")!!.label, form.port ?: "", type.field("port")!!.hint, KeyboardType.Number) { edit(form.copy(port = it.ifEmpty { null })) }
    if (type?.serial == true) TextSetting("serial", type.field("serial")?.label ?: "Serial number", form.serial, type.field("serial")?.hint, KeyboardType.Ascii, KeyboardCapitalization.Characters) { value ->
        // The serial names the model (the MCP's own table), unless one was chosen.
        val named = options.model(value)?.takeIf { form.model == null && models.any { m -> m.value == it } }
        edit(form.copy(serial = value, model = form.model ?: named))
    }
    type?.secret?.let { secret ->
        OutlinedTextField(form.secret, { edit(form.copy(secret = it)) }, Modifier.fillMaxWidth().testTag("add-printer-secret"),
            label = { Text(secret.label + if (secret.required) "" else " (optional)") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
        secret.hint?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
        obtainControl(options, form)?.let { obtain ->
            SecondaryButton(obtain.label, Modifier.fillMaxWidth().testTag("add-printer-obtain"), enabled = form.host.isNotBlank() && obtaining?.pending != true) { startObtaining("secret") }
            when {
                obtaining != null -> {
                    Text(obtaining.message, fontSize = 12.sp, color = when (obtaining.status) { "failed" -> Palette.needsYou; "approved" -> Palette.okGreen; else -> Palette.secondary })
                    if (obtaining.pending) obtaining.approvalPage?.let { page ->
                        TextButton({ context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page))) }) { Text("Open the approval page") }
                    }
                }
                obtain.hint != null -> Text(obtain.hint, color = Palette.secondary, fontSize = 12.sp)
            }
        }
    }
    type?.backends?.takeIf { it.size > 1 }?.let { backends ->
        ChoiceField("Printer MCP", form.backend, backends.map { it to label(it) }, { edit(form.copy(backend = it, model = null, slicer = null)) }, "add-printer-mcp")
        Text("Counterpart sends this printer's prints through this MCP.", color = Palette.secondary, fontSize = 12.sp)
    }
    options.slicer?.get(form.backend)?.let { slicer ->
        // The slicer the MCP would run, in its words; its paths only when the MCP can't find them.
        val choice = slicer.field("slicer")?.takeIf { !it.choices.isNullOrEmpty() }
        val path = slicer.field("slicer-path")?.takeIf { !slicer.found }
        val profiles = slicer.field("profiles")?.takeIf { slicer.profilesFound == false }
        if (choice != null || path != null || profiles != null) SectionTitle("Slicer")
        choice?.let { field -> ChoiceField(field.label, form.slicer ?: slicer.type, field.choices.orEmpty().map { it.value to it.label },
            { edit(form.copy(slicer = it.takeIf { v -> v != slicer.type })) }, "add-printer-slicer") }
        path?.let { TextSetting("slicer-path", it.label + if (it.required) "" else " (optional)", form.slicerPath ?: "", it.hint, KeyboardType.Uri) { v -> edit(form.copy(slicerPath = v.ifEmpty { null })) } }
        profiles?.let { TextSetting("profiles", it.label + if (it.required) "" else " (optional)", form.profiles ?: "", it.hint, KeyboardType.Uri) { v -> edit(form.copy(profiles = v.ifEmpty { null })) } }
        if (path != null || profiles != null) Text("${label(form.backend)} couldn't find these on your computer. Enter where they are there, or leave them for later.", color = Palette.secondary, fontSize = 12.sp)
    }

    SectionTitle("Check")
    SecondaryButton(if (checking) "Asking the printer…" else "Check Connection", Modifier.fillMaxWidth().testTag("add-printer-check"), enabled = ready && !checking && saving == null, onClick = runCheck)
    when {
        check?.reached == true -> {
            val image = check.image?.let { runCatching { Base64.decode(it.base64, Base64.DEFAULT) }.getOrNull() }?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            Text(if (image != null) "Connected. Here's what your printer sees." else if (check.camera == "failed") "Connected. The camera didn't send a picture." else "Connected.",
                color = Palette.okGreen, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("add-printer-connected"))
            image?.let { Image(it.asImageBitmap(), "The printer's camera", Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.FillWidth) }
        }
        check != null -> Text("Counterpart couldn't reach the printer. Check the address" + (type?.secret?.let { " and ${it.label.lowercase()}" } ?: "") + ".", color = Palette.needsYou)
        !checking -> Text(if (ready) "Check asks the printer for its status through its MCP. It never starts a print. Add saves it either way." else stillNeeded(form, type), color = Palette.secondary, fontSize = 12.sp)
    }
    problem?.let { Text(it, color = Palette.needsYou, fontSize = 13.sp) }
    PrimaryButton(if (saving == "form") "Adding…" else "Add Printer", Modifier.fillMaxWidth().testTag("add-printer-add"), enabled = ready && !checking && saving == null, onClick = add)
}

private fun stillNeeded(form: PrinterForm, type: PrinterSetupOptions.PrinterType?): String {
    val missing = buildList {
        if (form.host.isBlank()) add(type?.field("host")?.label ?: "Address")
        if (type?.serial == true && form.serial.isBlank()) add(type.field("serial")?.label ?: "Serial number")
        if (type?.serial == true && form.model == null) add(type.field("model")?.label ?: "Model")
        type?.secret?.takeIf { it.required && form.secret.isEmpty() }?.let { add(it.label) }
    }
    return if (missing.isEmpty()) "" else "Still needed: ${missing.joinToString(", ")}."
}

@Composable
private fun TextSetting(name: String, label: String, value: String, hint: String?, keyboard: KeyboardType,
                        capitalization: KeyboardCapitalization = KeyboardCapitalization.None, change: (String) -> Unit) {
    OutlinedTextField(value, change, Modifier.fillMaxWidth().testTag("add-printer-$name"), label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, capitalization = capitalization, autoCorrectEnabled = false))
    hint?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
}

/** A labelled menu of the MCP's own choices (value to label). */
@Composable
private fun ChoiceField(label: String, value: String?, choices: List<Pair<String, String>>, choose: (String) -> Unit, tag: String) {
    var open by remember { mutableStateOf(false) }
    Box {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.glass).clickable { open = true }.padding(horizontal = 14.dp, vertical = 10.dp).testTag(tag)) {
            Text(label, color = Palette.secondary, fontSize = 12.sp)
            Text(choices.firstOrNull { it.first == value }?.second ?: "Choose…", fontWeight = FontWeight.Medium)
        }
        DropdownMenu(open, { open = false }) {
            choices.forEach { (v, text) -> DropdownMenuItem({ Text(if (v == value) "$text  ✓" else text) }, onClick = { open = false; choose(v) }) }
        }
    }
}
