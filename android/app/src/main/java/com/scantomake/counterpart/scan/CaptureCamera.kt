package com.scantomake.counterpart.scan

import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * capture-camera v1 (`packages/contracts/src/reconstruction.ts`): per saved frame, the hash of the exact
 * saved bytes, the saved size, intrinsics in saved pixels, the frame timestamp, the tracking state and the
 * physical camera centre in metres. Pure math/JSON here so it is unit-testable; ARCore snapshots live in
 * [ArCapture]. `objectAnchor` is always null: the on-screen coverage anchor is progress guidance, never
 * measured evidence.
 */
data class CaptureCameraFrame(
    val image: String,
    val sha256: String,
    val width: Int,
    val height: Int,
    val fx: Double,
    val fy: Double,
    val cx: Double,
    val cy: Double,
    val timestampMs: Long,
    val tracking: String,
    val center: List<Double>,
)

data class SavedIntrinsics(val fx: Double, val fy: Double, val cx: Double, val cy: Double, val width: Int, val height: Int)

object CaptureCamera {
    /** ARCore `TrackingState` names to the wire's words. Anything else is honestly not tracking. */
    fun trackingWord(stateName: String): String = when (stateName) {
        "TRACKING" -> "tracking"
        "PAUSED" -> "limited"
        else -> "not-tracking"
    }

    /**
     * Intrinsics for the saved JPEG: first rescaled from the intrinsics' own image size to the CPU image
     * actually acquired (they normally agree), then carried through the clockwise pixel rotation the saver
     * applies. Rotations must be quarter turns.
     */
    fun savedIntrinsics(
        fx: Double, fy: Double, cx: Double, cy: Double,
        intrinsicsWidth: Int, intrinsicsHeight: Int,
        imageWidth: Int, imageHeight: Int,
        rotationDeg: Int,
    ): SavedIntrinsics {
        require(intrinsicsWidth > 0 && intrinsicsHeight > 0 && imageWidth > 0 && imageHeight > 0) { "bad image size" }
        var fX = fx * imageWidth / intrinsicsWidth
        var fY = fy * imageHeight / intrinsicsHeight
        var cX = cx * imageWidth / intrinsicsWidth
        var cY = cy * imageHeight / intrinsicsHeight
        val w = imageWidth; val h = imageHeight
        return when (((rotationDeg % 360) + 360) % 360) {
            0 -> SavedIntrinsics(fX, fY, cX, cY, w, h)
            90 -> SavedIntrinsics(fY, fX, h - cY, cX, h, w)
            180 -> SavedIntrinsics(fX, fY, w - cX, h - cY, w, h)
            270 -> SavedIntrinsics(fY, fX, cY, w - cX, h, w)
            else -> throw IllegalArgumentException("rotation must be a quarter turn")
        }
    }

    fun frameJson(f: CaptureCameraFrame): JsonObject = JsonObject(linkedMapOf(
        "image" to JsonPrimitive(f.image),
        "sha256" to JsonPrimitive(f.sha256),
        "width" to JsonPrimitive(f.width),
        "height" to JsonPrimitive(f.height),
        "fx" to JsonPrimitive(f.fx),
        "fy" to JsonPrimitive(f.fy),
        "cx" to JsonPrimitive(f.cx),
        "cy" to JsonPrimitive(f.cy),
        "timestampMs" to JsonPrimitive(f.timestampMs),
        "tracking" to JsonPrimitive(f.tracking),
        "center" to JsonArray(f.center.map { JsonPrimitive(it) }),
    ))

    /** The exact wire document. Frames are sorted by name so the bytes are stable across retries. */
    fun document(frames: List<CaptureCameraFrame>): JsonObject = JsonObject(linkedMapOf(
        "version" to JsonPrimitive(1),
        "kind" to JsonPrimitive("capture-camera"),
        "frames" to JsonArray(frames.sortedBy { it.image }.map { frameJson(it) }),
        "objectAnchor" to JsonNull,
    ))

    /** Reads a stored capture-camera document back; null when it is not one of ours. */
    fun parse(bytes: ByteArray): List<CaptureCameraFrame>? {
        val o = parseObject(bytes) ?: return null
        if (o["version"].num != 1.0 || o["kind"].str != "capture-camera") return null
        val frames = o["frames"].arr ?: return null
        if (frames.isEmpty() || frames.size > 10000) return null
        return frames.map { el ->
            val f = el.obj ?: return null
            val center = f["center"].arr?.map { it.num ?: return null } ?: return null
            if (center.size != 3 || center.any { !it.isFinite() }) return null
            CaptureCameraFrame(
                image = f["image"].str ?: return null,
                sha256 = f["sha256"].str ?: return null,
                width = f["width"].num?.toInt() ?: return null,
                height = f["height"].num?.toInt() ?: return null,
                fx = f["fx"].num ?: return null,
                fy = f["fy"].num ?: return null,
                cx = f["cx"].num ?: return null,
                cy = f["cy"].num ?: return null,
                timestampMs = f["timestampMs"].num?.toLong() ?: return null,
                tracking = f["tracking"].str ?: return null,
                center = center,
            )
        }
    }
}
