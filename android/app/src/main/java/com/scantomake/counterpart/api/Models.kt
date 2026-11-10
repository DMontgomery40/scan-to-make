package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.bool
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.str
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/** Decodes one optional field; a field that doesn't decode is left out, never the whole object (as the Swift does). */
inline fun <reified T> JsonObject.opt(key: String): T? {
    val element = this[key] ?: return null
    if (element is kotlinx.serialization.json.JsonNull) return null
    return try { WireJson.decodeFromJsonElement<T>(element) } catch (_: Exception) { null }
}

/**
 * One thing you want made (PRD §4), as the Mac keeps it at `/v1/objects` (docs/protocols/objects-api.md). Port of
 * CounterpartKit `Project`. Wire names are the companion's; unknown fields are ignored; unknown states decode
 * as `Unknown`; only a missing id, time or state makes an object unreadable.
 */
data class Project(
    val id: String,
    val createdAtMs: Double,
    val updatedAtMs: Double,
    val state: State,
    val instructions: String? = null,
    val scan: String? = null,
    val photos: List<String> = emptyList(),
    val capture: List<String>? = null,
    val captureDepth: List<String>? = null,
    val progress: String? = null,
    val passes: List<Pass> = emptyList(),
    val current: Result? = null,
    val question: Question? = null,
    val failure: String? = null,
    val canRetryCleanup: Boolean? = null,
    val print: Print? = null,
    val printerDestinationId: String? = null,
    val printConfirmation: PrintConfirmation? = null,
    val status: Status? = null,
    val title: String? = null,
    val kind: String? = null,
    val ask: Ask? = null,
    val settings: Settings? = null,
    val outcome: String? = null,
    val archived: Boolean? = null,
    val credit: JsonObject? = null,
    val files: JsonObject? = null,
    val pendingFollowup: String? = null,
    val messages: List<Message>? = null,
    val pendingPhotos: List<String>? = null,
    val plates: List<ProjectPlate>? = null,
    /** A rebuild waiting on the person: which part is the object, or how big it is. */
    val reconstructionReview: ReconstructionReview? = null,
    val raw: JsonObject = JsonObject(emptyMap()),
) {
    enum class State(val wire: String) {
        New("new"), TouchingUp("touching-up"), NeedsCloseup("needs-closeup"), Ready("ready"), Printing("printing"),
        Printed("printed"), Sent("sent"), Confirmed("confirmed"), Failed("failed"), Unknown("unknown");
        companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Unknown }
    }

    val hasScan: Boolean get() = scan != null || !capture.isNullOrEmpty()
    /** Cached copies of renders expire only when a pass finishes. */
    /** A locate pass changes no file (docs/protocols/seats.md), so it never rolls the version over. */
    val mediaVersion: Long get() = (passes.lastOrNull { it.endedAtMs != null && it.trigger != "locate" }?.endedAtMs ?: createdAtMs).toLong()
    val runningPass: Pass? get() = if (state == State.TouchingUp) passes.lastOrNull { it.endedAtMs == null } else null
    val projectStatus: ProjectStatus? get() = ProjectStatus.of(settings?.status) ?: ProjectStatus.of(outcome)
    val isArchived: Boolean get() = settings?.archived ?: (archived == true || projectStatus == ProjectStatus.Archived)
    val openAsk: Ask? get() = ask?.takeIf { it.status != "answered" }
    val selectedPlate: ProjectPlate? get() = plates?.firstOrNull { it.selected }
    val slicedOriginal: Boolean get() = selectedPlate?.sliced ?: (raw["publishedSelection"].obj?.get("sliced").bool == true)
    val completedPlateCount: Int get() = plates?.count { it.completedAtMs != null } ?: 0
    /** Any plate can be chosen except while a step runs. A send Counterpart couldn't confirm stays on its own plate
     *  ("Check print result") and never locks the others (David, Nov 6: "i can see them but i can't click on them"). */
    val canSelectPlate: Boolean get() = !plates.isNullOrEmpty() && state != State.Printing && state != State.TouchingUp
    /** Print asks "I checked the printer" first: the last send, or the chosen plate's, may have reached it (the companion's rule). */
    val printNeedsCheck: Boolean get() = print?.uncertain == true || selectedPlate?.uncertain == true
    /** Terminal reports take precedence over stale progress while the project transition arrives. */
    val printEnded: Boolean get() = print?.live?.state in setOf("finished", "failed", "cancelled") ||
        print?.monitor?.phase == "ended" || state in setOf(State.Printed, State.Confirmed, State.Failed) ||
        ProjectWords.phase(this) in setOf(ProjectPhase.Printed, ProjectPhase.Confirmed, ProjectPhase.Failed)

    companion object {
        fun decode(o: JsonObject): Project? {
            val id = o["id"].str ?: return null
            val created = o["createdAtMs"].num ?: return null
            val updated = o["updatedAtMs"].num ?: return null
            val state = o["state"].str ?: return null
            return Project(
                id = id, createdAtMs = created, updatedAtMs = updated, state = State.of(state),
                instructions = o.opt("instructions"), scan = o.opt("scan"), photos = o.opt<List<String>>("photos") ?: emptyList(),
                capture = o.opt("capture"), captureDepth = o.opt("captureDepth"), progress = o.opt("progress"),
                passes = o.opt<List<Pass>>("passes") ?: emptyList(), current = o.opt("current"), question = o.opt("question"),
                failure = o.opt("failure"), canRetryCleanup = o.opt("canRetryCleanup"), print = o.opt("print"),
                printerDestinationId = o.opt("printerDestinationId"), printConfirmation = o.opt("printConfirmation"),
                status = o.opt("status"), title = o.opt("title"), kind = o.opt("kind"), ask = o.opt("ask"), settings = o.opt("settings"),
                outcome = o.opt("outcome"), archived = o.opt("archived"), credit = o["credit"].obj, files = o["files"].obj,
                pendingFollowup = o.opt("pendingFollowup"), messages = o.opt("messages"), pendingPhotos = o.opt("pendingPhotos"), plates = o.opt("plates"),
                reconstructionReview = o.opt("reconstructionReview"), raw = o,
            )
        }
    }

    @Serializable data class Message(val id: String, val text: String, val atMs: Double, val photos: List<String> = emptyList())
    @Serializable data class Settings(val status: String? = null, val archived: Boolean? = null, val printerDestinationId: String? = null,
                                      val designEngine: String? = null, val notifications: String? = null)
    /** The companion's state line (`ObjectStatus`). Show `text` as is. */
    /** `detail`: what a list row shows under its phase's heading or capsule, never the heading again. */
    @Serializable data class Status(val phase: String, val text: String, val symbol: String = "", val tint: String = "secondary", val detail: String? = null)
    @Serializable data class Activity(val atMs: Double, val kind: String, val text: String)
    @Serializable data class Stage(val id: String, val words: String, val startedAtMs: Double, val endedAtMs: Double? = null, val typicalSec: Double? = null)
    @Serializable data class Estimate(val remainingSec: Double, val endsAtMs: Double)
    @Serializable data class Change(val tag: String, val text: String, val toleranceMm: Double? = null)
    @Serializable data class Pass(
        val startedAtMs: Double, val endedAtMs: Double? = null, val note: String? = null, val status: String? = null,
        val summary: String? = null, val activityCount: Int? = null, val trigger: String? = null, val stages: List<Stage>? = null,
        val estimate: Estimate? = null, val engine: String? = null,
    ) { val currentStage: Stage? get() = stages?.lastOrNull { it.endedAtMs == null } }
    @Serializable data class Result(val model: String, val renders: List<String> = emptyList(), val sizeMm: List<Double>? = null,
                                    val summary: String? = null, val changes: List<Change>? = null, val engine: String? = null,
                                    /** This 3MF prints with the settings it carries (a designer's project), as its printer's MCP says. */
                                    val ownSettings: Boolean? = null,
                                    /** A fit's places for the scanned object, as its pass said (docs/protocols/seats.md). */
                                    val seats: List<Seat>? = null)
    /** The scan turned about the fixed X, then Y, then Z axes (`rotationDeg`), then moved (`translationMm`), into the part's frame. */
    @Serializable data class Seat(val name: String? = null, val translationMm: List<Double>, val rotationDeg: List<Double>)
    /** A spool a print used, as the printer MCP reported it when the print was sent. */
    @Serializable data class Spool(val index: Int? = null, val colour: String, val material: String? = null, val name: String? = null)
    @Serializable data class Question(val closeup: String? = null)
    @Serializable data class Region(val x: Double, val y: Double, val width: Double, val height: Double)
    @Serializable data class Ask(
        val id: String, val question: String, val type: String? = null, val url: String? = null, val options: List<Option>? = null,
        val photo: String? = null, val region: Region? = null, val answers: List<String> = emptyList(), val status: String = "open",
        val askedAtMs: Double? = null,
        /** closeup, file, choice, region, scale, sizes: what the project is waiting on the person for. */
        val kind: String? = null,
        /** `sizes`: the sizes to confirm or correct, prefilled. */
        val sizes: List<Size>? = null,
    ) {
        @Serializable data class Option(val id: String, val label: String, val detail: String? = null, val thumbnail: String? = null)
        /** One size in millimetres. `id` is opaque; `label` says what to measure; `from` is `scan` or `published`. */
        @Serializable data class Size(val id: String, val label: String, val mm: Double, val from: String = "scan")
    }
    @Serializable data class PrintDestination(val id: String, val name: String)
    @Serializable data class PrintEstimate(val seconds: Double? = null, val grams: Double? = null)
    @Serializable data class PrintMonitor(val phase: String, val startedAt: String? = null, val lastReportAt: String? = null,
                                          val unreachableSince: String? = null, val endState: String? = null, val endedAt: String? = null)
    @Serializable data class Print(
        val bundleId: String? = null, val uncertain: Boolean? = null, val destination: PrintDestination? = null,
        val estimate: PrintEstimate? = null, val printId: String? = null, val destinationId: String? = null,
        val dispatchedAt: String? = null, val jobName: String? = null, val live: PrintLive? = null, val monitor: PrintMonitor? = null,
        val sentVia: String? = null,
        /** The spools this print uses (PRD §5.4): the result is drawn in them. */
        val spools: List<Spool>? = null,
    )

    /** The project's picture (PRD §5.1): the object alone on the stage, as the computer drew it (`pictures/…png`). */
    val picture: String? get() = raw["picture"].str
    /** Each gallery picture the computer drew: `part`, `scan`, `together`, `photo`. */
    val pictures: Map<String, String> get() = raw["pictures"].obj?.mapNotNull { (key, value) -> value.str?.let { key to it } }?.toMap() ?: emptyMap()
    /** A picture the computer has not drawn, by role: `drawing`, or `failed` (none is coming until what it shows changes). */
    val pictureStates: Map<String, String> get() = raw["pictureStates"].obj?.mapNotNull { (key, value) -> value.str?.let { key to it } }?.toMap() ?: emptyMap()
}

