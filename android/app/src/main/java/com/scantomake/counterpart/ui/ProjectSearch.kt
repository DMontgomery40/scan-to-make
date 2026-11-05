package com.scantomake.counterpart.ui

import com.scantomake.counterpart.api.Project

internal fun searchProjects(projects: List<Project>, query: String, printerName: (Project) -> String?): List<Project> =
    projects.filter { p ->
        query.isBlank() || listOfNotNull(p.title, p.instructions, printerName(p)).any { it.contains(query.trim(), ignoreCase = true) }
    }
