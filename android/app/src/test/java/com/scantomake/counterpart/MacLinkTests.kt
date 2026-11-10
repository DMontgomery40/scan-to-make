package com.scantomake.counterpart

import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.MacLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The same table as CounterpartKit's `MacLinkTests`. */
class MacLinkTests {
    private val pairing = CompanionException("pairing-changed", "Connect to your computer again.")
    private val refusal = CompanionException("invalid-state", "That project is printing.")

    @Test fun everyStateFromEveryEvent() {
        val states = listOf(MacLink.Checking, MacLink.Connected, MacLink.NotAnswering, MacLink.NeedsPairing(pairing.code, pairing.message))
        for (start in states) {
            assertEquals("$start: a reply is an answer", MacLink.Connected, start.answered())
            assertEquals("$start: one request the computer didn't answer says so at once", MacLink.NotAnswering, start.failed(CompanionException.unreachable))
            assertEquals("$start", MacLink.NeedsPairing(pairing.code, pairing.message), start.failed(pairing))
            assertEquals("$start: a refusal still proves the computer is there", MacLink.Connected, start.failed(refusal))
        }
    }

    @Test fun whatEachStateSays() {
        assertNull(MacLink.Checking.reachable)
        assertEquals(true, MacLink.Connected.reachable)
        assertEquals(false, MacLink.NotAnswering.reachable)
        assertNull("pairing is the problem, not reachability", MacLink.NeedsPairing(pairing.code, pairing.message).reachable)
    }
}
