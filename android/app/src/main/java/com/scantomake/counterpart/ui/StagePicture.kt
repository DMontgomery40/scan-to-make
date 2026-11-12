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
    val line = when {
        image != null -> "$label, as your computer drew it"
        path != null && !failed -> coming
        still == Still.Waiting -> coming
        path != null -> "The picture didn't come from your computer."
        else -> unavailableLine
    }
    val shows = when { image != null -> "shown"; line == coming -> "loading"; else -> "not available" }
    Box(modifier.stage().testTag("gallery-stage-picture").semantics { contentDescription = if (image != null) line else "$label. $line"; stateDescription = shows },
        contentAlignment = Alignment.Center) {
        when {
            image != null -> Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            shows == "loading" -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(28.dp), color = Color.White.copy(alpha = 0.6f), strokeWidth = 2.dp)
                Text(line, color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
            }
            else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(CIcons.Cube, null, tint = Color.White.copy(alpha = 0.4f), modifier = Modifier.size(42.dp))
                Text(line, color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp))
                if (path != null) TextButton(onClick = { failed = false; attempt++ }) { Text("Try again") }
            }
        }
    }
}
