package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.ui.searchProjects
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.serialization.json.jsonObject

class ProjectSearchTests {
    @Test fun searchCountsProjectsOnceAndClearingRestoresAll() {
        val projects = listOf("Caliper card", "Cable clip").mapIndexed { index, title ->
            requireNotNull(Project.decode(WireJson.parseToJsonElement(
                """{"id":"$index","title":"$title","instructions":"A useful part","state":"ready","createdAtMs":1,"updatedAtMs":2}"""
            ).jsonObject))
        }
        for ((query, expected) in listOf("caliper" to 1, "missing" to 0, "  " to 2, "" to 2, "USEFUL" to 2, "Workshop" to 2)) {
            assertEquals(query, expected, searchProjects(projects, query) { "Workshop" }.size)
        }
        assertEquals(projects, searchProjects(projects, "") { null })
    }
}
