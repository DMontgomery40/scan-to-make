package com.scantomake.counterpart.api

import java.util.UUID

/**
 * One id for each note a person writes, kept across every try at sending it. The Mac records a note once per id, so a
 * send whose reply was lost and is pressed again does not become a second message and a second design pass
 * (Nov 10, "Guitar pick"). A note is its words and its attachments: changed words are a new note, so are the same
 * words with other photos (the Mac ignores a repeat's photos, so they would never attach), and so are the same words
 * after a send that worked.
 */
data class NoteAttempt(val text: String, val photos: List<String>, val id: String) {
    companion object {
        /** [photos] is whatever names this note's attachments here: the chosen files' paths. */
        fun of(last: NoteAttempt?, text: String, photos: List<String> = emptyList(), newId: () -> String = { UUID.randomUUID().toString() }): NoteAttempt =
            if (last != null && last.text == text && last.photos == photos) last else NoteAttempt(text, photos, newId())
    }
}
