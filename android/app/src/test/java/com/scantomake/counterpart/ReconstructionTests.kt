package com.scantomake.counterpart

import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ReconstructionAnswers
import com.scantomake.counterpart.api.RegionSelection
import com.scantomake.counterpart.core.Hex
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.bool
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.scan.CaptureCamera
import com.scantomake.counterpart.scan.CaptureCameraFrame
import com.scantomake.counterpart.ui.StlParser
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val ID = "11111111-2222-3333-4444-555555555555"
private const val REVIEW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
private val HASH = "a".repeat(64)
private val HASH2 = "b".repeat(64)

private fun frame(name: String = "0001.jpg") = CaptureCameraFrame(
    image = name, sha256 = HASH, width = 640, height = 480, fx = 500.0, fy = 502.0, cx = 320.0, cy = 240.0,
    timestampMs = 1234, tracking = "tracking", center = listOf(0.1, 1.2, -0.3))

private fun reviewJson(kind: String, extra: String = ""): JsonObject = parseObject("""
    {"id":"$ID","createdAtMs":1,"updatedAtMs":2,"state":"needs-closeup","photos":[],
     "reconstructionReview":{"id":"$REVIEW","kind":"$kind","preview":"reconstruction-preview.stl?reviewId=$REVIEW",
       "boundsMin":[0,0,0],"boundsMax":[2,3,4],"extents":{"x":2,"y":3,"z":4},"scaleKnown":false $extra}}
""".trimIndent())!!

class CaptureCameraTests {
    @Test fun intrinsicsSurviveRotationAndRescale() {
        // Intrinsics quoted for 1280x960, CPU image actually 640x480, saved rotated 90° clockwise.
        val s = CaptureCamera.savedIntrinsics(1000.0, 1004.0, 640.0, 480.0, 1280, 960, 640, 480, 90)
        assertEquals(480, s.width); assertEquals(640, s.height)
        assertEquals(502.0, s.fx, 1e-9); assertEquals(500.0, s.fy, 1e-9)
        assertEquals(480.0 - 240.0, s.cx, 1e-9); assertEquals(320.0, s.cy, 1e-9)
        val r180 = CaptureCamera.savedIntrinsics(500.0, 502.0, 320.0, 240.0, 640, 480, 640, 480, 180)
        assertEquals(640 - 320.0, r180.cx, 1e-9); assertEquals(480 - 240.0, r180.cy, 1e-9)
        val r270 = CaptureCamera.savedIntrinsics(500.0, 502.0, 320.0, 240.0, 640, 480, 640, 480, 270)
        assertEquals(480, r270.width); assertEquals(240.0, r270.cx, 1e-9); assertEquals(640 - 320.0, r270.cy, 1e-9)
        try { CaptureCamera.savedIntrinsics(1.0, 1.0, 0.0, 0.0, 640, 480, 640, 480, 45); fail("45 degrees") }
        catch (_: IllegalArgumentException) {}
    }

    @Test fun trackingWords() {
        assertEquals("tracking", CaptureCamera.trackingWord("TRACKING"))
        assertEquals("limited", CaptureCamera.trackingWord("PAUSED"))
        assertEquals("not-tracking", CaptureCamera.trackingWord("STOPPED"))
        assertEquals("not-tracking", CaptureCamera.trackingWord("anything-else"))
    }

    @Test fun documentIsExactWireShapeAndParsesBack() {
        val doc = CaptureCamera.document(listOf(frame("0002.jpg"), frame("0001.jpg")))
        val text = WireJson.encodeToString(JsonObject.serializer(), doc)
        val back = parseObject(text)!!
        assertEquals(1.0, back["version"].num)
        assertEquals("capture-camera", back["kind"].str)
        // objectAnchor is an explicit JSON null, never the on-screen progress anchor.
        assertTrue(back.containsKey("objectAnchor"))
        assertTrue(text.contains("\"objectAnchor\":null"))
        val names = back["frames"].arr!!.map { it.obj!!["image"].str }
        assertEquals(listOf("0001.jpg", "0002.jpg"), names)
        val parsed = CaptureCamera.parse(text.toByteArray())!!
        assertEquals(listOf(frame("0001.jpg"), frame("0002.jpg")), parsed)
        assertNull(CaptureCamera.parse("""{"version":2,"kind":"capture-camera","frames":[]}""".toByteArray()))
        assertNull(CaptureCamera.parse("not json".toByteArray()))
    }

    @Test fun hashesAreOfExactBytes() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Hex.sha256(ByteArray(0)))
    }
}

