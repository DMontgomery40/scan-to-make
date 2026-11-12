package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.jsonOf
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/** Connection choices come from the running printer MCP, including labels and unavailable reasons. */
@Serializable
data class PrinterPrintRoute(val route: String, val mode: String, val type: String,
                             val choices: List<String>, val options: List<Option>? = null) {
    @Serializable data class Option(val id: String, val label: String, val available: Boolean,
                                    val reason: String? = null, val controls: String? = null)
    fun label(id: String): String = options?.firstOrNull { it.id == id }?.label ?: when (id) {
        "lan" -> "Local network"; "cloud" -> "Bambu Cloud"; "developer" -> "Local network, Developer Mode"; else -> id
    }
    fun available(id: String): Boolean = options?.firstOrNull { it.id == id }?.available ?: true
}

@Serializable
data class PrinterMcpSelection(val destinationId: String, val destinations: List<PrinterDestination>, val defaultDestinationId: String) {
    val catalog get() = PrinterCatalog(destinations, defaultDestinationId)
}

@Serializable
data class McpUpdate(val mcpId: String, val state: String, val fromVersion: String? = null,
                     val toVersion: String? = null, val found: String? = null) {
    val words: String get() = when (state) {
        "started" -> toVersion?.let { "Updating to $it…" } ?: "Updating…"
        "waiting" -> "Updates as soon as Counterpart finishes its work on this printer."
        "current" -> fromVersion?.let { "Up to date · $it" } ?: "Up to date"
        "unresolved" -> found ?: "The companion couldn't identify this installation."
        else -> "Check the update on your computer."
    }
}

private fun printerId(id: String) {
    if (!Regex("[A-Za-z0-9_-]{1,256}").matches(id)) throw CompanionException("invalid-request", "That printer isn't valid.")
}

suspend fun CompanionClient.printerPrintRoute(destinationId: String, route: String? = null): PrinterPrintRoute? {
    printerId(destinationId)
    if (route != null && !Regex("[a-z][a-z0-9_-]{0,31}").matches(route))
        throw CompanionException("invalid-request", "That printer connection isn't valid.")
    return request(if (route == null) "GET" else "POST", "/v1/objects/printers/$destinationId/route",
        route?.let { jsonOf("route" to it) }, timeoutMs = 35_000).opt("route")
}

suspend fun CompanionClient.choosePrinterMcp(destinationId: String, backend: String): PrinterMcpSelection {
    printerId(destinationId)
    if (backend !in setOf("bambu-printer-mcp", "mcp-3d-printer-server"))
        throw CompanionException("invalid-request", "That printer MCP isn't valid.")
    return WireJson.decodeFromJsonElement(request("POST", "/v1/objects/printers/$destinationId/mcp",
        jsonOf("backend" to backend), timeoutMs = 40_000))
}

suspend fun CompanionClient.updatePrinterMcp(mcpId: String, fresh: Boolean = false): McpUpdate {
    if (!Regex("mcp-[0-9a-f]{16}").matches(mcpId)) throw CompanionException("invalid-request", "That printer installation isn't valid.")
    return request("POST", "/v1/printers/mcp/$mcpId/update", if (fresh) jsonOf("fresh" to true) else JsonObject(emptyMap()))
        .opt<McpUpdate>("update") ?: throw CompanionException("invalid-response", "The companion didn't return an update result.")
}


