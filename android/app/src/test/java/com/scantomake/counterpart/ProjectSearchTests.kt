package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.ui.searchProjects
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.serialization.json.*

class ProjectSearchTests {
    @Test fun searchCountsProjectsOnceAndClearingRestoresAll() {
        val fixture = WireJson.parseToJsonElement(contractFixture("project-search.json").readText()).jsonObject
        val projects = fixture.getValue("projects").jsonArray.map { requireNotNull(Project.decode(it.jsonObject)) }
        val printerName = fixture.getValue("printerName").jsonPrimitive.content
        for (entry in fixture.getValue("cases").jsonArray) {
            val case = entry.jsonObject
            val query = case.getValue("query").jsonPrimitive.content
            val expected = case.getValue("expectedCount").jsonPrimitive.int
            assertEquals(query, expected, searchProjects(projects, query) { printerName }.size)
        }
        assertEquals(projects, searchProjects(projects, "") { null })
    }
}
