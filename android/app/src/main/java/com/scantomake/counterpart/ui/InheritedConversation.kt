package com.scantomake.counterpart.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.ProjectConversation
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The conversation this project was made from (#613; iPhone `InputsSection`'s inherited part): the From line, which
 * opens that project while it exists and says "since deleted" when it doesn't, then its words, dimmed and read-only,
 * then a divider before this project's own request. Nothing for a project made from nothing.
 */
@Composable
fun InheritedConversation(conversation: ProjectConversation, open: (String) -> Unit) {
    val line = conversation.inheritedLine ?: return
    val from = conversation.inheritedFrom
    Column(Modifier.fillMaxWidth().testTag("inherited-history"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(line, Modifier.fillMaxWidth().testTag("inherited-from").clickable(enabled = from?.exists == true, role = Role.Button) { from?.let { open(it.id) } },
            color = if (from?.exists == true) Palette.filament else Palette.secondary, fontSize = 14.sp)
        conversation.inheritedEntries.forEach { entry ->
            val person = entry.role == ProjectConversation.Role.Person
            Column(Modifier.fillMaxWidth().alpha(0.72f), horizontalAlignment = if (person) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (entry.showsTime) entry.atMs?.let { Text(time(it), color = Palette.secondary, fontSize = 11.sp) }
                Text(entry.text, Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(18.dp))
                    .background(if (person) Palette.filament.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.08f)).padding(12.dp, 8.dp), fontSize = 14.sp)
            }
        }
        HorizontalDivider(color = Color.White.copy(alpha = 0.12f))
    }
}

private fun time(atMs: Double): String =
    DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.US).format(Instant.ofEpochMilli(atMs.toLong()).atZone(ZoneId.systemDefault()))
