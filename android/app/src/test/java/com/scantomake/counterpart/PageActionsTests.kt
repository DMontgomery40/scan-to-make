package com.scantomake.counterpart

import com.scantomake.counterpart.api.MainAction
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.core.WireJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** PRD §5.4 One main action (board U17). The table is CounterpartKit's `Fixtures/main-actions.json`, read by the
 *  iPhone, Mac and Linux suites too: the same decision on every layout. */
class PageActionsTests {
    private data class Row(val number: Int, val name: String, val sending: Boolean, val projectSettings: Boolean, val project: Project, val main: String?, val others: List<String>,
                           val printWords: String?, val printPlace: String?, val printNote: String?)

    private fun JsonObject.text(key: String) = this[key]?.takeIf { it != JsonNull }?.jsonPrimitive?.contentOrNull

    private val document = WireJson.parseToJsonElement(kitFixture("main-actions.json").readText()).jsonObject
    private val rows = document["rows"]!!.jsonArray.map { it.jsonObject }.map { row ->
        val expected = row["expected"]!!.jsonObject
        val name = row.text("name")!!
        Row(row["row"]!!.jsonPrimitive.intOrNull ?: 0, name, row["sending"]?.jsonPrimitive?.booleanOrNull ?: false,
            row["projectSettings"]?.jsonPrimitive?.booleanOrNull ?: true,
            requireNotNull(Project.decode(row["project"]!!.jsonObject)) { "$name: not decodable on Android" },
            expected.text("main"), expected["others"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            expected.text("printWords"), expected.text("printPlace"), expected.text("printNote"))
    }

    // The fixture names are the Swift case names; Kotlin's enums hold the same names capitalised.
    private fun wire(action: ProjectAction) = action.name.replaceFirstChar { it.lowercase() }
    private fun wire(action: MainAction) = action.name.replaceFirstChar { it.lowercase() }

    @Test fun everyStateHasItsOneMainActionAndSaysWherePrintingGoes() {
        assertEquals(document["rows"]!!.jsonArray.size, rows.size)
        assertEquals("one row at least for each state of the table", (1..16).toSet(), rows.map { it.number }.toSet())
        for (row in rows) {
            val page = ProjectWords(row.project, sending = row.sending, projectSettings = row.projectSettings).page
            assertEquals("${row.name}: main", row.main, page.main?.let(::wire))
            assertEquals("${row.name}: others", row.others, page.others.map(::wire))
            assertEquals("${row.name}: what printing is called", row.printWords, page.printWords)
            assertEquals("${row.name}: where printing goes", row.printPlace, page.printPlace?.name?.lowercase())
            assertEquals("${row.name}: what would be printed", row.printNote, page.printNote)
        }
    }

    /** The rule the table follows, held for every row: one lead, each action once, Print filled only when it leads. */
    @Test fun anActionAppearsOnceAndPrintIsFilledOnlyWhenItLeads() {
        for (row in rows) {
            val page = ProjectWords(row.project, sending = row.sending, projectSettings = row.projectSettings).page
            assertEquals("${row.name}: an action twice", page.others.size, page.others.toSet().size)
            val prints = page.others.filter { it == ProjectAction.Print || it == ProjectAction.PrintChecked }
            assertEquals("${row.name}: printing is named exactly when it is offered", page.printWords != null, page.printIsMain || prints.isNotEmpty())
            assertFalse("${row.name}: Print leads and is also listed", page.printIsMain && prints.isNotEmpty())
            assertEquals(row.name, page.printPlace != null, page.printWords != null)
            page.main?.let { assertFalse("${row.name}: the lead is listed again", wire(it) in page.others.map(::wire)) }
        }
        // The pair the capture showed (row 14): Try Again leads; the earlier result prints from the card, once, under its true name.
        val page = ProjectWords(rows.first { it.name == "pass-stopped-earlier-result" }.project).page
        assertEquals(MainAction.Retry, page.main)
        assertEquals("Print the last version", page.printWords)
        assertTrue(page.printPlace?.name == "Card")
        assertFalse(page.printIsMain)
    }
}