/** The latest normalized printer report for a print (`PrintLive`). */
@Serializable
data class PrintLive(
    val state: String, val job: Job? = null, val observedAt: String? = null, val endsAt: String? = null, val temps: Temps? = null,
    val problems: List<Problem>? = null, val activeFilament: ActiveFilament? = null,
) {
    @Serializable data class ActiveFilament(val slot: String? = null, val material: String? = null, val color: String? = null)
    @Serializable data class Job(val name: String = "", val progress: Double? = null, val elapsedSec: Double? = null, val remainingSec: Double? = null,
                                 val layer: Int? = null, val totalLayers: Int? = null, val stage: String? = null)
    @Serializable data class Temperature(val actual: Double, val target: Double)
    @Serializable data class Temps(val nozzle: Temperature? = null, val bed: Temperature? = null, val chamber: Double? = null)
    @Serializable data class Problem(val code: String = "", val severity: String = "", val message: String = "")
}

/** The printer MCP's own question (MCP elicitation). Only an explicit answer to this id approves it. */
@Serializable
data class PrintConfirmation(val id: String, val message: String, val expiresAtMs: Double, val fields: List<Field> = emptyList(), val supported: Boolean = false) {
    @Serializable
    data class Field(
        val name: String, val title: String? = null, val description: String? = null, val required: Boolean = false,
        /** Absent means boolean. */
        val type: String? = null,
        @SerialName("enum") val enumValues: List<String>? = null, val enumNames: List<String>? = null,
        @SerialName("default") val defaultValue: JsonElement? = null,
        val minimum: Double? = null, val maximum: Double? = null, val minLength: Int? = null, val maxLength: Int? = null, val format: String? = null,
    ) {
        val kind: String get() = type ?: "boolean"
        val label: String get() = title ?: name
        val known: Boolean get() = kind in setOf("boolean", "string", "number", "integer")
        fun displayName(value: String): String {
            val i = enumValues?.indexOf(value) ?: -1
            return if (i >= 0 && enumNames != null && i < enumNames.size) enumNames[i] else value
        }
        /** True when `value` is the right type and within this field's limits. */
        fun accepts(value: JsonElement?): Boolean {
            val p = value as? JsonPrimitive ?: return false
            return when (kind) {
                "boolean" -> !p.isString && p.bool != null
                "string" -> {
                    if (!p.isString) return false
                    val text = p.content
                    if (enumValues != null && text !in enumValues) return false
                    val length = text.codePointCount(0, text.length)
                    if (minLength != null && length < minLength) return false
                    if (maxLength != null && length > maxLength) return false
                    matches(format, text)
                }
                "number", "integer" -> {
                    if (p.isString) return false
                    val n = p.num ?: return false
                    if (!n.isFinite() || (kind == "integer" && Math.rint(n) != n)) return false
                    if (minimum != null && n < minimum) return false
                    if (maximum != null && n > maximum) return false
                    true
                }
                else -> false
            }
        }
        /** A switch always starts off: a person ticks every printer check themselves. */
        val initialValue: JsonElement?
            get() = if (kind == "boolean") JsonPrimitive(false) else defaultValue?.takeIf { accepts(it) }

        private fun matches(format: String?, text: String): Boolean = when (format) {
            "email" -> Regex("""[^@\s]+@[^@\s]+\.[^@\s]+""").matches(text)
            "uri" -> try { java.net.URI(text).scheme != null } catch (_: Exception) { false }
            "date" -> Regex("""\d{4}-\d{2}-\d{2}""").matches(text) && try { java.time.LocalDate.parse(text).toString() == text } catch (_: Exception) { false }
            "date-time" -> Iso.parse(text) != null
            else -> true
        }
    }

