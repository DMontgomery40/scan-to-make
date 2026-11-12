package com.scantomake.counterpart

import com.scantomake.counterpart.api.CounterpartEvent
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.app.NotificationActions
import com.scantomake.counterpart.core.WireJson
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #630: the companion's "nothing is coming out of the nozzle" line reaches this app's event, card and notification. */
class PrintCheckTests {
    private val fixture = WireJson.parseToJsonElement(contractFixture("print-check.json").readText()).jsonObject
    private val line = fixture.getValue("line").jsonPrimitive.content

    @Test fun theCheckEventDecodesAndNotifiesWithItsButtons() {
        val event = requireNotNull(CounterpartEvent.decode(fixture.getValue("event").jsonObject))
        assertEquals("print.check", event.type)
        assertEquals(line, event.body)
        // timeSensitive is the PROBLEMS channel (Notifications.channel): high importance.
        assertEquals("timeSensitive", event.notify)
        assertTrue(event.frame!!.endsWith(".jpg"))
        assertEquals(listOf(NotificationActions.Action.OpenPrint, NotificationActions.Action.Pause), NotificationActions.actions("print.check"))
        assertEquals("printing", NotificationActions.screen(null, "print.check"))
    }

    @Test fun theProjectCardAndPrintingScreenSayTheLine() {
        val value = fixture.getValue("project").jsonObject
        val project = requireNotNull(Project.decode(JsonObject(value + mapOf("createdAtMs" to JsonPrimitive(1), "updatedAtMs" to JsonPrimitive(2)))))
        assertEquals(line, ProjectWords(project).line)
        assertEquals(line, project.print?.live?.problems?.first()?.message)
        // After the printer says it finished, the card keeps the warning.
        val printedValue = fixture.getValue("printedProject").jsonObject
        val printed = requireNotNull(Project.decode(JsonObject(printedValue + mapOf("createdAtMs" to JsonPrimitive(1), "updatedAtMs" to JsonPrimitive(2)))))
        assertEquals(printedValue.getValue("status").jsonObject.getValue("text").jsonPrimitive.content, ProjectWords(printed).line)
        assertTrue(ProjectWords(printed).line.contains("camera showed nothing coming out"))
    }
}
