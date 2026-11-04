package com.scantomake.counterpart.scan

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import com.google.ar.core.Config
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import com.scantomake.counterpart.core.Hex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicInteger
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.atan2
import kotlin.math.sqrt

/** What the scan screen shows while recording. */
data class ScanProgress(
    val frames: Int = 0,
    val tracking: Boolean = false,
    /** 24 sectors of 15° around the object, true where the phone has looked from. */
    val sectors: List<Boolean> = List(24) { false },
    /** Distance to what's in the middle of the view, from the Depth API, in metres. */
    val distanceM: Float? = null,
    val depth: Boolean = false,
)

/**
 * A walk-around capture with ARCore: the camera's motion tracking decides when the phone has moved far enough for
 * a new frame, so frames are spread around the object rather than taken on a timer. Where the phone supports the
 * Depth API (depth from motion; no Android phone has LiDAR) it is on, and used to show how far away the object
 * is. Frames are saved as `NNNN.jpg` in `folder`; the Mac rebuilds the model from them (Apple photogrammetry).
 */
class ArCapture(private val session: Session, private val folder: File, private val sensorRotation: () -> Int,
                private val displayRotation: () -> Int, private val update: (ScanProgress) -> Unit) : GLSurfaceView.Renderer {
    @Volatile var recording = false
    private val count = AtomicInteger(0)
    private val encoder = Executors.newSingleThreadExecutor()
    /** One future per submitted frame, in capture order; finishing awaits these off the UI thread. */
    private val saves: MutableList<Future<CaptureCameraFrame>> = Collections.synchronizedList(mutableListOf())
    private var lastPose: Pose? = null
    private var lastAt = 0L
    private var anchor: FloatArray? = null
    private val sectors = BooleanArray(24)
    private var width = 1
    private var height = 1
    val depthSupported: Boolean = session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)

    private var texture = 0
    private var program = 0
    private val quad: FloatBuffer = floats(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
    private val uv: FloatBuffer = floats(FloatArray(8))

    companion object {
        const val MAX_FRAMES = 150
        private fun floats(a: FloatArray): FloatBuffer = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(a); position(0) }
        private const val VERTEX = "attribute vec4 a_Position; attribute vec2 a_TexCoord; varying vec2 v_TexCoord;" +
            "void main() { gl_Position = a_Position; v_TexCoord = a_TexCoord; }"
        private const val FRAGMENT = "#extension GL_OES_EGL_image_external : require\nprecision mediump float; varying vec2 v_TexCoord;" +
            "uniform samplerExternalOES s_Texture; void main() { gl_FragColor = texture2D(s_Texture, v_TexCoord); }"

        /** YUV_420_888 to NV21, honouring row and pixel strides. */
        fun nv21(image: Image): ByteArray {
            val w = image.width; val h = image.height
            val out = ByteArray(w * h * 3 / 2)
            val y = image.planes[0]; val u = image.planes[1]; val v = image.planes[2]
            var pos = 0
            val yBuf = y.buffer
            for (row in 0 until h) { yBuf.position(row * y.rowStride); yBuf.get(out, pos, w); pos += w }
            val uBuf = u.buffer; val vBuf = v.buffer
            for (row in 0 until h / 2) for (col in 0 until w / 2) {
                val vi = row * v.rowStride + col * v.pixelStride
                val ui = row * u.rowStride + col * u.pixelStride
                out[pos++] = vBuf.get(vi); out[pos++] = uBuf.get(ui)
            }
            return out
        }
    }

    fun frames() = count.get()

    @Synchronized
    fun reset() {
        check(saves.all { it.isDone }) { "The previous scan is still saving." }
        folder.listFiles()?.filter {
            Regex("[0-9]{4}\\.jpg(?:\\.part)?").matches(it.name) ||
                it.name in setOf("capture-camera.json", "capture-kind", "finished")
        }?.forEach { check(it.delete()) { "The previous scan could not be cleared." } }
        count.set(0); lastPose = null; anchor = null; sectors.fill(false); saves.clear()
    }

    /** What finishing a capture learned from the encoder: the frames actually saved, and how many failed. */
    data class SavedFrames(val frames: List<CaptureCameraFrame>, val failed: Int)

    /**
     * Waits (off the UI thread) until every submitted frame is written, then returns the successful frames
     * with their capture-camera metadata. Callers must not write the finished marker or navigate before
     * this returns, and must look at `failed` rather than assuming the submitted count was saved.
     */
    suspend fun awaitSaved(): SavedFrames = withContext(Dispatchers.IO) {
        // The same lock guards camera-frame submission. Stop cannot miss a frame whose
        // capture was already in progress when Done was tapped.
        val pending = synchronized(this@ArCapture) { recording = false; saves.toList() }
        val saved = mutableListOf<CaptureCameraFrame>()
        var failed = 0
        for (future in pending) {
            try { saved += future.get() } catch (_: Exception) { failed += 1 }
        }
        SavedFrames(saved.sortedBy { it.image }, failed)
    }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        val t = IntArray(1); GLES20.glGenTextures(1, t, 0); texture = t[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        session.setCameraTextureName(texture)
        fun shader(type: Int, src: String) = GLES20.glCreateShader(type).also { GLES20.glShaderSource(it, src); GLES20.glCompileShader(it) }
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, VERTEX))
        GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT))
        GLES20.glLinkProgram(program)
    }

    override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) {
        width = w; height = h
        GLES20.glViewport(0, 0, w, h)
        session.setDisplayGeometry(displayRotation(), w, h)
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val frame = try { session.update() } catch (_: Exception) { return }
        if (frame.hasDisplayGeometryChanged()) {
            quad.position(0); uv.position(0)
            frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, quad, Coordinates2d.TEXTURE_NORMALIZED, uv)
            quad.position(0); uv.position(0)
        }
        if (frame.timestamp != 0L) draw()
        track(frame)
    }

    private fun draw() {
        GLES20.glDisable(GLES20.GL_DEPTH_TEST); GLES20.glDepthMask(false)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        val pos = GLES20.glGetAttribLocation(program, "a_Position")
        val tex = GLES20.glGetAttribLocation(program, "a_TexCoord")
        GLES20.glVertexAttribPointer(pos, 2, GLES20.GL_FLOAT, false, 0, quad)
        GLES20.glVertexAttribPointer(tex, 2, GLES20.GL_FLOAT, false, 0, uv)
        GLES20.glEnableVertexAttribArray(pos); GLES20.glEnableVertexAttribArray(tex)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(pos); GLES20.glDisableVertexAttribArray(tex)
        GLES20.glDepthMask(true); GLES20.glEnable(GLES20.GL_DEPTH_TEST)
    }

    private fun centreDepth(frame: Frame): Float? {
        if (!depthSupported) return null
        return try {
            frame.acquireDepthImage16Bits().use { depth ->
                val plane = depth.planes[0]
                val x = depth.width / 2; val y = depth.height / 2
                val mm = plane.buffer.order(ByteOrder.nativeOrder()).getShort(y * plane.rowStride + x * plane.pixelStride).toInt() and 0xffff
                if (mm == 0) null else mm / 1000f
            }
        } catch (_: NotYetAvailableException) { null } catch (_: Exception) { null }
    }

    @Synchronized
    private fun track(frame: Frame) {
        val camera = frame.camera
        val tracking = camera.trackingState == TrackingState.TRACKING
        val distance = if (tracking) centreDepth(frame) else null
        if (tracking && recording) {
            val pose = camera.pose
            if (anchor == null) {
                // The object: where the centre of the view lands (depth or a plane), else 40 cm ahead.
                val hit = frame.hitTest(width / 2f, height / 2f).firstOrNull()?.hitPose
                val ahead = distance ?: 0.4f
                anchor = hit?.let { floatArrayOf(it.tx(), it.ty(), it.tz()) }
                    ?: pose.compose(Pose.makeTranslation(0f, 0f, -ahead)).let { floatArrayOf(it.tx(), it.ty(), it.tz()) }
            }
            val now = System.currentTimeMillis()
            val last = lastPose
            val moved = last == null || dist(last, pose) > 0.04f || angle(last, pose) > 10f
            if (moved && now - lastAt > 350 && count.get() < MAX_FRAMES) {
                try {
                    // Snapshot this frame's CPU-image intrinsics, pose and timestamp now: they belong to
                    // this frame, and ARCore may report different values for the next one.
                    val intrinsics = camera.imageIntrinsics
                    val focal = intrinsics.focalLength; val principal = intrinsics.principalPoint; val intrDims = intrinsics.imageDimensions
                    val snapshot = Snapshot(
                        fx = focal[0].toDouble(), fy = focal[1].toDouble(),
                        cx = principal[0].toDouble(), cy = principal[1].toDouble(),
                        intrinsicsWidth = intrDims[0], intrinsicsHeight = intrDims[1],
                        timestampMs = frame.timestamp / 1_000_000,
                        tracking = CaptureCamera.trackingWord(camera.trackingState.name),
                        center = listOf(pose.tx().toDouble(), pose.ty().toDouble(), pose.tz().toDouble()),
                    )
                    frame.acquireCameraImage().use { image ->
                        val bytes = nv21(image); val w = image.width; val h = image.height
                        val index = count.incrementAndGet()
                        val rotation = sensorRotation()
                        val name = "%04d.jpg".format(index)
                        saves += encoder.submit<CaptureCameraFrame> { save(bytes, w, h, rotation, File(folder, name), name, snapshot) }
                    }
                    lastPose = pose; lastAt = now
                    anchor?.let { a -> sectors[(((Math.toDegrees(atan2((pose.tx() - a[0]).toDouble(), (pose.tz() - a[2]).toDouble())) + 360) % 360) / 15).toInt() % 24] = true }
                } catch (_: NotYetAvailableException) {} catch (_: Exception) {}
            }
        }
        update(ScanProgress(count.get(), tracking, sectors.toList(), distance, depthSupported))
    }

    private fun dist(a: Pose, b: Pose): Float {
        val dx = a.tx() - b.tx(); val dy = a.ty() - b.ty(); val dz = a.tz() - b.tz()
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    private fun angle(a: Pose, b: Pose): Float {
        val qa = a.rotationQuaternion; val qb = b.rotationQuaternion
        val dot = kotlin.math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]).coerceAtMost(1f)
        return Math.toDegrees(2.0 * kotlin.math.acos(dot.toDouble())).toFloat()
    }

    /** One frame's camera snapshot, taken on the GL thread at acquire time. */
    private data class Snapshot(
        val fx: Double, val fy: Double, val cx: Double, val cy: Double,
        val intrinsicsWidth: Int, val intrinsicsHeight: Int,
        val timestampMs: Long, val tracking: String, val center: List<Double>,
    )

    /**
     * Encodes one frame and returns its capture-camera record, bound to the exact bytes written: the hash
     * and size are read from the final JPEG, and the intrinsics are carried through the same rotation.
     * Throws when the frame could not be saved, so finishing can say so instead of counting it.
     */
    private fun save(nv21: ByteArray, w: Int, h: Int, rotation: Int, target: File, name: String, snapshot: Snapshot): CaptureCameraFrame {
        val out = ByteArrayOutputStream()
        YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), 92, out)
        var bytes = out.toByteArray()
        if (bytes.isEmpty()) throw IllegalStateException("empty frame")
        if (rotation % 360 != 0) {
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IllegalStateException("undecodable frame")
            val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
            val o2 = ByteArrayOutputStream(); turned.compress(Bitmap.CompressFormat.JPEG, 92, o2); bytes = o2.toByteArray()
            bitmap.recycle(); turned.recycle()
            if (bytes.isEmpty()) throw IllegalStateException("empty rotated frame")
        }
        val saved = CaptureCamera.savedIntrinsics(
            snapshot.fx, snapshot.fy, snapshot.cx, snapshot.cy,
            snapshot.intrinsicsWidth, snapshot.intrinsicsHeight, w, h, rotation)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth != saved.width || bounds.outHeight != saved.height)
            throw IllegalStateException("saved size ${bounds.outWidth}x${bounds.outHeight} != expected ${saved.width}x${saved.height}")
        if (saved.width < 16 || saved.height < 16 || !(saved.fx > 0) || !(saved.fy > 0) || snapshot.center.any { !it.isFinite() })
            throw IllegalStateException("implausible camera metadata")
        val temp = File(target.path + ".part")
        temp.writeBytes(bytes)
        if (!temp.renameTo(target)) { temp.delete(); throw IllegalStateException("could not save frame") }
        return CaptureCameraFrame(
            image = name, sha256 = Hex.sha256(bytes), width = saved.width, height = saved.height,
            fx = saved.fx, fy = saved.fy, cx = saved.cx, cy = saved.cy,
            timestampMs = maxOf(0, snapshot.timestampMs), tracking = snapshot.tracking, center = snapshot.center)
    }

    /** Never blocks: finishing awaits [awaitSaved]; disposal lets queued writes drain. */
    fun close() { encoder.shutdown() }
}
