package com.scantomake.counterpart.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Project

internal fun searchProjects(projects: List<Project>, query: String, printerName: (Project) -> String?): List<Project> =
    projects.filter { p ->
        query.isBlank() || searchValues(p, printerName).any { it.contains(query.trim(), ignoreCase = true) }
    }

/** Every value a search reads, the title first, always in first place, so a project without one keeps its other values (review F5). */
private fun searchValues(p: Project, printerName: (Project) -> String?): List<String> = listOf(p.title ?: "") + listOfNotNull(p.instructions, printerName(p))

/** A search result's reason: a short line with the match at [start, end). */
internal data class SearchSnippet(val text: String, val start: Int, val end: Int)

/**
 * Why a search found a project whose title doesn't say (first look U10, Nov 10): the first searched value holding the
 * query, cut to a short line around it. Null when the title has it.
 */
internal fun searchSnippet(p: Project, query: String, printerName: (Project) -> String?): SearchSnippet? {
    val needle = query.trim()
    if (needle.isEmpty() || p.title?.contains(needle, ignoreCase = true) == true) return null
    for (value in searchValues(p, printerName).drop(1)) {
        val line = value.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val at = line.indexOf(needle, ignoreCase = true)
        if (at < 0) continue
        var start = maxOf(0, at - 30)
        var end = minOf(line.length, at + needle.length + 70)
        if (start > 0) { val space = line.indexOf(' ', start); if (space in 0 until at) start = space + 1 }
        if (end < line.length) { val space = line.lastIndexOf(' ', end); if (space > at + needle.length) end = space }
        // Never inside a character: an emoji is two UTF-16 units (review F5).
        if (start in 1 until line.length && Character.isLowSurrogate(line[start])) start -= 1
        if (end in 1 until line.length && Character.isLowSurrogate(line[end])) end += 1
        val lead = if (start > 0) "…" else ""
        val text = lead + line.substring(start, end) + if (end < line.length) "…" else ""
        return SearchSnippet(text, lead.length + at - start, lead.length + at - start + needle.length)
    }
    return null
}

/** The snippet under a card or row, the match in bold. Nothing when there's none. */
@Composable
internal fun SearchReason(snippet: SearchSnippet?, modifier: Modifier = Modifier) {
    snippet ?: return
    Text(buildAnnotatedString {
        append(snippet.text.substring(0, snippet.start))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = Color.White)) { append(snippet.text.substring(snippet.start, snippet.end)) }
        append(snippet.text.substring(snippet.end))
    }, modifier.padding(top = 4.dp).testTag("search-reason"), color = Palette.secondary, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
}
