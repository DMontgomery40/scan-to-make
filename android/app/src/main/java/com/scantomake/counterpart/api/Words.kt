package com.scantomake.counterpart.api

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/** Size, time and grams, written the same way on every screen. Port of CounterpartKit `Format`. */
object Format {
    fun size(mm: List<Double>?): String? {
        if (mm == null || mm.size != 3 || !mm.all { it.isFinite() && it >= 0 }) return null
        return mm.joinToString(" × ") { it.roundToInt().toString() } + " mm"
    }

    fun duration(seconds: Double?): String? {
        if (seconds == null || !seconds.isFinite() || seconds < 0) return null
        if (seconds < 60) return "${seconds.roundToInt()} s"
        val minutes = (seconds / 60).roundToInt()
        if (minutes < 60) return "$minutes min"
        val hours = minutes / 60
        val rest = minutes % 60
        return if (rest == 0) "$hours h" else "$hours h $rest m"
    }

    fun about(seconds: Double?): String? {
        if (seconds == null || !seconds.isFinite() || seconds < 0) return null
        if (seconds < 60) return "less than a minute"
        return "about " + (duration(seconds) ?: "")
    }

    fun grams(g: Double?): String? {
        if (g == null || !g.isFinite() || g < 0) return null
        return if (g < 10) String.format(Locale.US, "%.1f g", g) else "${g.roundToInt()} g"
    }

    fun percent(value: Double?): String? {
        if (value == null || !value.isFinite()) return null
        return "${kotlin.math.floor(value.coerceIn(0.0, 100.0)).toInt()}%"
    }

    fun temperature(c: Double?): String? = if (c == null || !c.isFinite()) null else "${c.roundToInt()} °C"

    fun `when`(atMs: Long, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        val seconds = (nowMs - atMs) / 1000.0
        if (seconds < 60) return "Now"
        if (seconds < 3600) return "${(seconds / 60).toInt()} min ago"
        val day = Instant.ofEpochMilli(atMs).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        if (day == today) return "${(seconds / 3600).toInt()} h ago"
        if (day == today.minusDays(1)) return "Yesterday"
        return DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()).format(day)
    }

    fun whenInSentence(atMs: Long, nowMs: Long = System.currentTimeMillis()): String = when (val w = `when`(atMs, nowMs)) {
        "Now" -> "just now"; "Yesterday" -> "yesterday"; else -> w
    }

    fun clock(atMs: Long): String = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()).format(Instant.ofEpochMilli(atMs).atZone(ZoneId.systemDefault()))

    fun ago(atMs: Long, nowMs: Long = System.currentTimeMillis()): String {
        val s = maxOf(0L, (nowMs - atMs) / 1000)
        return if (s < 60) "$s s ago" else "${s / 60} min ago"
    }
}

/** The PRD §4 project states, as the screens show them. Port of CounterpartKit `ProjectPhase`. */
enum class ProjectPhase(val wire: String, val label: String, val tone: Tone) {
    Draft("draft", "Not sent yet", Tone.Secondary),
    Sending("sending", "Sending to your computer", Tone.Working),
    Working("working", "Your computer is working", Tone.Working),
    NeedsYou("needs-you", "Needs you", Tone.NeedsYou),
    Ready("ready", "Ready to print", Tone.Accent),
    Preparing("preparing", "Getting the print ready", Tone.Accent),
    Printing("printing", "Printing", Tone.Printing),
    Printed("printed", "Printed", Tone.Secondary),
    Sent("sent", "Sent to your printer", Tone.Secondary),
    Confirmed("confirmed", "Done", Tone.Printing),
    Failed("failed", "Couldn't finish", Tone.Failed),
    Unknown("unknown", "Update Counterpart", Tone.Secondary);

    val isRunning: Boolean get() = this in setOf(Sending, Working, Preparing, Printing)

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } }
}

enum class Tone { Working, NeedsYou, Accent, Printing, Secondary, Failed }

enum class ProjectAction { FinishSending, Scan, AttachPhotos, MakeIt, Print, PrintChecked, Correct, OpenCamera, BestGuess, Retry, ItWorks, NeedsChanges }

/** A project in plain words: the one source of status words. Port of CounterpartKit `ProjectWords`. */
class ProjectWords(project: Project, sending: Boolean = false, printerName: String? = null, nowMs: Long = System.currentTimeMillis()) {
    val title: String = title(project)
    val phase: ProjectPhase = phase(project, sending)
    val status: String
    val line: String
    val busy: Boolean
    val size: String? = Format.size(project.current?.sizeMm)
    val actions: List<ProjectAction>

