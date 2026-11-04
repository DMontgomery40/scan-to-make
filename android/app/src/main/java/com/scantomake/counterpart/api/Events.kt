package com.scantomake.counterpart.api

import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.bool
import com.scantomake.counterpart.core.num
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** One user-visible change (docs/protocols/events.md). The companion writes every event's words: show them as is. */
data class CounterpartEvent(
    val seq: Int, val id: String, val at: String, val type: String, val projectId: String?, val printId: String?,
    val printerName: String?, val title: String, val body: String, val notify: String, val data: Payload?, val frame: String?,
) {
    @Serializable
    data class Payload(
        val progress: Double? = null, val remainingSec: Double? = null, val endsAt: String? = null, val layer: Int? = null,
        val totalLayers: Int? = null, val state: String? = null, val stage: String? = null, val askId: String? = null,
        val confirmationId: String? = null, val mcpId: String? = null, val fromVersion: String? = null, val toVersion: String? = null,
    )

    companion object {
        /** An event this version can't read is skipped; it never costs the page. */
        fun decode(o: JsonObject): CounterpartEvent? {
            val seq = o["seq"].num?.toInt() ?: return null
            val id = o["id"].str ?: return null
            val type = o["type"].str ?: return null
            val title = o["title"].str ?: return null
            val body = o["body"].str ?: return null
            return CounterpartEvent(seq, id, o["at"].str ?: "", type, o.opt("projectId"), o.opt("printId"), o.opt("printerName"), title, body,
                o["notify"].str?.takeIf { it in setOf("none", "passive", "active", "timeSensitive") } ?: "none", o.opt("data"), o.opt("frame"))
        }
    }
}

/** One page of the event log (`EventsPage`). */
data class EventsPage(val events: List<CounterpartEvent>, val next: Int, val latest: Int, val truncated: Boolean, val reset: Boolean) {
    val needsResync: Boolean get() = truncated || reset

    companion object {
        fun decode(o: JsonObject): EventsPage? {
            val next = o["next"].num?.toInt() ?: return null
            val events = o["events"].arr?.mapNotNull { it.obj?.let(CounterpartEvent::decode) } ?: emptyList()
            return EventsPage(events, next, o["latest"].num?.toInt() ?: next, o["truncated"].bool == true, o["reset"].bool == true)
        }
    }
}

sealed class EventUpdate {
    data class Event(val event: CounterpartEvent) : EventUpdate()
    data object Resync : EventUpdate()
}

/**
 * Follows `GET /v1/events` for as long as the collector runs. Port of CounterpartKit `EventStream`: the first read
 * starts from now (no history); later reads carry on from the cursor. Ends with `not-supported` from an older
 * Mac and with a pairing error when the phone has to pair again.
 */
fun eventStream(client: CompanionClient, startAfter: Int? = null): Flow<EventUpdate> = flow {
    var cursor: Int? = startAfter
    var failures = 0
    while (true) {
        try {
            val page = client.events(cursor ?: 0, if (cursor == null) 0 else 25, if (cursor == null) 0 else 100)
            failures = 0
            if (cursor != null && page.needsResync) emit(EventUpdate.Resync)
            if (cursor != null) for (event in page.events) emit(EventUpdate.Event(event))
            cursor = page.next
        } catch (e: CancellationException) {
            throw e
        } catch (e: CompanionException) {
            if (e.isUnsupported || e.needsPairing) throw e
            if (client.answers()) { failures = 0; delay(1_000); continue }
            failures += 1
            // While the Mac is away: 1, 2, 5, 15, then 30 s between tries. Then reload once it answers.
            delay(listOf(1L, 2, 5, 15, 30)[minOf(failures - 1, 4)] * 1000)
            if (failures == 1) emit(EventUpdate.Resync)
        }
    }
}
