package com.scantomake.counterpart.api

import java.util.UUID

/**
 * One id for each note a person writes, kept across every try at sending it. The Mac records a note once per id, so a
 * send whose reply was lost and is pressed again does not become a second message and a second design pass
 * (Nov 10, "Guitar pick"). Changed words are a new note; so are the same words after a send that worked.
 */
data class NoteAttempt(val text: String, val id: String) {
    companion object {
        fun of(last: NoteAttempt?, text: String, newId: () -> String = { UUID.randomUUID().toString() }): NoteAttempt =
            if (last?.text == text) last else NoteAttempt(text, newId())
    }
}
