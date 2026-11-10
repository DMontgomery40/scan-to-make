package com.scantomake.counterpart.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.scantomake.counterpart.api.AskPicture
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ScanPhotos
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private val outline = Color(0xFFFF9E0A)

/** A photo upright (its EXIF orientation applied: an iPhone photo is often stored on its side, and the region is measured
 *  on the upright picture), decoded at most `maxSide` pixels on its longer side. */
internal fun decodeUpright(file: File, maxSide: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
    val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val orientation = try { ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
    val (degrees, mirrored) = uprightTurn(orientation)
    if (degrees == 0f && !mirrored) return bitmap.asImageBitmap()
    val matrix = Matrix().apply { setRotate(degrees); if (mirrored) postScale(-1f, 1f) }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).asImageBitmap()
}

/** How to stand a photo upright for each of the eight EXIF orientations: rotate by `first` degrees, then mirror
 *  left-right when `second` (a front camera's photo is often stored mirrored; review F6 on #456). */
internal fun uprightTurn(orientation: Int): Pair<Float, Boolean> = when (orientation) {
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> 0f to true
    ExifInterface.ORIENTATION_ROTATE_180 -> 180f to false
    ExifInterface.ORIENTATION_FLIP_VERTICAL -> 180f to true
    ExifInterface.ORIENTATION_TRANSPOSE -> 90f to true
    ExifInterface.ORIENTATION_ROTATE_90 -> 90f to false
    ExifInterface.ORIENTATION_TRANSVERSE -> -90f to true
    ExifInterface.ORIENTATION_ROTATE_270 -> -90f to false
    else -> 0f to false
}

/** The rest of the picture dimmed and the asked-about region outlined, over a picture that fills this box. */
@Composable
private fun RegionOverlay(region: Project.Region?, modifier: Modifier = Modifier) {
    val r = region?.let(AskPicture::clamped) ?: return
    Canvas(modifier) {
        val box = Rect(Offset((size.width * r.x).toFloat(), (size.height * r.y).toFloat()),
            Size((size.width * r.width).toFloat(), (size.height * r.height).toFloat()))
        val corner = CornerRadius(minOf(10.dp.toPx(), box.minDimension / 2))
        val dim = Path().apply { fillType = PathFillType.EvenOdd; addRect(Rect(Offset.Zero, size)); addRoundRect(RoundRect(box, corner)) }
        drawPath(dim, Color.Black.copy(alpha = 0.5f))
        drawRoundRect(outline, box.topLeft, box.size, corner, style = Stroke(3.dp.toPx()))
    }
}

/** The question's picture (David, Nov 9: "the area it's highlighting is almost impossible to see"): the card's width, the
 *  whole photo at its own aspect ratio, region dimmed-around and outlined, a caption true for any question. Tap opens it
 *  full screen, where it pinches and double-taps to zoom with the region still marked. */
@Composable
fun AskPhoto(project: Project, ask: Project.Ask?) {
    // No picture at all: nothing, rather than an empty box whose caption names a picture that isn't there.
    val name = ask?.photo?.let { "asks/" + it.substringAfterLast('/') } ?: project.posterName() ?: return
    val region = if (ask?.photo != null) ask.region else null
    val caption = AskPicture.caption(ask)
    // Keyed on the picture, so a new question starts empty, never under the last one's photo (review F3).
    var bitmap by remember(project.id, project.mediaVersion, name) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(project.id, project.mediaVersion, name) { mutableStateOf(false) }
    var full by remember { mutableStateOf(false) }
    LaunchedEffect(project.id, project.mediaVersion, name) {
        if (bitmap != null) return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) { try { decodeUpright(Counterpart.instance.companion.download(project, name), 1600) } catch (_: Exception) { null } }
        failed = bitmap == null
    }
    // It failed to load (the computer asleep, the file gone): nothing, not an empty box captioned as if it were there (F2).
    if (failed) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val b = bitmap
            Box(Modifier.heightIn(max = 420.dp).aspectRatio(b?.let { it.width.toFloat() / it.height } ?: (4f / 3f))
                .clip(RoundedCornerShape(18.dp)).stage()
                .clickable(enabled = b != null, onClickLabel = "Open full screen") { full = true }
                .semantics { contentDescription = caption; role = Role.Image }
                .testTag("ask-picture")) {
                if (b != null) {
                    Image(b, null, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
                    RegionOverlay(region, Modifier.fillMaxSize())
                }
            }
        }
        Text(caption, color = Palette.secondary, fontSize = 13.sp)
    }
    val b = bitmap
    if (full && b != null) Dialog({ full = false }, DialogProperties(usePlatformDefaultWidth = false)) {
        ZoomablePicture(b, region, caption) { full = false }
    }
}

@Composable
private fun ZoomablePicture(bitmap: ImageBitmap, region: Project.Region?, caption: String, close: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(Modifier.fillMaxSize().background(Color.Black).testTag("ask-picture-full").semantics { stateDescription = "Zoom ${(scale * 100).toInt()} percent" }
        .pointerInput(Unit) {
            detectTransformGestures { _, pan, zoom, _ ->
                scale = (scale * zoom).coerceIn(1f, 6f)
                offset = if (scale == 1f) Offset.Zero else offset + pan
            }
        }
        .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 3f }) },
        contentAlignment = Alignment.Center) {
        Box(Modifier.aspectRatio(bitmap.width.toFloat() / bitmap.height).graphicsLayer {
            scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
        }) {
            Image(bitmap, caption, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
            RegionOverlay(region, Modifier.fillMaxSize())
        }
        TextButton(close, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp).testTag("ask-picture-close")) { Text("Close", color = Color.White) }
        Text(caption, color = Color.White, fontSize = 13.sp, modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp)
            .background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(50)).padding(horizontal = 14.dp, vertical = 8.dp))
    }
}

/** The scan as one thing in What you sent: five frames round the orbit and the count. Only those five are fetched; Show
 *  All opens every frame in a grid that fetches each as it scrolls into view. */
@Composable
fun ScanStrip(project: Project) {
    val frames = project.capture.orEmpty().map { "capture/$it" }
    if (frames.isEmpty()) return
    var all by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Show every photo") { all = true }.testTag("scan-strip")
        .semantics(mergeDescendants = true) { contentDescription = "Your scan, ${ScanPhotos.words(frames.size)}" },
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            ScanPhotos.sample(frames.size).forEach { i ->
                ProjectImage(project, frames[i], Modifier.weight(1f).aspectRatio(0.75f).clip(RoundedCornerShape(8.dp)), maxSide = 300)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Your scan · ${ScanPhotos.words(frames.size)}", fontSize = 14.sp, modifier = Modifier.weight(1f))
            Text("Show All", color = Palette.filament, fontSize = 14.sp)
        }
    }
    if (all) Dialog({ all = false }, DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().testTag("scan-gallery")) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Your scan · ${ScanPhotos.words(frames.size)}", fontSize = 17.sp, modifier = Modifier.weight(1f))
                TextButton({ all = false }) { Text("Done") }
            }
            LazyVerticalGrid(GridCells.Adaptive(104.dp), Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                itemsIndexed(frames, key = { _, path -> path }) { index, path ->
                    ProjectImage(project, path, Modifier.aspectRatio(0.75f).semantics { contentDescription = "Photo ${index + 1} of ${frames.size}" }, maxSide = 300)
                }
            }
        }
    }
}
