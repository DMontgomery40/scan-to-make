package com.scantomake.counterpart.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ReconstructionAnswers
import com.scantomake.counterpart.api.ReconstructionReview
import com.scantomake.counterpart.api.RegionSelection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.util.Locale

private sealed interface PreviewState {
    data object Loading : PreviewState
    data class Failed(val message: String) : PreviewState
    data class Ready(val mesh: StlMesh) : PreviewState
}

/**
 * The reconstruction review: the actual rebuilt mesh, turnable and zoomable, with the person's explicit
 * choice drawn on it in preview coordinates — which part is the object (region), or how big it is
 * (scale). Nothing is pre-approved: no selection (or no valid measurement), no answer to send.
 */
@Composable
fun ReconstructionReviewCard(
    project: Project,
    review: ReconstructionReview,
    busy: Boolean,
    loadPreview: suspend () -> ByteArray,
    answer: (JsonObject) -> Unit,
) {
    var preview by remember(review.id) { mutableStateOf<PreviewState>(PreviewState.Loading) }
    var retry by remember(review.id) { mutableIntStateOf(0) }
    var problem by remember(review.id) { mutableStateOf<String?>(null) }
    var selection by remember(review.id) { mutableStateOf<RegionSelection?>(null) }
    var cropMin by remember(review.id) { mutableStateOf(review.boundsMin.map { it.toFloat() }) }
    var cropMax by remember(review.id) { mutableStateOf(review.boundsMax.map { it.toFloat() }) }
    var axis by remember(review.id) {
        mutableStateOf(listOf("x" to review.extents.x, "y" to review.extents.y, "z" to review.extents.z).maxByOrNull { it.second }?.first ?: "x")
    }
    var extentText by remember(review.id) { mutableStateOf("") }

    LaunchedEffect(review.id, retry) {
        preview = PreviewState.Loading
        preview = try {
            val bytes = loadPreview()
            val mesh = withContext(Dispatchers.Default) { StlParser.parse(bytes) }
            if (mesh == null) PreviewState.Failed("The rebuilt model couldn't be read on this phone. Try again, or answer on your computer.")
            else PreviewState.Ready(mesh)
        } catch (e: CompanionException) { PreviewState.Failed(e.message) }
        catch (_: Exception) { PreviewState.Failed(CompanionException.unreachable.message) }
    }

    val axisIndex = listOf("x", "y", "z").indexOf(axis)
    val highlight: MeshHighlight? = when (review.kind) {
        "scale" -> meshHighlight(review.boundsMin, review.boundsMax, axisIndex)
        "region" -> when (val s = selection) {
            RegionSelection.Suggested -> review.suggestedComponent()?.let { meshHighlight(it.boundsMin, it.boundsMax) }
            is RegionSelection.Component -> review.components?.firstOrNull { it.index == s.index }?.let { meshHighlight(it.boundsMin, it.boundsMax) }
            is RegionSelection.Crop -> meshHighlight(s.min, s.max)
            null -> review.suggestedComponent()?.let { meshHighlight(it.boundsMin, it.boundsMax) }
        }
        else -> null
    }

    fun extentsLine(x: Double, y: Double, z: Double): String {
        val mx = review.mm(x); val my = review.mm(y); val mz = review.mm(z)
        return if (mx != null && my != null && mz != null) "${fmt(mx)} × ${fmt(my)} × ${fmt(mz)} mm"
        else "${fmt(x)} × ${fmt(y)} × ${fmt(z)}"
    }

    GlassCard(Modifier.fillMaxWidth()) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Icon(CIcons.Hand, null, tint = Palette.needsYou); Spacer(Modifier.width(8.dp)); Text("Check the rebuilt model", fontWeight = FontWeight.SemiBold) }
        Text(when (review.kind) {
            "region" -> "Which part of this model is the object you scanned? Turn it with one finger, pinch to zoom, then choose the part you see."
            "scale" -> "How big is the object? Pick the side shown in orange, measure that side on the real object, and enter it in millimetres."
            else -> "Your computer is asking about the rebuilt model. Update Counterpart to answer it here."
        })
        if (review.kind == "region" && review.scaleKnown) Text("Its size is already known from the scan, so no measurement is needed.", color = Palette.secondary, fontSize = 13.sp)

        Box(Modifier.fillMaxWidth().aspectRatio(1.1f).clip(RoundedCornerShape(18.dp)), contentAlignment = Alignment.Center) {
            when (val p = preview) {
                PreviewState.Loading -> Text("Loading the rebuilt model…", color = Palette.secondary)
                is PreviewState.Failed -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.message, color = Palette.failed)
                    SecondaryButton("Try Again") { retry += 1 }
                }
                is PreviewState.Ready -> MeshPreview(p.mesh, review.boundsMin, review.boundsMax, highlight, Modifier.fillMaxSize())
            }
        }

        when (review.kind) {
            "region" -> {
                review.suggestion?.let { s ->
                    SecondaryButton((if (selection == RegionSelection.Suggested) "✓ " else "") + "Suggested part · " +
                        extentsLine(s.extents.x, s.extents.y, s.extents.z), Modifier.fillMaxWidth(), enabled = !busy) { selection = RegionSelection.Suggested }
                    Text(s.reason, color = Palette.secondary, fontSize = 12.sp)
                }
                review.components?.forEach { c ->
                    val chosen = (selection as? RegionSelection.Component)?.index == c.index
                    SecondaryButton((if (chosen) "✓ " else "") + "Piece ${c.index + 1} · ${fmt(c.share * 100)}% · " +
                        extentsLine(c.extents.x, c.extents.y, c.extents.z), Modifier.fillMaxWidth(), enabled = !busy) { selection = RegionSelection.Component(c.index) }
                }
                val cropping = selection is RegionSelection.Crop
                SecondaryButton((if (cropping) "✓ " else "") + "Crop box", Modifier.fillMaxWidth(), enabled = !busy && review.boundsValid) {
                    selection = RegionSelection.Crop(cropMin.map { it.toDouble() }, cropMax.map { it.toDouble() })
                }
                if (cropping && review.boundsValid) {
                    Text("Move each face until the box holds just the object.", color = Palette.secondary, fontSize = 12.sp)
                    for (a in 0 until 3) {
                        val lo = review.boundsMin[a].toFloat(); val hi = review.boundsMax[a].toFloat()
                        val name = listOf("X", "Y", "Z")[a]
                        Text("$name from ${fmt(cropMin[a].toDouble())} to ${fmt(cropMax[a].toDouble())}", fontSize = 12.sp, color = Palette.secondary)
                        Slider(cropMin[a], { v ->
                            cropMin = cropMin.toMutableList().also { it[a] = minOf(v, cropMax[a] - (hi - lo) * 0.01f) }
                            selection = RegionSelection.Crop(cropMin.map { it.toDouble() }, cropMax.map { it.toDouble() })
                        }, Modifier.fillMaxWidth(), enabled = !busy, valueRange = lo..hi)
                        Slider(cropMax[a], { v ->
                            cropMax = cropMax.toMutableList().also { it[a] = maxOf(v, cropMin[a] + (hi - lo) * 0.01f) }
                            selection = RegionSelection.Crop(cropMin.map { it.toDouble() }, cropMax.map { it.toDouble() })
                        }, Modifier.fillMaxWidth(), enabled = !busy, valueRange = lo..hi)
                    }
                }
                val picked = selection
                val cropValid = picked !is RegionSelection.Crop || ReconstructionAnswers.validCrop(review, picked.min, picked.max)
                PrimaryButton("Use This Part", Modifier.fillMaxWidth(), enabled = !busy && preview is PreviewState.Ready && picked != null && cropValid) {
                    problem = null
                    try { answer(ReconstructionAnswers.regionAnswer(review, picked!!)) }
                    catch (e: CompanionException) { problem = e.message }
                }
            }
            "scale" -> {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (name in listOf("x", "y", "z")) {
                        val chosen = axis == name
                        SecondaryButton((if (chosen) "✓ " else "") + "${name.uppercase()} · ${fmt(review.extents.axis(name))}", Modifier.weight(1f), enabled = !busy) { axis = name }
                    }
                }
                val mm = ReconstructionAnswers.validExtentMm(extentText)
                OutlinedTextField(extentText, { extentText = it }, Modifier.fillMaxWidth(), enabled = !busy,
                    label = { Text("The ${axis.uppercase()} side, in millimetres") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                if (extentText.isNotBlank() && mm == null) Text("Enter the size in millimetres (1 to 10,000).", color = Palette.failed, fontSize = 12.sp)
                PrimaryButton("Use This Size", Modifier.fillMaxWidth(), enabled = !busy && preview is PreviewState.Ready && mm != null) {
                    problem = null
                    try { answer(ReconstructionAnswers.scaleAnswer(review, axis, mm!!)) }
                    catch (e: CompanionException) { problem = e.message }
                }
            }
        }
        problem?.let { Text(it, color = Palette.failed) }
    } }
}

private fun fmt(v: Double): String {
    if (!v.isFinite()) return "–"
    val r = Math.rint(v)
    return if (kotlin.math.abs(v - r) < 0.005) String.format(Locale.US, "%d", r.toLong())
    else String.format(Locale.US, "%.2f", v).trimEnd('0').trimEnd('.')
}
