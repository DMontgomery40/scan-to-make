package com.scantomake.counterpart.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * What this phone last heard from its computer about each project, kept on disk so a page opens from it when the
 * computer stops answering, after a relaunch too (board X100; the same as CounterpartKit's `KnownProjects`). One file
 * per computer (`mac` is the pairing's base URL): another computer's projects are never shown as this one's.
 */
data class KnownProjects(val mac: String, val projects: List<Project> = emptyList(), val heard: Map<String, Long> = emptyMap()) {
    fun encode(): String = JsonObject(mapOf(
        "mac" to JsonPrimitive(mac),
        "projects" to JsonArray(projects.map { it.raw }),
        "heard" to JsonObject(heard.mapValues { JsonPrimitive(it.value) }),
    )).toString()

    /** The computer answered with these projects at `ms`; the ones it no longer lists are dropped. */
    fun heard(listed: List<Project>, ms: Long) = copy(projects = listed, heard = listed.associate { it.id to ms })

    /** The computer answered with one project at `ms`. */
    fun heard(project: Project, ms: Long) = copy(
        projects = if (projects.any { it.id == project.id }) projects.map { if (it.id == project.id) project else it } else listOf(project) + projects,
        heard = heard + (project.id to ms))

    fun forget(id: String) = copy(projects = projects.filterNot { it.id == id }, heard = heard - id)

    companion object {
        /** The saved copy for this computer, or null when there is none, it is unreadable, or it belongs to another. */
        fun decode(text: String?, mac: String): KnownProjects? = try {
            val o = Json.parseToJsonElement(text ?: return null).jsonObject
            if (o["mac"]?.jsonPrimitive?.content != mac) null
            else KnownProjects(mac,
                o["projects"]?.jsonArray?.mapNotNull { (it as? JsonObject)?.let(Project::decode) } ?: emptyList(),
                o["heard"]?.jsonObject?.mapNotNull { (k, v) -> v.jsonPrimitive.longOrNull?.let { k to it } }?.toMap() ?: emptyMap())
        } catch (_: Exception) { null }

        /** The one line over what the phone already had while the computer isn't answering, and when it was true. */
        fun awayLine(heardMs: Long?, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
            val first = "Your computer isn’t answering, so Print and Send wait."
            heardMs ?: return "$first This is what your phone already had."
            return "$first This is what your phone had ${whenText(heardMs, nowMs, zone, locale)}."
        }

        /** "at 4:12 PM", "yesterday at 4:12 PM", "on Nov 8 at 4:12 PM". */
        fun whenText(ms: Long, nowMs: Long, zone: ZoneId, locale: Locale): String {
            val at = Instant.ofEpochMilli(ms).atZone(zone)
            val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
            val clock = at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
            return when (at.toLocalDate()) {
                today -> "at $clock"
                today.minusDays(1) -> "yesterday at $clock"
                else -> "on ${at.format(DateTimeFormatter.ofPattern("MMM d", locale))} at $clock"
            }
        }
    }
}
