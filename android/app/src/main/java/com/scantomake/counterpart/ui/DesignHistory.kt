package com.scantomake.counterpart.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.DesignHistory
import com.scantomake.counterpart.api.DesignVersion
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.ProjectStatus

/**
 * A project's earlier designs on its page (#616 slice 1; CounterpartKit `DesignHistoryView`): What you have (printed or
 * It works, newest first, each with its own Did it fit?) and Earlier designs (never printed, without the newest). One
 * design: nothing, the page is today's page. Read-only: printing or changing an earlier design belongs to slice 2.
 */
@Composable
fun DesignHistorySection(project: Project, enabled: Boolean, select: (String) -> Unit, answer: (String, ProjectStatus) -> Unit) {
    val history = remember(project) { DesignHistory(project) }
    if (!history.showsSections) return
    Column(Modifier.fillMaxWidth().testTag("design-history"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (history.have.isNotEmpty()) {
            SectionTitle("What you have")
            history.have.forEach { version ->
                GlassCard(Modifier.fillMaxWidth(), padding = 12.dp) { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(Modifier.fillMaxWidth().testTag("design-${version.id}")
                        .clickable(role = Role.Button) { select(version.id) },
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        ProjectImage(project, thumbnail(version), Modifier.size(72.dp).clip(RoundedCornerShape(12.dp)), maxSide = 300)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(history.printedLine(version), fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            Text(version.label, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(history.outcomeLine(version), color = Palette.secondary, fontSize = 12.sp)
                        }
                        Icon(CIcons.Chevron, null, tint = Palette.secondary, modifier = Modifier.size(14.dp))
                    }
                    // A printed design nobody answered yet: its own It works / Needs changes, kept with that design.
                    if (version.outcome == null) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        SecondaryButton("It Works", Modifier.weight(1f).testTag("design-${version.id}-works"), enabled = enabled) { answer(version.id, ProjectStatus.Works) }
                        SecondaryButton("Needs Changes", Modifier.weight(1f).testTag("design-${version.id}-needs-changes"), enabled = enabled) { answer(version.id, ProjectStatus.NeedsChanges) }
                    }
                } }
            }
        }
        if (history.earlier.isNotEmpty()) {
            SectionTitle("Earlier designs")
            history.earlier.forEach { version ->
                Row(Modifier.fillMaxWidth().testTag("design-${version.id}")
                    .clickable(role = Role.Button) { select(version.id) }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(DesignHistory.date(version.sealedAtMs), Modifier.width(56.dp), color = Palette.secondary, fontSize = 14.sp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(version.label, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        // A design that went to the printer says so, even when how it ended wasn't kept.
                        if (history.attempts(version).isNotEmpty()) Text(history.printedLine(version), color = Palette.secondary, fontSize = 12.sp)
                    }
                    Icon(CIcons.Chevron, null, tint = Palette.secondary, modifier = Modifier.size(14.dp))
                }
            }
        }
        project.historyRestored?.let { Text(it, color = Palette.secondary, fontSize = 12.sp) }
    }
}

/** The bar over an earlier design shown on the stage: which one, and the way back to the newest. */
@Composable
fun ViewingEarlierDesignBar(project: Project, version: DesignVersion, showNewest: () -> Unit) {
    Row(Modifier.fillMaxWidth().testTag("viewing-earlier-design"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Earlier design · ${DesignHistory(project).printedLine(version)}", color = Palette.secondary, fontSize = 12.sp)
            Text(version.label, fontSize = 15.sp)
        }
        TextButton(showNewest, Modifier.testTag("show-newest")) { Text("Show the Newest") }
    }
}

private fun thumbnail(version: DesignVersion): String? = version.picture ?: version.result.renders.firstOrNull()?.let(ProjectGallery::renderPath)
