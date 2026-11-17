package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.canLocate
import com.scantomake.counterpart.api.drawnColour
import com.scantomake.counterpart.api.photoPicture
import com.scantomake.counterpart.api.picturePath
import com.scantomake.counterpart.api.showingDesign
import com.scantomake.counterpart.api.Still
import com.scantomake.counterpart.api.still
import com.scantomake.counterpart.core.parseObject
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** PRD §5.4 Pictures: the same entries as CounterpartKit and Linux, from packages/contracts/fixtures/project-gallery.json. */
class ProjectGalleryTests {
    private val doc = parseObject(contractFixture("project-gallery.json").readText())!!

    @Test fun everyClientDerivesTheSamePicturesFromTheSharedCases() {
        val cases = doc["cases"]!!.jsonArray
        assertTrue(cases.size >= 8)
        for (item in cases.map { it.jsonObject }) {
            val name = item["name"]!!.jsonPrimitive.content
            val project = Project.decode(item["project"]!!.jsonObject)!!
            val expected = item["entries"]!!.jsonArray.map { it.jsonObject }
            val entries = ProjectGallery.of(project).entries
            assertEquals(name, expected.map { it["id"]!!.jsonPrimitive.content }, entries.map { it.id })
            item["photoPicture"]?.let { assertEquals(name, it.jsonPrimitive.content, project.photoPicture()) }
            item["canLocate"]?.let { assertEquals(name, it.jsonPrimitive.boolean, project.canLocate) }
            entries.zip(expected).forEach { (entry, want) ->
                assertEquals(name, want["kind"]!!.jsonPrimitive.content, entry.kind.wire)
                assertEquals(name, want["label"]!!.jsonPrimitive.content, entry.label)
                assertEquals(name, want["measures"]!!.jsonPrimitive.content, entry.measures)
                assertEquals(name, want["sizeMm"]?.jsonArray?.map { it.jsonPrimitive.double }, entry.sizeMm)
                assertEquals(name, want["photos"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList<String>(), entry.photos)
                want["still"]?.let {
                    val got = when (val s = project.still(entry)) { is Still.Picture -> s.path; Still.Waiting -> "waiting"; Still.NotAvailable -> "not available" }
                    assertEquals("$name: ${entry.id}'s stage", it.jsonPrimitive.content, got)
                }
                val colour = when (val c = entry.colour) { ProjectGallery.Colour.Neutral -> "neutral"; ProjectGallery.Colour.Own -> "own"; is ProjectGallery.Colour.Spool -> c.hex }
                assertEquals(name, want["colour"]!!.jsonPrimitive.content, colour)
                // #840: what the stage's AR opens, the one rule every client derives (null: none).
                assertTrue("$name: ${entry.id} says what its AR opens", want.containsKey("ar"))
                assertEquals("$name: ${entry.id}'s AR", (want["ar"] as? JsonPrimitive)?.contentOrNull, entry.ar)
                val drawing = want["drawing"]!!.jsonObject
                when (val d = entry.drawing) {
                    is ProjectGallery.Drawing.Model -> assertEquals(name, drawing["model"]?.jsonPrimitive?.content, d.path)
                    is ProjectGallery.Drawing.Picture -> assertEquals(name, drawing["picture"]?.jsonPrimitive?.content, d.path)
                    is ProjectGallery.Drawing.Assembly -> {
                        val a = drawing["assembly"]!!.jsonObject
                        assertEquals(name, a["part"]!!.jsonPrimitive.content, d.part)
                        assertEquals(name, a["object"]!!.jsonPrimitive.content, d.obj)
                        assertEquals(name, a["seats"]!!.jsonPrimitive.int, d.seats.size)
                    }
                    is ProjectGallery.Drawing.Parts -> org.junit.Assert.fail("$name: no gallery case has parts (project-parts.json does)")
                }
            }
        }
    }

    /**
     * #691: what the stage turns for a design, part by part, from packages/contracts/fixtures/project-parts.json: each part's
     * mesh in its own colour, neutral for one with none, only the chosen plate's parts of a designer's kit, a sealed
     * design's own parts when it is shown, and the merged mesh exactly as before when there are no parts.
     */
    @Test fun eachPartIsDrawnInItsOwnColourFromTheSharedPartCases() {
        val cases = parseObject(contractFixture("project-parts.json").readText())!!["cases"]!!.jsonArray.map { it.jsonObject }
        assertEquals(5, cases.size)
        fun word(c: ProjectGallery.Colour) = when (c) { is ProjectGallery.Colour.Spool -> c.hex; else -> "neutral" }
        fun drawn(p: Project): List<Pair<String, String>> {
            val entry = ProjectGallery.of(p).entries.first { it.kind == ProjectGallery.Kind.Part }
            return when (val d = entry.drawing) {
                is ProjectGallery.Drawing.Parts -> d.parts.map { it.mesh to word(it.colour) }
                is ProjectGallery.Drawing.Model -> listOf(d.path to word(entry.colour))
                else -> error("${entry.drawing} is not turned")
            }
        }
        fun want(e: JsonElement) = e.jsonArray.map { it.jsonObject["mesh"]!!.jsonPrimitive.content to it.jsonObject["colour"]!!.jsonPrimitive.content }
        for (item in cases) {
            val name = item["name"]!!.jsonPrimitive.content
            val record = JsonObject(mapOf("id" to JsonPrimitive("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a99"), "createdAtMs" to JsonPrimitive(1),
                "updatedAtMs" to JsonPrimitive(2), "state" to JsonPrimitive("ready")) + item["object"]!!.jsonObject)
            val project = Project.decode(record)!!
            assertEquals(name, want(item["draw"]!!), drawn(project))
            // #845: a design drawn part by part offers AR from its first part.
            (ProjectGallery.of(project).entries.first { it.kind == ProjectGallery.Kind.Part }.drawing as? ProjectGallery.Drawing.Parts)?.let {
                assertEquals(name, it.parts.first().mesh, ProjectGallery.of(project).entries.first { e -> e.kind == ProjectGallery.Kind.Part }.ar)
            }
            item["drawVersion"]?.jsonObject?.forEach { (id, draw) -> assertEquals("$name, design $id", want(draw), drawn(project.showingDesign(id))) }
        }
    }

    private val partsDoc get() = parseObject(contractFixture("project-parts.json").readText())!!
    private fun partsProject(o: JsonObject, extra: Map<String, JsonElement> = emptyMap()) = Project.decode(JsonObject(mapOf(
        "id" to JsonPrimitive("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a99"), "createdAtMs" to JsonPrimitive(1), "updatedAtMs" to JsonPrimitive(2),
        "state" to JsonPrimitive("ready")) + o + extra))!!
    private fun drawWords(e: JsonElement) = e.jsonArray.map { it.jsonObject["mesh"]!!.jsonPrimitive.content to it.jsonObject["colour"]!!.jsonPrimitive.content }
    private fun words(d: ProjectGallery.Drawing.Parts) = d.parts.map { it.mesh to when (val c = it.colour) { is ProjectGallery.Colour.Spool -> c.hex; else -> "neutral" } }

    /** Review of #869, P1-2: a kit with several plates is one entry per plate, each turning its own parts (CounterpartKit). */
    @Test fun eachPlateOfAKitTurnsItsOwnPartsInTheGallery() {
        val block = partsDoc["plates"]!!.jsonObject
        val entries = ProjectGallery.of(partsProject(block["object"]!!.jsonObject)).entries
        val want = block["drawPlates"]!!.jsonObject
        assertEquals(want.keys.toList(), entries.map { it.id })
        for (entry in entries) {
            assertEquals(ProjectGallery.Kind.Plate, entry.kind)
            when (val d = entry.drawing) {
                is ProjectGallery.Drawing.Parts -> {
                    assertEquals(entry.id, drawWords(want[entry.id]!!), words(d))
                    assertEquals("#845: ${entry.id}'s AR is its first part", d.parts.first().mesh, entry.ar)
                }
                is ProjectGallery.Drawing.Picture -> { assertEquals(entry.id, want[entry.id]!!.jsonObject["picture"]!!.jsonPrimitive.content, d.path); assertNull(entry.ar) }
                else -> org.junit.Assert.fail("${entry.id}: ${entry.drawing}")
            }
        }
        // A plate drawn by its parts keeps its own picture as the still.
        val project = partsProject(block["object"]!!.jsonObject)
        assertEquals(Still.Picture("renders/k-1.png"), project.still(entries[1]))
    }

    /** Review of #869, P2-4: parts are all or nothing; one unreadable entry and the merged mesh turns, neutral, as before. */
    @Test fun oneUnreadablePartMeansNoPartsAtAll() {
        val block = partsDoc["unreadable"]!!.jsonObject
        val project = partsProject(block["object"]!!.jsonObject)
        assertTrue(project.current!!.parts.isEmpty())
        val entry = ProjectGallery.of(project).entries.first { it.kind == ProjectGallery.Kind.Part }
        val want = drawWords(block["draw"]!!).single()
        assertEquals(ProjectGallery.Drawing.Model(want.first), entry.drawing)
        assertEquals(ProjectGallery.Colour.Neutral, entry.colour)
        // A plate that isn't a number is unreadable too.
        val badPlate = parseObject("""{"kind":"fit","current":{"model":"current/model.3mf","renders":[],"parts":[{"id":"1/1","mesh":"current/parts/part-1.stl","plate":"one"}]}}""")!!
        assertTrue(partsProject(badPlate).current!!.parts.isEmpty())
    }

    /** Review of #869, P2-6: a copy's Together is the copy in the scan's place, drawn as the part is; a fit's keeps the
     *  part with the scanned object in each seat (CounterpartKit `testACopysTogetherIsThePartInTheScansPlaceNotInsideTheScan`). */
    @Test fun aCopysTogetherIsThePartInTheScansPlaceNotInsideTheScan() {
        val first = partsDoc["cases"]!!.jsonArray[0].jsonObject["object"]!!.jsonObject
        val current = JsonObject(first["current"]!!.jsonObject + ("seats" to parseObject("""{"s":[{"rotationDeg":[0,0,0],"translationMm":[0,-19.5,3]}]}""")!!["s"]!!))
        val copy = partsProject(JsonObject(first + ("current" to current)), mapOf("scan" to JsonPrimitive("scan.usdz"), "photos" to JsonArray(emptyList())))
        val entries = ProjectGallery.of(copy).entries
        val part = entries.first { it.kind == ProjectGallery.Kind.Part }
        val together = entries.first { it.kind == ProjectGallery.Kind.Together }
        assertEquals(part.drawing, together.drawing)
        assertNull(together.ar)
        val fit = partsProject(JsonObject(first + ("current" to current) + ("kind" to JsonPrimitive("fit"))), mapOf("scan" to JsonPrimitive("scan.usdz"), "photos" to JsonArray(emptyList())))
        val assembly = ProjectGallery.of(fit).entries.first { it.kind == ProjectGallery.Kind.Together }.drawing as ProjectGallery.Drawing.Assembly
        assertEquals("current/model.stl", assembly.part); assertEquals("scan/scan.usdz", assembly.obj); assertEquals(1, assembly.seats.size)
    }

    /** #706: the stage draws each part through the dark-part floor; a part with no colour is the neutral material. */
    @Test fun eachPartsDrawnColourGoesThroughTheDarkPartFloor() {
        fun rgb(hex: String) = hex.removePrefix("#").toInt(16).let { floatArrayOf(((it shr 16) and 255) / 255f, ((it shr 8) and 255) / 255f, (it and 255) / 255f) }
        assertTrue(com.scantomake.counterpart.api.stageRgb(ProjectGallery.Colour.Spool("#000000")).contentEquals(rgb("#333435")))
        assertTrue(com.scantomake.counterpart.api.stageRgb(ProjectGallery.Colour.Spool("#111111")).contentEquals(rgb(drawnColour("#111111"))))
        assertTrue(drawnColour("#111111") != "#111111")
        assertTrue(com.scantomake.counterpart.api.stageRgb(ProjectGallery.Colour.Spool("#B0855D")).contentEquals(rgb("#B0855D")))
        assertTrue(com.scantomake.counterpart.api.stageRgb(ProjectGallery.Colour.Neutral).contentEquals(rgb(com.scantomake.counterpart.api.NEUTRAL_MATERIAL)))
    }

    /** The stage stays dark for every colour (David, Nov 11): a dark part is floored in its material, not by lightening the backdrop. */
    @Test fun everyFilamentColourStaysReadableOnTheDarkStage() {
        val drawn = doc["stage"]!!.jsonObject["drawnColours"]!!.jsonObject
        for ((spool, want) in drawn) if (spool.startsWith("#")) assertEquals(spool, want.jsonPrimitive.content, drawnColour(spool))
        assertEquals("#333435", drawnColour("#000000")) // a true black filament is charcoal, not a silhouette
        assertEquals(ProjectGallery.Colour.Neutral, drawnColour(ProjectGallery.Colour.Neutral))
        assertEquals(ProjectGallery.Colour.Own, drawnColour(ProjectGallery.Colour.Own))
    }

    /** Review of #451, finding 5: a locate pass changes no file, so the media version (and the download cache) stays. */
    @Test fun aLocatePassNeverRollsTheMediaVersionOver() {
        val p = Project.decode(parseObject("""{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","passes":[{"startedAtMs":10,"endedAtMs":20,"status":"done","trigger":"new"},{"startedAtMs":30,"endedAtMs":40,"status":"done","trigger":"locate"}]}""")!!)!!
        assertEquals(20L, p.mediaVersion)
    }

    /** David, Nov 10: "the photograph including everything in it is by far the worst". Never a photo or a scan frame. */
    @Test fun aProjectPictureIsTheObjectAloneNeverAPhotoOfTheRoom() {
        fun project(extra: String) = Project.decode(parseObject("""{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":["bottle.jpg"],"capture":["0001.heic"]$extra}""")!!)!!
        assertNull(project("").picturePath())
        assertEquals("renders/overview.png", project(""","current":{"model":"current/model.stl","renders":["current/renders/overview.png"]}""").picturePath())
        assertEquals("pictures/part-1.png", project(""","picture":"pictures/part-1.png","current":{"model":"current/model.stl","renders":["current/renders/overview.png"]}""").picturePath())
    }

    /** #748 (review of #741, P2): a picture the phone keeps is decoding, not coming from the computer: the bare stage, no
     *  spinner and no "coming" line, as the iPhone's `.decoding`. A picture it doesn't keep is still loading. */
    @Test fun aKeptPictureDecodesOnABareStageAndNeverSaysItIsComing() {
        val picture = Still.Picture("pictures/part.png")
        assertEquals(com.scantomake.counterpart.ui.StageShows.Decoding, com.scantomake.counterpart.ui.stageShows(picture, hasImage = false, failed = false, libraryHas = true))
        assertEquals(com.scantomake.counterpart.ui.StageShows.Loading, com.scantomake.counterpart.ui.stageShows(picture, hasImage = false, failed = false, libraryHas = false))
        assertEquals(com.scantomake.counterpart.ui.StageShows.Shown, com.scantomake.counterpart.ui.stageShows(picture, hasImage = true, failed = false, libraryHas = true))
        assertEquals(com.scantomake.counterpart.ui.StageShows.NotAvailable, com.scantomake.counterpart.ui.stageShows(picture, hasImage = false, failed = true, libraryHas = true))
        assertEquals(com.scantomake.counterpart.ui.StageShows.Loading, com.scantomake.counterpart.ui.stageShows(Still.Waiting, hasImage = false, failed = false, libraryHas = false))
        assertEquals(com.scantomake.counterpart.ui.StageShows.NotAvailable, com.scantomake.counterpart.ui.stageShows(Still.NotAvailable, hasImage = false, failed = false, libraryHas = true))
        assertEquals("loading", com.scantomake.counterpart.ui.StageShows.Decoding.description)
    }
}
