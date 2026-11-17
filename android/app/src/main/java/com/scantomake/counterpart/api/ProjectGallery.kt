package com.scantomake.counterpart.api

import java.util.Locale

/**
 * The pictures at the top of a project's page (PRD §5.4 Pictures), derived from its data, in order. Port of
 * CounterpartKit `ProjectGallery`; both read `packages/contracts/fixtures/project-gallery.json`.
 */
data class ProjectGallery(val entries: List<Entry>) {
    enum class Kind(val wire: String) { Part("part"), Plate("plate"), Together("together"), Scan("scan") }

    sealed interface Drawing {
        /** A model to turn, at a project path. */
        data class Model(val path: String) : Drawing
        /** A still: a render, a designer's plate picture. */
        data class Picture(val path: String) : Drawing
        /** The part with the scanned object in each seat. */
        data class Assembly(val part: String, val obj: String, val seats: List<Project.Seat>) : Drawing
        /** #691: a multi-part design, each part's mesh in its own colour (neutral when it has none), all in one frame. */
        data class Parts(val parts: List<DrawnPart>) : Drawing
    }

    /** One mesh of a [Drawing.Parts] and the colour the MCP or the pass gave it ([Colour.Spool]), else [Colour.Neutral]. */
    data class DrawnPart(val mesh: String, val colour: Colour)

    sealed interface Colour {
        data object Neutral : Colour
        data class Spool(val hex: String) : Colour
        data object Own : Colour
    }

    data class Entry(
        val id: String, val kind: Kind, val label: String, val drawing: Drawing, val colour: Colour,
        /** The size chip's word for what it measures. */
        val measures: String, val sizeMm: List<Double>? = null, val photos: List<String> = emptyList(),
    ) {
        /** "Part · 213 × 43 × 82 mm" when the size is known. */
        fun sizeText(measured: List<Double>? = null): String? = sizeWords(measured ?: sizeMm)?.let { "$measures · $it" }

        /**
         * What the stage's AR opens for this entry, as a project path (CounterpartKit `ProjectGallery.Entry.ar`, #840): the
         * one rule every client derives from the project's own state. A part that turns in 3D offers the STL its stage turns,
         * a scan its own USDZ; Together, a plate, a part shown as a picture and a handheld STL scan offer none. Android shows
         * no AR control (PRD §6.1). For the shared cases the value is the iPhone's; the iPhone alone also reads a scan's file
         * sizes and names the phone's preview under a too-large rebuild, which Android, with no AR control, has no use for.
         */
        val ar: String?
            get() {
                // #845: a design drawn part by part (a part, or a kit's plate) opens AR from its parts; `ar` names the first.
                if (kind == Kind.Part || kind == Kind.Plate) (drawing as? Drawing.Parts)?.let { return it.parts.firstOrNull()?.mesh }
                val path = (drawing as? Drawing.Model)?.path ?: return null
                val lower = path.lowercase(Locale.ROOT)
                return when (kind) {
                    Kind.Part -> path.takeIf { lower.endsWith(".stl") }
                    Kind.Scan -> path.takeIf { lower.endsWith(".usdz") }
                    else -> null
                }
            }
    }

    val first: Entry? get() = entries.firstOrNull()

