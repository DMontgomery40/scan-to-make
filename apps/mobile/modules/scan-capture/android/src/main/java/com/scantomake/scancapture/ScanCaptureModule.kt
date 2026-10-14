package com.scantomake.scancapture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@ReactModule(name = ScanCaptureModule.NAME)
class ScanCaptureModule(reactContext: ReactApplicationContext) :
  NativeScanCaptureSpec(reactContext) {

  private val lock = Any()
  private var session: Session? = null
  private var frameLoop: ArCoreFrameLoop? = null
  private var sampler: ScheduledExecutorService? = null

  private val framesInWindow = AtomicInteger(0)
  @Volatile private var tracking = "STOPPED"
  private var startedAtNs = 0L
  private var windowStartedAtNs = 0L

  override fun getName() = NAME

  override fun isSupported(promise: Promise) {
    val availability = ArCoreApk.getInstance().checkAvailability(reactApplicationContext)
    promise.resolve(availability == ArCoreApk.Availability.SUPPORTED_INSTALLED)
  }

  override fun startSession(sampleIntervalMs: Double, promise: Promise) {
    if (reactApplicationContext.checkSelfPermission(Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("scan_capture_permission", "Camera permission is required.")
      return
    }

    synchronized(lock) {
      stopLocked()
      val session =
        try {
          Session(reactApplicationContext)
        } catch (e: Exception) {
          promise.reject("scan_capture_start", e.message ?: e.javaClass.simpleName, e)
          return
        }

      val depthEnabled = session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
      session.configure(
        Config(session).apply {
          focusMode = Config.FocusMode.AUTO
          updateMode = Config.UpdateMode.BLOCKING
          if (depthEnabled) depthMode = Config.DepthMode.AUTOMATIC
        },
      )

      try {
        session.resume()
      } catch (e: Exception) {
        session.close()
        promise.reject("scan_capture_start", e.message ?: e.javaClass.simpleName, e)
        return
      }

      val now = SystemClock.elapsedRealtimeNanos()
      startedAtNs = now
      windowStartedAtNs = now
      framesInWindow.set(0)
      tracking = "PAUSED"

      val loop = ArCoreFrameLoop(
        session,
        onFrame = { state ->
          framesInWindow.incrementAndGet()
          tracking = state
        },
        onError = { message -> emitOnError(message) },
      )
      loop.start()

      val intervalMs = sampleIntervalMs.toLong().coerceAtLeast(100L)
      val executor = Executors.newSingleThreadScheduledExecutor()
      executor.scheduleAtFixedRate({ emitWindow() }, intervalMs, intervalMs, TimeUnit.MILLISECONDS)

      this.session = session
      this.frameLoop = loop
      this.sampler = executor

      promise.resolve(
        Arguments.createMap().apply {
          putString("framework", "arcore")
          putString("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
          putString("osVersion", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
          putBoolean("depthEnabled", depthEnabled)
          putBoolean("meshEnabled", false)
        },
      )
    }
  }

  override fun stopSession(promise: Promise) {
    synchronized(lock) { stopLocked() }
    promise.resolve(null)
  }

  override fun invalidate() {
    synchronized(lock) { stopLocked() }
    super.invalidate()
  }

  private fun stopLocked() {
    sampler?.shutdownNow()
    sampler = null
    val loop = frameLoop
    val session = session
    frameLoop = null
    this.session = null
    // update() may be blocked waiting for a frame; pausing unblocks it.
    loop?.shutdown(STOP_TIMEOUT_MS)
    session?.pause()
    loop?.join(STOP_TIMEOUT_MS)
    session?.close()
    tracking = "STOPPED"
  }

  private fun emitWindow() {
    val now = SystemClock.elapsedRealtimeNanos()
    val frames = framesInWindow.getAndSet(0)
    val sample = Arguments.createMap().apply {
      putDouble("tMs", (now - startedAtNs) / 1e6)
      putDouble("intervalMs", (now - windowStartedAtNs) / 1e6)
      putInt("frames", frames)
      putString("thermal", thermalStatus())
      putString("tracking", tracking)
    }
    windowStartedAtNs = now
    emitOnSample(sample)
  }

  private fun thermalStatus(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unavailable"
    val power = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    return when (power.currentThermalStatus) {
      PowerManager.THERMAL_STATUS_NONE -> "none"
      PowerManager.THERMAL_STATUS_LIGHT -> "light"
      PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
      PowerManager.THERMAL_STATUS_SEVERE -> "severe"
      PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
      PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
      PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
      else -> "unknown"
    }
  }

  companion object {
    const val NAME = "ScanCapture"
    private const val STOP_TIMEOUT_MS = 500L
  }
}
