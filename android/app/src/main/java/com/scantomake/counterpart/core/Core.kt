package com.scantomake.counterpart.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.security.MessageDigest
import java.util.Base64

/**
 * A regular expression that must match the whole string, as JavaScript `^…$` does. Port of
 * CounterpartKit's `Pattern`: patterns use `[0-9]`, never `\d`.
 */
class Pattern(pattern: String, caseInsensitive: Boolean = false) {
    private val regex = if (caseInsensitive) Regex(pattern, RegexOption.IGNORE_CASE) else Regex(pattern)
    fun matches(value: String?): Boolean = value != null && regex.matches(value)
}

object Hex {
    fun string(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    fun sha256(bytes: ByteArray): String = string(sha256Bytes(bytes))
    fun sha256Bytes(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun bytes(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        return ByteArray(hex.length / 2) { i ->
            hex.substring(i * 2, i * 2 + 2).toIntOrNull(16)?.toByte() ?: return null
        }
    }
}

object Base64Url {
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/** Plain text a person typed: 1…max UTF-16 units, trimmed, no control characters (the Mac's own rule). */
fun isPlainText(text: String, max: Int): Boolean {
    val trimmed = text.trim()
    return trimmed.isNotEmpty() && trimmed.length <= max && trimmed.none { it.code < 0x20 || it.code == 0x7f }
}

/** One shared JSON configuration: unknown keys are ignored, as every client of the companion must. */
val WireJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

fun parseObject(text: String): JsonObject? = try { WireJson.parseToJsonElement(text) as? JsonObject } catch (_: Exception) { null }
fun parseObject(bytes: ByteArray): JsonObject? = parseObject(bytes.toString(Charsets.UTF_8))

val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
val JsonElement?.num: Double? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
val JsonElement?.obj: JsonObject? get() = this as? JsonObject
val JsonElement?.arr: JsonArray? get() = this as? JsonArray

fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.filter { it.second != null }.associate { it.first to toJson(it.second) })

fun toJson(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value)
    is Long -> JsonPrimitive(value)
    is Double -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.filter { it.value != null }.associate { it.key.toString() to toJson(it.value) })
    is Iterable<*> -> JsonArray(value.map { toJson(it) })
    is Array<*> -> JsonArray(value.map { toJson(it) })
    else -> JsonPrimitive(value.toString())
}

/** JavaScript's encodeURIComponent: everything but ASCII letters, digits and `-_.!~*'()` is percent-encoded. */
fun encodeURIComponent(text: String): String {
    val keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()"
    val out = StringBuilder()
    for (b in text.toByteArray(Charsets.UTF_8)) {
        val c = (b.toInt() and 0xff)
        if (c < 0x80 && keep.indexOf(c.toChar()) >= 0) out.append(c.toChar()) else out.append("%%%02X".format(c))
    }
    return out.toString()
}

/** Percent-encodes a query value: also `+ & = #`, so a name can't split the query (ProjectUploader.queryValue). */
fun encodeQueryValue(text: String): String {
    val keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!$'()*,;:@/?"
    val out = StringBuilder()
    for (b in text.toByteArray(Charsets.UTF_8)) {
        val c = (b.toInt() and 0xff)
        if (c < 0x80 && keep.indexOf(c.toChar()) >= 0) out.append(c.toChar()) else out.append("%%%02X".format(c))
    }
    return out.toString()
}

/** Percent-encodes a path segment, keeping the characters `URLPathAllowed` keeps (and "/"). */
fun encodePath(text: String): String {
    val keep = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!$&'()*+,=:@/"
    val out = StringBuilder()
    for (b in text.toByteArray(Charsets.UTF_8)) {
        val c = (b.toInt() and 0xff)
        if (c < 0x80 && keep.indexOf(c.toChar()) >= 0) out.append(c.toChar()) else out.append("%%%02X".format(c))
    }
    return out.toString()
}
