package com.scantomake.counterpart.api

import kotlinx.serialization.Serializable

/** Curated shared catalog, never copied user projects or conversation history. */
@Serializable
data class StarterProject(
    val id: String, val title: String, val subtitle: String, val summary: String, val instructions: String,
    val designer: String, val url: String, val licence: String, val detail: String, val source: String,
    val image: String? = null, val imageURL: String? = null, val imageCredit: String? = null,
)
