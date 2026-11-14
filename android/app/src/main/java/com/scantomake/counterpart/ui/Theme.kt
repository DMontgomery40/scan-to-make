package com.scantomake.counterpart.ui

import com.scantomake.counterpart.api.picturePath

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.Tone
import com.scantomake.counterpart.app.Counterpart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

// The visual system (PRD §10), as the iPhone app draws it: one warm accent ("filament orange"), fixed status
// colours always paired with a symbol and words, content on a near-black stage.
object Palette {
    val filament = Color(0xFFFF732E)
    val stageTop = Color(0xFF212429)
    val stageBottom = Color(0xFF0D0D12)
    val okGreen = Color(0xFF40D678)
    val card = Color(0xFF171717)
    val well = Color(0xFF121212)
    val glass = Color(0x1FFFFFFF)
    val secondary = Color(0xFF9A9AA0)
    val working = Color(0xFF3D8BFF)
    val needsYou = Color(0xFFFF9F0A)
    val failed = Color(0xFFFF453A)
}

private val scheme = darkColorScheme(
    primary = Palette.filament, onPrimary = Color.Black, secondary = Palette.filament, background = Color.Black, onBackground = Color.White,
    surface = Color(0xFF0E0E10), onSurface = Color.White, surfaceVariant = Palette.card, onSurfaceVariant = Palette.secondary,
    error = Palette.failed, outline = Color(0xFF3A3A3F),
)

@Composable
fun CounterpartTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = scheme) {
    // MaterialTheme supplies the palette, but plain Text inherits LocalContentColor.
    // Screens paint their own dark canvas; controls can still provide onPrimary/onSurface.
    CompositionLocalProvider(LocalContentColor provides scheme.onBackground, content = content)
}

fun Tone.color(): Color = when (this) {
    Tone.Working -> Palette.working
    Tone.NeedsYou -> Palette.needsYou
    Tone.Accent -> Palette.filament
    Tone.Printing -> Palette.okGreen
    Tone.Secondary -> Palette.secondary
    Tone.Failed -> Palette.failed
}

fun ProjectPhase.icon(): ImageVector = when (this) {
    ProjectPhase.Draft -> CIcons.Pencil
    ProjectPhase.Sending -> CIcons.Upload
    ProjectPhase.Working -> CIcons.Wand
    ProjectPhase.NeedsYou -> CIcons.Hand
    ProjectPhase.Ready -> CIcons.Seal
    ProjectPhase.Preparing -> CIcons.Gear
    ProjectPhase.Printing -> CIcons.Printer
    ProjectPhase.Printed -> CIcons.Box
    ProjectPhase.Sent -> CIcons.Plane
    ProjectPhase.Confirmed -> CIcons.Check
    ProjectPhase.Failed -> CIcons.Warning
    ProjectPhase.Unknown -> CIcons.Question
}

/** The dark stage behind models and photos. */
fun Modifier.stage(): Modifier = background(Brush.verticalGradient(listOf(Palette.stageTop, Palette.stageBottom)))

/** A project's state: symbol and words on dark glass, in the state's colour. */
@Composable
fun StatusCapsule(phase: ProjectPhase, text: String? = null, modifier: Modifier = Modifier, icon: androidx.compose.ui.graphics.vector.ImageVector? = null) {
    val tint = if (phase == ProjectPhase.Printed) Color.White.copy(alpha = 0.75f) else phase.tone.color()
    Row(modifier.clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(icon ?: phase.icon(), null, tint = tint, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(5.dp))
        Text(text ?: phase.label, color = tint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) =
    Text(text, modifier = modifier, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color.White)

/** A rounded glass card. */
@Composable
fun GlassCard(modifier: Modifier = Modifier, padding: Dp = 14.dp, content: @Composable () -> Unit) {
    Box(modifier.clip(RoundedCornerShape(24.dp)).background(Palette.glass).border(1.dp, Color.White.copy(alpha = 0.06f), RoundedCornerShape(24.dp)).padding(padding)) { content() }
}

@Composable
fun PrimaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.height(50.dp), shape = RoundedCornerShape(25.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Palette.filament, contentColor = Color.Black)) {
        if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
    }
}

