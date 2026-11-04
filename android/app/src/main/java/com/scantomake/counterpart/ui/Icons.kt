package com.scantomake.counterpart.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** The app's symbols: Material's core set where it has one, simple line drawings for the rest (SF Symbols' roles). */
object CIcons {
    private fun line(name: String, block: PathBuilder.() -> Unit): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        path(fill = null, stroke = SolidColor(Color.White), strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathBuilder = block)
    }.build()
    private fun solid(name: String, block: PathBuilder.() -> Unit): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        path(fill = SolidColor(Color.White), pathBuilder = block)
    }.build()

    val Add = Icons.Filled.Add
    @Suppress("DEPRECATION") val Back = Icons.Filled.ArrowBack
    val Check = Icons.Filled.CheckCircle
    val Tick = Icons.Filled.Check
    val Close = Icons.Filled.Close
    val Trash = Icons.Filled.Delete
    val Pencil = Icons.Filled.Edit
    val Info = Icons.Filled.Info
    @Suppress("DEPRECATION") val Chevron = Icons.Filled.KeyboardArrowRight
    val Bell = Icons.Filled.Notifications
    val Play = Icons.Filled.PlayArrow
    val Refresh = Icons.Filled.Refresh
    val Search = Icons.Filled.Search
    @Suppress("DEPRECATION") val Send = Icons.Filled.Send
    val Gear = Icons.Filled.Settings
    val Sparkle = Icons.Filled.Star
    val Warning = Icons.Filled.Warning

    val Pause = solid("pause") { moveTo(6f, 5f); lineTo(10f, 5f); lineTo(10f, 19f); lineTo(6f, 19f); close(); moveTo(14f, 5f); lineTo(18f, 5f); lineTo(18f, 19f); lineTo(14f, 19f); close() }
    val Stop = solid("stop") { moveTo(6f, 6f); lineTo(18f, 6f); lineTo(18f, 18f); lineTo(6f, 18f); close() }
    val Cube = line("cube") {
        moveTo(12f, 3f); lineTo(20f, 7.5f); lineTo(20f, 16.5f); lineTo(12f, 21f); lineTo(4f, 16.5f); lineTo(4f, 7.5f); close()
        moveTo(4f, 7.5f); lineTo(12f, 12f); lineTo(20f, 7.5f); moveTo(12f, 12f); lineTo(12f, 21f)
    }
    val Printer = line("printer") {
        moveTo(7f, 9f); lineTo(7f, 3f); lineTo(17f, 3f); lineTo(17f, 9f)
        moveTo(7f, 17f); lineTo(4f, 17f); lineTo(4f, 9f); lineTo(20f, 9f); lineTo(20f, 17f); lineTo(17f, 17f)
        moveTo(7f, 14f); lineTo(17f, 14f); lineTo(17f, 21f); lineTo(7f, 21f); close()
    }
    val Camera = line("camera") {
        moveTo(3f, 8f); lineTo(7f, 8f); lineTo(9f, 5f); lineTo(15f, 5f); lineTo(17f, 8f); lineTo(21f, 8f); lineTo(21f, 19f); lineTo(3f, 19f); close()
        moveTo(15.5f, 13f); arcTo(3.5f, 3.5f, 0f, true, true, 8.5f, 13f); arcTo(3.5f, 3.5f, 0f, true, true, 15.5f, 13f)
    }
    val Photo = line("photo") {
        moveTo(3f, 5f); lineTo(21f, 5f); lineTo(21f, 19f); lineTo(3f, 19f); close()
        moveTo(3f, 16f); lineTo(9f, 11f); lineTo(13f, 15f); lineTo(16f, 12f); lineTo(21f, 16f)
    }
    val Bubble = line("bubble") {
        moveTo(4f, 5f); lineTo(20f, 5f); lineTo(20f, 16f); lineTo(10f, 16f); lineTo(6f, 20f); lineTo(6f, 16f); lineTo(4f, 16f); close()
        moveTo(8f, 9f); lineTo(16f, 9f); moveTo(8f, 12f); lineTo(13f, 12f)
    }
    val Wand = line("wand") {
        moveTo(4f, 20f); lineTo(15f, 9f); moveTo(13f, 7f); lineTo(17f, 11f)
        moveTo(18f, 3f); lineTo(18f, 6f); moveTo(16.5f, 4.5f); lineTo(19.5f, 4.5f); moveTo(8f, 3f); lineTo(8f, 5f); moveTo(7f, 4f); lineTo(9f, 4f)
    }
    val Hand = line("hand") {
        moveTo(8f, 13f); lineTo(8f, 5.5f); moveTo(11f, 12f); lineTo(11f, 4f); moveTo(14f, 12f); lineTo(14f, 5f); moveTo(17f, 13f); lineTo(17f, 7f)
        moveTo(8f, 13f); lineTo(6f, 11.5f); moveTo(17f, 13f); curveTo(17f, 18f, 15f, 21f, 12f, 21f); curveTo(9f, 21f, 7f, 18f, 6f, 15f)
    }
    val Seal = line("seal") {
        moveTo(12f, 3f); lineTo(14.5f, 5f); lineTo(18f, 5f); lineTo(18.5f, 8.5f); lineTo(21f, 11f); lineTo(19f, 14f); lineTo(19f, 17.5f)
        lineTo(15.5f, 18f); lineTo(12f, 21f); lineTo(8.5f, 18f); lineTo(5f, 17.5f); lineTo(5f, 14f); lineTo(3f, 11f); lineTo(5.5f, 8.5f); lineTo(6f, 5f); lineTo(9.5f, 5f); close()
        moveTo(8.5f, 12f); lineTo(11f, 14.5f); lineTo(15.5f, 9.5f)
    }
    val Box = line("box") {
        moveTo(3f, 8f); lineTo(12f, 4f); lineTo(21f, 8f); lineTo(21f, 17f); lineTo(12f, 21f); lineTo(3f, 17f); close()
        moveTo(3f, 8f); lineTo(12f, 12f); lineTo(21f, 8f); moveTo(12f, 12f); lineTo(12f, 21f)
    }
    val Plane = line("plane") { moveTo(21f, 3f); lineTo(3f, 10.5f); lineTo(10f, 13.5f); lineTo(13f, 21f); close(); moveTo(10f, 13.5f); lineTo(21f, 3f) }
    val Question = line("question") {
        moveTo(9f, 9f); curveTo(9f, 6f, 15f, 6f, 15f, 9f); curveTo(15f, 11f, 12f, 11.5f, 12f, 14f); moveTo(12f, 18f); lineTo(12f, 18.5f)
    }
    val Upload = line("upload") { moveTo(12f, 16f); lineTo(12f, 4f); moveTo(7f, 9f); lineTo(12f, 4f); lineTo(17f, 9f); moveTo(4f, 20f); lineTo(20f, 20f) }
    val Link = line("link") {
        moveTo(10f, 14f); lineTo(14f, 10f)
        moveTo(11f, 7f); lineTo(13f, 5f); curveTo(15f, 3f, 21f, 9f, 19f, 11f); lineTo(17f, 13f)
        moveTo(13f, 17f); lineTo(11f, 19f); curveTo(9f, 21f, 3f, 15f, 5f, 13f); lineTo(7f, 11f)
    }
    val Layers = line("layers") { moveTo(12f, 4f); lineTo(21f, 9f); lineTo(12f, 14f); lineTo(3f, 9f); close(); moveTo(3f, 13f); lineTo(12f, 18f); lineTo(21f, 13f) }
    val Clock = line("clock") {
        moveTo(21f, 12f); arcTo(9f, 9f, 0f, true, true, 3f, 12f); arcTo(9f, 9f, 0f, true, true, 21f, 12f); moveTo(12f, 7f); lineTo(12f, 12f); lineTo(15f, 14f)
    }
    val Weight = line("weight") { moveTo(6f, 20f); lineTo(8f, 9f); lineTo(16f, 9f); lineTo(18f, 20f); close(); moveTo(14f, 6f); arcTo(2f, 2f, 0f, true, true, 10f, 6f); arcTo(2f, 2f, 0f, true, true, 14f, 6f) }
    val Qr = line("qr") {
        moveTo(4f, 4f); lineTo(10f, 4f); lineTo(10f, 10f); lineTo(4f, 10f); close(); moveTo(14f, 4f); lineTo(20f, 4f); lineTo(20f, 10f); lineTo(14f, 10f); close()
        moveTo(4f, 14f); lineTo(10f, 14f); lineTo(10f, 20f); lineTo(4f, 20f); close(); moveTo(14f, 14f); lineTo(16f, 14f); moveTo(20f, 14f); lineTo(20f, 16f)
        moveTo(14f, 18f); lineTo(14f, 20f); lineTo(20f, 20f); moveTo(17f, 17f); lineTo(17f, 17.5f)
    }
    val Wifi = line("wifi") {
        moveTo(2f, 9f); curveTo(8f, 3.5f, 16f, 3.5f, 22f, 9f); moveTo(5f, 12.5f); curveTo(9f, 9f, 15f, 9f, 19f, 12.5f)
        moveTo(8.5f, 16f); curveTo(10.5f, 14.3f, 13.5f, 14.3f, 15.5f, 16f); moveTo(12f, 19.5f); lineTo(12f, 20f)
    }
    val Ruler = line("ruler") {
        moveTo(3f, 16f); lineTo(16f, 3f); lineTo(21f, 8f); lineTo(8f, 21f); close(); moveTo(7f, 12f); lineTo(9f, 14f); moveTo(10f, 9f); lineTo(12f, 11f); moveTo(13f, 6f); lineTo(15f, 8f)
    }
}
