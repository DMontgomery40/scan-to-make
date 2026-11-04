package com.scantomake.counterpart.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPlate

@Composable
fun ProjectPlates(project: Project, busy: Boolean, select: (ProjectPlate) -> Unit, print: (ProjectPlate) -> Unit) {
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
                }
            }
        }
        if (!project.canSelectPlate) Text(if (project.print?.uncertain == true)
            "Check the current print on your printer before changing plates." else "Choose another plate when this step finishes.",
            color = Palette.secondary, fontSize = 13.sp)
    }
}