@Composable
fun SecondaryButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null, color: Color = Color.White, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.height(48.dp), shape = RoundedCornerShape(24.dp),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = Palette.glass, contentColor = color)) {
        if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, fontWeight = FontWeight.Medium)
    }
}

/** A tag, not a control: plain fill so it doesn't look tappable. */
@Composable
fun Chip(icon: ImageVector, text: String, tint: Color = Palette.filament) {
    Row(Modifier.clip(RoundedCornerShape(50)).background(Color.White.copy(alpha = 0.08f)).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(12.dp)); Spacer(Modifier.width(4.dp))
        Text(text, color = tint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun InfoTile(title: String, value: String, icon: ImageVector, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(Palette.card).padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, null, tint = Palette.secondary, modifier = Modifier.size(18.dp))
        Text(value, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1)
        Text(title, color = Palette.secondary, fontSize = 12.sp)
    }
}

@Composable
fun AppIcon(size: Dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.24f)).background(Brush.linearGradient(listOf(Color(0xFFFF8A4C), Color(0xFFE2541A)))),
        contentAlignment = Alignment.Center) {
        Icon(CIcons.Cube, null, tint = Color.White, modifier = Modifier.size(size * 0.55f))
    }
}

/** Images downloaded from the Mac, decoded once and kept in memory. */
object ImageCache {
    private val cache = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    fun get(key: String): ImageBitmap? = cache.get(key)
    fun put(key: String, bitmap: ImageBitmap) { cache.put(key, bitmap) }

    fun decode(file: File, maxSide: Int = 1600): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }
    fun decode(bytes: ByteArray): ImageBitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}

/** A file of a project (a render, a photo, an Ask's picture), fetched over the pinned connection. */
@Composable
fun ProjectImage(project: Project, name: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop,
                 /** The longest side to decode: about 300 for a grid cell, so a scan's 130 frames never decode near full size. */
                 maxSide: Int = 1600) {
    val key = name?.let { "${project.id}/${project.mediaVersion}/$it" + if (maxSide == 1600) "" else "@$maxSide" }
    var bitmap by remember(key) { mutableStateOf(key?.let(ImageCache::get)) }
    LaunchedEffect(key) {
        if (key == null || name == null || bitmap != null) return@LaunchedEffect
        // The copy this phone keeps first, with no network (on-device-library.md); then the computer, for this version.
        val companion = Counterpart.instance.companion
        val kept = companion.library?.latest(project.id, name)
        if (kept != null) bitmap = withContext(Dispatchers.IO) { ImageCache.decode(kept.first, maxSide) }
        if (kept?.second == project.mediaVersion && bitmap != null) { ImageCache.put(key, bitmap!!); return@LaunchedEffect }
        withContext(Dispatchers.IO) {
            try { ImageCache.decode(companion.download(project, name), maxSide)?.also { ImageCache.put(key, it) } } catch (_: Exception) { null }
        }?.let { bitmap = it }
    }
    Box(modifier.stage(), contentAlignment = Alignment.Center) {
        val b = bitmap
        if (b != null) androidx.compose.foundation.Image(b, null, Modifier.fillMaxSize(), contentScale = contentScale)
        else Icon(CIcons.Cube, null, tint = Color.White.copy(alpha = 0.18f), modifier = Modifier.size(42.dp))
    }
}

/** The project's picture: the real thing first (a photo or scan frame), else its model render. */
fun Project.posterName(): String? = picturePath()

@Composable
fun Dot(color: Color, size: Dp = 10.dp) = Box(Modifier.size(size).clip(CircleShape).background(color))

@Composable
fun FullWidth(content: @Composable () -> Unit) = Box(Modifier.fillMaxWidth()) { content() }
