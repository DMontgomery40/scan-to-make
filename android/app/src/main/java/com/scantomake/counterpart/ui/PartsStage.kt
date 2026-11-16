package com.scantomake.counterpart.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.viewinterop.AndroidView
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.stageRgb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The dark stage (#22242B) every layout draws parts on. */
private val STAGE = floatArrayOf(0x22 / 255f, 0x24 / 255f, 0x2B / 255f)

/** "Your copy in 2 parts, each in its own colour": what the parts stage says, before and after it is drawn. */
fun partsStageLine(label: String, count: Int): String =
    if (count == 1) "$label, in its own colour" else "$label in $count parts, each in its own colour"

/**
 * #691: a multi-part design on the project's stage, each part's mesh in its own colour (floored on the dark stage, #706),
 * all in the 3MF's build frame so they line up; drag turns it, pinch zooms. Until every part's mesh is on the phone, and
 * if one can't be had, [still] shows: the same stage picture as any other entry, so the stage is never empty.
 */
@Composable
fun PartsStage(project: Project, parts: List<ProjectGallery.DrawnPart>, label: String, modifier: Modifier = Modifier, still: @Composable () -> Unit) {
    val key = "${project.id}/${project.mediaVersion}/" + parts.joinToString("|") { it.mesh }
    var meshes by remember(key) { mutableStateOf<List<Pair<StlMesh, FloatArray>>?>(null) }
    var failed by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key) {
        val companion = Counterpart.instance.companion
        // The renderer's triangle budget is shared, so many parts never become an unbounded GPU allocation.
        val budget = maxOf(2_000, StlParser.MAX_RENDERED_TRIANGLES / parts.size)
        val loaded = withContext(Dispatchers.IO) {
            try {
                parts.map { part -> (StlParser.parse(companion.download(project, part.mesh).readBytes(), budget) ?: return@withContext null) to stageRgb(part.colour) }
            } catch (_: Exception) { null }
        }
        if (loaded == null) failed = true else meshes = loaded
    }
    val shown = meshes
    Box(modifier.testTag("gallery-stage-parts").semantics {
        contentDescription = partsStageLine(label, parts.size)
        stateDescription = when { shown != null -> "shown"; failed -> "not available"; else -> "loading" }
    }) {
        if (shown == null) still()
        else AndroidView(factory = { ctx -> MeshSurfaceView(ctx, STAGE).also { it.showParts(shown) } }, modifier = Modifier.fillMaxSize())
    }
}
