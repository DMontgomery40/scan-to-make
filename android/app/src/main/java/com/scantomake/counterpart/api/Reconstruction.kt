package com.scantomake.counterpart.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.abs

/**
 * Linux photo-reconstruction review, exactly as `packages/contracts/src/reconstruction.ts` defines it and
 * the companion serves it on the public object. Bounds/extents are in reconstruction units until
 * `scaleKnown`; crop answers use these same preview coordinates.
 */
@Serializable
data class ReconstructionExtents(val x: Double, val y: Double, val z: Double) {
    fun axis(name: String): Double = when (name) { "x" -> x; "y" -> y; else -> z }
}

@Serializable
data class ReconstructionSuggestion(
    val type: String,
    val reason: String,
    val extents: ReconstructionExtents,
    val extentsM: ReconstructionExtents? = null,
)

@Serializable
data class ReconstructionComponent(
    val index: Int,
    val vertices: Int = 0,
    val faces: Int = 0,
    val share: Double = 0.0,
    val boundsMin: List<Double>,
    val boundsMax: List<Double>,
    val extents: ReconstructionExtents,
)

@Serializable
data class ReconstructionReview(
    val id: String,
    val kind: String,
    val preview: String,
    val previewMeshSha256: String? = null,
    val meshSha256: String? = null,
    val boundsMin: List<Double>,
    val boundsMax: List<Double>,
    val extents: ReconstructionExtents,
    val scaleKnown: Boolean = false,
    val scaleMPerUnit: Double? = null,
    val suggestion: ReconstructionSuggestion? = null,
    val components: List<ReconstructionComponent>? = null,
) {
    val boundsValid: Boolean
        get() = boundsMin.size == 3 && boundsMax.size == 3 &&
            (boundsMin + boundsMax).all { it.isFinite() } && boundsMin.indices.all { boundsMin[it] < boundsMax[it] }

    /**
     * The component the suggestion refers to (the tool suggests the largest component when it has no
     * anchor region): matched by extents, falling back to the largest share. Null for an anchor region,
     * whose bounds the public review does not carry.
     */
    fun suggestedComponent(): ReconstructionComponent? {
        val s = suggestion ?: return null
        if (s.type != "component") return null
        val list = components ?: return null
        return list.firstOrNull { c ->
            abs(c.extents.x - s.extents.x) < 1e-6 && abs(c.extents.y - s.extents.y) < 1e-6 && abs(c.extents.z - s.extents.z) < 1e-6
        } ?: list.maxByOrNull { it.share }
    }

    /** Units to millimetres when scale is proven, else null (show reconstruction units, never guess). */
    fun mm(units: Double): Double? = if (scaleKnown && scaleMPerUnit != null && scaleMPerUnit > 0) units * scaleMPerUnit * 1000 else null
}

/** What the person picked in a region review. Nothing is pre-picked: no selection, no confirmable answer. */
sealed interface RegionSelection {
    data object Suggested : RegionSelection
    data class Component(val index: Int) : RegionSelection
    data class Crop(val min: List<Double>, val max: List<Double>) : RegionSelection
}

object ReconstructionAnswers {
    /** The server's accepted measurement range (`ReconstructionAnswerSchema`). */
    const val MIN_MM = 1.0
    const val MAX_MM = 10_000.0

    fun validExtentMm(text: String): Double? {
        val value = text.trim().replace(',', '.').toDoubleOrNull() ?: return null
        return if (value.isFinite() && value in MIN_MM..MAX_MM) value else null
    }

    /** A crop must be a real box that overlaps the preview (the companion re-checks the same rules). */
    fun validCrop(review: ReconstructionReview, min: List<Double>, max: List<Double>): Boolean {
        if (min.size != 3 || max.size != 3 || !review.boundsValid) return false
        if ((min + max).any { !it.isFinite() }) return false
        if (min.indices.any { !(min[it] < max[it]) }) return false
        return min.indices.none { max[it] < review.boundsMin[it] || min[it] > review.boundsMax[it] }
    }

    fun regionAnswer(review: ReconstructionReview, selection: RegionSelection): JsonObject {
        val hash = review.previewMeshSha256 ?: throw CompanionException("invalid-review", "This preview can't be answered from this app. Update Counterpart on your computer.")
        val sel = when (selection) {
            RegionSelection.Suggested -> JsonObject(mapOf("type" to JsonPrimitive("suggested")))
            is RegionSelection.Component -> JsonObject(mapOf(
                "type" to JsonPrimitive("component"), "index" to JsonPrimitive(selection.index)))
            is RegionSelection.Crop -> {
                if (!validCrop(review, selection.min, selection.max)) throw CompanionException("invalid-crop", "That selection does not cover any of the model. Try again.")
                JsonObject(mapOf(
                    "type" to JsonPrimitive("crop"),
                    "min" to JsonArray(selection.min.map { JsonPrimitive(it) }),
                    "max" to JsonArray(selection.max.map { JsonPrimitive(it) })))
            }
        }
        return JsonObject(mapOf(
            "type" to JsonPrimitive("region"),
            "previewMeshSha256" to JsonPrimitive(hash),
            "selection" to sel))
    }

    fun scaleAnswer(review: ReconstructionReview, axis: String, extentMm: Double): JsonObject {
        val hash = review.meshSha256 ?: throw CompanionException("invalid-review", "This measurement can't be sent from this app. Update Counterpart on your computer.")
        if (axis !in setOf("x", "y", "z") || !extentMm.isFinite() || extentMm !in MIN_MM..MAX_MM)
            throw CompanionException("invalid-measurement", "Enter the size in millimetres (1 to 10,000).")
        return JsonObject(mapOf(
            "type" to JsonPrimitive("scale"),
            "meshSha256" to JsonPrimitive(hash),
            "axis" to JsonPrimitive(axis),
            "extentMm" to JsonPrimitive(extentMm)))
    }

    /**
     * The `start` body for an Android photo capture: exact frame names, no depth, camera metadata
     * required for AR captures, and explicit scale qualification for every Android capture (plain photos
     * have no scale until the person measures in reconstruction review).
     */
    fun captureManifest(images: List<String>, cameraMetadataRequired: Boolean): JsonObject {
        val json = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        json["version"] = JsonPrimitive(1)
        json["images"] = JsonArray(images.sorted().map { JsonPrimitive(it) })
        json["depthRequired"] = JsonPrimitive(false)
        if (cameraMetadataRequired) json["cameraMetadataRequired"] = JsonPrimitive(true)
        json["scaleQualificationRequired"] = JsonPrimitive(true)
        return JsonObject(json)
    }

    /** `/healthz` capability a host must report before any Android photo capture starts on it. */
    const val CAPABILITY = "reconstructionReviewV1"
    val updateHost: CompanionException
        get() = CompanionException("update-host", "Update Counterpart on your computer, then send this scan again. Your scan is kept on this phone.")
}
