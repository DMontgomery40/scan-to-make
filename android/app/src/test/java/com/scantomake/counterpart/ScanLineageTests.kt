package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ScanLineage
import com.scantomake.counterpart.api.makeFromScanBody
import com.scantomake.counterpart.api.ProjectFit
import com.scantomake.counterpart.core.parseObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of CounterpartKit's ScanLineageTests (design §3.3): the same projects offer it, the same lines on both pages. */
class ScanLineageTests {
    private fun project(json: String) = Project.decode(parseObject("""{"createdAtMs":1,"updatedAtMs":2,"photos":[],"passes":[],"state":"ready",$json}""")!!)!!
    private val leatherman = project(""""id":"src","title":"Leatherman Wave+ replica","kind":"copy","scan":"scan.usdz","createdAtMs":1000""")
    private fun made(id: String, title: String, ms: Long) =
        project(""""id":"$id","title":"$title","kind":"fit","scan":"scan.usdz","createdAtMs":$ms,"scanFrom":{"id":"src","title":"Leatherman Wave+ replica"}""")

    @Test fun everyProjectTheComputerHasAScanForOffersItWhateverItsKind() {
        assertTrue(leatherman.canMakeFromScan)
        assertFalse(project(""""id":"c","capture":["0001.heic"]""").canMakeFromScan)
        assertEquals("Make something else from this scan", ScanLineage.ACTION)
        assertEquals("Make something that fits this", ScanLineage.FIT_CHOICE)
        assertEquals("Copy this object", ScanLineage.COPY_CHOICE)
        assertEquals("Use a scan you already have", ScanLineage.USE_EXISTING)
    }

    @Test fun bothPagesSayWhereTheScanCameFrom() {
        val belt = made("belt", "Belt case", 2000); val clip = made("clip", "Pocket clip", 3000)
        assertEquals("Uses the scan from “Leatherman Wave+ replica”", ScanLineage(belt, listOf(leatherman, belt, clip)).fromLine)
        assertNull(ScanLineage(leatherman, listOf(leatherman, belt)).fromLine)
        assertEquals("Also made from this scan: “Belt case”", ScanLineage(leatherman, listOf(leatherman, belt)).madeLine)
        assertEquals("Also made from this scan: 2 projects", ScanLineage(leatherman, listOf(leatherman, belt, clip)).madeLine)
        assertEquals(listOf("clip", "belt"), ScanLineage(leatherman, listOf(leatherman, belt, clip)).made.map { it.id })
        val gone = ScanLineage(belt, listOf(belt))
        assertEquals("Uses the scan from “Leatherman Wave+ replica”, since deleted", gone.fromLine)
        assertFalse(gone.from!!.exists)
        assertEquals(listOf("belt", "src"), ScanLineage.scans(listOf(leatherman, project(""""id":"w","instructions":"A hook","createdAtMs":9000"""), belt)).map { it.id })
        assertEquals("scanned Nov 4", ScanLineage.scannedLine(project(""""id":"d","scan":"s.usdz","createdAtMs":1762243200000"""), java.time.ZoneId.of("America/Denver")))
    }

    @Test fun theRequestAsksForTheChosenKindWithTheWords() {
        val fit = makeFromScanBody("fit", " a belt case for it ", ProjectFit.of("lookup"))
        assertEquals("fit", fit["kind"]!!.jsonPrimitive.content)
        assertEquals("a belt case for it", fit["instructions"]!!.jsonPrimitive.content)
        assertTrue("fit" in fit)
        val copy = makeFromScanBody("copy", "", ProjectFit.of("lookup"))
        assertEquals("copy", copy["kind"]!!.jsonPrimitive.content)
        assertFalse("instructions" in copy); assertFalse("fit" in copy)
    }
}
