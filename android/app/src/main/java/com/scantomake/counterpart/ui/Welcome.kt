package com.scantomake.counterpart.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Welcome (PRD §5.10): the two jobs. */
@Composable
fun WelcomeScreen(next: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Brush.radialGradient(listOf(Palette.filament.copy(alpha = 0.30f), Color.Black), radius = 900f,
        center = androidx.compose.ui.geometry.Offset(540f, 80f)))) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(24.dp))
            AppIcon(88.dp)
            Text("Counterpart", fontSize = 34.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 18.dp))
            Text("Make things that fit your life, with your phone, your computer and your 3D printer.", color = Palette.secondary,
                textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp, start = 8.dp, end = 8.dp))
            Spacer(Modifier.height(30.dp))
            JobCard(CIcons.Ruler, "Make something that fits", "Describe it and show what it fits. Your computer designs the part.",
                listOf(CIcons.Bubble to "Describe", CIcons.Camera to "Show"))
            Spacer(Modifier.height(14.dp))
            JobCard(CIcons.Cube, "Copy something", "Scan it. Your computer fixes what the scanner missed and makes it printable.",
                listOf(CIcons.Cube to "Scan", CIcons.Wand to "Fix"))
            Text("Your computer does the designing, cleanup and printing. The next step connects this phone to it.", color = Palette.secondary,
                fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 22.dp, start = 16.dp, end = 16.dp))
            Text("Either way, you'll get a notification when it's ready, and another when the print is done.", color = Palette.secondary,
                fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 22.dp, start = 16.dp, end = 16.dp))
            Spacer(Modifier.height(28.dp))
            PrimaryButton("Continue", Modifier.fillMaxWidth(), onClick = next)
        }
    }
}

@Composable
fun JobCard(art: ImageVector, title: String, detail: String, chips: List<Pair<ImageVector, String>>, onClick: (() -> Unit)? = null) {
    val m = Modifier.fillMaxWidth().let { if (onClick != null) it.clip(RoundedCornerShape(26.dp)).then(Modifier.clickableNoRipple(onClick)) else it }
    GlassCard(m, padding = 12.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(96.dp, 112.dp).clip(RoundedCornerShape(18.dp)).stage(), contentAlignment = Alignment.Center) {
                Icon(art, null, tint = Palette.filament, modifier = Modifier.size(52.dp))
            }
            Spacer(Modifier.width(14.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                Text(detail, color = Palette.secondary, fontSize = 14.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { chips.forEach { Chip(it.first, it.second) } }
            }
        }
    }
}

fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier = this.then(Modifier.clickable(onClick = onClick))

/** Notifications, asked with their reason (PRD §5.10 step 3). */
@Composable
fun NotifyPermissionScreen(done: () -> Unit) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { done() }
    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(1f))
        GlassCard(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AppIcon(38.dp); Spacer(Modifier.width(12.dp))
                Column { Text("Mic mount is ready to print", fontWeight = FontWeight.SemiBold, fontSize = 14.sp); Text("About 1 h 12 m on P1S.", color = Palette.secondary, fontSize = 14.sp) }
            }
        }
        Icon(CIcons.Bell, null, tint = Palette.filament, modifier = Modifier.padding(top = 30.dp).size(40.dp))
        Text("Know when it's ready", fontSize = 28.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 18.dp))
        Text("So you know when it's ready and when the print is done.", color = Palette.secondary, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
        Column(Modifier.padding(top = 26.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Benefit(CIcons.Seal, Palette.filament, "Your computer finished a design or a scan")
            Benefit(CIcons.Hand, Palette.needsYou, "It needs a photo or a yes from you")
            Benefit(CIcons.Printer, Palette.okGreen, "The print is halfway, done, or stopped")
        }
        Spacer(Modifier.weight(1f))
        PrimaryButton("Turn On Notifications", Modifier.fillMaxWidth()) {
            if (Build.VERSION.SDK_INT >= 33) launcher.launch(Manifest.permission.POST_NOTIFICATIONS) else done()
        }
        Spacer(Modifier.height(10.dp))
        SecondaryButton("Not Now", Modifier.fillMaxWidth(), onClick = done)
        Text("Choose which ones in Settings, any time.", color = Palette.secondary, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
    }
}

@Composable
private fun Benefit(icon: ImageVector, tint: Color, text: String) = Row(verticalAlignment = Alignment.CenterVertically) {
    Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp)); Spacer(Modifier.width(14.dp)); Text(text, fontSize = 15.sp)
}
