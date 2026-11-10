package com.scantomake.counterpart

import com.scantomake.counterpart.api.AskSizesForm
import com.scantomake.counterpart.api.Project
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as CounterpartKit's `AskSizesFormTests`. */
class AskSizesFormTests {
    private val waisted = listOf(
        Project.Ask.Size("size-1", "width at the pink stripe", 64.0, "scan"),
        Project.Ask.Size("size-2", "width at the waist", 53.5, "scan"),
        Project.Ask.Size("size-3", "height to the cap tip", 107.0, "published"))
    private fun ask(kind: String? = "sizes", sizes: List<Project.Ask.Size>? = waisted) =
        Project.Ask(id = "a", question = "Can you confirm or correct these?", answers = listOf("sizes", "text", "camera"), kind = kind, sizes = sizes)

    @Test fun theFieldsArePrefilledWithTheComputersNumbersAndConfirmSendsThemAll() {
        val form = AskSizesForm.of(ask())!!
        assertEquals(listOf("64", "53.5", "107"), form.fields.map { it.text })
        assertEquals(waisted.map { it.label }, form.fields.map { it.label })
        assertTrue(form.unchanged)
        assertEquals(listOf(AskSizesForm.Answer("size-1", 64.0), AskSizesForm.Answer("size-2", 53.5), AskSizesForm.Answer("size-3", 107.0)), form.answer)
    }

    /** The computer's number can be finer than the field shows; untouched, that is still Confirm (the computer keeps its own number). */
    @Test fun aNumberFinerThanTheFieldShowsIsStillUnchanged() {
        val fine = listOf(Project.Ask.Size("a", "width", 68.412, "scan"), Project.Ask.Size("b", "waist", 53.4567, "scan"))
        val form = AskSizesForm.of(ask(sizes = fine))!!
        assertEquals(listOf("68.41", "53.46"), form.fields.map { it.text })
        assertTrue(form.unchanged)
        assertEquals(listOf(AskSizesForm.Answer("a", 68.41), AskSizesForm.Answer("b", 53.46)), form.answer)
        assertFalse(form.with("a", "68.42").unchanged)
    }

    @Test fun aCorrectionACommaAndABlankField() {
        var form = AskSizesForm.of(ask())!!.with("size-1", " 63 ").with("size-2", "53,2")
        assertFalse(form.unchanged)
        assertEquals(listOf(AskSizesForm.Answer("size-1", 63.0), AskSizesForm.Answer("size-2", 53.2), AskSizesForm.Answer("size-3", 107.0)), form.answer)
        // A size the person doesn't know is left out, never sent as confirmed.
        form = form.with("size-3", "")
        assertEquals(listOf("size-1", "size-2"), form.answer!!.map { it.id })
    }

    @Test fun nothingIsSentWhileAFieldIsNotANumberOrAllAreBlank() {
        val form = AskSizesForm.of(ask())!!
        for (bad in listOf("about 60", "0", "-4", "10001", "6 3", "1e3")) assertNull(bad, form.with("size-1", bad).answer)
        assertNull(form.with("size-1", " ").with("size-2", "").with("size-3", "").answer)
    }

    @Test fun onlyASizesQuestionWithSizesIsOne() {
        assertNull(AskSizesForm.of(ask(kind = "closeup")))
        assertNull(AskSizesForm.of(ask(sizes = null)))
        assertNull(AskSizesForm.of(ask(sizes = emptyList())))
        assertNull(AskSizesForm.of(null))
        assertEquals(1, AskSizesForm.of(ask(sizes = listOf(Project.Ask.Size("only", "inner diameter", 25.0, "published"))))!!.fields.size)
        assertEquals("from the maker", AskSizesForm.source("published"))
        assertEquals("from your scan", AskSizesForm.source("scan"))
    }

    /** One answer carries everything the card holds: words or a caliper photo go with the numbers as they stand. */
    @Test fun anotherAnswerFromTheCardCarriesTheNumbersAsTheyStand() {
        var form = AskSizesForm.of(ask())!!
        assertEquals("prefilled", AskSizesForm.Carried.Sizes(listOf(AskSizesForm.Answer("size-1", 64.0), AskSizesForm.Answer("size-2", 53.5), AskSizesForm.Answer("size-3", 107.0))), form.carried)
        form = form.with("size-1", "63").with("size-3", "")
        assertEquals("edited, one unknown", AskSizesForm.Carried.Sizes(listOf(AskSizesForm.Answer("size-1", 63.0), AskSizesForm.Answer("size-2", 53.5))), form.carried)
        form = form.with("size-2", "about 53")
        assertEquals("nothing goes until the field is a number or empty", AskSizesForm.Carried.Invalid, form.carried)
        form = form.with("size-1", " ").with("size-2", " ").with("size-3", " ")
        assertEquals("every size unknown: the other answer goes alone", AskSizesForm.Carried.None, form.carried)
    }

    /** The same forms on every client (train #499 review, F8). */
    @Test fun aNumberIsDigitsWithAtMostOneDecimalPart() {
        for (good in listOf("64", "53.5", " 53,25 ", "0.5", "10000")) assertNotNull(good, AskSizesForm.millimetres(good))
        for (bad in listOf("1e3", ".5", "5.", "5.5.5", "+5", "-4", "0", "10001", "6 3", "about 60", "", "\u0665")) assertNull(bad, AskSizesForm.millimetres(bad))
    }

    /** A kind this build doesn't know offers no answer; a question with no kind is from an older computer and is answered. */
    @Test fun aQuestionOfAnUnknownKindOffersNoAnswer() {
        for (kind in AskSizesForm.knownKinds) assertTrue(kind, AskSizesForm.answerable(kind))
        assertTrue(AskSizesForm.answerable(null))
        assertFalse(AskSizesForm.answerable("colour"))
    }
}
