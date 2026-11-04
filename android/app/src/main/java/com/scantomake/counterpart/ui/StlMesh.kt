package com.scantomake.counterpart.ui

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * A preview mesh ready for the renderer: non-indexed triangles with flat normals, in the STL's own
 * (preview) coordinates. Rendering is stride-decimated to a bounded triangle count so a 64 MiB preview
 * can never become an unbounded GPU allocation; every selection and answer is computed from the review's
 * bounds/components, never from the decimated geometry.
 */
class StlMesh(
    val positions: FloatArray,
    val normals: FloatArray,
    val boundsMin: FloatArray,
    val boundsMax: FloatArray,
    val renderedTriangles: Int,
    val sourceTriangles: Int,
)

object StlParser {
    const val MAX_RENDERED_TRIANGLES = 120_000

    fun parse(bytes: ByteArray, maxTriangles: Int = MAX_RENDERED_TRIANGLES): StlMesh? {
        if (bytes.isEmpty() || maxTriangles <= 0) return null
        // An ASCII file can have 84 header-looking bytes; a binary header that begins "solid" is the
        // classic ambiguity, so text that reads as STL text is parsed as text first.
        val head = bytes.copyOf(minOf(bytes.size, 1024)).toString(Charsets.US_ASCII)
        if (head.startsWith("solid") && head.contains("facet")) return parseAscii(bytes, maxTriangles)
        return parseBinary(bytes, maxTriangles) ?: parseAscii(bytes, maxTriangles)
    }

    private fun parseBinary(bytes: ByteArray, maxTriangles: Int): StlMesh? {
        if (bytes.size < 84) return null
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val declared = buffer.getInt(80).toLong() and 0xffffffffL
        val available = (bytes.size - 84) / 50
        if (declared <= 0 || available <= 0) return null
        // A text file can start with 84 plausible bytes; only trust binary when the size agrees.
        if (declared > available && bytes.size != 84 + declared.toInt() * 50) return null
        val count = minOf(declared, available.toLong()).toInt()
        val stride = (count + maxTriangles - 1) / maxTriangles
        val rendered = (count + stride - 1) / stride
        val positions = FloatArray(rendered * 9)
        val normals = FloatArray(rendered * 9)
        val lo = floatArrayOf(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
        val hi = floatArrayOf(Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY)
        var out = 0
        var tri = 0
        while (tri < count) {
            val base = 84 + tri * 50 + 12
            val v = FloatArray(9)
            var finite = true
            for (i in 0 until 9) { v[i] = buffer.getFloat(base + i * 4); if (!v[i].isFinite()) finite = false }
            if (finite) {
                writeTriangle(v, positions, normals, out, lo, hi)
                out += 1
            }
            tri += stride
        }
        if (out == 0) return null
        return finish(positions, normals, out, lo, hi, count)
    }

    private fun parseAscii(bytes: ByteArray, maxTriangles: Int): StlMesh? {
        val text = bytes.toString(Charsets.US_ASCII)
        if (!text.startsWith("solid") || !text.contains("facet")) return null
        val vertices = ArrayList<FloatArray>()
        for (line in text.lineSequence()) {
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size == 4 && parts[0] == "vertex") {
                val v = floatArrayOf(parts[1].toFloatOrNull() ?: return null, parts[2].toFloatOrNull() ?: return null, parts[3].toFloatOrNull() ?: return null)
                if (v.any { !it.isFinite() }) return null
                vertices += v
                if (vertices.size > 3_000_000) return null
            }
        }
        val count = vertices.size / 3
        if (count == 0) return null
        val stride = (count + maxTriangles - 1) / maxTriangles
        val rendered = (count + stride - 1) / stride
        val positions = FloatArray(rendered * 9)
        val normals = FloatArray(rendered * 9)
        val lo = floatArrayOf(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
        val hi = floatArrayOf(Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY)
        var out = 0
        var tri = 0
        while (tri < count) {
            val v = FloatArray(9)
            for (k in 0 until 3) { val p = vertices[tri * 3 + k]; v[k * 3] = p[0]; v[k * 3 + 1] = p[1]; v[k * 3 + 2] = p[2] }
            writeTriangle(v, positions, normals, out, lo, hi)
            out += 1
            tri += stride
        }
        return finish(positions, normals, out, lo, hi, count)
    }

    private fun writeTriangle(v: FloatArray, positions: FloatArray, normals: FloatArray, tri: Int, lo: FloatArray, hi: FloatArray) {
        val o = tri * 9
        v.copyInto(positions, o)
        val ux = v[3] - v[0]; val uy = v[4] - v[1]; val uz = v[5] - v[2]
        val wx = v[6] - v[0]; val wy = v[7] - v[1]; val wz = v[8] - v[2]
        var nx = uy * wz - uz * wy; var ny = uz * wx - ux * wz; var nz = ux * wy - uy * wx
        val len = sqrt(nx * nx + ny * ny + nz * nz)
        if (len > 0f && len.isFinite()) { nx /= len; ny /= len; nz /= len } else { nx = 0f; ny = 0f; nz = 1f }
        for (k in 0 until 3) { normals[o + k * 3] = nx; normals[o + k * 3 + 1] = ny; normals[o + k * 3 + 2] = nz }
        for (k in 0 until 3) for (a in 0 until 3) {
            val c = v[k * 3 + a]
            if (c < lo[a]) lo[a] = c
            if (c > hi[a]) hi[a] = c
        }
    }

    private fun finish(positions: FloatArray, normals: FloatArray, rendered: Int, lo: FloatArray, hi: FloatArray, source: Int): StlMesh =
        StlMesh(
            if (rendered * 9 == positions.size) positions else positions.copyOf(rendered * 9),
            if (rendered * 9 == normals.size) normals else normals.copyOf(rendered * 9),
            lo, hi, rendered, source)
}
