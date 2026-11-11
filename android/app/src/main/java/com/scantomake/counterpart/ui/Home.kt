package com.scantomake.counterpart.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Format
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPhase
import androidx.compose.ui.platform.testTag
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.rowLine
import com.scantomake.counterpart.app.AppState
import kotlinx.coroutines.launch

/** Home (PRD §5.1): what's running now, what needs you, and every project as a real render. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(open: (String, Boolean) -> Unit, newProject: (String?) -> Unit, printers: () -> Unit, settings: () -> Unit, pairAgain: () -> Unit = settings) {
    val state = AppState.of(LocalContext.current)
    val projects by state.projects.collectAsState()
    val loaded by state.loaded.collectAsState()
    val error by state.error.collectAsState()
    val link by state.link.collectAsState()
    val macName by state.macName.collectAsState()
    val catalog by state.catalog.collectAsState()
    state.sending.collectAsState().value
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var showArchived by remember { mutableStateOf(false) }

    val searched = searchProjects(projects, query, state::printerName)
    // Why a search found a project whose title doesn't say (U10).
    fun reason(p: Project) = searchSnippet(p, query, state::printerName)
    val visible = searched.filter { !it.isArchived }
    val archived = searched.filter { it.isArchived }.sortedByDescending { it.updatedAtMs }
    fun phase(p: Project) = state.words(p).phase
    val done = visible.filter { phase(it) == ProjectPhase.Confirmed }.sortedByDescending { it.updatedAtMs }
    val running = visible.filter { phase(it) in setOf(ProjectPhase.Printing, ProjectPhase.Preparing) } +
        visible.filter { phase(it) in setOf(ProjectPhase.Working, ProjectPhase.Sending) }
    val needsYou = visible.filter { phase(it) in setOf(ProjectPhase.NeedsYou, ProjectPhase.Failed) }
    val grid = visible.filter { phase(it) != ProjectPhase.Confirmed }.sortedWith(compareByDescending<Project> { phase(it) == ProjectPhase.Ready }.thenByDescending { it.updatedAtMs })

    val mac = macName ?: "Your computer"
    // Once, for the whole list: not answering, and when what is shown is from (X100).
    val heard by state.heard.collectAsState()
    val heardText = heard.values.maxOrNull()?.let { " · this is from " + com.scantomake.counterpart.api.KnownProjects.whenText(it, System.currentTimeMillis(), java.time.ZoneId.systemDefault(), java.util.Locale.getDefault()).removePrefix("at ") } ?: ""
    val connection = when (link.reachable) { false -> "$mac isn't answering$heardText"; true -> "$mac connected"; else -> mac }
    val printing = catalog?.destinations.orEmpty().filter { printer ->
        projects.any { p -> phase(p) == ProjectPhase.Printing && (p.print?.destinationId ?: p.print?.destination?.id ?: p.printerDestinationId) == printer.id }
    }
    val ready = catalog?.destinations.orEmpty().count { it.state == "ready" }
    val subtitle = connection + when {
        printing.size == 1 -> " · ${printing[0].model ?: printing[0].name} printing"
        printing.size > 1 -> " · ${printing.size} printers printing"
        ready > 0 -> " · $ready ${if (ready == 1) "printer" else "printers"} ready"
        else -> ""
    }
    val problems = catalog?.destinations.orEmpty().count { it.state == "offline" || it.capabilities?.update != null }
    val printersLabel = if (problems == 0) "Printers" else "Printers, $problems ${if (problems == 1) "needs" else "need"} attention"


    Scaffold(containerColor = Color.Black, topBar = {
        TopAppBar(colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black), title = {
            Column { Text("Projects", fontWeight = FontWeight.Bold); Text(subtitle, fontSize = 13.sp, color = Palette.secondary, modifier = Modifier.testTag("projects-status")) }
        }, actions = {
            IconButton(onClick = { searching = !searching; if (!searching) query = "" }) { Icon(CIcons.Search, "Search") }
            IconButton(onClick = printers) {
                BadgedBox(badge = { if (problems > 0) Badge { Text("$problems") } }) { Icon(CIcons.Printer, printersLabel) }
            }
            IconButton(onClick = settings) { Icon(CIcons.Gear, "Settings") }
        })
    }, floatingActionButton = {
        ExtendedFloatingActionButton(onClick = { newProject(null) }, containerColor = Palette.filament, contentColor = Color.Black,
            icon = { Icon(CIcons.Add, null) }, text = { Text("New", fontWeight = FontWeight.SemiBold) })
    }) { padding ->
        Column(Modifier.padding(padding)) {
            if (searching || query.isNotBlank()) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("Projects, printers, notes") }, singleLine = true)
                    if (searched.size < projects.size) {
                        Text("${searched.size} of ${projects.size} projects match “$query”", color = Palette.secondary)
                        TextButton(onClick = { query = "" }) { Text("Show All") }
                    }
                }
            }
        PullToRefreshBox(refreshing, onRefresh = { scope.launch { refreshing = true; state.load(); state.loadPrinters(); refreshing = false } }, Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                error?.let { e -> item { ConnectionBanner(e.message, e.needsPairing,
                    retry = { scope.launch { state.load(); state.loadPrinters() } }, connectDifferent = pairAgain) } }
                if (query.isBlank()) item { StarterProjects { open(it, false) } }
                if (loaded && projects.isEmpty() && error == null) {
                    item { EmptyHome(newProject) }
                }
                if (running.isNotEmpty()) {
                    item { SectionTitle("Now") }
                    items(running, key = { "now-" + it.id }) { p ->
                        val w = state.words(p)
                        Column { NowCard(p, w) { open(p.id, ProjectWords.watchable(p, w.phase)) }; SearchReason(reason(p)) }
                    }
                }
                if (needsYou.isNotEmpty()) {
                    item { SectionTitle("Needs you") }
                    items(needsYou, key = { "needs-" + it.id }) { p -> Column { NowCard(p, state.words(p)) { open(p.id, false) }; SearchReason(reason(p)) } }
                }
                if (grid.isNotEmpty()) { item { SectionTitle("All projects") }; gridItems(grid, "all") { p -> Column { ProjectCard(p, state.words(p)) { open(p.id, false) }; SearchReason(reason(p)) } } }
                if (done.isNotEmpty()) { item { SectionTitle("Done") }; gridItems(done, "done") { p -> Column { ProjectCard(p, state.words(p)) { open(p.id, false) }; SearchReason(reason(p)) } } }
                if (archived.isNotEmpty()) {
                    item { Text((if (showArchived) "▾ " else "▸ ") + "Archived · ${archived.size}", color = Palette.secondary, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.clickable { showArchived = !showArchived }.padding(vertical = 6.dp)) }
                    if (showArchived || query.isNotBlank()) items(archived, key = { "arch-" + it.id }) { p ->
                        Column {
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.card).clickable { open(p.id, false) }.padding(14.dp)) {
                                Text(state.words(p).title, Modifier.weight(1f)); Text(Format.`when`(p.updatedAtMs.toLong()), color = Palette.secondary, fontSize = 13.sp)
                            }
                            // Archived results say why they matched too (review F5).
                            SearchReason(reason(p))
                        }
                    }
                }
                if (!loaded && error == null) item { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Palette.filament) } }
            }
        }
    }
    }
}

/** Two equal columns. */
private fun androidx.compose.foundation.lazy.LazyListScope.gridItems(list: List<Project>, prefix: String, card: @Composable (Project) -> Unit) {
    items(list.chunked(2), key = { row -> prefix + row.joinToString { it.id } }) { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { Box(Modifier.weight(1f)) { card(it) } }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
fun ConnectionBanner(message: String, pair: Boolean, retry: () -> Unit = {}, connectDifferent: () -> Unit = {}) {
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(CIcons.Warning, null, tint = Palette.needsYou); Spacer(Modifier.width(10.dp))
                Text(message, fontSize = 14.sp)
            }
            // "…then try again" needs the button it names (F6); pairing again is one tap away, not a Settings hunt.
            Row {
                TextButton(onClick = retry) { Text("Try Again") }
                TextButton(onClick = connectDifferent) { Text(if (pair) "Connect to Your Computer" else "Connect a Different Computer") }
            }
        }
    }
}

