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
            if (!Regex("^\\d+(\\.\\d+)?$").matches(typed)) return null
            return typed.toDoubleOrNull()?.takeIf { it > 0 && it <= 10_000 }
        }

        fun source(from: String) = if (from == "published") "from the maker" else "from your scan"

        /** The kinds of question this build knows how to answer (contracts `AskSchema.kind`). */
        val knownKinds = setOf("closeup", "file", "choice", "region", "scale", "sizes")
    }
}
