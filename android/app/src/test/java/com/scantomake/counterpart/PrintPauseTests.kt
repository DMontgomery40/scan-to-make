package com.scantomake.counterpart

import com.scantomake.counterpart.api.PrintChoice
import com.scantomake.counterpart.api.PrintPauses
import org.junit.Assert.*
import org.junit.Test

class PrintPauseTests {
    @Test fun layersAreSortedAndDeduplicatedWithoutRounding() {
        assertEquals(listOf(2, 9, 23), PrintPauses.parse("23, 2, 9, 2", 30))
        assertEquals(emptyList<Int>(), PrintPauses.parse("", null))
        for (input in listOf("1", "0", "2.5", "-2", "100001", "2,,3", "2,", "three", "999999999999"))
            assertNull(input, PrintPauses.parse(input, null))
        assertNull(PrintPauses.parse("12", 11))
        assertNull(PrintPauses.parse((2..18).joinToString(","), null))
        assertEquals(listOf(2), PrintPauses.parse("2", null))
    }

    @Test fun printRequestCarriesThePauseLayers() {
        assertEquals("[2,9]", PrintChoice(pauseBeforeLayers = listOf(9, 2, 9)).body["pauseBeforeLayers"].toString())
        assertNull(PrintChoice().body["pauseBeforeLayers"])
    }
}
