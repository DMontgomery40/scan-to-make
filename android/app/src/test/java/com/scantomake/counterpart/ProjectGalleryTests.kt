package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectGallery
import com.scantomake.counterpart.api.picturePath
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
            entries.zip(expected).forEach { (entry, want) ->
                assertEquals(name, want["kind"]!!.jsonPrimitive.content, entry.kind.wire)
                assertEquals(name, want["label"]!!.jsonPrimitive.content, entry.label)
                assertEquals(name, want["measures"]!!.jsonPrimitive.content, entry.measures)
                assertEquals(name, want["sizeMm"]?.jsonArray?.map { it.jsonPrimitive.double }, entry.sizeMm)
                assertEquals(name, want["photos"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList<String>(), entry.photos)
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

    /** David, Nov 10: "the photograph including everything in it is by far the worst". Never a photo or a scan frame. */
    @Test fun aProjectPictureIsTheObjectAloneNeverAPhotoOfTheRoom() {
        fun project(extra: String) = Project.decode(parseObject("""{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":["bottle.jpg"],"capture":["0001.heic"]$extra}""")!!)!!
        assertNull(project("").picturePath())
        assertEquals("renders/overview.png", project(""","current":{"model":"current/model.stl","renders":["current/renders/overview.png"]}""").picturePath())
        assertEquals("pictures/part-1.png", project(""","picture":"pictures/part-1.png","current":{"model":"current/model.stl","renders":["current/renders/overview.png"]}""").picturePath())
    }
}
