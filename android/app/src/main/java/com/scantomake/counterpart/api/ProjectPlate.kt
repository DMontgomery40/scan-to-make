package com.scantomake.counterpart.api

import kotlinx.serialization.Serializable

/** The companion retains all plates and their printer-confirmed completion, including reprints. */
@Serializable
data class ProjectPlate(
    val id: String, val fileIndex: Int, val plateIndex: Int, val name: String, val fileName: String,
    val thumbnail: String? = null, val selected: Boolean, val sliced: Boolean, val status: String,
    val printId: String? = null, val completedAtMs: Double? = null,
    /** Its last send may have reached the printer: printing it again asks "I checked the printer". */
    val uncertain: Boolean? = null,
) {
    val statusText: String get() = when (status) {
        "printed" -> "Printed"
        "preparing" -> "Getting ready"
        "printing" -> "Printing"
        "paused" -> "Paused"
        "cancelled" -> if (completedAtMs == null) "Cancelled" else "Reprint cancelled · printed before"
        "failed" -> if (completedAtMs == null) "Print failed" else "Reprint failed · printed before"
        "sent" -> "Sent to printer"
        "unknown" -> "Check print result"
        else -> if (completedAtMs == null) "Not printed" else "Printed"
    }
}
