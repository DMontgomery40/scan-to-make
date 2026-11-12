package com.scantomake.counterpart.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A sealed design of a project (#616), oldest first in `versions`: each finished pass that produced a printable model,
 * kept beside the others and never overwritten. Port of CounterpartKit `Project.DesignVersion`.
 */
@Serializable
data class DesignVersion(
    val id: String, val sealedAtMs: Double, val passStartedAtMs: Double? = null, val note: String? = null,
    val modelSha256: String, val result: Project.Result, val picture: String? = null,
    val pictures: Map<String, String>? = null, val pictureStates: Map<String, String>? = null,
    val outcome: String? = null, val printedAtMs: Double? = null,
) {
    /** How a person points at it: what changed, in the pass's own first sentence, else its date. */
    val label: String get() {
        val line = result.summary?.split("\n")?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return DesignHistory.date(sealedAtMs)
        val end = line.indexOf(". ")
        return if (end < 0) line else line.substring(0, end) + "."
    }
}

/** One print attempt, naming its design (CounterpartKit `Project.PrintAttempt`). */
@Serializable
data class PrintAttempt(
    val id: String, val versionId: String? = null, val startedAtMs: Double, val printId: String? = null, val bundleId: String,
    val destination: Project.PrintDestination? = null, val monitor: Project.PrintMonitor? = null, val spools: List<Project.Spool>? = null,
)

/** The designs a person has, and those they have not printed (#616). Latest is a default, never a stored pointer.
 *  Port of CounterpartKit `DesignHistory`, word for word. */
class DesignHistory(val project: Project) {
    private val versions: List<DesignVersion> = project.versions.orEmpty()
    private val prints: List<PrintAttempt> = project.prints.orEmpty()
    val latest: DesignVersion? get() = versions.lastOrNull()
    /** Every design that was printed or answered It works, newest first (the latest included: it is printed too). */
    val have: List<DesignVersion> get() = versions.reversed().filter { printedAt(it) != null || it.outcome == "works" }
    /** Sealed designs never printed, newest first, without the latest (the page's hero). */
    val earlier: List<DesignVersion> get() = versions.reversed().filter { it.id != latest?.id && printedAt(it) == null && it.outcome != "works" }
    /** A project with one design reads exactly as before: no sections. */
    val showsSections: Boolean get() = versions.size > 1

    fun attempts(version: DesignVersion): List<PrintAttempt> = prints.filter { it.versionId == version.id }

    fun printedAt(version: DesignVersion): Double? {
        version.printedAtMs?.let { return it }
        return attempts(version).filter { it.monitor?.endState == "done" }
            .map { attempt -> Iso.parse(attempt.monitor?.endedAt)?.toDouble() ?: attempt.startedAtMs }.maxOrNull()
    }

    /** Attempts on this design whose end was never kept (made before attempts were recorded; their frames survive). */
    fun unknownEnds(version: DesignVersion): Int = attempts(version).count { it.monitor?.endState == null }

    fun printedLine(version: DesignVersion): String {
        val at = printedAt(version)
        if (at == null) {
            if (version.outcome == "works") return "Printed"
            // Never "not printed" for a design that went to the printer: say what is known (#616, the hanger's Nov 4 design).
            val tries = attempts(version).size
            if (unknownEnds(version) > 0) return "Sent to the printer ${if (tries == 1) "once" else "$tries times"} · how ${if (tries == 1) "it" else "they"} ended wasn’t kept"
            if (tries > 0) return "Not printed · ${if (tries == 1) "1 try" else "$tries tries"} didn’t finish"
            return "Not printed yet"
        }
        val printer = attempts(version).lastOrNull { it.monitor?.endState == "done" }?.destination?.name
        return listOfNotNull("Printed ${date(at)}", printer).joinToString(" · ")
    }

    fun outcomeLine(version: DesignVersion): String = when (version.outcome) {
        "works" -> "It works"
        "needs-changes" -> "Needs changes"
        else -> if (printedAt(version) == null) "Ready to print" else "Did it fit?"
    }

    /** The one case the list line changes (DESIGN.md §3.1): the newest design is unprinted and unanswered while an
     *  earlier one was printed. Every other project keeps today's phase and words; Done stays Done. */
    private val twoTruths: Double? get() {
        val latest = latest ?: return null
        if (versions.size <= 1 || latest.outcome != null || printedAt(latest) != null) return null
        if (project.state in setOf(Project.State.New, Project.State.TouchingUp, Project.State.NeedsCloseup, Project.State.Printing,
                Project.State.Failed, Project.State.Sent, Project.State.Confirmed, Project.State.Printed)) return null
        return versions.dropLast(1).mapNotNull { printedAt(it) }.maxOrNull()
    }
    val phase: ProjectPhase? get() = if (twoTruths == null) null else ProjectPhase.Ready
    val line: String? get() = twoTruths?.let { "New one ready · printed ${date(it)}" }

    /** Activity's mark on the pass that sealed a design: "This became the Nov 4 design". */
    fun sealedLine(passStartedAtMs: Double): String? {
        if (!showsSections) return null
        val version = versions.firstOrNull { it.passStartedAtMs == passStartedAtMs } ?: return null
        return "This became the ${date(version.sealedAtMs)} design"
    }

    companion object {
        /** "Nov 4", in this device's time zone, as the computer's words write it. */
        fun date(atMs: Double): String = SimpleDateFormat("MMM d", Locale.US).apply { timeZone = TimeZone.getDefault() }.format(Date(atMs.toLong()))
    }
}

/**
 * A view of one sealed design in the existing stage (CounterpartKit `Project.showingDesign`). This value never goes back
 * to the store. Built from the wire object with the design's own fields, so every getter that reads `raw` (`picture`,
 * `pictures`, `pictureStates`) agrees with the design shown, never the newest's.
 */
fun Project.showingDesign(id: String?): Project {
    if (id == null) return this
    val history = DesignHistory(this)
    val version = versions?.firstOrNull { it.id == id } ?: return this
    val versionRaw = (raw["versions"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { (it["id"] as? JsonPrimitive)?.content == id } ?: return this
    val attemptsRaw = (raw["prints"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.filter { (it["versionId"] as? JsonPrimitive)?.content == id }.orEmpty()
    val state = when {
        history.printedAt(version) != null -> if (version.outcome == "works") Project.State.Confirmed else Project.State.Printed
        version.outcome == "works" -> Project.State.Confirmed
        history.unknownEnds(version) > 0 -> Project.State.Sent
        else -> Project.State.Ready
    }
    val view = raw.toMutableMap()
    fun put(key: String, value: kotlinx.serialization.json.JsonElement?) { if (value == null) view.remove(key) else view[key] = value }
    put("current", versionRaw["result"])
    put("picture", versionRaw["picture"]); put("pictures", versionRaw["pictures"]); put("pictureStates", versionRaw["pictureStates"])
    put("outcome", versionRaw["outcome"]); view.remove("status")
    view["versions"] = JsonArray(listOf(versionRaw))
    view["prints"] = JsonArray(attemptsRaw)
    put("print", attemptsRaw.lastOrNull()?.let { attempt ->
        JsonObject(listOf("bundleId", "destination", "monitor", "spools").mapNotNull { key -> attempt[key]?.let { key to it } }.toMap())
    })
    view["state"] = JsonPrimitive(state.wire)
    view["updatedAtMs"] = JsonPrimitive(version.sealedAtMs)
    return Project.decode(JsonObject(view)) ?: this
}
