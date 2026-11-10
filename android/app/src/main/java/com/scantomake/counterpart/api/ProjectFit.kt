package com.scantomake.counterpart.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * How a fit gets its exact size, chosen in New and sent as fields beside the request (contracts `FitSchema`). Port of
 * CounterpartKit `ProjectFit`. The request itself is only what the person typed.
 */
data class ProjectFit(val sizeSource: String, val measured: List<Size> = emptyList()) {
    /** One size in millimetres. `id` is opaque; `label` says what was measured in words a person can act on. */
    data class Size(val id: String, val label: String, val mm: Double)

    /** The `fit` field of a create or draft request. */
    val json: JsonObject get() = JsonObject(buildMap {
        put("sizeSource", JsonPrimitive(sizeSource))
        if (sizeSource == "measured") put("measured", JsonArray(measured.map {
            JsonObject(mapOf("id" to JsonPrimitive(it.id), "label" to JsonPrimitive(it.label), "mm" to JsonPrimitive(it.mm)))
        }))
    })

    companion object {
        /** Null for an unknown source, or "I measured" with no size: there is nothing to send. */
        fun of(sizeSource: String, measured: List<Size> = emptyList()): ProjectFit? = when {
            sizeSource !in setOf("lookup", "measured", "scan") -> null
            sizeSource == "measured" && measured.isEmpty() -> null
            else -> ProjectFit(sizeSource, if (sizeSource == "measured") measured else emptyList())
        }
    }
}

/** The body of a create request. `instructions` is what the person typed; how a fit's size is settled goes beside
 *  it as `fit`, never inside it. */
fun createBody(instructions: String, kind: String?, url: String?, fit: ProjectFit?): JsonObject {
    val text = instructions.trim()
    val json = LinkedHashMap<String, JsonElement>()
    if (text.isNotEmpty()) json["instructions"] = JsonPrimitive(text)
    if (kind != null && kind in setOf("fit", "copy", "published")) json["kind"] = JsonPrimitive(kind)
    url?.let { json["url"] = JsonPrimitive(it) }
    if (fit != null && kind == "fit" && text.isNotEmpty()) json["fit"] = fit.json
    return JsonObject(json)
}

/** The body of a draft update. The fit choice is sent every time: the fields, or null when the draft is no longer a fit. */
fun draftBody(instructions: String, kind: String?, fit: ProjectFit?): JsonObject {
    val json = LinkedHashMap<String, JsonElement>()
    json["instructions"] = JsonPrimitive(instructions)
    if (kind != null && kind in setOf("fit", "copy")) json["kind"] = JsonPrimitive(kind)
    json["fit"] = if (kind == "fit" && fit != null) fit.json else JsonNull
    return JsonObject(json)
}
