package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.showingDesign
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.parseObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #788 on Android: the same derivation as CounterpartKit `DesignDraftTests`, over the shared
 *  `packages/contracts/fixtures/project-draft.json`. */
class DesignDraftTests {
    private val doc = parseObject(contractFixture("project-draft.json").readText())!!
    private fun entry(name: String) = doc["projects"]!!.jsonObject[name]!!.jsonObject
    private fun project(name: String, edit: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit = {}) =
        Project.decode(JsonObject(entry(name)["project"]!!.jsonObject.toMutableMap().also(edit)))!!

    @Test fun theLineAndThePrintNoteAreTheContracts() {
        assertEquals(doc["line"]!!.jsonPrimitive.content, Project.Draft.LINE)
        assertEquals(doc["printNote"]!!.jsonPrimitive.content, Project.Draft.PRINT_NOTE)
        assertEquals(doc["collapseAfter"]!!.jsonPrimitive.content.toInt(), Project.Draft.COLLAPSE_AFTER)
    }

    @Test fun aRoundFourDraftKeepsTheMCPsReasonsAsGivenAndCollapsesThem() {
        val project = project("round4")
        val reasons = entry("round4")["reasons"]!!.jsonArray.map { it.jsonPrimitive.content }
        val draft = project.current!!.draft!!
        assertEquals(reasons, draft.reasons)
        assertTrue(draft.collapses)
        assertEquals(reasons.take(2), draft.shown(false))
        assertEquals(reasons, draft.shown(true))
        assertEquals(draft, project.versions!!.last().result.draft)
        assertEquals(draft, project.showingDesign(project.versions!!.last().id).current?.draft)
        assertEquals(ProjectPhase.Ready, ProjectWords.phase(project))
        assertEquals(Project.Draft.LINE, ProjectWords(project).line)
        // A companion that wrote no line: Android says it too.
        assertEquals(Project.Draft.LINE, ProjectWords(project("round4") { it.remove("status") }).line)
    }

    @Test fun anOlderMCPsDraftHasNoReasonsAndAFinishedDesignIsNoDraft() {
        val older = project("older").current!!.draft!!
        assertEquals(emptyList<String>(), older.reasons)
        assertFalse(older.collapses)
        assertNull(project("finished").current!!.draft)
        assertTrue(ProjectWords(project("finished")).line.startsWith("Ready to print"))
        val odd = WireJson.decodeFromString(Project.Draft.serializer(), """{"reasons":["Model the desk.",3,"  ",null]}""")
        assertEquals(listOf("Model the desk."), odd.reasons)
        assertEquals(emptyList<String>(), WireJson.decodeFromString(Project.Draft.serializer(), """{"reasons":"not a list"}""").reasons)
    }
}