    companion object {
        const val WAIT = "You can leave this project and return to it while your computer works."
        const val PUT_DOWN = "You can put your phone down. We'll let you know when it's ready."
        const val DONE_LINE = "Done · it works"

        fun outcomeQuestion(project: Project) = if (project.kind == "published") "Did it come out right?" else "Did it fit?"

        fun title(project: Project): String {
            project.title?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            val text = (project.instructions ?: "").trim()
            if (text.isEmpty()) {
                if (project.hasScan) return "Copy of your scan"
                return if (project.photos.isEmpty()) "Unfinished project" else "Photo project"
            }
            var first = text.split("\n")[0]
            Regex("""[.!?](\s|$)""").find(first)?.let { first = first.substring(0, it.range.first) }
            if (first.length <= 44) return first
            val cut = first.take(43)
            val word = cut.lastIndexOf(' ').let { if (it >= 0) cut.substring(0, it) else cut }
            return word.trim() + "…"
        }

        fun phase(project: Project, sending: Boolean = false): ProjectPhase {
            if (project.state == Project.State.New) return if (sending) ProjectPhase.Sending else ProjectPhase.Draft
            if (project.projectStatus == ProjectStatus.Works &&
                project.state in setOf(Project.State.Ready, Project.State.Printed, Project.State.Confirmed) && project.printConfirmation == null &&
                (project.state == Project.State.Confirmed || project.print?.uncertain != true)) return ProjectPhase.Confirmed
            ProjectPhase.of(project.status?.phase)?.let { return it }
            if (project.status == null && project.printConfirmation != null) return ProjectPhase.NeedsYou
            return when (project.state) {
                Project.State.New -> if (sending) ProjectPhase.Sending else ProjectPhase.Draft
                Project.State.TouchingUp -> ProjectPhase.Working
                Project.State.NeedsCloseup -> ProjectPhase.NeedsYou
                Project.State.Ready -> ProjectPhase.Ready
                Project.State.Printing -> {
                    val p = project.print
                    if (p?.monitor?.phase == "watching" || (p?.printId != null && (p.live?.state ?: "") in setOf("printing", "paused"))) ProjectPhase.Printing
                    else ProjectPhase.Preparing
                }
                Project.State.Printed -> if (project.print?.monitor?.endState == "done") ProjectPhase.Printed else ProjectPhase.Sent
                Project.State.Sent -> ProjectPhase.Sent
                Project.State.Confirmed -> ProjectPhase.Confirmed
                Project.State.Failed -> ProjectPhase.Failed
                Project.State.Unknown -> ProjectPhase.Unknown
            }
        }

        /** What reached the Mac, in a few words. */
        fun sentLine(project: Project): String {
            val photos = project.photos.size
            val photoWords = if (photos == 1) "1 photo" else "$photos photos"
            return when {
                project.hasScan && photos == 0 -> "A scan"
                project.hasScan -> "A scan and $photoWords"
                photos == 0 -> "Just the description"
                else -> photoWords.replaceFirstChar { it.uppercase() }
            }
        }

        fun question(project: Project): String {
            project.openAsk?.question?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            val part = (project.question?.closeup ?: "").trim()
            return "Can you send me a close-up of ${part.ifEmpty { "the part I missed" }}? I can't see what's happening there."
        }

        /** The Printing screen (camera, Pause, Stop) is the place for this project. */
        fun watchable(project: Project, phase: ProjectPhase): Boolean {
            if (phase == ProjectPhase.Printing) return true
            val print = project.print ?: return false
            if (phase != ProjectPhase.Preparing || print.dispatchedAt == null) return false
            return (print.monitor?.phase ?: "") in setOf("starting", "watching")
        }

        fun workingLine(project: Project, fallback: String, nowMs: Long = System.currentTimeMillis()): String {
            val pass = project.runningPass ?: return fallback
            val stage = pass.currentStage?.words ?: fallback
            val estimate = pass.estimate ?: return stage
            val left = estimate.endsAtMs / 1000 - nowMs / 1000.0
            return listOfNotNull(stage, Format.about(maxOf(60.0, left))).joinToString(" · ")
        }
    }

