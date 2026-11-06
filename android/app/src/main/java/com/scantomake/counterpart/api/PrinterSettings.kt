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
    @SerialName("moves") val listedMoves: List<Move>? = null) {
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
    /** One Move to Counterpart's updated copy, named by its printers, MCP and the copy they leave. */
    @Serializable data class Move(val mcpId: String, val title: String)
    /** In the order the uses are listed (never by id), each titled so two Moves for one printer read apart. */
    val moves: List<Move> get() = listedMoves ?: uses.filter { it.canMove }.map { it.mcpId }.distinct().map { id ->
        val on = uses.filter { it.mcpId == id }
        val first = on.first()
        val from = if (first.kind == "app") "Counterpart’s older copy" + (first.path?.let { " at $it" } ?: "") else first.path?.let { "your copy at $it" } ?: "your copy"
        Move(id, "Move " + on.map { it.printer }.distinct().joinToString(", ") + " ($label, $from) to Counterpart’s updated copy")
    }
    val moveIds: List<String> get() = moves.map { it.mcpId }
    fun moveTitle(id: String) = moves.firstOrNull { it.mcpId == id }?.title ?: "Move to Counterpart’s updated copy"
}
@Serializable private data class McpCopiesReply(val packages: List<McpPackageCopies>)
suspend fun CompanionClient.mcpCopies(): List<McpPackageCopies> =
    WireJson.decodeFromJsonElement<McpCopiesReply>(request("GET", "/v1/printers/mcps")).packages