    /** What the person gave; untouched fields fall back to the default (never for a switch); a cleared field (JSON null) stays cleared. */
    private fun given(f: Field, content: Map<String, JsonElement?>): JsonElement? {
        if (content.containsKey(f.name)) return content[f.name]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        return if (f.kind == "boolean") null else f.defaultValue
    }

    /** The app can show every field natively. Otherwise the question goes to the Mac (or Don't Print). */
    val isRenderable: Boolean get() = supported && fields.all { it.known }

    /** Every required field has a valid value; a required switch must be on. */
    fun canAccept(content: Map<String, JsonElement?>, nowMs: Long): Boolean {
        if (!isRenderable || expiresAtMs <= nowMs) return false
        return fields.all { f ->
            val value = given(f, content)
            if (value == null) !f.required
            else if (f.kind == "boolean" && f.required) value == JsonPrimitive(true)
            else f.accepts(value)
        }
    }

    /** The `print-confirmation` body. Switches the person left alone are sent as false. */
    fun response(action: String, content: Map<String, JsonElement?>, nowMs: Long): JsonObject? {
        if (expiresAtMs <= nowMs) return null
        if (action == "accept" && !canAccept(content, nowMs)) return null
        val answer = LinkedHashMap<String, JsonElement>()
        for (f in fields) {
            val value = given(f, content)
            if (value != null && f.accepts(value)) answer[f.name] = value
            else if (f.kind == "boolean") answer[f.name] = JsonPrimitive(false)
        }
        val inner = LinkedHashMap<String, JsonElement>()
        inner["action"] = JsonPrimitive(action)
        if (action == "accept") inner["content"] = JsonObject(answer)
        return JsonObject(mapOf("confirmationId" to JsonPrimitive(id), "answer" to JsonObject(inner)))
    }
}

