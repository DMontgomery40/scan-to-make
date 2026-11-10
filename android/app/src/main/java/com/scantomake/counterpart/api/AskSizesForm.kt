package com.scantomake.counterpart.api

/**
 * The fields of a size question: one per size the computer asked about, prefilled with its number, each editable.
 * Port of CounterpartKit `AskSizesForm`; the same rules decide what is sent on every client.
 */
data class AskSizesForm(val fields: List<Field>) {
    data class Field(val id: String, val label: String, val from: String, val asked: Double, val text: String)
    data class Answer(val id: String, val mm: Double)

    /** What to send: every field that holds a number. Null while a filled field isn't a number, or none is filled.
     *  A field left blank is a size the person doesn't know: it is left out, never sent as confirmed. */
    val answer: List<Answer>? get() {
        val sizes = mutableListOf<Answer>()
        for (field in fields) {
            if (field.text.isBlank()) continue
            sizes += Answer(field.id, millimetres(field.text) ?: return null)
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

    /** Nothing was changed: the button says Confirm. */
    val unchanged: Boolean get() = fields.all { millimetres(it.text) == millimetres(text(it.asked)) }

    fun with(id: String, text: String) = copy(fields = fields.map { if (it.id == id) it.copy(text = text) else it })

    companion object {
        /** Null when the question lists no sizes: it is not a size question. */
        fun of(ask: Project.Ask?): AskSizesForm? {
            val sizes = ask?.sizes?.takeIf { ask.kind == "sizes" && it.isNotEmpty() } ?: return null
            return AskSizesForm(sizes.map { Field(it.id, it.label, it.from, it.mm, text(it.mm)) })
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

        fun source(from: String) = if (from == "published") "from the maker" else "from your scan"

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
