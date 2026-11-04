package com.scantomake.counterpart.ui

import android.content.Context
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.max
import kotlin.math.sqrt

/** A box drawn over the mesh, in the same preview coordinates. `axis` (0/1/2) accents its parallel edges. */
data class MeshHighlight(val min: FloatArray, val max: FloatArray, val axis: Int? = null)

/**
 * An orbit/zoom view of a real triangle mesh (OpenGL ES 2.0, flat-shaded), framed on given bounds and
 * able to draw a selection box in the mesh's own coordinates. Drag turns it; pinch zooms.
 */
class MeshSurfaceView(context: Context) : GLSurfaceView(context) {
    private val renderer = MeshRenderer()
    @Volatile private var azimuth = 35f
    @Volatile private var elevation = 22f
    @Volatile private var zoom = 1f

    private val orbit = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            azimuth -= dx * 0.4f
            elevation = (elevation - dy * 0.4f).coerceIn(-85f, 85f)
            requestRender()
            return true
        }
    })
    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            zoom = (zoom * detector.scaleFactor).coerceIn(0.35f, 6f)
            requestRender()
            return true
        }
    })

    init {
        setEGLContextClientVersion(2)
        preserveEGLContextOnPause = true
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        pinch.onTouchEvent(event)
        if (!pinch.isInProgress) orbit.onTouchEvent(event)
        return true
    }

    fun show(mesh: StlMesh, frameMin: FloatArray, frameMax: FloatArray) {
        azimuth = 35f; elevation = 22f; zoom = 1f
        queueEvent { renderer.setMesh(mesh, frameMin, frameMax) }
        requestRender()
    }

    fun highlight(box: MeshHighlight?) {
        queueEvent { renderer.setHighlight(box) }
        requestRender()
    }

    private inner class MeshRenderer : Renderer {
        private var program = 0
        private var meshBuffers = IntArray(2)
        private var lineBuffer = IntArray(1)
        private var triangleCount = 0
        private var lineCount = 0
        private var axisLineStart = 0
        private var axisLineCount = 0
        private var center = FloatArray(3)
        private var radius = 1f
        private val projection = FloatArray(16)
        private val view = FloatArray(16)
        private val model = FloatArray(16)
        private val mvp = FloatArray(16)
        private val normalM = FloatArray(16)

        fun setMesh(mesh: StlMesh, frameMin: FloatArray, frameMax: FloatArray) {
            GLES20.glDeleteBuffers(2, meshBuffers, 0)
            GLES20.glGenBuffers(2, meshBuffers, 0)
            upload(meshBuffers[0], mesh.positions)
            upload(meshBuffers[1], mesh.normals)
            triangleCount = mesh.renderedTriangles
            center = FloatArray(3) { (frameMin[it] + frameMax[it]) / 2 }
            var r = 0f
            for (a in 0 until 3) r = max(r, (frameMax[a] - frameMin[a]) / 2)
            radius = if (r > 0f && r.isFinite()) r * sqrt(2f) else 1f
        }

        fun setHighlight(box: MeshHighlight?) {
            lineCount = 0; axisLineCount = 0; axisLineStart = 0
            if (box == null || box.min.size != 3 || box.max.size != 3) return
            val edges = boxEdges(box.min, box.max)
            val all = ArrayList<Float>()
            val accent = ArrayList<Float>()
            for ((a, b) in edges) {
                val target = if (box.axis != null && edgeAxis(a, b) == box.axis) accent else all
                a.forEach { target += it }; b.forEach { target += it }
            }
            val joined = FloatArray(all.size + accent.size) { i -> if (i < all.size) all[i] else accent[i - all.size] }
            GLES20.glDeleteBuffers(1, lineBuffer, 0)
            GLES20.glGenBuffers(1, lineBuffer, 0)
            upload(lineBuffer[0], joined)
            lineCount = all.size / 3
            axisLineStart = lineCount
            axisLineCount = accent.size / 3
        }

        private fun edgeAxis(a: FloatArray, b: FloatArray): Int = (0 until 3).firstOrNull { a[it] != b[it] } ?: -1

        private fun boxEdges(lo: FloatArray, hi: FloatArray): List<Pair<FloatArray, FloatArray>> {
            val c = (0 until 8).map { i -> floatArrayOf(if (i and 1 == 0) lo[0] else hi[0], if (i and 2 == 0) lo[1] else hi[1], if (i and 4 == 0) lo[2] else hi[2]) }
            val pairs = listOf(0 to 1, 0 to 2, 0 to 4, 1 to 3, 1 to 5, 2 to 3, 2 to 6, 3 to 7, 4 to 5, 4 to 6, 5 to 7, 6 to 7)
            return pairs.map { (a, b) -> c[a] to c[b] }
        }

        private fun upload(buffer: Int, data: FloatArray) {
            val fb: FloatBuffer = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(data); position(0) }
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, buffer)
            GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, data.size * 4, fb, GLES20.GL_STATIC_DRAW)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        }

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            GLES20.glClearColor(0.05f, 0.05f, 0.07f, 1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            fun shader(type: Int, src: String) = GLES20.glCreateShader(type).also { GLES20.glShaderSource(it, src); GLES20.glCompileShader(it) }
            program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, VERTEX))
            GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT))
            GLES20.glLinkProgram(program)
        }

        override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) {
            GLES20.glViewport(0, 0, w, h)
            Matrix.perspectiveM(projection, 0, 40f, if (h == 0) 1f else w.toFloat() / h, 0.1f, 1000f)
        }

        override fun onDrawFrame(gl: GL10?) {
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            if (triangleCount == 0 || program == 0) return
            val distance = radius * 3.2f / max(0.1f, zoom)
            Matrix.setLookAtM(view, 0, 0f, 0f, distance, 0f, 0f, 0f, 0f, 1f, 0f)
            Matrix.setIdentityM(model, 0)
            Matrix.rotateM(model, 0, elevation, 1f, 0f, 0f)
            Matrix.rotateM(model, 0, azimuth, 0f, 1f, 0f)
            Matrix.translateM(model, 0, -center[0], -center[1], -center[2])
            Matrix.multiplyMM(normalM, 0, view, 0, model, 0)
            Matrix.multiplyMM(mvp, 0, projection, 0, normalM, 0)
            GLES20.glUseProgram(program)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "u_MVP"), 1, false, mvp, 0)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "u_Normal"), 1, false, normalM, 0)
            val posLoc = GLES20.glGetAttribLocation(program, "a_Position")
            val normLoc = GLES20.glGetAttribLocation(program, "a_Normal")
            val colourLoc = GLES20.glGetUniformLocation(program, "u_Colour")
            val flatLoc = GLES20.glGetUniformLocation(program, "u_Flat")
            // The mesh itself.
            GLES20.glUniform1f(flatLoc, 0f)
            GLES20.glUniform4f(colourLoc, 0.72f, 0.78f, 0.84f, 1f)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, meshBuffers[0])
            GLES20.glVertexAttribPointer(posLoc, 3, GLES20.GL_FLOAT, false, 0, 0)
            GLES20.glEnableVertexAttribArray(posLoc)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, meshBuffers[1])
            GLES20.glVertexAttribPointer(normLoc, 3, GLES20.GL_FLOAT, false, 0, 0)
            GLES20.glEnableVertexAttribArray(normLoc)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, triangleCount * 3)
            // The selection box over it.
            if (lineCount + axisLineCount > 0) {
                GLES20.glUniform1f(flatLoc, 1f)
                GLES20.glDisableVertexAttribArray(normLoc)
                GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, lineBuffer[0])
                GLES20.glVertexAttribPointer(posLoc, 3, GLES20.GL_FLOAT, false, 0, 0)
                GLES20.glLineWidth(2f)
                if (lineCount > 0) {
                    GLES20.glUniform4f(colourLoc, 1f, 0.62f, 0.04f, 0.55f)
                    GLES20.glDrawArrays(GLES20.GL_LINES, 0, lineCount)
                }
                if (axisLineCount > 0) {
                    GLES20.glUniform4f(colourLoc, 1f, 0.45f, 0.18f, 1f)
                    GLES20.glLineWidth(4f)
                    GLES20.glDrawArrays(GLES20.GL_LINES, axisLineStart, axisLineCount)
                }
            }
            GLES20.glDisableVertexAttribArray(posLoc)
            GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        }
    }

    companion object {
        private const val VERTEX = """
            attribute vec4 a_Position; attribute vec3 a_Normal;
            uniform mat4 u_MVP; uniform mat4 u_Normal;
            varying vec3 v_Normal;
            void main() { gl_Position = u_MVP * a_Position; v_Normal = normalize(mat3(u_Normal[0].xyz, u_Normal[1].xyz, u_Normal[2].xyz) * a_Normal); }
        """
        private const val FRAGMENT = """
            precision mediump float;
            uniform vec4 u_Colour; uniform float u_Flat;
            varying vec3 v_Normal;
            void main() {
              if (u_Flat > 0.5) { gl_FragColor = u_Colour; return; }
              vec3 light = normalize(vec3(0.4, 0.7, 0.6));
              float shade = 0.35 + 0.65 * abs(dot(normalize(v_Normal), light));
              gl_FragColor = vec4(u_Colour.rgb * shade, u_Colour.a);
            }
        """
    }
}

/** The mesh preview as a composable; `frameMin/frameMax` are the review bounds it must align with. */
@Composable
fun MeshPreview(mesh: StlMesh, frameMin: List<Double>, frameMax: List<Double>, highlight: MeshHighlight?, modifier: Modifier = Modifier) {
    AndroidView(
        factory = { ctx -> MeshSurfaceView(ctx).also { it.show(mesh, frameMin.toFloats(), frameMax.toFloats()) } },
        update = { view -> view.highlight(highlight) },
        modifier = modifier,
    )
}

private fun List<Double>.toFloats(): FloatArray = FloatArray(3) { i -> getOrNull(i)?.toFloat()?.takeIf { it.isFinite() } ?: 0f }

/** A highlight box from double preview coordinates. */
fun meshHighlight(min: List<Double>, max: List<Double>, axis: Int? = null): MeshHighlight? {
    if (min.size != 3 || max.size != 3 || (min + max).any { !it.isFinite() }) return null
    return MeshHighlight(min.toFloats(), max.toFloats(), axis)
}
