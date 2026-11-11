package com.scantomake.counterpart

import com.scantomake.counterpart.api.KnownProjects
import com.scantomake.counterpart.api.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

/** The same cases as CounterpartKit's `KnownProjectsTests` (board X100). */
class KnownProjectsTests {
    private fun project(id: String, state: String = "ready", title: String = "Mic mount") = Project.decode(Json.parseToJsonElement(
        """{"id":"$id","createdAtMs":1,"updatedAtMs":2,"state":"$state","title":"$title","instructions":"Holds the mic","photos":[],"passes":[]}""").jsonObject)!!

    @Test fun everyListedProjectSurvivesARelaunchAndAnotherComputersCopyIsNeverShown() {
        val known = KnownProjects("https://a:9077").heard(listOf(project("a"), project("b", "printing")), 1_000)
        val back = KnownProjects.decode(known.encode(), "https://a:9077")!!
        assertEquals(listOf("a", "b"), back.projects.map { it.id })
        assertEquals(known.projects, back.projects)
        assertEquals(1_000L, back.heard["b"])
        assertNull(KnownProjects.decode(known.encode(), "https://b:9077"))
        assertNull(KnownProjects.decode("not json", "https://a:9077"))
    }

    @Test fun aListDropsWhatTheComputerNoLongerHasAndOneAnswerKeepsTheRestsTimes() {
        var known = KnownProjects("m").heard(listOf(project("a"), project("b")), 100)
        known = known.heard(project("a", "printing"), 200)
        assertEquals(200L, known.heard["a"]); assertEquals(100L, known.heard["b"])
        known = known.forget("b")
        assertEquals(listOf("a"), known.projects.map { it.id }); assertNull(known.heard["b"])
    }

    @Test fun theAwayLineSaysTheComputerIsntAnsweringAndWhenWhatIsShownWasTrue() {
        val zone = ZoneId.of("America/Denver"); val locale = Locale.US
        val now = 1_762_819_200_000L // Nov 10 2025 17:00 MST
        val line = { ms: Long? -> KnownProjects.awayLine(ms, now, zone, locale) }
        assertTrue(line(now - 48 * 60_000).startsWith("Your computer isn’t answering, so anything that needs it waits. This is what your phone had at 4:12"))
        assertTrue(line(now - 86_400_000).contains("had yesterday at 5:00"))
        assertTrue(line(now - 3 * 86_400_000).contains("had on Nov 7 at 5:00"))
        assertEquals("Your computer isn’t answering, so anything that needs it waits. This is what your phone already had.", line(null))
    }
}
