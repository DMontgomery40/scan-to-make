package com.scantomake.counterpart

import com.scantomake.counterpart.api.McpPackageCopies
import com.scantomake.counterpart.api.PrinterSoftwareRow
import com.scantomake.counterpart.core.WireJson
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #775 (David, Nov 12, Settings → Printer software: "messy af looking, double entries, confusing wording"): one quiet row
 * per MCP, the same words as CounterpartKit's `PrinterSoftwareRow` and Linux's `printerSoftwareRow`, from the companion's
 * own answers (`mcp-printer-software-*.json`).
 */
class PrinterSoftwareTests {
    @Serializable private data class Reply(val packages: List<McpPackageCopies>)
    private fun software(name: String) = WireJson.decodeFromString<Reply>(contractFixture("mcp-printer-software-$name.json").readText()).packages

    @Test fun twoProfilesOfOnePrinterAreOneUsedByAndNothingNewerHasNoUpdate() {
        val (bambu, generic) = software("current").map { it.row() }
        assertEquals("bambu-printer-mcp", bambu.name)
        assertEquals("1.1.94", bambu.version)
        assertEquals(PrinterSoftwareRow.UP_TO_DATE, bambu.status)
        assertNull("nothing newer: no Update", bambu.update)
        assertEquals("Used by P1S", bambu.usedBy)
        assertEquals(emptyList<PrinterSoftwareRow.Other>(), bambu.others)
        assertEquals("1.2.76", generic.version)
        assertEquals("No printer uses it yet", generic.usedBy)
        for (row in listOf(bambu, generic)) assertFalse(row.toString().contains("Counterpart’s copy"))
    }

    @Test fun aNewerVersionSaysAvailableWithOneUpdate() {
        val packages = software("update")
        val row = packages[0].row()
        assertEquals("1.1.95 available", row.status)
        assertEquals(packages[0].appMcpId, row.update)
        assertNull(packages[1].row().update)
    }

    @Test fun aPrinterOnAnotherCopyGetsOneLineAndUseCounterparts() {
        val pkg = software("own-copy")[0]
        val other = pkg.row().others.single()
        assertEquals(pkg.uses[1].mcpId, other.mcpId)
        assertEquals("P1S runs your own copy (1.1.80)", other.words)
        assertEquals("Use Counterpart’s", other.button)
        assertEquals("Use Counterpart’s bambu-printer-mcp for P1S instead of your own copy (1.1.80)", other.label)
        assertEquals("Runs from a folder you manage, so Counterpart doesn't update it by itself. Your own copy is left as it is.", other.footnote)
        assertEquals("the printer's own page shows only its own", emptyList<PrinterSoftwareRow.Other>(), pkg.row("someone-else").others)
    }

    /** A companion from before #775: no status line, no Update, printers once by id, the same plain line. */
    @Test fun anOlderCompanionRendersCleanly() {
        val pkg = WireJson.decodeFromString<McpPackageCopies>("""
        {"package":"bambu-printer-mcp","label":"bambu-printer-mcp","appMcpId":"mcp-a","version":"1.1.94","latestVersion":"1.1.95",
         "appCopy":{"kind":"app","version":"1.1.94"},
         "uses":[{"destinationId":"current","printerId":"p1s","printer":"P1S","mcpId":"mcp-a","kind":"app","version":"1.1.94","canMove":false,"managed":true},
                 {"destinationId":"lan","printerId":"p1s","printer":"P1S","mcpId":"mcp-a","kind":"app","version":"1.1.94","canMove":false,"managed":true},
                 {"destinationId":"x1c","printerId":"x1c","printer":"X1C","mcpId":"mcp-b","kind":"checkout","path":"/x/bambu","version":"1.1.80","canMove":true}],
         "moves":[{"mcpId":"mcp-b","title":"Move X1C (bambu-printer-mcp, your copy at /x/bambu) to Counterpart’s updated copy"}]}
        """.trimIndent())
        val row = pkg.row()
        assertEquals("1.1.94", row.version)
        assertNull(row.status)
        assertNull(row.update)
        assertEquals("Used by P1S and X1C", row.usedBy)
        assertEquals(listOf("X1C runs your own copy (1.1.80)"), row.others.map { it.words })
        assertEquals("Your own copy is left as it is.", row.others.single().footnote)
    }
}