    init {
        val made = if (project.current == null) emptyList() else listOf(if (project.printNeedsCheck) ProjectAction.PrintChecked else ProjectAction.Print, ProjectAction.Correct)
        val again = if (project.current == null) emptyList() else listOf(ProjectAction.Print, ProjectAction.Correct)
        var s: String
        var b: Boolean
        var a: List<ProjectAction>
        var l: String
        if (phase == ProjectPhase.Confirmed && project.state != Project.State.Confirmed) {
            s = "It works."; b = false; a = again; l = DONE_LINE
        } else when (project.state) {
            Project.State.New -> {
                if (sending) { s = "Sending to your computer. Keep the app open until it finishes."; b = true; a = emptyList() }
                else if (project.hasScan || project.photos.isNotEmpty()) { s = "Draft saved. Finish sending to begin."; b = false; a = listOf(ProjectAction.FinishSending) }
                else {
                    val described = (project.instructions ?: "").isNotBlank()
                    s = "Add photos or a scan."; b = false
                    a = if (described) listOf(ProjectAction.Scan, ProjectAction.AttachPhotos, ProjectAction.MakeIt) else listOf(ProjectAction.Scan, ProjectAction.AttachPhotos)
                }
                l = if (sending) phase.label else if (project.hasScan || project.photos.isNotEmpty()) "Draft saved · finish sending to begin" else "Add photos or a scan"
            }
            Project.State.TouchingUp -> {
                val progress = (project.progress ?: "").trim()
                if (progress.isNotEmpty()) { s = "${project.progress} $WAIT"; b = true; a = emptyList(); l = workingLine(project, project.progress!!) }
                else {
                    val what = if (project.passes.size > 1 && project.current != null) "Making your changes." else if (project.scan != null) "Touching up your scan." else "Making it."
                    s = "$what $WAIT"; b = true; a = emptyList(); l = workingLine(project, what.dropLast(1))
                }
            }
            Project.State.NeedsCloseup -> {
                s = question(project); b = false; a = listOf(ProjectAction.OpenCamera, ProjectAction.AttachPhotos, ProjectAction.BestGuess)
                l = "Needs you · " + (project.openAsk?.question ?: project.question?.closeup?.let { "a close-up of $it" } ?: "a close-up")
            }
            Project.State.Ready -> { s = "Ready to print"; b = false; a = made; l = listOfNotNull("Ready to print", size).joinToString(" · ") }
            Project.State.Printing -> {
                if (project.printConfirmation != null) { s = "Your printer needs your confirmation."; b = true; a = emptyList(); l = "Your printer needs a yes" }
                else if (phase == ProjectPhase.Printing) {
                    val printer = printerName ?: project.print?.destination?.name ?: "your printer"
                    val live = project.print?.live
                    l = listOfNotNull("Printing on $printer", Format.percent(live?.job?.progress), Format.duration(live?.job?.remainingSec)?.let { "$it left" }).joinToString(" · ")
                    if (live?.state == "paused") l = "Paused on $printer"
                    if (project.print?.monitor?.unreachableSince != null) l = "Lost contact with $printer. Still trying."
                    s = l; b = true; a = emptyList()
                } else { s = project.progress ?: "Preparing print…"; b = true; a = emptyList(); l = project.progress ?: "Getting the print ready" }
            }
            Project.State.Printed -> {
                val finished = project.print?.monitor?.endState == "done"
                val endedAt = Iso.parse(project.print?.monitor?.endedAt) ?: project.updatedAtMs.toLong()
                val ask = finished && project.projectStatus in setOf(null, ProjectStatus.Printed)
                s = if (finished) "Printed" else "Print request accepted"; b = false
                a = if (ask) listOf(ProjectAction.ItWorks, ProjectAction.NeedsChanges) + made else made
                l = if (finished) "Printed " + Format.whenInSentence(endedAt, nowMs) else "Sent to " + (project.print?.destination?.name ?: "your printer")
            }
            Project.State.Confirmed -> { s = "It works."; b = false; a = again; l = DONE_LINE }
            Project.State.Sent -> {
                val printer = printerName ?: project.print?.destination?.name ?: "your printer"
                if (project.print?.sentVia == "bambu-connect") {
                    s = "Finish on your computer: press Print in Bambu Connect."; l = "Finish on your computer: press Print in Bambu Connect"
                } else { s = "Sent to $printer. Counterpart can't follow this print."; l = "Sent to $printer · Counterpart can't follow this print" }
                b = false; a = made
            }
            Project.State.Failed -> {
                val failure = (project.failure ?: "").trim()
                val recovery = if (made.isEmpty()) listOf(ProjectAction.Retry, ProjectAction.Correct)
                    else if (project.canRetryCleanup == true) listOf(ProjectAction.Retry) + made else made
                s = failure.ifEmpty { "Something went wrong on your computer." }; b = false; a = recovery
                l = if (failure.isEmpty()) "Didn't finish · try again" else failure.split(". ").first()
            }
            Project.State.Unknown -> { s = "Update Counterpart to see this one."; b = false; a = emptyList(); l = "Update Counterpart to see this one" }
        }
        status = s; busy = b; actions = a
        // The Mac's own words win when it writes them, except while this phone is still sending.
        val mac = project.status?.takeIf { it.text.isNotEmpty() && project.state != Project.State.New }
        line = if (mac != null && !(phase == ProjectPhase.Confirmed && mac.phase != ProjectPhase.Confirmed.wire)) mac.text else l
    }
}
