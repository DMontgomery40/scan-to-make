package com.scantomake.counterpart

import com.scantomake.counterpart.api.DesignHistory
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectConversation
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.Still
import com.scantomake.counterpart.api.showingDesign
import com.scantomake.counterpart.api.still
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.parseObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.TimeZone

/** #616 slice 1 on Android (#743): the same derivation as CounterpartKit `DesignHistoryTests`, over the shared
 *  `packages/contracts/fixtures/project-versions.json`. */
class DesignHistoryTests {
    private val doc = parseObject(contractFixture("project-versions.json").readText())!!
    private val zone = TimeZone.getDefault()
    // The fixture's print ended 2026-11-04T23:32Z: "Nov 4" in UTC and west of it, as the Kit tests run.
    @Before fun utc() { TimeZone.setDefault(TimeZone.getTimeZone("UTC")) }
    @After fun restore() { TimeZone.setDefault(zone) }

    private fun raw(): JsonObject = doc["project"]!!.jsonObject
    private fun project(edit: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit = {}) =
        Project.decode(JsonObject(raw().toMutableMap().also(edit)))!!
    private fun versionsWith(edit: (Int, MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit) = { o: MutableMap<String, kotlinx.serialization.json.JsonElement> ->
        o["versions"] = JsonArray(o["versions"]!!.jsonArray.mapIndexed { i, v -> JsonObject(v.jsonObject.toMutableMap().also { edit(i, it) }) })
    }
    private fun attempt(id: String, versionId: String, startedAtMs: Double, endState: String? = null) = WireJson.parseToJsonElement(
        """{"id":"$id","versionId":"$versionId","startedAtMs":$startedAtMs,"bundleId":"b"${endState?.let { ""","monitor":{"phase":"ended","endState":"$it"}""" } ?: ""}}""")

    @Test fun printedAndReadyAreBothTrueAndAnEarlierDesignHasOnlyItsOwnFiles() {
        val project = project()
        val expected = doc["expected"]!!.jsonObject
        val history = DesignHistory(project)
        assertEquals(ProjectPhase.Ready, ProjectWords.phase(project))
        assertEquals(expected["line"]!!.jsonPrimitive.content, ProjectWords(project).line)
        assertEquals(expected["have"]!!.jsonArray.map { it.jsonPrimitive.content }, history.have.map { it.id })
        assertEquals(expected["earlier"]!!.jsonArray.map { it.jsonPrimitive.content }, history.earlier.map { it.id })
        val printed = history.have.first()
        assertEquals("works", printed.outcome)
        val view = project.showingDesign(printed.id)
        assertEquals(printed.result.model, view.current?.model)
        assertEquals(printed.picture, view.picture)
        assertEquals(listOf(60.0, 40.0, 20.0), view.current?.sizeMm)
        assertEquals("Workshop printer", view.print?.destination?.name)
        assertNotEquals(project.current?.model, view.current?.model)
        assertEquals(ProjectGallery.Drawing.Model(printed.result.model), ProjectGallery.of(view).first?.drawing)
        // The stage's still is the design's own render, never the newest's.
        assertEquals(Still.Picture("versions/10000000-0000-4000-8000-000000000001/renders/front.png"), view.still(ProjectGallery.of(view).first!!))
        assertEquals("Printed Nov 4 · Workshop printer", history.printedLine(printed))
        assertEquals("It works", history.outcomeLine(printed))
        assertEquals("A rest for a 25 mm desk.", printed.label)
        assertNull(history.sealedLine(1.0))
        // No earlier design asked for: the project itself.
        assertEquals(project, project.showingDesign(null))
    }

    /** #616's own complaint, the other way round: what David marked Done must not move back to Ready because the print
     *  that made it Done isn't in the records. */
    @Test fun doneStaysDoneWhateverThePrintRecordsSay() {
        val newest = "10000000-0000-4000-8000-000000000003"
        val done: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit = { o ->
            o["state"] = JsonPrimitive("confirmed"); o["outcome"] = JsonPrimitive("works")
            versionsWith { i, v -> if (i == 2) v["outcome"] = JsonPrimitive("works") }(o)
        }
        var project = project(done)
        assertEquals(ProjectPhase.Confirmed, ProjectWords.phase(project))
        assertNull(DesignHistory(project).line)
        // The pink box: its newest design answered It works, with only a failed attempt on record.
        project = project { o -> done(o); o["prints"] = JsonArray(o["prints"]!!.jsonArray + attempt("failed", newest, 1793990000000.0, "failed")) }
        assertEquals(ProjectPhase.Confirmed, ProjectWords.phase(project))
        assertEquals(listOf(newest, "10000000-0000-4000-8000-000000000001"), DesignHistory(project).have.map { it.id })
        // One design and nothing else: the page and the list read exactly as before.
        project = project { o -> done(o); o["versions"] = JsonArray(listOf(o["versions"]!!.jsonArray[2])); o["prints"] = JsonArray(emptyList()) }
        assertFalse(DesignHistory(project).showsSections)
        assertEquals(ProjectPhase.Confirmed, ProjectWords.phase(project))
    }

    /** The hanger's Nov 4 design: three attempts kept only as frame folders, ends unknown. It went to the printer, so it
     *  never reads "Not printed yet", and on the stage it is "Sent to your printer", not "Ready to print". */
    @Test fun aDesignWhosePrintsEndedUnknownIsNeverCalledUnprinted() {
        val middle = "10000000-0000-4000-8000-000000000002"
        var project = project { o -> o["prints"] = JsonArray((1..3).map { attempt("frames-$it", middle, 1793791652751.0 + it) }) }
        val version = project.versions!![1]
        assertNull(DesignHistory(project).printedAt(version))
        assertEquals("Sent to the printer 3 times · how they ended wasn’t kept", DesignHistory(project).printedLine(version))
        assertEquals(Project.State.Sent, project.showingDesign(middle).state)
        assertEquals(ProjectPhase.Sent, ProjectWords.phase(project.showingDesign(middle)))
        project = project { o -> o["prints"] = JsonArray(listOf(attempt("failed", middle, 1.0, "failed"))) }
        assertEquals("Not printed · 1 try didn’t finish", DesignHistory(project).printedLine(project.versions!![1]))
        assertEquals(Project.State.Ready, project.showingDesign(middle).state)
        assertEquals("Ready to print", DesignHistory(project).outcomeLine(project.versions!![1]))
    }

    @Test fun theComputersWordsWinAndActivityNamesTheSealingPass() {
        var project = project { o -> o["status"] = WireJson.parseToJsonElement("""{"phase":"ready","text":"New one ready · printed Nov 4","symbol":"checkmark.seal","tint":"accent"}""") }
        assertEquals("New one ready · printed Nov 4", ProjectWords(project).line)
        project = project(versionsWith { i, v -> if (i == 1) v["passStartedAtMs"] = JsonPrimitive(1793836000000.0) })
        assertEquals("This became the ${DesignHistory.date(project.versions!![1].sealedAtMs)} design", DesignHistory(project).sealedLine(1793836000000.0))
        assertNull(DesignHistory(project).sealedLine(5.0))
        // A multi-part design (the pink box's decorated lid) is drawn from the merged STL sealed beside its 3MF.
        assertEquals("versions/abc/model.stl", ProjectGallery.versionMesh("versions/abc/touched.3mf"))
        assertEquals("versions/abc/touched.stl", ProjectGallery.versionMesh("versions/abc/touched.stl"))
        assertEquals("versions/abc/renders/a.png", ProjectGallery.renderPath("versions/abc/renders/a.png"))
        assertEquals("renders/a.png", ProjectGallery.renderPath("current/renders/a.png"))
    }

    @Test fun anOlderComputerSendsNoDesignsAndNothingChanges() {
        val project = project { o -> o.remove("versions"); o.remove("prints") }
        assertNull(project.versions)
        assertFalse(DesignHistory(project).showsSections)
        assertEquals(ProjectPhase.Ready, ProjectWords.phase(project))
        assertEquals("Ready to print", ProjectWords(project).line)
        assertEquals(project, project.showingDesign("10000000-0000-4000-8000-000000000001"))
        // A design that doesn't decode drops the list, never the project.
        assertEquals("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02", project { o -> o["versions"] = JsonPrimitive("nonsense") }.id)
    }
}

/** #613 (from #600's review, F4): a project made from another shows that one's conversation, over the shared
 *  `packages/contracts/fixtures/inherited-history.json`, as CounterpartKit `InheritedHistoryTests`. */
class InheritedHistoryTests {
    @Test fun snapshotComesBeforeThisProjectsOwnWordsAndSurvivesSourceDeletion() {
        val projects = WireJson.parseToJsonElement(contractFixture("inherited-history.json").readText()).jsonArray.map { Project.decode(it.jsonObject)!! }
        val copy = projects[1]
        val conversation = ProjectConversation(copy, projects)
        assertEquals("From “Forester phone mount”", conversation.inheritedLine)
        assertEquals(projects[0].id, conversation.inheritedFrom?.id)
        assertEquals(true, conversation.inheritedFrom?.exists)
        assertEquals(listOf("A mount for my phone.", "Which case is on the phone?", "The case is a JETech clear case.", "Made a holder for that case."),
            conversation.inheritedEntries.map { it.text })
        assertEquals(listOf(1794348000010.0, 1794348000020.0, 1794348000030.0, 1794348000040.0), conversation.inheritedEntries.map { it.atMs })
        assertEquals(listOf(ProjectConversation.Role.Person, ProjectConversation.Role.Counterpart, ProjectConversation.Role.Person, ProjectConversation.Role.Counterpart),
            conversation.inheritedEntries.map { it.role })
        assertEquals(listOf(true, false, false, false), conversation.inheritedEntries.map { it.showsTime })
        val deleted = ProjectConversation(copy, listOf(copy))
        assertEquals("From “Forester phone mount”, since deleted", deleted.inheritedLine)
        assertEquals(conversation.inheritedEntries, deleted.inheritedEntries)
        // The source renamed since: its title now.
        val renamed = Project.decode(JsonObject(projects[0].raw + ("title" to JsonPrimitive("Car phone mount"))))!!
        assertEquals("From “Car phone mount”", ProjectConversation(copy, listOf(renamed, copy)).inheritedLine)
        // A project made from nothing has no inherited part.
        assertNull(ProjectConversation(projects[0], projects).inheritedLine)
        assertEquals(emptyList<ProjectConversation.Entry>(), ProjectConversation(projects[0], projects).inheritedEntries)
    }
}