class ReconstructionModelTests {
    @Test fun reviewDecodesOnProject() {
        val p = Project.decode(reviewJson("region", ""","previewMeshSha256":"$HASH","suggestion":{"type":"component","reason":"largest","extents":{"x":2,"y":3,"z":4}},
            "components":[{"index":0,"vertices":10,"faces":4,"share":0.75,"boundsMin":[0,0,0],"boundsMax":[2,3,4],"extents":{"x":2,"y":3,"z":4}}]"""))!!
        val r = p.reconstructionReview!!
        assertEquals("region", r.kind)
        assertEquals(HASH, r.previewMeshSha256)
        assertTrue(r.boundsValid)
        assertEquals(0, r.suggestedComponent()?.index)
        assertNull(r.mm(2.0))
    }

    @Test fun regionAnswersSendExactHashes() {
        val r = Project.decode(reviewJson("region", ""","previewMeshSha256":"$HASH" """))!!.reconstructionReview!!
        val suggested = ReconstructionAnswers.regionAnswer(r, RegionSelection.Suggested)
        assertEquals("region", suggested["type"].str)
        assertEquals(HASH, suggested["previewMeshSha256"].str)
        assertEquals("suggested", suggested["selection"].obj!!["type"].str)
        val component = ReconstructionAnswers.regionAnswer(r, RegionSelection.Component(3))
        assertEquals(3.0, component["selection"].obj!!["index"].num)
        val crop = ReconstructionAnswers.regionAnswer(r, RegionSelection.Crop(listOf(0.5, 0.5, 0.5), listOf(1.0, 2.0, 3.0)))
        assertEquals(listOf(0.5, 0.5, 0.5), crop["selection"].obj!!["min"].arr!!.map { it.num })
    }

    @Test fun cropsMustOverlapAndNotInvert() {
        val r = Project.decode(reviewJson("region"))!!.reconstructionReview!!
        assertTrue(ReconstructionAnswers.validCrop(r, listOf(-1.0, 0.0, 0.0), listOf(1.0, 1.0, 1.0)))
        assertFalse(ReconstructionAnswers.validCrop(r, listOf(5.0, 0.0, 0.0), listOf(6.0, 1.0, 1.0)))
        assertFalse(ReconstructionAnswers.validCrop(r, listOf(1.0, 0.0, 0.0), listOf(0.5, 1.0, 1.0)))
        assertFalse(ReconstructionAnswers.validCrop(r, listOf(Double.NaN, 0.0, 0.0), listOf(1.0, 1.0, 1.0)))
    }

    @Test fun scaleAnswersAreFiniteBoundedAndBound() {
        assertEquals(42.5, ReconstructionAnswers.validExtentMm("42.5")!!, 1e-9)
        assertEquals(42.5, ReconstructionAnswers.validExtentMm(" 42,5 ")!!, 1e-9)
        assertNull(ReconstructionAnswers.validExtentMm("0"))
        assertNull(ReconstructionAnswers.validExtentMm("10001"))
        assertNull(ReconstructionAnswers.validExtentMm("-3"))
        assertNull(ReconstructionAnswers.validExtentMm("NaN"))
        assertNull(ReconstructionAnswers.validExtentMm("big"))
        val r = Project.decode(reviewJson("scale", ""","meshSha256":"$HASH2" """))!!.reconstructionReview!!
        val a = ReconstructionAnswers.scaleAnswer(r, "y", 120.0)
        assertEquals(HASH2, a["meshSha256"].str)
        assertEquals("y", a["axis"].str)
        assertEquals(120.0, a["extentMm"].num)
        try { ReconstructionAnswers.scaleAnswer(r, "w", 10.0); fail("axis") } catch (_: CompanionException) {}
        try { ReconstructionAnswers.regionAnswer(r, RegionSelection.Suggested); fail("hash") } catch (_: CompanionException) {}
    }

    @Test fun manifestForArAndPlainPhotos() {
        val ar = ReconstructionAnswers.captureManifest(listOf("0002.jpg", "0001.jpg"), cameraMetadataRequired = true)
        assertEquals(1.0, ar["version"].num)
        assertEquals(listOf("0001.jpg", "0002.jpg"), ar["images"].arr!!.map { it.str })
        assertEquals(false, ar["depthRequired"].bool)
        assertEquals(true, ar["cameraMetadataRequired"].bool)
        assertEquals(true, ar["scaleQualificationRequired"].bool)
        val plain = ReconstructionAnswers.captureManifest(listOf("0001.jpg"), cameraMetadataRequired = false)
        assertFalse(plain.containsKey("cameraMetadataRequired"))
        assertEquals(true, plain["scaleQualificationRequired"].bool)
    }

