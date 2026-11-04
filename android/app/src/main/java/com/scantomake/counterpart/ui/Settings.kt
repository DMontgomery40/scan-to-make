package com.scantomake.counterpart.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.Notifications
import com.scantomake.counterpart.core.isPlainText
import com.scantomake.counterpart.core.jsonOf
import com.scantomake.counterpart.core.str
import kotlinx.coroutines.launch

/** Printers (PRD §5.6): the printers configured in the MCPs on the Mac, what they're doing, and what they can do. */
@Composable
fun PrintersScreen(back: () -> Unit) {
    val state = AppState.of(LocalContext.current)
    val catalog by state.catalog.collectAsState()
    LaunchedEffect(Unit) { while (true) { state.loadPrinters(); kotlinx.coroutines.delay(10_000) } }
    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back) { Icon(CIcons.Back, "Back") }
            Text("Printers", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val list = catalog?.destinations
            if (list == null) Text("Reading the printers on your Mac…", color = Palette.secondary)
            else if (list.isEmpty()) Text("No printers are set up on your Mac yet. Add one in Counterpart on your Mac (bambu-printer-mcp or mcp-3D-printer-server).", color = Palette.secondary)
            list?.forEach { d ->
                GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Dot(when (d.state) { "ready" -> Palette.okGreen; "busy", "printing" -> Palette.filament; "offline" -> Palette.failed; else -> Palette.secondary })
                        Spacer(Modifier.width(8.dp))
                        Text(d.name, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        if (d.id == catalog?.defaultDestinationId) Text("Default", color = Palette.filament, fontSize = 12.sp)
                    }
                    Text("${d.modelName} · ${d.stateWords} · via ${d.via}", color = Palette.secondary, fontSize = 13.sp)
                    state.printing(d.id)?.let { Text("Printing ${state.words(it).title}", fontSize = 13.sp) }
                    d.capabilities?.let { c ->
                        Text(listOfNotNull(if (c.progress) "Progress" else null, if (c.camera != "none") "Camera" else null, if (c.pause) "Pause" else null,
                            if (c.filaments != "none") "Filaments" else null).joinToString(" · "), color = Palette.secondary, fontSize = 12.sp)
                        c.update?.message?.takeIf { it.isNotBlank() }?.let { Text(it + " Update it from Counterpart on your Mac.", color = Palette.needsYou, fontSize = 12.sp) }
                    }
                } }
            }
        }
    }
}

/** Settings: this phone's name, the Mac it's paired with, notifications and milestones. */
@Composable
fun SettingsScreen(back: () -> Unit, pairAgain: () -> Unit) {
    val context = LocalContext.current
    val app = Counterpart.instance
    val state = AppState.of(context)
    val scope = rememberCoroutineScope()
    val status by state.status.collectAsState()
    val macName by state.macName.collectAsState()
    var name by remember { mutableStateOf(app.prefs.getString(Counterpart.DEVICE_NAME_KEY, null) ?: app.pairingStore.deviceName()) }
    var milestones by remember { mutableStateOf<String?>(null) }
    var forget by remember { mutableStateOf(false) }
    var notifications by remember { mutableStateOf(Notifications.allowed(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notifications = it }
    LaunchedEffect(Unit) { milestones = try { app.companion.settings()["milestones"].str } catch (_: Exception) { null } }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back) { Icon(CIcons.Back, "Back") }
            Text("Settings", fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
        }
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SectionTitle("Your Mac")
            GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(macName ?: "Your Mac", fontWeight = FontWeight.SemiBold)
                Text("Address in use: ${status?.host ?: "–"}", color = Palette.secondary, fontSize = 13.sp)
                status?.expiresAtMs?.let { Text("Pairing renews by itself; next renewal before ${java.text.DateFormat.getDateInstance().format(java.util.Date(it.toLong()))}", color = Palette.secondary, fontSize = 12.sp) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    SecondaryButton("Connect a Different Mac", Modifier.weight(1f), onClick = pairAgain)
                }
                SecondaryButton("Forget This Mac", Modifier.fillMaxWidth(), color = Palette.failed) { forget = true }
            } }
            SectionTitle("This phone")
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Name your Mac shows") }, singleLine = true)
            SecondaryButton("Save Name", Modifier.fillMaxWidth(), enabled = isPlainText(name, 80)) { app.prefs.edit().putString(Counterpart.DEVICE_NAME_KEY, name.trim()).apply() }
            Text("Your Mac shows the new name after you reopen Counterpart here.", color = Palette.secondary, fontSize = 12.sp)

            SectionTitle("Notifications")
            if (!notifications) SecondaryButton("Turn On Notifications", Modifier.fillMaxWidth()) {
                if (Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else SecondaryButton("Choose Which Ones", Modifier.fillMaxWidth()) {
                context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            }
            Text("Print milestones", fontWeight = FontWeight.Medium)
            val options = listOf("off" to "Off", "50" to "Halfway", "25-50-75" to "Every quarter", "every-10" to "Every 10%")
            options.forEach { (value, label) ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.card).clickable {
                    scope.launch { try { milestones = app.companion.changeSettings(jsonOf("milestones" to value))["milestones"].str } catch (_: Exception) {} }
                }.padding(14.dp)) { Text(label, Modifier.weight(1f)); if (milestones == value) Icon(CIcons.Tick, null, tint = Palette.filament) }
            }
            Text("Notifications come from your Mac over your Wi-Fi (or Tailscale). Away from both, they arrive when the phone can reach your Mac again.",
                color = Palette.secondary, fontSize = 12.sp)
            SectionTitle("About")
            Text("Counterpart for Android 0.1.0 · open source · github.com/DMontgomery40/scan-to-make", color = Palette.secondary, fontSize = 13.sp)
        }
    }
    if (forget) AlertDialog(onDismissRequest = { forget = false }, title = { Text("Forget This Mac?") },
        text = { Text("This phone stops connecting to it. Your projects stay on your Mac; pair again to see them.") },
        confirmButton = { TextButton({ forget = false; state.forgetMac() }) { Text("Forget This Mac", color = Palette.failed) } },
        dismissButton = { TextButton({ forget = false }) { Text("Cancel") } })
}