/** The status a person sets on a project (PRD §5.4 Project Settings). */
enum class ProjectStatus(val wire: String, val label: String) {
    NotPrinted("not-printed", "Not printed"), Printed("printed", "Printed"), Works("works", "Done"),
    NeedsChanges("needs-changes", "Needs changes"), Archived("archived", "Archived");
    companion object {
        fun of(wire: String?) = entries.firstOrNull { it.wire == wire }
        val choices = listOf(NotPrinted, Printed, Works, NeedsChanges)
    }
}

/** A printer configured in the user's MCPs on the Mac (`GET /v1/objects/printers`). */
@Serializable
data class PrinterDestination(
    val id: String, val name: String, val backend: String = "", val model: String? = null, val address: String? = null,
    val source: String = "", val origin: String? = null, val state: String? = null, val stateCheckedAt: String? = null,
    val capabilities: Capabilities? = null, val mcpId: String? = null, val mcps: List<McpChoice>? = null,
) {
    @Serializable data class McpChoice(val backend: String, val destinationId: String)
    @Serializable
    data class Capabilities(
        val progress: Boolean = false, val layers: Boolean = false, val camera: String = "none", val filaments: String = "none",
        val pause: Boolean = false, val resume: Boolean = false, val cancel: Boolean = false, val quality: Boolean = false,
        val strength: Boolean = false, val copies: Boolean? = null, val materialChoice: Boolean? = null, val update: Update? = null,
        val layerPauses: Boolean? = null, val server: Server? = null,
    ) {
        @Serializable data class Update(val message: String = "", val latestVersion: String? = null)
        @Serializable data class Server(val name: String, val version: String)
    }

    val isBambu: Boolean get() = backend == "bambu-printer-mcp"
    val via: String get() = if (isBambu) "bambu-printer-mcp" else "mcp-3D-printer-server"
    val hasCamera: Boolean get() = capabilities?.let { it.camera != "none" } ?: isBambu
    val canPause: Boolean get() = capabilities?.pause ?: false
    val canResume: Boolean get() = capabilities?.resume ?: false
    val canCancel: Boolean get() = capabilities?.cancel ?: false
    val modelName: String get() = model ?: if (isBambu) "Bambu Lab printer" else "3D printer"
    val stateWords: String get() = when (state) {
        "ready" -> "Ready"; "busy" -> "Busy"; "offline" -> "Offline"; "printing" -> "Printing"; else -> "Not checked yet"
    }
}

