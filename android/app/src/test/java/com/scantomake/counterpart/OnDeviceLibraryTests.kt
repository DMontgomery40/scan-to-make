package com.scantomake.counterpart

import com.scantomake.counterpart.api.LibraryPlan
import com.scantomake.counterpart.api.OnDeviceLibrary
import com.scantomake.counterpart.api.OnDeviceLibrary.Keep
import com.scantomake.counterpart.api.OnDeviceLibrary.Kind
import com.scantomake.counterpart.api.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/** The same cases as CounterpartKit's `OnDeviceLibraryTests` (docs/design/overhaul/on-device-library.md). */
class OnDeviceLibraryTests {
    private val base = Files.createTempDirectory("library").toFile()
    private fun library() = OnDeviceLibrary(base).apply { use("https://a:9077") }
    private fun project(id: String, ended: Int) = Project.decode(Json.parseToJsonElement(
        """{"id":"$id","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[{"startedAtMs":1,"endedAtMs":$ended,"status":"done"}],"current":{"model":"current/model.stl","renders":[]},"picture":"pictures/part-0123456789abcdef.png"}""").jsonObject)!!

    @Test fun theIndexSurvivesARelaunch() {
        val lib = library()
        val file = lib.commit("png".toByteArray(), "p", "pictures/a.png", 10, "a.png")
        lib.opened("p", 5)
        val again = library()
        assertEquals(file, again.file("p", "pictures/a.png", 10, "a.png"))
        assertNull(again.file("p", "pictures/a.png", 11))
        assertEquals(5L, again.lastOpened("p"))
        assertEquals(3L, again.usage)
    }

    @Test fun aNewerVersionReplacesTheOldOnlyOnceItHasArrivedAndALateOlderOneLeavesIt() {
        val lib = library()
        val model = lib.commit("stl".toByteArray(), "p", "model.stl", 1, "model.stl")
        val first = lib.commit("a".toByteArray(), "p", "pictures/a.png", 1, "a.png")
        assertEquals(first, lib.latest("p", "pictures/a.png")?.first)
        val second = lib.commit("b".toByteArray(), "p", "pictures/a.png", 2, "a.png")
        assertFalse(first.exists()); assertTrue(second.exists()); assertTrue(model.exists())
        lib.commit("old".toByteArray(), "p", "pictures/a.png", 1, "a.png")
        assertEquals(2L, lib.latest("p", "pictures/a.png")?.second)
    }

    @Test fun evictionTakesScansThenModelsOfTheOldestOpenedAndPicturesLast() {
        val lib = library()
        lib.opened("old", 1); lib.opened("recent", 100)
        for (id in listOf("old", "recent")) {
            lib.commit(ByteArray(100), id, "pictures/p.png", 1, "p.png")
            lib.commit(ByteArray(1_000), id, "model.stl", 1, "model.stl")
        }
        lib.commit(ByteArray(5_000), "recent", "scan/scan.usdz", 1, "scan.usdz")
        val gone = lib.evict(Keep.Everything, 1_000)
        assertEquals(listOf("Scan:recent", "Model:old", "Model:recent"), gone.map { "${it.kind}:${it.project}" })
        assertEquals(listOf("old"), lib.evict(Keep.Everything, 150).map { it.project })
        assertNotNull(lib.latest("recent", "pictures/p.png"))
    }

    @Test fun pruningUnpairingAndAnotherComputerClear() {
        val lib = library()
        val gone = lib.commit("a".toByteArray(), "gone", "pictures/p.png", 1, "p.png")
        lib.commit("b".toByteArray(), "kept", "pictures/p.png", 1, "p.png")
        lib.prune(setOf("kept"))
        assertFalse(gone.exists()); assertNotNull(lib.latest("kept", "pictures/p.png"))
        lib.use("https://b:9077")
        assertNull(lib.latest("kept", "pictures/p.png"))
        lib.commit("c".toByteArray(), "kept", "pictures/p.png", 1, "p.png")
        lib.unpair()
        assertFalse(lib.isActive); assertFalse(base.exists())
    }

    @Test fun theFillAndTheLinkRules() {
        val projects = (1..5).map { project("p$it", it * 1000) }
        val wants = LibraryPlan.wants(projects, setOf("p1"), Keep.Models)
        assertEquals(projects.map { it.id }.toSet(), wants.filter { it.kind == Kind.Picture }.map { it.project.id }.toSet())
        assertEquals(setOf("p1", "p3", "p4", "p5"), wants.filter { it.kind == Kind.Model }.map { it.project.id }.toSet())
        val picture = wants.first { it.kind == Kind.Picture }
        val model = wants.first { it.kind == Kind.Model }
        assertTrue(LibraryPlan.fetches(picture, Keep.Models, metered = true))
        assertFalse(LibraryPlan.fetches(model, Keep.Models, metered = true))
        assertTrue(LibraryPlan.fetches(model, Keep.Models, metered = false))
        assertFalse(LibraryPlan.fetches(model, Keep.Pictures, metered = false))
    }
}
