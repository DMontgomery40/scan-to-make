package com.scantomake.counterpart.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPlate
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag

@Composable
fun ProjectPlates(project: Project, busy: Boolean, select: (ProjectPlate) -> Unit, print: (ProjectPlate) -> Unit, markPrinted: (ProjectPlate) -> Unit, markNotPrinted: (ProjectPlate) -> Unit) {
    var recording by remember { mutableStateOf<ProjectPlate?>(null) }
    val plates = project.plates.orEmpty()
    if (plates.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Plates", fontWeight = FontWeight.SemiBold)
            Text("${project.completedPlateCount} of ${plates.size} printed", color = Palette.secondary, fontSize = 13.sp)
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            plates.forEach { plate ->
                Column(Modifier.width(164.dp).clip(RoundedCornerShape(18.dp))
                    .background(if (plate.selected) Palette.filament.copy(alpha = 0.15f) else Palette.card).padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ProjectImage(project, plate.thumbnail?.let { "renders/${it.substringAfterLast('/')}" },
                        Modifier.fillMaxWidth().height(94.dp).clip(RoundedCornerShape(12.dp)), ContentScale.Fit)
                    Text(plate.name, fontWeight = FontWeight.SemiBold)
                    if (plates.map { it.fileIndex }.distinct().size > 1) Text(plate.fileName, fontSize = 12.sp, color = Palette.secondary)
                    Text(plate.statusText, fontSize = 12.sp, color = Palette.secondary)
                    SecondaryButton(if (plate.selected) "Selected" else "Select", Modifier.fillMaxWidth(),
                        enabled = !busy && project.canSelectPlate && !plate.selected) { select(plate) }
                    PrimaryButton(if (plate.completedAtMs == null) "Print…" else "Print Again…", Modifier.fillMaxWidth(),
                        enabled = !busy && project.canSelectPlate) { print(plate) }
                    if (plate.status != "printed" && plate.completedAtMs == null) SecondaryButton("I printed this elsewhere",
                        Modifier.fillMaxWidth().testTag("printed-elsewhere-${plate.fileIndex}-${plate.plateIndex}"),
                        enabled = !busy && project.canSelectPlate) { recording = plate }
                }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            plates.filter { it.status == "printed" || it.completedAtMs != null }.forEach { plate ->
                SecondaryButton("Mark ${plate.name} not printed", Modifier.testTag("mark-not-printed-${plate.fileIndex}-${plate.plateIndex}"),
                    enabled = !busy && project.canSelectPlate) { markNotPrinted(plate) }
            }
        }
        recording?.let { plate ->
            AlertDialog(onDismissRequest = { recording = null },
                title = { Text("Mark ${plate.name} as printed elsewhere?") }, text = { Text(plate.fileName) },
                confirmButton = { TextButton(enabled = !busy && project.canSelectPlate, onClick = { recording = null; markPrinted(plate) }) { Text("Mark as printed") } },
                dismissButton = { TextButton(onClick = { recording = null }) { Text("Cancel") } })
        }
        if (!project.canSelectPlate) Text("Choose another plate when this step finishes.", color = Palette.secondary, fontSize = 13.sp)
    }
}

/** The plate a Print sheet prints, and the way to change it there (David, Nov 6: the sheet opened on plate 1 and he
 *  couldn't switch it). Each plate is a radio choice for TalkBack and the keyboard; the estimate and pictures follow it. */
@Composable
fun PrintSheetPlates(project: Project, busy: Boolean, select: (ProjectPlate) -> Unit) {
    val plates = project.plates.orEmpty()
    if (plates.size < 2) return
    val manyFiles = plates.map { it.fileIndex }.distinct().size > 1
    Row(Modifier.horizontalScroll(rememberScrollState()).selectableGroup().testTag("print-sheet-plates"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        plates.forEach { plate ->
            val enabled = !busy && project.canSelectPlate
            Column(Modifier.clip(RoundedCornerShape(14.dp)).background(if (plate.selected) Palette.filament.copy(alpha = 0.15f) else Palette.card)
                .border(2.dp, if (plate.selected) Palette.filament else Color.Transparent, RoundedCornerShape(14.dp))
                .selectable(selected = plate.selected, enabled = enabled, role = Role.RadioButton) { if (!plate.selected) select(plate) }
                .semantics { contentDescription = "${plate.name}, ${plate.statusText}" }
                .testTag("print-sheet-plate-${plate.fileIndex}-${plate.plateIndex}")
                .padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(plate.name, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(if (manyFiles) "${plate.fileName} · ${plate.statusText}" else plate.statusText, color = Palette.secondary, fontSize = 12.sp)
            }
        }
    }
}
