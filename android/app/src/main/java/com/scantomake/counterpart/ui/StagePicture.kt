package com.scantomake.counterpart.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.Still
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The one still picture on a project's stage (review B1/S7 on #539; CounterpartKit `Project.still(for:)`, iOS
 * `StagePicture`). Every still goes through it and it is never only the backdrop: shown, the picture; waiting, a
 * progress mark and what is coming; not available, a symbol and one line, with Try again where a fetch failed. Never a
 * picture of something else. Its state is the `gallery-stage-picture` node's state description.
 */
/** What the stage shows (iOS `StagePicture.Shows`). `Decoding`: the phone keeps this picture and is decoding it now (a few
 *  milliseconds): the bare stage, never a spinner or "coming from your computer" for bytes already on the phone (#748;
 *  review of #741, P2). Its state description is "loading", as on the iPhone. */
enum class StageShows(val description: String) { Shown("shown"), Loading("loading"), Decoding("loading"), NotAvailable("not available") }

/** The stage's state from what it has (pure, so the decoding case is unit-tested): a picture, a failed fetch, a kept copy. */
fun stageShows(still: Still, hasImage: Boolean, failed: Boolean, libraryHas: Boolean): StageShows = when {
    hasImage -> StageShows.Shown
    still is Still.Picture && !failed && libraryHas -> StageShows.Decoding
    still is Still.Picture && !failed -> StageShows.Loading
    still == Still.Waiting -> StageShows.Loading
    else -> StageShows.NotAvailable
}

@Composable
fun StagePicture(project: Project, still: Still, label: String, unavailableLine: String, modifier: Modifier = Modifier) {
    val path = (still as? Still.Picture)?.path
    val key = path?.let { "${project.id}/${project.mediaVersion}/$it" }
    var attempt by remember(key) { mutableIntStateOf(0) }
    var bitmap by remember(key) { mutableStateOf(key?.let(ImageCache::get)) }
    var failed by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key, attempt) {
        if (key == null || path == null || bitmap != null) return@LaunchedEffect
        failed = false
        // The copy this phone keeps is a picture shown, at once and with no network; a newer one replaces it when it arrives.
        val companion = Counterpart.instance.companion
        val kept = companion.library?.latest(project.id, path)
        if (kept != null) bitmap = withContext(Dispatchers.IO) { ImageCache.decode(kept.first) }
        if (kept?.second == project.mediaVersion && bitmap != null) { ImageCache.put(key, bitmap!!); return@LaunchedEffect }
        val got = withContext(Dispatchers.IO) {
            try { ImageCache.decode(companion.download(project, path))?.also { ImageCache.put(key, it) } } catch (_: Exception) { null }
        }
        if (got != null) bitmap = got else if (bitmap == null) failed = true
    }
    val coming = "$label: coming from your computer"
    val image = bitmap
    val libraryHas = remember(key) { path != null && Counterpart.instance.companion.library?.latest(project.id, path) != null }
    val shows = stageShows(still, image != null, failed, libraryHas)
    val line = when (shows) {
        StageShows.Shown, StageShows.Decoding -> "$label, as your computer drew it"
        StageShows.Loading -> coming
        StageShows.NotAvailable -> if (path != null) "The picture didn't come from your computer." else unavailableLine
    }
    Box(modifier.stage().testTag("gallery-stage-picture").semantics {
            contentDescription = if (shows == StageShows.Shown || shows == StageShows.Decoding) line else "$label. $line"; stateDescription = shows.description },
        contentAlignment = Alignment.Center) {
        when (shows) {
            StageShows.Shown -> image?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
            // The phone has it: the bare stage for the moment it takes to decode.
            StageShows.Decoding -> Unit
            StageShows.Loading -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(28.dp), color = Color.White.copy(alpha = 0.6f), strokeWidth = 2.dp)
                Text(line, color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
            }
            StageShows.NotAvailable -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(CIcons.Cube, null, tint = Color.White.copy(alpha = 0.4f), modifier = Modifier.size(42.dp))
                Text(line, color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
                if (path != null) TextButton(onClick = { failed = false; attempt++ }) { Text("Try again") }
            }
        }
    }
}
