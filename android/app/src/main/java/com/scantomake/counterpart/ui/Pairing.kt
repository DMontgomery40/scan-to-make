package com.scantomake.counterpart.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.pairing.NearbyCrypto
import com.scantomake.counterpart.pairing.NearbyMac
import com.scantomake.counterpart.pairing.NearbyStarted
import com.scantomake.counterpart.pairing.PairingInvitation
import com.scantomake.counterpart.pairing.PairingLink
import com.scantomake.counterpart.pairing.PairingWords
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

/** Find your Mac (PRD §5.10 step 2): scan the Mac's QR code, open its link, or pair with a Mac on this Wi-Fi. */
@Composable
fun FindYourMacScreen(replace: Boolean = false, onPaired: () -> Unit, cancel: (() -> Unit)? = null) {
    val context = LocalContext.current
    val app = Counterpart.instance
    val state = AppState.of(context)
    val scope = rememberCoroutineScope()
    val pendingLink by state.pendingLink.collectAsState()
    var working by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var connected by remember { mutableStateOf<String?>(null) }
    var nearby by remember { mutableStateOf<List<NearbyMac>?>(null) }
    var looking by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf<NearbyStarted?>(null) }
    var pasted by remember { mutableStateOf("") }
    var camera by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var job by remember { mutableStateOf<Job?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it }

    fun finish(name: String?) {
        connected = name ?: state.macName.value ?: "your Mac"
        state.readStatus()
        scope.launch { state.loadCapabilities(); delay(1200); onPaired() }
    }

    fun pair(text: String) {
        if (working != null) return
        problem = null
        val invitation = try { PairingInvitation.parse(text) } catch (e: Exception) { problem = PairingWords.failure(e); return }
        working = "Pairing with ${invitation.name ?: "your Mac"}…"
        job = scope.launch {
            try {
                app.pairing.pair(invitation, app.pairingStore.deviceName())
                invitation.name?.let { app.prefs.edit().putString(AppState.MAC_NAME_KEY, it).apply(); state.macName.value = it }
                state.pendingLink.value = null
                finish(invitation.name)
            } catch (e: Exception) { problem = PairingWords.failure(e) } finally { working = null }
        }
    }

    LaunchedEffect(pendingLink) { pendingLink?.let { pair(it) } }
    LaunchedEffect(Unit) { if (!camera) permission.launch(Manifest.permission.CAMERA) }
    DisposableEffect(Unit) { onDispose { app.nearby.stopBrowsing() } }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (cancel != null) Row(Modifier.fillMaxWidth()) {
            IconButton(onClick = { job?.cancel(); cancel() }) { Icon(CIcons.Close, "Cancel") }
        }
        connected?.let {
            Spacer(Modifier.height(80.dp))
            Icon(CIcons.Check, null, tint = Palette.okGreen, modifier = Modifier.size(72.dp))
            Text("Connected to $it", fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            return@Column
        }
        Text("Find your Mac", fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text(if (replace) "This phone is paired with a Mac. Pairing with another one replaces it."
            else "On your Mac, open Counterpart. Point your camera at the code it shows.", color = Palette.secondary, textAlign = TextAlign.Center)

        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(28.dp)).background(Palette.card).border(2.dp, Palette.filament.copy(alpha = 0.6f), RoundedCornerShape(28.dp)),
            contentAlignment = Alignment.Center) {
            when {
                working != null -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(color = Palette.filament); Spacer(Modifier.height(12.dp)); Text(working!!)
                }
                code != null -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(20.dp)) {
                    Text("Code", color = Palette.secondary)
                    Text(NearbyCrypto.display(code!!.code), fontSize = 44.sp, fontWeight = FontWeight.Bold, color = Palette.filament)
                    Text("Make sure your Mac shows the same number, then click Allow on your Mac.", textAlign = TextAlign.Center, color = Palette.secondary)
                    Spacer(Modifier.height(10.dp)); Text("Waiting for your Mac…")
                }
                camera -> QrScanner(Modifier.fillMaxSize()) { text -> if (PairingLink.isPairingLink(text) || text.trim().startsWith("{")) pair(text) }
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(20.dp)) {
                    Icon(CIcons.Qr, null, tint = Palette.secondary, modifier = Modifier.size(56.dp))
                    Text("Counterpart needs the camera to read your Mac's code.", textAlign = TextAlign.Center, color = Palette.secondary)
                    Spacer(Modifier.height(10.dp))
                    SecondaryButton("Allow Camera") { permission.launch(Manifest.permission.CAMERA) }
                }
            }
        }
        problem?.let { Text(it, color = Palette.failed, textAlign = TextAlign.Center) }

        // Nearby: the Mac on this Wi-Fi (Bonjour), both screens show the same 6-digit code.
        GlassCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(CIcons.Wifi, null, tint = Palette.filament); Spacer(Modifier.width(10.dp))
                    Text("On this Wi-Fi · Counterpart is open", fontWeight = FontWeight.SemiBold)
                }
                when {
                    looking -> Text("Looking for your Mac on this Wi-Fi…", color = Palette.secondary)
                    nearby?.isEmpty() == true -> Text("No Mac found on this Wi-Fi. Are they on the same Wi-Fi, or is your VPN on?", color = Palette.secondary)
                    else -> {}
                }
                nearby?.forEach { mac ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.card).clickable(enabled = working == null && code == null) {
                        problem = null
                        job = scope.launch {
                            try {
                                app.nearby.pair(mac, app.pairingStore.deviceName()) { code = it }
                                app.prefs.edit().putString(AppState.MAC_NAME_KEY, mac.name).apply(); state.macName.value = mac.name
                                finish(mac.name)
                            } catch (e: Exception) { problem = PairingWords.failure(e) } finally { code = null }
                        }
                    }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(mac.name, Modifier.weight(1f), fontWeight = FontWeight.Medium); Text("Pair", color = Palette.filament)
                    }
                }
                SecondaryButton(if (nearby == null) "Look on This Wi-Fi" else "Look Again", Modifier.fillMaxWidth(), enabled = !looking && working == null) {
                    looking = true
                    scope.launch {
                        try { nearby = app.nearby.browse() } catch (e: Exception) { problem = PairingWords.failure(e) } finally { looking = false }
                    }
                }
            }
        }

        // The link from the Mac, pasted (for example sent from the Mac by Messages or e-mail).
        GlassCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Or paste the link from your Mac", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(pasted, { pasted = it }, Modifier.fillMaxWidth(), placeholder = { Text("scantomake://pair?…") }, singleLine = true)
                SecondaryButton("Pair", Modifier.fillMaxWidth(), enabled = pasted.isNotBlank() && working == null) { pair(pasted.trim()) }
            }
        }
    }
}

/** The camera, reading QR codes (CameraX + ZXing). Calls `found` with each code's text. */
@Composable
fun QrScanner(modifier: Modifier, found: (String) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val reader = remember { MultiFormatReader().apply { setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)) } }
    var last by remember { mutableStateOf("") }
    DisposableEffect(Unit) { onDispose { executor.shutdown(); try { ProcessCameraProvider.getInstance(context).get().unbindAll() } catch (_: Exception) {} } }
    AndroidView(factory = { ctx ->
        val view = PreviewView(ctx)
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { image ->
                try {
                    val plane = image.planes[0]
                    val buffer = plane.buffer
                    val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
                    val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                    val text = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
                    if (text != last) { last = text; ContextCompat.getMainExecutor(ctx).execute { found(text) } }
                } catch (_: Exception) { } finally { reader.reset(); image.close() }
            }
            try { provider.unbindAll(); provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) } catch (_: Exception) {}
        }, ContextCompat.getMainExecutor(ctx))
        view
    }, modifier = modifier)
}
