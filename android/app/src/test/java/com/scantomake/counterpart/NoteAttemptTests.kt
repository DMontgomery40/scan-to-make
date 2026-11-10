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
        val first = NoteAttempt.of(null, "Thicker walls", newId = id)
        assertEquals(NoteAttempt("Thicker walls", emptyList(), "id-1"), first)
        assertSame("a second try at the same note", first, NoteAttempt.of(first, "Thicker walls", newId = id))
        assertEquals("id-2", NoteAttempt.of(first, "Thicker walls, 3 mm", newId = id).id)
        // After a send that worked the screen forgets the attempt, so the same words again are a new note.
        assertEquals("id-3", NoteAttempt.of(null, "Thicker walls", newId = id).id)
        // A note is its words and its attachments: other photos are another note.
        val one = NoteAttempt.of(null, "See the photos", listOf("/a.jpg"), id)
        assertSame(one, NoteAttempt.of(one, "See the photos", listOf("/a.jpg"), id))
        assertEquals("id-5", NoteAttempt.of(one, "See the photos", listOf("/a.jpg", "/b.jpg"), id).id)
        assertEquals("id-6", NoteAttempt.of(one, "See the photos", listOf("/b.jpg"), id).id)
        assertEquals("id-7", NoteAttempt.of(one, "See the photos", newId = id).id)
        assertTrue("the Mac accepts this id", Regex("[A-Za-z0-9-]{8,64}").matches(NoteAttempt.of(null, "x").id))
    }
}