@Serializable
data class PrinterCatalog(val destinations: List<PrinterDestination> = emptyList(), val defaultDestinationId: String = "") {
    fun destination(id: String?): PrinterDestination? = destinations.firstOrNull { it.id == (id ?: defaultDestinationId) }
}

/** A spool the printer reports (`GET /v1/objects/<id>/filaments`). */
@Serializable
data class PrinterFilament(val slot: Int, val colour: String = "#888888", val material: String = "", val name: String = "",
                           val filamentId: String = "", val destinationId: String = "", val suggested: Boolean? = null,
                           /** Where the spool sits, in the printer MCP's own words. */
                           val label: String? = null,
                           /** Which spools can feed one print together, as the printer MCP groups them. */
                           val feed: String? = null) {
    val isExternal: Boolean get() = slot >= 254
    /** The printer MCP's label for the spool; its material from an older Mac that doesn't send one. */
    val slotLabel: String get() = label ?: material
    /** The spool as a person reads it: the printer MCP's name ("Sunflower Yellow PLA Basic") once it sends a label. */
    val spoolName: String get() = if (label != null) name else "$material $displayName"
    /** "A2 · Sunflower Yellow PLA Basic", both the printer MCP's; the material and name from an older computer. */
    val title: String get() = label?.let { "$it · $name" } ?: spoolName
    val displayName: String get() {
        var text = name.replace(Regex("""\s*#[0-9a-fA-F]{6,8}\s*$"""), "").trim()
        val suffix = " $material"
        if (text.length > suffix.length && text.uppercase().endsWith(suffix.uppercase())) text = text.dropLast(suffix.length)
        return text.ifEmpty { material }
    }
    fun toJson(): JsonObject = JsonObject(mapOf("slot" to JsonPrimitive(slot), "colour" to JsonPrimitive(colour), "material" to JsonPrimitive(material),
        "name" to JsonPrimitive(name), "filamentId" to JsonPrimitive(filamentId), "destinationId" to JsonPrimitive(destinationId)))
}

