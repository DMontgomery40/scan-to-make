package com.scantomake.counterpart.api

import java.net.URI

/** A model page link in what someone typed or pasted (MakerWorld, Printables…). Port of CounterpartKit `PublishedModelLink`. */
object PublishedModelLink {
    private val sites = listOf("makerworld.com", "printables.com", "prusaprinters.org", "thingiverse.com", "thangs.com", "cults3d.com",
        "myminifactory.com", "grabcad.com", "makershop.co", "crealitycloud.com", "printables.cz")
    private val link = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)

    fun find(text: String): String? = link.findAll(text).map { it.value.trimEnd('.', ',', ')', ']', '!', '?', ';', ':') }.firstOrNull { candidate ->
        val uri = try { URI(candidate) } catch (_: Exception) { return@firstOrNull false }
        val host = uri.host?.lowercase() ?: return@firstOrNull false
        val path = uri.path ?: ""
        if (path.length <= 1) return@firstOrNull false
        val ext = path.substringAfterLast('.', "").lowercase()
        ext in setOf("3mf", "stl") || sites.any { host == it || host.endsWith(".$it") }
    }
}