    companion object {
        /** `parts` is the seam a project's part list (designed separately) will feed; today it is [printableParts]. */
        fun of(project: Project, parts: List<PrintablePart> = printableParts(project), scanOnThisDevice: Boolean = false): ProjectGallery {
            val entries = parts.map { Entry(it.id, if (it.isPlate) Kind.Plate else Kind.Part, it.label, it.drawing, it.colour, if (it.isPlate) "Plate" else "Part", it.sizeMm) }.toMutableList()
            val scans = scanModels(project, scanOnThisDevice)
            val part = parts.singleOrNull()
            val seats = project.current?.seats.orEmpty()
            // Only where it is drawn right today: a USDZ scan. A handheld STL scan gets no Together until the project carries its frame.
            if (part != null && seats.isNotEmpty() && scans.isNotEmpty() && scans[0].lowercase(Locale.ROOT).endsWith(".usdz")) {
                val turns = part.drawing is Drawing.Model || part.drawing is Drawing.Parts
                // A copy's Together is the part in the scan's place (#691, CounterpartKit): the part as it is drawn, never
                // the scan drawn over it. A fit's is the part (its merged mesh, when drawn part by part) with the object in each seat.
                val model = (part.drawing as? Drawing.Model)?.path ?: (part.drawing as? Drawing.Parts)?.let { partMesh(project) }
                if (turns && project.kind == "copy") entries += Entry("together", Kind.Together, "Together", part.drawing, part.colour, "Together")
                else if (model != null) entries += Entry("together", Kind.Together, "Together", Drawing.Assembly(model, scans[0], seats), part.colour, "Together")
            }
            scans.forEachIndexed { index, scan ->
                entries += Entry("scan-$index", Kind.Scan, if (scans.size > 1) "Scan ${index + 1}" else "What you scanned", Drawing.Model(scan), Colour.Own, "Scan",
                    photos = scanPhotos(project))
            }
            // A copy leads with the scanned object in its own colours (the mockup's potato) until its result is drawn in its
            // real colours: a spool chosen, or (#858) the printer MCP's parts carrying theirs. The companion's `copyLeadsWithScan`.
            if (copyLeadsWithScan(project)) entries.indexOfFirst { it.kind == Kind.Scan }.takeIf { it > 0 }?.let { entries.add(0, entries.removeAt(it)) }
            return ProjectGallery(entries)
        }

        /** Whether a copy still leads with its scan: no spool chosen, and no part with its own colour yet (#858, #691). */
        fun copyLeadsWithScan(project: Project): Boolean =
            project.kind == "copy" && spoolColour(project) == null && project.current?.parts.orEmpty().none { it.colour?.let(::hex) != null }

        fun printableParts(project: Project): List<PrintablePart> {
            val plates = project.plates.orEmpty()
            // Every plate the file has is an entry; one whose picture the MCP didn't send shows the placeholder (""). With the
            // file's parts meshed (#691), a plate turns in 3D, its own parts in their colours (CounterpartKit).
            if (plates.size > 1) return plates.mapIndexed { index, plate ->
                val drawn = drawnParts(project, plate = index)
                PrintablePart("plate-${plate.id}", plate.name.ifEmpty { "Plate ${index + 1}" }, drawn?.let { Drawing.Parts(it) } ?: Drawing.Picture(plate.thumbnail ?: ""), Colour.Own, isPlate = true)
            }
            val current = project.current ?: return emptyList()
            val label = when (project.kind) { "copy" -> "Your copy"; "published" -> "Model"; else -> "Your part" }
            // #691: a multi-part design whose parts the printer MCP meshed turns part by part, each in its own colour.
            // A designer's kit shows the plate it prints (`publishedSelection.plateIndex`).
            val plate = if (project.kind == "published") (project.raw["publishedSelection"] as? kotlinx.serialization.json.JsonObject)?.get("plateIndex")
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() } else null
            drawnParts(project, plate)?.let { return listOf(PrintablePart("result", label, Drawing.Parts(it), Colour.Own, current.sizeMm)) }
            val mesh = partMesh(project)
            if (mesh == null) {
                // A designer's 3MF has no merged mesh: the Mac's drawing of all the file's objects first, as on the other
                // clients (Nov 10). Always an entry (review B2 on #539): with no picture yet ("") the stage says it is coming or that it can't be had.
                val render = project.pictures["part"] ?: current.renders.firstOrNull()?.let(::renderPath) ?: plates.firstOrNull()?.thumbnail ?: ""
                return listOf(PrintablePart("result", label, Drawing.Picture(render), Colour.Own, current.sizeMm))
            }
            // A multi-part design turns from its merged mesh, neutral until the MCPs report each part's colour (#769, #645).
            val multipart = current.model.lowercase(Locale.ROOT).endsWith(".3mf")
            return listOf(PrintablePart("result", label, Drawing.Model(mesh), if (multipart) Colour.Neutral else spoolColour(project)?.let { Colour.Spool(it) } ?: Colour.Neutral, current.sizeMm))
        }

        /**
         * The mesh the part's stage turns (CounterpartKit `Project.partMesh`, #769): `model.stl` for a one-colour design, a
         * sealed design's own file (`versions/<id>/touched.stl`), or the merged `model.stl` a pass writes beside a multi-part
         * design's 3MF (`current/model.stl`, `versions/<id>/model.stl`), only when the computer lists it (`mergedMesh`, review
         * of #770). Null for a designer's published 3MF, or a 3MF whose merged mesh isn't listed: its picture.
         */
        fun partMesh(project: Project): String? {
            val model = project.current?.model ?: return null
            // Neither an STL nor a 3MF (#840): `model.stl` would serve bytes no stage can turn, so its picture stands for it.
            if (!model.lowercase(Locale.ROOT).endsWith(".3mf")) return if (!model.lowercase(Locale.ROOT).endsWith(".stl")) null else if (model.startsWith("versions/")) model else "model.stl"
            if (project.kind == "published" || !(model.startsWith("current/") || model.startsWith("versions/"))) return null
            return versionMesh(model).takeIf { it == project.current?.mergedMesh }
        }

