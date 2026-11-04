package com.scantomake.counterpart.api

/** One-based layers, matching the printer MCP's Add pause contract. Null means an invalid entry. */
object PrintPauses {
    fun parse(text: String, totalLayers: Int?): List<Int>? {
        if (text.isBlank()) return emptyList()
        val layers = text.split(',').map { token ->
            val digits = token.trim()
            if (!digits.matches(Regex("[0-9]+"))) return null
            val layer = digits.toIntOrNull() ?: return null
            if (layer !in 2..100_000 || (totalLayers != null && layer > totalLayers)) return null
            layer
        }.distinct().sorted()
        return layers.takeIf { it.size <= 16 }
    }
}