@Composable
private fun EmptyHome(start: (String?) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(20.dp))
        Text("What do you want to make?", fontSize = 26.sp, fontWeight = FontWeight.Bold)
        JobCard(CIcons.Ruler, "Make something that fits", "Describe it and show what it fits. Your computer designs the part.",
            listOf(CIcons.Bubble to "Describe", CIcons.Camera to "Show")) { start("fit") }
        JobCard(CIcons.Cube, "Copy something", "Scan it. Your computer fixes what the scanner missed and makes it printable.",
            listOf(CIcons.Cube to "Scan", CIcons.Wand to "Fix")) { start("copy") }
        JobCard(CIcons.Link, "Print a published model", "Paste a MakerWorld or Printables link. Your computer gets the designer's file.",
            listOf(CIcons.Link to "Paste a link")) { start(null) }
        Text("You'll get a notification when it's ready.", color = Palette.secondary, fontSize = 13.sp)
    }
}

@Composable
private fun NowCard(p: Project, w: ProjectWords, onClick: () -> Unit) {
    val progress = p.print?.live?.job?.progress
    GlassCard(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).clickable(onClick = onClick), padding = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ProjectImage(p, p.posterName(), Modifier.size(76.dp).clip(RoundedCornerShape(16.dp)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(w.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                StatusCapsule(w.phase)
                // The capsule already names the phase: the line shows only what differs.
                Text(rowLine(p, w.line), Modifier.testTag("row-line-${p.id}"), color = Palette.secondary, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (w.phase == ProjectPhase.Printing && progress != null) LinearProgressIndicator({ (progress / 100).toFloat() }, Modifier.fillMaxWidth(), color = Palette.okGreen)
                else if (w.phase.isRunning) LinearProgressIndicator(Modifier.fillMaxWidth(), color = w.phase.tone.color())
            }
        }
    }
}

@Composable
private fun ProjectCard(p: Project, w: ProjectWords, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(Palette.card).clickable(onClick = onClick)) {
        Box {
            ProjectImage(p, p.posterName(), Modifier.fillMaxWidth().aspectRatio(1f))
            StatusCapsule(w.phase, modifier = Modifier.padding(8.dp))
        }
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(w.title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(w.size ?: Format.`when`(p.updatedAtMs.toLong()), color = Palette.secondary, fontSize = 12.sp, maxLines = 1)
        }
    }
}
