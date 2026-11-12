package com.scantomake.counterpart

import com.scantomake.counterpart.api.AskSizesForm
import com.scantomake.counterpart.api.Project
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

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
        assertEquals(listOf(AskSizesForm.Answer("a", 68.42, measured = true), AskSizesForm.Answer("b", 53.46)), form.with("a", "68.42").answer)
    }

    @Test fun aCorrectionACommaAndABlankField() {
        var form = AskSizesForm.of(ask())!!.with("size-1", " 63 ").with("size-2", "53,2")
        assertFalse(form.unchanged)
        assertEquals(listOf(AskSizesForm.Answer("size-1", 63.0, true), AskSizesForm.Answer("size-2", 53.2, true), AskSizesForm.Answer("size-3", 107.0)), form.answer)
        // A size the person doesn't know is left out, never sent as accepted.
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
    }

    /** One answer carries everything the card holds: words or a caliper photo go with the numbers as they stand. */
    @Test fun anotherAnswerFromTheCardCarriesTheNumbersAsTheyStand() {
        var form = AskSizesForm.of(ask())!!
        assertEquals("prefilled", AskSizesForm.Carried.Sizes(listOf(AskSizesForm.Answer("size-1", 64.0), AskSizesForm.Answer("size-2", 53.5), AskSizesForm.Answer("size-3", 107.0))), form.carried)
        form = form.with("size-1", "63").with("size-3", "")
        assertEquals("edited, one unknown: the typed one carries as measured", AskSizesForm.Carried.Sizes(listOf(AskSizesForm.Answer("size-1", 63.0, true), AskSizesForm.Answer("size-2", 53.5))), form.carried)
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

    /** #622: the Forester phone mount (`size-sources.json`, which CounterpartKit, Linux and the companion read too). Each
     *  field says where the computer's number came from, a published one with its product and where it was published;
     *  an untouched number goes as accepted and only a typed one as measured, by the card's own button and in the body. */
    @Test fun eachSizeKeepsItsSourceAndOnlyATypedNumberIsMeasured() = kotlinx.coroutines.runBlocking {
        val doc = com.scantomake.counterpart.core.WireJson.parseToJsonElement(contractFixture("size-sources.json").readText()).jsonObject
        val ask = com.scantomake.counterpart.core.WireJson.decodeFromJsonElement(Project.Ask.serializer(), doc["ask"]!!)
        assertEquals("JETech clear case for iPhone 16 Pro", ask.sizes!!.first().product)
        for (row in doc["words"]!!.jsonArray.map { it.jsonObject }) {
            val text = { key: String -> row[key]?.jsonPrimitive?.content }
            assertEquals(text("from"), text("other"), AskSizesForm.source(text("from")!!, text("product"), text("reference")))
        }
        val form = AskSizesForm.of(ask)!!
        assertEquals(listOf("Published for JETech clear case for iPhone 16 Pro · example.invalid", "Published for JETech clear case for iPhone 16 Pro · JETech product listing (placeholder)",
            "Your computer's estimate, not measured", "Read from your scan", "Published size, product not named"), form.fields.map(AskSizesForm::source))
        val id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a22"
        for (case in doc["answers"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            var edited = form
            for ((field, text) in case["edits"]!!.jsonObject) edited = edited.with(field, text.jsonPrimitive.content)
            val sent = edited.answer!!
            assertEquals(name, case["sizes"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }, sent.map { it.id })
            assertEquals(name, case["sizes"]!!.jsonArray.map { it.jsonObject["mm"]!!.jsonPrimitive.double }, sent.map { it.mm })
            assertEquals(name, case["measured"]!!.jsonArray.map { it.jsonPrimitive.content }, sent.filter { it.measured }.map { it.id })
            assertEquals(name, case["unchanged"]!!.jsonPrimitive.boolean, edited.unchanged)
            assertEquals(name, AskSizesForm.Carried.Sizes(sent), edited.carried)
            var body: String? = null
            val fake = FakeTransport { request, _ -> body = request.body?.toString(Charsets.UTF_8); json(200, mapOf("object" to mapOf("id" to id, "createdAtMs" to 1, "updatedAtMs" to 2, "state" to "touching-up"))) }
            val store = com.scantomake.counterpart.pairing.PairingStore(com.scantomake.counterpart.pairing.MemoryStore()).apply { save(v2Record(), false) }
            com.scantomake.counterpart.api.CompanionClient(com.scantomake.counterpart.pairing.PairingClient(store, fake), fake, "Pixel 8", "Pixel",
                java.io.File(System.getProperty("java.io.tmpdir"), "cp-test-${System.nanoTime()}")).answerAsk(id, sizes = sent)
            assertEquals(name, case["measured"], com.scantomake.counterpart.core.WireJson.parseToJsonElement(body!!).jsonObject["measured"])
        }
    }
}
