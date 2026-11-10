package com.scantomake.counterpart

import com.scantomake.counterpart.api.NoteAttempt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same table as CounterpartKit's `NoteAttempts` cases in `CorrectionQueueTests`. */
class NoteAttemptTests {
    @Test fun oneNoteKeepsOneIdAcrossTriesAndChangedWordsAreANewNote() {
        var next = 0
        val id = { "id-${++next}" }
        val first = NoteAttempt.of(null, "Thicker walls", id)
        assertEquals(NoteAttempt("Thicker walls", "id-1"), first)
        assertSame("a second try at the same note", first, NoteAttempt.of(first, "Thicker walls", id))
        assertEquals("id-2", NoteAttempt.of(first, "Thicker walls, 3 mm", id).id)
        // After a send that worked the screen forgets the attempt, so the same words again are a new note.
        assertEquals("id-3", NoteAttempt.of(null, "Thicker walls", id).id)
        assertTrue("the Mac accepts this id", Regex("[A-Za-z0-9-]{8,64}").matches(NoteAttempt.of(null, "x").id))
    }
}
