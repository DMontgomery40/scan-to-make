package com.scantomake.counterpart.scan

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.opengl.GLSurfaceView
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.scantomake.counterpart.app.Media
import com.scantomake.counterpart.ui.CIcons
import com.scantomake.counterpart.ui.Palette
import com.scantomake.counterpart.ui.PrimaryButton
import com.scantomake.counterpart.ui.SecondaryButton
import kotlinx.coroutines.delay
import java.io.File

/**
 * Scan it (first version). With ARCore (and its Depth API where the phone has it) frames are taken as you walk
 * around the object; without ARCore, the camera takes a photo every 1.5 s while you walk. Either way the Mac
 * rebuilds the model from the frames. Done keeps the scan on this phone; Send on New (or the project) sends it.
 */
@Composable
fun ScanScreen(projectId: String, done: () -> Unit) {
    val context = LocalContext.current
    val folder = remember { Media.captureFolder(context, projectId) }
    var camera by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it }
    var availability by remember { mutableStateOf<ArCoreApk.Availability?>(null) }
    var useAr by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(Unit) {
        if (!camera) permission.launch(Manifest.permission.CAMERA)
        // A new scan replaces whatever this project had recorded on the phone.
        folder.deleteRecursively(); folder.mkdirs()
        var a = ArCoreApk.getInstance().checkAvailability(context)
        while (a.isTransient) { delay(200); a = ArCoreApk.getInstance().checkAvailability(context) }
        availability = a
        useAr = a == ArCoreApk.Availability.SUPPORTED_INSTALLED
    }
    DisposableEffect(Unit) {
        val window = (context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }

    fun finish(frames: Int) {
        if (frames >= MIN_FRAMES) File(folder, "finished").writeText(frames.toString())
        done()
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when {
            !camera -> Message("Counterpart needs the camera to scan.", "Allow Camera") { permission.launch(Manifest.permission.CAMERA) }
            useAr == null -> Message("Getting the camera ready…")
            useAr == true -> ArScan(folder, ::finish)
            availability == ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED || availability == ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD ->
                Message("Scanning works best with Google Play Services for AR. Install it, or scan with plain photos.", "Install") {
                    (context as? Activity)?.let { try { ArCoreApk.getInstance().requestInstall(it, true) } catch (_: Exception) {} }
                    useAr = false
                }
            else -> PhotoScan(folder, ::finish)
        }
        IconButton(onClick = done, modifier = Modifier.statusBarsPadding().padding(8.dp)) { Icon(CIcons.Close, "Cancel", tint = Color.White) }
    }
}

const val MIN_FRAMES = 20

@Composable
private fun Message(text: String, button: String? = null, action: () -> Unit = {}) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, textAlign = TextAlign.Center)
        if (button != null) SecondaryButton(button, Modifier.padding(top = 16.dp), onClick = action)
    }
}

private fun sensorOrientation(context: Context, cameraId: String?): Int = try {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    manager.getCameraCharacteristics(cameraId ?: manager.cameraIdList.first()).get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
} catch (_: Exception) { 90 }

@Composable
private fun ArScan(folder: File, finish: (Int) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var progress by remember { mutableStateOf(ScanProgress()) }
    var recording by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf<String?>(null) }
    val holder = remember {
        try {
            val session = Session(context)
            // The sharpest CPU image the camera offers: photogrammetry needs detail.
            session.getSupportedCameraConfigs(CameraConfigFilter(session)).maxByOrNull { it.imageSize.width * it.imageSize.height }?.let { session.cameraConfig = it }
            val config = Config(session).apply {
                focusMode = Config.FocusMode.AUTO
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
                if (session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) depthMode = Config.DepthMode.AUTOMATIC
            }
            session.configure(config)
            val rotation = sensorOrientation(context, session.cameraConfig.cameraId)
            @Suppress("DEPRECATION")
            val display = { (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation }
            session to ArCapture(session, folder, { rotation }, display) { progress = it }
        } catch (e: Exception) { failed = "ARCore couldn't start here (${e.javaClass.simpleName}). Close and try again, or scan with photos."; null }
    }
    if (holder == null) { if (failed != null) PhotoScan(folder, finish); return }
    val (session, capture) = holder
    var view by remember { mutableStateOf<GLSurfaceView?>(null) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> { try { session.resume() } catch (_: Exception) {}; view?.onResume() }
                Lifecycle.Event.ON_PAUSE -> { view?.onPause(); session.pause() }
                else -> {}
            }
        }
        owner.lifecycle.addObserver(observer)
        try { session.resume() } catch (e: Exception) { failed = e.message }
        onDispose { owner.lifecycle.removeObserver(observer); view?.onPause(); session.pause(); capture.close(); session.close() }
    }
    AndroidView(factory = { ctx ->
        GLSurfaceView(ctx).apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 16, 0)
            setRenderer(capture)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
            view = this
        }
    }, Modifier.fillMaxSize())
    Overlay(progress, recording, if (capture.depthSupported) "ARCore · Depth API on" else "ARCore · motion tracking (this phone has no Depth API)",
        start = { capture.reset(); capture.recording = true; recording = true },
        stop = { capture.recording = false; recording = false; finish(capture.frames()) })
}

