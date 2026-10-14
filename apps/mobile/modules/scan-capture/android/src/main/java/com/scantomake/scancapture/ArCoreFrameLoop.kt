package com.scantomake.scancapture

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.GLES11Ext
import android.opengl.GLES20
import com.google.ar.core.Session
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.SessionPausedException

/**
 * Drives `Session.update()` on its own thread with an offscreen GL context.
 * ARCore will not deliver frames without a camera texture, even when nothing
 * is drawn. No preview is rendered yet, so the D004 run is only representative
 * once the AR preview view is added.
 */
internal class ArCoreFrameLoop(
  private val session: Session,
  private val onFrame: (tracking: String) -> Unit,
  private val onError: (message: String) -> Unit,
) : Thread("ScanCaptureArCore") {
  @Volatile private var running = true

  fun shutdown(timeoutMs: Long) {
    running = false
    join(timeoutMs)
  }

  override fun run() {
    val display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    val version = IntArray(2)
    EGL14.eglInitialize(display, version, 0, version, 1)

    val configs = arrayOfNulls<EGLConfig>(1)
    val configCount = IntArray(1)
    EGL14.eglChooseConfig(
      display,
      intArrayOf(
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
        EGL14.EGL_RED_SIZE, 8,
        EGL14.EGL_GREEN_SIZE, 8,
        EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_NONE,
      ),
      0, configs, 0, 1, configCount, 0,
    )
    val config = configs[0]
    if (configCount[0] == 0 || config == null) {
      onError("No EGL config available for the ARCore camera texture.")
      return
    }
    val context = EGL14.eglCreateContext(
      display, config, EGL14.EGL_NO_CONTEXT,
      intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
    )
    val surface = EGL14.eglCreatePbufferSurface(
      display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0,
    )
    EGL14.eglMakeCurrent(display, surface, surface, context)

    val textures = IntArray(1)
    GLES20.glGenTextures(1, textures, 0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textures[0])
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    session.setCameraTextureName(textures[0])

    var lastTimestamp = 0L
    try {
      while (running) {
        // BLOCKING update mode: returns once per camera frame.
        val frame = session.update()
        if (frame.timestamp != 0L && frame.timestamp != lastTimestamp) {
          lastTimestamp = frame.timestamp
          onFrame(frame.camera.trackingState.name)
        }
      }
    } catch (_: SessionPausedException) {
      // Expected while stopping.
    } catch (e: CameraNotAvailableException) {
      onError("Camera not available: ${e.message ?: "unknown"}")
    } catch (e: RuntimeException) {
      if (running) onError("ARCore update failed: ${e.message ?: e.javaClass.simpleName}")
    } finally {
      GLES20.glDeleteTextures(1, textures, 0)
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      EGL14.eglDestroySurface(display, surface)
      EGL14.eglDestroyContext(display, context)
      EGL14.eglReleaseThread()
    }
  }
}