        /**
         * What the stage turns for a multi-part design (#691; packages/contracts/fixtures/project-parts.json `draw`): each
         * part's mesh with its own colour, or neutral for a part with none. Only `plate`'s parts (0-based) when one is given;
         * a part with no plate is on every plate. Null without parts: the merged mesh turns, neutral, as before.
         */
        fun drawnParts(project: Project, plate: Int? = null): List<DrawnPart>? {
            val parts = project.current?.parts.orEmpty()
            if (parts.isEmpty()) return null
            val shown = parts.filter { plate == null || it.plate == null || it.plate == plate }
            return shown.map { DrawnPart(it.mesh, it.colour?.let(::hex)?.let { c -> Colour.Spool(c) } ?: Colour.Neutral) }.ifEmpty { null }
        }

        /** The one spool the result prints in: the last print's spools, else the colour the printer reported printing it. */
        fun spoolColour(project: Project): String? {
            val spools = project.print?.spools
            if (!spools.isNullOrEmpty()) return if (spools.map { hex(it.colour) }.toSet().size == 1) hex(spools[0].colour) else null
            return project.print?.live?.activeFilament?.color?.let(::hex)
        }

        fun scanModels(project: Project, onThisDevice: Boolean = false): List<String> {
            val scan = project.scan
            if (scan != null && scan.substringAfterLast('.').lowercase(Locale.ROOT) in setOf("usdz", "usdc", "usda", "stl")) return listOf("scan/$scan")
            return if (onThisDevice) listOf("scan/scan.usdz") else emptyList()
        }

        fun scanPhotos(project: Project): List<String> =
            if (project.photos.isEmpty()) project.capture.orEmpty().map { "capture/$it" } else project.photos.map { "photos/$it" }

        /** A sealed design's mesh (#616): its STL, or for a multi-part design the merged STL sealed beside its 3MF. */
        fun versionMesh(model: String): String =
            if (!model.lowercase(Locale.ROOT).endsWith(".3mf")) model else (model.split("/").dropLast(1) + "model.stl").joinToString("/")

        /** A render's project path; a sealed design's renders keep their own folder (`versions/<id>/renders/…`). */
        fun renderPath(render: String) = if (render.startsWith("versions/")) render else "renders/${render.substringAfterLast('/')}"

        fun hex(text: String): String? {
            val digits = text.trim().removePrefix("#")
            if (digits.length < 6 || digits.take(6).toIntOrNull(16) == null) return null
            return "#" + digits.take(6).uppercase(Locale.ROOT)
        }

        private fun sizeWords(mm: List<Double>?): String? {
            if (mm == null || mm.size != 3 || mm.any { !it.isFinite() || it < 0 }) return null
            return mm.joinToString(" × ") { v -> if (v > 0 && v < 0.05) "<0.1" else String.format(Locale.US, "%.1f", v).removeSuffix(".0") } + " mm"
        }
    }
}

/** One thing that will print, as the gallery shows it: today the result or a designer's plate; a part list's parts later. */
data class PrintablePart(
    val id: String, val label: String, val drawing: ProjectGallery.Drawing, val colour: ProjectGallery.Colour,
    val sizeMm: List<Double>? = null, val isPlate: Boolean = false,
)

/**
 * The project's picture everywhere (Home, search, notifications): the gallery's first entry drawn as the object alone on
 * the stage by the computer (`picture`); until then a designer's plate or a design's render; never a photo of the room
 * (David, Nov 10). Null shows the placeholder.
 */
fun Project.picturePath(): String? = picture ?: selectedPlate?.thumbnail ?: plates?.firstOrNull()?.thumbnail
    ?: current?.renders?.firstOrNull()?.let(ProjectGallery::renderPath)

/** The page's picture while the gallery is empty (photos sent, no model yet): the subject the computer cut out of the photo. */
fun Project.photoPicture(): String? = pictures["photo"]