/** One part of a multi-colour model with the spool the printer MCP proposes for it (`GET /v1/objects/<id>/colour-mapping`). */
@Serializable
data class ModelColourFilament(val index: Int, val name: String? = null, val colour: String? = null, val material: String? = null,
                               val slot: Int? = null, val verdict: String? = null, val note: String? = null)

/** A multi-colour model's parts and the printer's spools: which spool each part prints from, as the printer MCP proposes. */
@Serializable
data class ColourMapping(val filaments: List<ModelColourFilament> = emptyList(), val trays: List<PrinterFilament> = emptyList(),
                         val modelVersion: String? = null) {
    /** The MCP's proposal per part (part index → slot): where the sheet starts. */
    val proposedSlots: Map<Int, Int> get() = filaments.mapNotNull { f -> f.slot?.let { f.index to it } }.toMap()
    /** The chosen spool for every part, in the model's order; null until every part has one. */
    fun spools(slots: Map<Int, Int>): List<PrinterFilament>? {
        val chosen = filaments.map { f -> trays.firstOrNull { it.slot == slots[f.index] } }
        return if (filaments.isNotEmpty() && chosen.all { it != null }) chosen.filterNotNull() else null
    }
    /** The chosen spools come from more than one of the MCP's feeds: one print feeds from one. */
    fun mixesFeeds(slots: Map<Int, Int>): Boolean = slots.values.mapNotNull { slot -> trays.firstOrNull { it.slot == slot }?.feed }.toSet().size > 1
    /** What the person should know about a part's spool: the MCP's note while its proposal stands. */
    fun note(part: ModelColourFilament, slots: Map<Int, Int>): String? {
        if (slots[part.index] == part.slot && part.note != null) return part.note
        val tray = trays.firstOrNull { it.slot == slots[part.index] } ?: return null
        return if (part.material != null && !tray.material.equals(part.material, ignoreCase = true)) "Prints in ${tray.material}, not ${part.material}." else null
    }
}

/** `POST /v1/objects/<id>/estimate`. */
@Serializable
data class SliceEstimate(val destinationId: String = "", val quality: String = "standard", val strength: String = "standard",
                         val seconds: Double? = null, val grams: Double? = null, val layers: Int? = null, val slicerWarning: String? = null,
                         // What the printer MCP actually sliced with: the app never guesses slicer numbers (PRD §8.0).
                         val layerHeightMm: Double? = null, val wallLoops: Int? = null, val infillPercent: Double? = null,
                         // The sliced file this estimate made, and the printer MCP's pictures of that exact file (Nov 5).
                         val sliceSha256: String? = null, val preview: SlicePreview? = null,
                         // The installed printer MCP can't say whether this 3MF prints with its own settings: update it.
                         val ownSettingsUpdate: String? = null) {
    /** The slice Print may send: only one whose pictures are of that exact file. */
    val shownSlice: String? get() = sliceSha256?.takeIf { sha -> preview?.sha256 == sha && preview.views.isNotEmpty() }
}