@Composable
private fun PhotoScan(folder: File, finish: (Int) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val capture = remember { ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build() }
    var recording by remember { mutableStateOf(false) }
    var frames by remember { mutableStateOf(0) }
    LaunchedEffect(recording) {
        while (recording && frames < ArCapture.MAX_FRAMES) {
            val index = frames + 1
            val target = File(folder, "%04d.jpg".format(index))
            capture.takePicture(ImageCapture.OutputFileOptions.Builder(target).build(), ContextCompat.getMainExecutor(context),
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(output: ImageCapture.OutputFileResults) {}
                    override fun onError(exception: ImageCaptureException) { target.delete() }
                })
            frames = index
            delay(1_500)
        }
    }
    AndroidView(factory = { ctx ->
        val view = PreviewView(ctx)
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
            try { provider.unbindAll(); provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture) } catch (_: Exception) {}
        }, ContextCompat.getMainExecutor(ctx))
        view
    }, Modifier.fillMaxSize())
    Overlay(ScanProgress(frames = frames, tracking = true), recording, "Photos every 1.5 s (no ARCore on this phone)",
        start = { folder.listFiles()?.forEach { it.delete() }; frames = 0; recording = true },
        stop = { recording = false; finish(frames) })
}

@Composable
private fun Overlay(progress: ScanProgress, recording: Boolean, mode: String, start: () -> Unit, stop: () -> Unit) {
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(16.dp), verticalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.fillMaxWidth().padding(top = 48.dp).clip(RoundedCornerShape(20.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(14.dp)) {
            Text(when {
                !recording -> "Put the object somewhere you can walk around. Fill most of the view with it, then tap Start."
                !progress.tracking -> "Move the phone slowly so it can find its place."
                progress.distanceM != null && progress.distanceM > 1.0f -> "Come closer: about 30–60 cm from it."
                progress.distanceM != null && progress.distanceM < 0.15f -> "A little further away."
                else -> "Walk slowly all the way around it. Then once more, higher up."
            }, fontSize = 15.sp)
            Text(mode, color = Palette.secondary, fontSize = 12.sp)
            progress.distanceM?.let { Text("About ${(it * 100).toInt()} cm away", color = Palette.secondary, fontSize = 12.sp) }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            if (recording && progress.sectors.any { it }) Canvas(Modifier.size(120.dp)) {
                val r = size.minDimension / 2 - 8
                progress.sectors.forEachIndexed { i, on ->
                    drawArc(if (on) Palette.filament else Color.White.copy(alpha = 0.2f), i * 15f - 90f + 1f, 13f, false,
                        topLeft = Offset(center.x - r, center.y - r), size = androidx.compose.ui.geometry.Size(r * 2, r * 2), style = Stroke(10f))
                }
            }
            Text("${progress.frames} frames" + if (progress.frames < MIN_FRAMES && recording) " · at least $MIN_FRAMES" else "",
                fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(8.dp))
            Row(Modifier.fillMaxWidth()) {
                if (!recording) PrimaryButton("Start", Modifier.fillMaxWidth(), onClick = start)
                else PrimaryButton(if (progress.frames >= MIN_FRAMES) "Done" else "Keep going…", Modifier.fillMaxWidth(), enabled = progress.frames >= MIN_FRAMES, onClick = stop)
            }
        }
    }
}
