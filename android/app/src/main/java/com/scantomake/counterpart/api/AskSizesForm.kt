package com.scantomake.counterpart.api

/**
 * The fields of a size question: one per size the computer asked about, prefilled with its number, each editable.
 * Port of CounterpartKit `AskSizesForm`; the same rules decide what is sent on every client.
 */
data class AskSizesForm(val fields: List<Field>) {
    data class Field(val id: String, val label: String, val from: String, val asked: Double, val text: String,
                     val product: String? = null, val reference: String? = null) {
        /** The person typed or edited this number (anything but the prefilled text, spaces aside). Untouched, it is the
         *  computer's number accepted, never a measurement (#622). */
        val measured: Boolean get() = text.trim() != text(asked)
    }
    /** One size to send back, and whether the person typed it (`measured`) or let the computer's number stand. */
    data class Answer(val id: String, val mm: Double, val measured: Boolean = false)

    /** What to send: every field that holds a number. Null while a filled field isn't a number, or none is filled.
     *  A field left blank is a size the person doesn't know: it is left out, never sent as accepted. */
    val answer: List<Answer>? get() {
        val sizes = mutableListOf<Answer>()
        for (field in fields) {
            if (field.text.isBlank()) continue
            sizes += Answer(field.id, millimetres(field.text) ?: return null, field.measured)
        }
        return sizes.ifEmpty { null }
    }

    /** What goes with any other answer sent from the same card (words, a caliper photo): one answer carries everything the
     *  card holds, so a number typed into a field is never dropped by pressing another button. */
    sealed interface Carried {
        /** The numbers as they stand, edited or prefilled. */
        data class Sizes(val sizes: List<Answer>) : Carried
        /** Every field is blank: the person knows none of them, and the other answer goes alone. */
        data object None : Carried
        /** A filled field isn't a number: nothing is sent until it is fixed or cleared. */
        data object Invalid : Carried
    }
    val carried: Carried get() = answer?.let { Carried.Sizes(it) } ?: if (fields.all { it.text.isBlank() }) Carried.None else Carried.Invalid

    /** Nothing was typed: the button says Confirm, and every number goes as accepted. */
    val unchanged: Boolean get() = fields.none { it.measured }

    fun with(id: String, text: String) = copy(fields = fields.map { if (it.id == id) it.copy(text = text) else it })

    companion object {
        /** Null when the question lists no sizes: it is not a size question. */
        fun of(ask: Project.Ask?): AskSizesForm? {
            val sizes = ask?.sizes?.takeIf { ask.kind == "sizes" && it.isNotEmpty() } ?: return null
            return AskSizesForm(sizes.map { Field(it.id, it.label, it.from, it.mm, text(it.mm), it.product, it.reference) })
        }

        /** A number as a person types it: no trailing ".0", at most two decimals. */
        fun text(mm: Double): String {
            val rounded = Math.round(mm * 100) / 100.0
            return if (rounded == Math.rint(rounded)) rounded.toLong().toString() else rounded.toString()
        }

        /** The number a field holds, when it is one (a comma or a point for the decimal; over zero, at most 10 m). */
        fun millimetres(text: String): Double? {
            val typed = text.trim().replace(',', '.')
            // Digits with at most one decimal part, ASCII only, as every client takes it: never "1e3", ".5", "5." or "٥".
            if (!Regex("^[0-9]+(\\.[0-9]+)?$").matches(typed)) return null
            return typed.toDoubleOrNull()?.takeIf { it > 0 && it <= 10_000 }
        }

        /** Under a field: where the computer's number came from (#622). A published one names the product it is for and
         *  where it was published; a source this build doesn't know reads as an estimate, never as the scan or the maker's. */
        fun source(from: String, product: String? = null, reference: String? = null): String = when (from) {
            "published" -> {
                val named = product?.trim().orEmpty()
                val place = reference?.let(::place)
                when {
                    named.isEmpty() -> "Published size, product not named"
                    place == null -> "Published for $named"
                    else -> "Published for $named · $place"
                }
            }
            "scan" -> "Read from your scan"
            else -> "Your computer's estimate, not measured"
        }
        fun source(field: Field) = source(field.from, field.product, field.reference)

        /** Where a published size was published, short: a link's site (without "www."), or the document's name as given. */
        fun place(reference: String): String? {
            val trimmed = reference.trim()
            if (trimmed.isEmpty()) return null
            val host = Regex("^https?://([^/?#:]+)", RegexOption.IGNORE_CASE).find(trimmed)?.groupValues?.get(1)?.lowercase()
            return host?.removePrefix("www.")?.takeIf { it.isNotEmpty() } ?: trimmed
        }

        /** The kinds of question this build knows how to answer (contracts `AskSchema.kind`). */
        val knownKinds = setOf("closeup", "file", "choice", "region", "scale", "sizes")

        /** False for a kind this build doesn't know: the card shows the question and says to update, and offers no answer
         *  at all, because any answer it offered could consume the question wrongly. No kind is a computer older than
         *  kinds, answered the old way. */
        fun answerable(kind: String?) = kind == null || kind in knownKinds

        /** Said under the fields while nothing can be sent, and when another answer is pressed with a field that isn't a number. */
        const val invalidWords = "Enter each size in millimetres, or leave one empty if you don't know it."
    }
}
