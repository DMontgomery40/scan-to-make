package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.canLocate
import com.scantomake.counterpart.api.drawnColour
import com.scantomake.counterpart.api.photoPicture
import com.scantomake.counterpart.api.picturePath
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
                }
            }
        }
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
