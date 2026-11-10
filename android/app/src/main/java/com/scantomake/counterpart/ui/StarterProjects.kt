package com.scantomake.counterpart.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.StarterProject
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.core.WireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

private val previewClient by lazy {
    OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(10, TimeUnit.SECONDS).build()
}

@Composable
fun StarterProjects(open: (String) -> Unit) {
    val context = LocalContext.current
    val state = AppState.of(context)
    val scope = rememberCoroutineScope()
    var starters by remember { mutableStateOf<List<StarterProject>>(emptyList()) }
    var selected by remember { mutableStateOf<StarterProject?>(null) }
    var adding by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        starters = withContext(Dispatchers.IO) {
            context.assets.open("Starters/catalog.json").bufferedReader().use { WireJson.decodeFromString(it.readText()) }
        }
    }
    if (starters.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionTitle("Start with something useful")
        BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cardWidth = starterCardWidth(maxWidth, starters.size)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            starters.forEach { starter ->
                GlassCard(Modifier.width(cardWidth)) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        StarterImage(starter, Modifier.fillMaxWidth().height(130.dp).clip(RoundedCornerShape(14.dp)))
                        Text(starter.title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                        Text(starter.subtitle, color = Palette.secondary, fontSize = 13.sp)
                        Text(starter.detail, color = Palette.secondary, fontSize = 12.sp)
                        Text("By ${starter.designer}", color = Palette.secondary, fontSize = 12.sp)
                        SecondaryButton("See Project", Modifier.fillMaxWidth()) { problem = null; selected = starter }
                    }
                }
            }
        }
        }
    }
    val reachable = state.link.collectAsState().value.reachable
    selected?.let { starter ->
        AlertDialog(onDismissRequest = { if (!adding) selected = null }, title = { Text(starter.title) },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Next to the top, where the tap's result is seen — not under the scroll (F6).
                problem?.let { Text(it, color = Palette.failed) }
                    ?: if (reachable == false) Text("Your computer isn't answering. Check it's on and awake, then try again.", color = Palette.failed) else null
                StarterImage(starter, Modifier.fillMaxWidth().height(160.dp))
                Text(starter.summary)
                Text(starter.instructions)
                Text("By ${starter.designer} · ${starter.licence}", fontSize = 12.sp, color = Palette.secondary)
                starter.imageCredit?.let { Text(it, fontSize = 11.sp, color = Palette.secondary) }
            } },
            confirmButton = { TextButton(enabled = !adding, onClick = {
                adding = true; problem = null
                scope.launch {
                    try {
                        val project = Counterpart.instance.companion.addStarter(starter.id)
                        state.show(project); selected = null; open(project.id)
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { problem = (e as? CompanionException)?.message ?: CompanionException.unreachable.message }
                    finally { adding = false }
                }
            }) { Text(if (adding) "Adding…" else "Add to My Projects") } },
            dismissButton = { TextButton(enabled = !adding, onClick = { selected = null }) { Text("Cancel") } })
    }
}

@Composable
private fun StarterImage(starter: StarterProject, modifier: Modifier) {
    val context = LocalContext.current
    var bitmap by remember(starter.id) { mutableStateOf<ImageBitmap?>(ImageCache.get("starter/${starter.id}")) }
    LaunchedEffect(starter.id) {
        if (bitmap != null) return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) {
            try {
                val bytes = if (starter.image != null) context.assets.open("Starters/${starter.image}").use { it.readBytes() }
                else if (starter.imageURL?.startsWith("https://") == true) {
                    previewClient.newCall(Request.Builder().url(starter.imageURL).build()).execute().use { response ->
                        if (!response.isSuccessful) return@withContext null
                        val source = response.body?.source() ?: return@withContext null
                        if (source.request(4L * 1024 * 1024 + 1)) return@withContext null
                        source.readByteArray()
                    }
                } else return@withContext null
                ImageCache.decode(bytes)?.also { ImageCache.put("starter/${starter.id}", it) }
            } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
        }
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        bitmap?.let { Image(it, starter.title, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
            ?: Icon(if (starter.id == "scan-platform") CIcons.Camera else CIcons.Ruler, starter.title, Modifier.size(56.dp), tint = Palette.filament)
    }
}

/**
 * A starter card's width (first look U14, Nov 10: the second starter was cut off at the margin): its natural 256 dp when
 * every card fits; narrower so they fit whole when there are only two; otherwise two whole cards and about a third of the
 * next, a deliberate peek. The same rule as `StarterProjectsView.cardWidth` on iOS and the Mac.
 */
internal fun starterCardWidth(available: Dp, count: Int, spacing: Dp = 12.dp, natural: Dp = 256.dp): Dp {
    if (count <= 0 || available <= 0.dp) return natural
    if (natural * count + spacing * (count - 1) <= available) return natural
    if (count <= 2) return maxOf(150.dp, (available - spacing * (count - 1)) / count)
    return minOf(natural, maxOf(150.dp, (available - spacing * 2) / 2.35f))
}