    @Test fun newRoutesHaveScopes() {
        assertEquals("captures:import", CompanionClient.scope("POST", "/v1/objects/$ID/capture-camera"))
        assertEquals("captures:import", CompanionClient.scope("POST", "/v1/objects/$ID/reconstruction"))
        assertEquals("projects:read", CompanionClient.scope("GET", "/v1/objects/$ID/reconstruction-preview.stl"))
    }
}

class StlParserTests {
    private fun binaryStl(tris: List<FloatArray>): ByteArray {
        val buffer = ByteBuffer.allocate(84 + tris.size * 50).order(ByteOrder.LITTLE_ENDIAN)
        buffer.position(80); buffer.putInt(tris.size)
        for (tri in tris) {
            buffer.position(buffer.position() + 12)
            tri.forEach { buffer.putFloat(it) }
            buffer.putShort(0)
        }
        return buffer.array()
    }

    @Test fun binaryParsesWithComputedNormalsAndBounds() {
        val mesh = StlParser.parse(binaryStl(listOf(floatArrayOf(0f, 0f, 0f, 2f, 0f, 0f, 0f, 3f, 0f))))!!
        assertEquals(1, mesh.sourceTriangles); assertEquals(1, mesh.renderedTriangles)
        assertEquals(listOf(0f, 0f, 0f), mesh.boundsMin.toList())
        assertEquals(listOf(2f, 3f, 0f), mesh.boundsMax.toList())
        assertEquals(1f, mesh.normals[2], 1e-6f)
    }

    @Test fun asciiParses() {
        val text = """
            solid preview
             facet normal 0 0 1
              outer loop
               vertex 0 0 0
               vertex 1 0 0
               vertex 0 1 0
              endloop
             endfacet
            endsolid
        """.trimIndent()
        val mesh = StlParser.parse(text.toByteArray())!!
        assertEquals(1, mesh.renderedTriangles)
        assertNotNull(mesh)
    }

    @Test fun renderingIsBoundedByDecimation() {
        val tri = floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f)
        val mesh = StlParser.parse(binaryStl(List(1000) { tri }), maxTriangles = 10)!!
        assertEquals(1000, mesh.sourceTriangles)
        assertEquals(10, mesh.renderedTriangles)
        assertEquals(90, mesh.positions.size)
    }

    @Test fun rejectsGarbageAndNonFinite() {
        assertNull(StlParser.parse(ByteArray(0)))
        assertNull(StlParser.parse("hello".toByteArray()))
        val bad = binaryStl(listOf(floatArrayOf(Float.NaN, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f)))
        assertNull(StlParser.parse(bad))
    }
}

class HostReadinessTests {
    private fun health(caps: Set<String>, checking: Set<String> = emptySet()) = CompanionClient.Health(caps, null, checking)

    /** #751 review: a companion that has just started says it is still checking; the phone waits, never "Update Counterpart". */
    @Test fun aHostStillCheckingIsWaitedForNotCalledOutOfDate() = kotlinx.coroutines.runBlocking {
        val answers = ArrayDeque(listOf(
            health(emptySet(), setOf(ReconstructionAnswers.CAPABILITY)),
            health(emptySet(), setOf(ReconstructionAnswers.CAPABILITY)),
            health(setOf(ReconstructionAnswers.CAPABILITY))))
        var waited = 0L
        assertNull(ReconstructionAnswers.hostRefusal({ answers.removeFirst() }, { waited += it }))
        assertEquals(4_000L, waited)
    }

    @Test fun anOlderHostStillGetsTheUpdateLineAtOnce() = kotlinx.coroutines.runBlocking {
        var waited = 0L
        assertEquals("update-host", ReconstructionAnswers.hostRefusal({ health(emptySet()) }, { waited += it })?.code)
        assertEquals(0L, waited)
    }

    @Test fun aCheckThatNeverSettlesSaysTheComputerIsGettingReadyNotUpdate() = kotlinx.coroutines.runBlocking {
        var waited = 0L
        val refusal = ReconstructionAnswers.hostRefusal({ health(emptySet(), setOf(ReconstructionAnswers.CAPABILITY)) }, { waited += it }, limitMs = 6_000)
        assertEquals("host-checking", refusal?.code)
        assertEquals(6_000L, waited)
    }
}
