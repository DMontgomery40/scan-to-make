package com.scantomake.counterpart

import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ScanLineage
import com.scantomake.counterpart.api.makeFromScanBody
import com.scantomake.counterpart.api.ProjectFit
import com.scantomake.counterpart.core.WireJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Make something else from this scan (design §3.3). The cases are CounterpartKit's `Fixtures/scan-lineage.json`, read
 *  by the iPhone and Mac suite too: the same projects offer it, the same lines on every layout. */
class ScanLineageTests {
    private val document = WireJson.parseToJsonElement(kitFixture("scan-lineage.json").readText()).jsonObject
    private val projects: Map<String, Project> = document["projects"]!!.jsonObject.mapValues { (key, value) ->
        requireNotNull(Project.decode(value.jsonObject)) { "$key: not decodable on Android" }
    }
    private fun JsonObject.text(key: String) = this[key]?.takeIf { it != JsonNull }?.jsonPrimitive?.contentOrNull
    private fun JsonObject.keys(key: String) = this[key]!!.jsonArray.map { it.jsonPrimitive.content }

    @Test fun theWordsAreTheSameEverywhere() {
        val words = document["words"]!!.jsonObject
        assertEquals(words.text("action"), ScanLineage.ACTION)
        assertEquals(words.text("fitChoice"), ScanLineage.FIT_CHOICE)
        assertEquals(words.text("copyChoice"), ScanLineage.COPY_CHOICE)
        assertEquals(words.text("useExisting"), ScanLineage.USE_EXISTING)
    }

    @Test fun everyProjectTheComputerHasAScanForOffersItWhateverItsKind() {
        val cases = document["canMakeFromScan"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val project = projects.getValue(case.text("project")!!)
            assertEquals(case.text("why"), case["expected"]!!.jsonPrimitive.booleanOrNull, project.canMakeFromScan)
        }
    }

    @Test fun bothPagesSayWhereTheScanCameFromAndWhatElseWasMade() {
        val cases = document["lineage"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val name = case.text("name")
            val lineage = ScanLineage(projects.getValue(case.text("project")!!), case.keys("among").map(projects::getValue))
            assertEquals(name, case.text("fromLine"), lineage.fromLine)
            assertEquals(name, case["fromExists"]?.takeIf { it != JsonNull }?.jsonPrimitive?.booleanOrNull, lineage.from?.exists)
            assertEquals(name, case.text("madeLine"), lineage.madeLine)
            assertEquals(name, case.keys("made"), lineage.made.map { it.id })
        }
    }

    @Test fun newOffersEveryScanTheComputerHasNewestFirst() {
        val scans = document["scans"]!!.jsonObject
        assertEquals(scans.keys("expected"), ScanLineage.scans(scans.keys("among").map(projects::getValue)).map { it.id })
        assertEquals("scanned Nov 4", ScanLineage.scannedLine(projects.getValue("src").copy(createdAtMs = 1762243200000.0), java.time.ZoneId.of("America/Denver")))
    }

    @Test fun theRequestAsksForTheChosenKindWithTheWords() {
        val fit = makeFromScanBody("fit", " a belt case for it ", ProjectFit.of("scan"))
        assertEquals("fit", fit["kind"]!!.jsonPrimitive.content)
        assertEquals("a belt case for it", fit["instructions"]!!.jsonPrimitive.content)
        assertEquals("""{"sizeSource":"scan"}""", fit["fit"].toString())
        val copy = makeFromScanBody("copy", "", ProjectFit.of("scan"))
        assertEquals("copy", copy["kind"]!!.jsonPrimitive.content)
        assertFalse("instructions" in copy); assertFalse("only a fit says how its size is settled", "fit" in copy)
    }
}
