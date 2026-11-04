package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.core.WireJson
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

class PrintStateTests {
    @Test fun terminalEvidenceWinsOverLateActiveReports() {
        val cases = WireJson.parseToJsonElement(contractFixture("print-terminal-state.json").readText()).jsonArray
        for (entry in cases) {
            val case = entry.jsonObject
            val value = JsonObject(case.getValue("project").jsonObject + mapOf(
                "id" to JsonPrimitive("print-state-fixture"),
                "createdAtMs" to JsonPrimitive(1), "updatedAtMs" to JsonPrimitive(2)))
            val project = requireNotNull(Project.decode(value))
            assertEquals(case.getValue("name").jsonPrimitive.content,
                case.getValue("ended").jsonPrimitive.boolean, project.printEnded)
        }
    }
}