@Serializable
data class McpPackageCopies(val `package`: String, val label: String, val appMcpId: String, val appCopy: Copy? = null, val uses: List<Usage>,
    /** The companion's Moves, in the order the uses are listed (absent from a companion before Nov 6). */
    @SerialName("moves") val listedMoves: List<Move>? = null,
    /** The copy Check and Add run (Counterpart's when it has one). */
    val version: String? = null,
    /** #775: the printers that use it, each once; a newer version Update installs; npm said nothing is newer. A companion before #775 sends none. */
    val usedBy: List<String>? = null, val available: String? = null, val upToDate: Boolean? = null) {
    @Serializable data class Copy(val version: String? = null)
    @Serializable data class Usage(val destinationId: String, val printerId: String, val printer: String, val mcpId: String,
        val kind: String, val path: String? = null, val version: String? = null, val canMove: Boolean,
        /** It runs Counterpart's own copy; a companion before Nov 6 doesn't say (its canMove does). */
        val managed: Boolean? = null,
        /** The companion's sentence: which copy, its version, and whether it's older than Counterpart's. */
        @SerialName("words") val sentence: String? = null) {
        val words: String get() {
            if (sentence != null) return sentence
            val place = path?.let { " at $it" } ?: ""
            val source = if (managed ?: !canMove) "Counterpart’s copy" else if (kind == "app") "Counterpart’s older copy$place" else "your copy$place"
            return "$printer uses $source (${version ?: "version unknown"})."
        }
    }
    /** One Move to Counterpart's updated copy, named by its printers, MCP and the copy they leave. #775 adds `printers` (each once), `words` (the row's one line) and `reason` (Q9). */
    @Serializable data class Move(val mcpId: String, val title: String, val printers: List<String>? = null, val words: String? = null, val reason: String? = null)
    /** In the order the uses are listed (never by id), each titled so two Moves for one printer read apart. */
    val moves: List<Move> get() = listedMoves ?: uses.filter { it.canMove }.map { it.mcpId }.distinct().map { id ->
        val on = uses.filter { it.mcpId == id }
        val first = on.first()
        val from = if (first.kind == "app") "Counterpart’s older copy" + (first.path?.let { " at $it" } ?: "") else first.path?.let { "your copy at $it" } ?: "your copy"
        Move(id, "Move " + on.map { it.printer }.distinct().joinToString(", ") + " ($label, $from) to Counterpart’s updated copy")
    }
    val moveIds: List<String> get() = moves.map { it.mcpId }
    fun moveTitle(id: String) = moves.firstOrNull { it.mcpId == id }?.title ?: "Move to Counterpart’s updated copy"

    /** Settings → Printer software's row (#775); `printerId` narrows it to one printer's page. */
    fun row(printerId: String? = null): PrinterSoftwareRow {
        val others = moves.filter { move -> printerId == null || uses.any { it.printerId == printerId && it.mcpId == move.mcpId } }.map { move ->
            val on = uses.filter { it.mcpId == move.mcpId }
            val printers = move.printers ?: PrinterSoftwareRow.once(on.map { it.printerId to it.printer })
            val first = on.firstOrNull()
            val words = move.words ?: first?.let { PrinterSoftwareRow.otherCopy(printers, it.kind == "app", it.version) } ?: move.title
            val lead = PrinterSoftwareRow.listed(printers) + " "
            val copy = if (words.startsWith(lead)) words.removePrefix(lead).replace(Regex("^runs? "), "") else words
            PrinterSoftwareRow.Other(move.mcpId, words, "Use Counterpart’s",
                "Use Counterpart’s $label for ${PrinterSoftwareRow.listed(printers)} instead of $copy",
                listOfNotNull(move.reason, PrinterSoftwareRow.LEFT_ALONE).joinToString(" "))
        }
        val newer = if (appCopy != null) available else null
        val used = usedBy ?: PrinterSoftwareRow.once(uses.map { it.printerId to it.printer })
        return PrinterSoftwareRow(label, appCopy?.version ?: version,
            newer?.let { "$it available" } ?: if (upToDate == true) PrinterSoftwareRow.UP_TO_DATE else null,
            if (newer != null) appMcpId else null,
            if (used.isEmpty()) "No printer uses it yet" else "Used by " + PrinterSoftwareRow.listed(used), others)
    }
}

/**
 * One printer MCP in Settings → Printer software (#775), the same words as CounterpartKit's `PrinterSoftwareRow` (iPhone,
 * iPad, Mac) and Linux's `printerSoftwareRow`: its name and version; "Up to date" or "<version> available" with one Update;
 * the printers that use it, each once; and only when a printer runs another copy, one line and one "Use Counterpart’s".
 */
data class PrinterSoftwareRow(val name: String, val version: String?, val status: String?, val update: String?, val usedBy: String, val others: List<Other>) {
    /** `label` is the button's spoken name: two printers' buttons never read the same. */
    data class Other(val mcpId: String, val words: String, val button: String, val label: String, val footnote: String)
    companion object {
        const val UP_TO_DATE = "Up to date"
        const val LEFT_ALONE = "Your own copy is left as it is."
        /** "P1S", "P1S and X1C", "P1S, X1C and A1". */
        fun listed(names: List<String>) = if (names.size > 1) names.dropLast(1).joinToString(", ") + " and " + names.last() else names.firstOrNull() ?: ""
        /** Each printer once by its id, in listed order. */
        fun once(printers: List<Pair<String, String>>) = printers.distinctBy { it.first }.map { it.second }
        /** A companion from before #775: the same line the companion now sends. */
        fun otherCopy(printers: List<String>, earlier: Boolean, version: String?) =
            listed(printers) + (if (printers.size > 1) " run " else " runs ") + (if (earlier) "an earlier copy" else "your own copy") + (version?.let { " ($it)" } ?: "")
    }
}
@Serializable private data class McpCopiesReply(val packages: List<McpPackageCopies>)
suspend fun CompanionClient.mcpCopies(): List<McpPackageCopies> =
    WireJson.decodeFromJsonElement<McpCopiesReply>(request("GET", "/v1/printers/mcps")).packages
