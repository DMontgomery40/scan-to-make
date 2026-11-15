package com.scantomake.counterpart.api

/**
 * The last requests to the computer that failed, kept in memory only for Settings → Share Diagnostics… (#799).
 * Each entry is the method, the route without its query, and the HTTP status or transport code: never a header,
 * a body, a token or the computer's address.
 */
class RecentFailures(private val limit: Int = 50, private val clock: () -> Long = System::currentTimeMillis) {
    data class Entry(val atMs: Long, val method: String, val route: String, val status: Int?, val code: String?)

    private val entries = ArrayDeque<Entry>()

    @Synchronized fun record(method: String, path: String, status: Int? = null, code: String? = null) {
        entries.addLast(Entry(clock(), method, path.substringBefore("?").take(200), status, code))
        while (entries.size > limit) entries.removeFirst()
    }

    @Synchronized fun list(): List<Entry> = entries.toList()
}