/** `PrintEstimate.preview` (packages/contracts): base64 PNGs the printer MCP drew from the sliced G-code. */
@Serializable
data class SlicePreview(val sha256: String, val views: List<View> = emptyList(), val mmPerPixel: Double? = null) {
    @Serializable data class View(val name: String, val label: String, val png: String, val width: Int, val height: Int)
}

/** The print sheet's choices, sent as chosen; the printer MCP turns them into its slicer's settings. */
enum class PrintQuality(val wire: String, val title: String) {
    Draft("draft", "Draft"), Standard("standard", "Standard"), Fine("fine", "Fine")
}

enum class PrintStrength(val wire: String, val title: String) {
    Standard("standard", "Standard"), Strong("strong", "Strong"), Max("max", "Max")
}

/** Which filament a print uses (`colour` / `filament` in `POST …/print`). */
sealed class PrintColour {
    data class Tray(val filament: PrinterFilament) : PrintColour()
    data object Auto : PrintColour()
    data object External : PrintColour()
    data class Material(val material: String) : PrintColour()
}

/** What the print sheet sends with Print (CounterpartKit `PrintChoice.body`). */
data class PrintChoice(val colour: PrintColour? = null, val quality: PrintQuality = PrintQuality.Standard,
                       val strength: PrintStrength = PrintStrength.Standard, val checked: Boolean = false, val copies: Int? = null,
                       val pauseBeforeLayers: List<Int> = emptyList(), val sliceSha256: String? = null,
                       /** A multi-colour model: one spool per part, in the model's order, and the model version they were chosen for. */
                       val spools: List<PrinterFilament>? = null, val modelVersion: String? = null) {
    /** The estimate of these exact choices (no `checked`, no slice yet): it slices the file Print then sends. */
    fun estimateBody(destinationId: String?): JsonObject =
        JsonObject(body - "checked" - "sliceSha256" + listOfNotNull(destinationId?.let { "destinationId" to JsonPrimitive(it) }))

    val body: JsonObject get() {
        val json = LinkedHashMap<String, JsonElement>()
        json["checked"] = JsonPrimitive(checked)
        if (spools != null) {
            json["filaments"] = kotlinx.serialization.json.JsonArray(spools.map { it.toJson() })
            modelVersion?.let { json["filamentsModelVersion"] = JsonPrimitive(it) }
        } else when (colour) {
            is PrintColour.Tray -> json["filament"] = colour.filament.toJson()
            PrintColour.Auto -> json["colour"] = JsonObject(mapOf("auto" to JsonPrimitive(true)))
            PrintColour.External -> json["colour"] = JsonObject(mapOf("external" to JsonPrimitive(true)))
            is PrintColour.Material -> json["colour"] = JsonObject(mapOf("material" to JsonPrimitive(colour.material)))
            null -> {}
        }
        if (quality != PrintQuality.Standard) json["quality"] = JsonPrimitive(quality.wire)
        if (strength != PrintStrength.Standard) json["strength"] = JsonPrimitive(strength.wire)
        copies?.let { json["copies"] = JsonPrimitive(maxOf(1, it)) }
        if (pauseBeforeLayers.isNotEmpty()) {
            val pauses = pauseBeforeLayers.distinct().sorted()
            require(pauses.size <= 16 && pauses.all { it in 2..100_000 }) { "Choose up to 16 pause layers, starting at layer 2." }
            json["pauseBeforeLayers"] = kotlinx.serialization.json.JsonArray(pauses.map { JsonPrimitive(it) })
        }
        sliceSha256?.let { json["sliceSha256"] = JsonPrimitive(it) }
        return JsonObject(json)
    }
}

/** ISO 8601 dates with or without fractional seconds. */
object Iso {
    fun parse(text: String?): Long? {
        if (text == null) return null
        return try { OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli() } catch (_: Exception) { null }
    }
}
