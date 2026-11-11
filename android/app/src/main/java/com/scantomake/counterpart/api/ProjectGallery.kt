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
    }

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
            if (part != null && part.drawing is Drawing.Model && seats.isNotEmpty() && scans.isNotEmpty() && scans[0].lowercase(Locale.ROOT).endsWith(".usdz"))
                entries += Entry("together", Kind.Together, "Together", Drawing.Assembly(part.drawing.path, scans[0], seats), part.colour, "Together")
            scans.forEachIndexed { index, scan ->
                entries += Entry("scan-$index", Kind.Scan, if (scans.size > 1) "Scan ${index + 1}" else "What you scanned", Drawing.Model(scan), Colour.Own, "Scan",
                    photos = scanPhotos(project))
            }
            // A copy before a spool is chosen leads with the scanned object in its own colours (the mockup's potato).
            if (project.kind == "copy" && spoolColour(project) == null) entries.indexOfFirst { it.kind == Kind.Scan }.takeIf { it > 0 }?.let { entries.add(0, entries.removeAt(it)) }
            return ProjectGallery(entries)
        }

        fun printableParts(project: Project): List<PrintablePart> {
            val plates = project.plates.orEmpty()
            // Every plate the file has is an entry; one whose picture the MCP didn't send shows the placeholder ("").
            if (plates.size > 1) return plates.mapIndexed { index, plate ->
                PrintablePart("plate-${plate.id}", plate.name.ifEmpty { "Plate ${index + 1}" }, Drawing.Picture(plate.thumbnail ?: ""), Colour.Own, isPlate = true)
            }
            val current = project.current ?: return emptyList()
            val label = when (project.kind) { "copy" -> "Your copy"; "published" -> "Model"; else -> "Your part" }
            if (current.model.lowercase(Locale.ROOT).endsWith(".3mf")) {
                // The Mac's drawing of all the file's objects first, as on the other clients (Nov 10).
                // Always an entry (review B2 on #539): with no picture yet ("") the stage says it is coming or that it can't be had.
                val render = project.pictures["part"] ?: current.renders.firstOrNull()?.let(::renderPath) ?: plates.firstOrNull()?.thumbnail ?: ""
                return listOf(PrintablePart("result", label, Drawing.Picture(render), Colour.Own, current.sizeMm))
            }
            return listOf(PrintablePart("result", label, Drawing.Model("model.stl"), spoolColour(project)?.let { Colour.Spool(it) } ?: Colour.Neutral, current.sizeMm))
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

        fun renderPath(render: String) = "renders/${render.substringAfterLast('/')}"

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
    ProjectGallery.Kind.Plate -> (entry.drawing as? ProjectGallery.Drawing.Picture)?.path
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