/** The computer's picture of one gallery entry. Null when there is none yet ([still] says whether one is coming). */
fun Project.pictureFor(entry: ProjectGallery.Entry): String? = when (entry.kind) {
    ProjectGallery.Kind.Part -> (entry.drawing as? ProjectGallery.Drawing.Picture)?.path ?: pictures["part"] ?: current?.renders?.firstOrNull()?.let(ProjectGallery::renderPath)
    // A plate drawn by its parts (#691) keeps its own picture as the still until they are here.
    ProjectGallery.Kind.Plate -> (entry.drawing as? ProjectGallery.Drawing.Picture)?.path ?: plates?.firstOrNull { "plate-${it.id}" == entry.id }?.thumbnail
    ProjectGallery.Kind.Together -> pictures["together"]
    ProjectGallery.Kind.Scan -> pictures["scan"] ?: pictures["photo"]
}?.ifEmpty { null }

/**
 * What the stage shows for an entry while no model is drawn (CounterpartKit `Project.still(for:)`): its own picture, or
 * that one is coming, or that none can be had. A picture of something else never stands in for it.
 */
sealed interface Still {
    data class Picture(val path: String) : Still
    /** None yet, and one is coming: the computer hasn't drawn it. */
    data object Waiting : Still
    /** None is coming: the computer's drawing failed, or a designer's plate came without its picture. */
    data object NotAvailable : Still
}

fun Project.still(entry: ProjectGallery.Entry): Still {
    pictureFor(entry)?.let { return Still.Picture(it) }
    val role = when (entry.kind) {
        ProjectGallery.Kind.Part -> "part"
        ProjectGallery.Kind.Together -> "together"
        ProjectGallery.Kind.Scan -> "scan"
        ProjectGallery.Kind.Plate -> return Still.NotAvailable
    }
    return if (pictureStates[role] == "failed") Still.NotAvailable else Still.Waiting
}

/**
 * A part made to fit a scanned object, made before passes said where it sits: the computer can find it. Only for a USDZ
 * scan, the one frame Together is drawn in today (PRD §6.1).
 */
val Project.canLocate: Boolean get() = kind == "fit" && scan?.lowercase(Locale.ROOT)?.endsWith(".usdz") == true && current != null &&
    current.model.lowercase(Locale.ROOT).endsWith(".stl") && current.seats.isNullOrEmpty() &&
    state != Project.State.Printing && state != Project.State.TouchingUp

/**
 * The colour the stage's material draws a spool in (CounterpartKit `StageMaterial`): the stage stays dark (#22242B)
 * for every part, and a dark filament is lifted to a minimum brightness of 0.20 — the Mac's still pictures' floor —
 * so black is charcoal, never a silhouette. Neutral and own colours pass through; a spool's real colour still shows
 * in swatches and names.
 */
fun drawnColour(colour: ProjectGallery.Colour): ProjectGallery.Colour = when (colour) {
    is ProjectGallery.Colour.Spool -> ProjectGallery.Colour.Spool(drawnColour(colour.hex))
    else -> colour
}

/** The stage's neutral material, the same grey on every layout (Linux `ModelStage`, CounterpartKit `StageMaterial`). */
const val NEUTRAL_MATERIAL = "#94949A"

/**
 * #691, #706: the colour the stage draws one part of a multi-part design in, as 0–1 RGB: its spool through the dark-part
 * floor ([drawnColour]), so a black part is charcoal on the dark stage, or the neutral material when it has none.
 */
fun stageRgb(colour: ProjectGallery.Colour): FloatArray {
    val hex = (drawnColour(colour) as? ProjectGallery.Colour.Spool)?.hex ?: NEUTRAL_MATERIAL
    val value = hex.removePrefix("#").take(6).toIntOrNull(16) ?: NEUTRAL_MATERIAL.removePrefix("#").toInt(16)
    return floatArrayOf(((value shr 16) and 255) / 255f, ((value shr 8) and 255) / 255f, (value and 255) / 255f)
}

fun drawnColour(hex: String): String {
    if (!Regex("^#[0-9A-Fa-f]{6}$").matches(hex)) return hex
    val value = hex.substring(1).toInt(16)
    val rgb = doubleArrayOf(((value shr 16) and 255) / 255.0, ((value shr 8) and 255) / 255.0, (value and 255) / 255.0)
    val floor = 0.20
    val brightness = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    if (brightness < floor) {
        val lift = (floor - brightness) / floor
        doubleArrayOf(1.0, 1.01, 1.04).forEachIndexed { i, m -> rgb[i] += lift * floor * m }
    }
    return "#" + rgb.joinToString("") { String.format(Locale.ROOT, "%02X", Math.round(it.coerceIn(0.0, 1.0) * 255).toInt()) }
}
