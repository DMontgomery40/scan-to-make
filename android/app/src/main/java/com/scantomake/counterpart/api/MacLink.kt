package com.scantomake.counterpart.api

/**
 * Whether the paired computer is answering, as one value the whole app reads. Port of CounterpartKit `MacLink`.
 * Every reply, even a refusal, is an answer; only two failures are about the connection: the computer didn't answer,
 * or it wants this phone paired again.
 */
sealed interface MacLink {
    /** Nothing has come back yet (first launch, a new pairing). */
    data object Checking : MacLink
    data object Connected : MacLink
    data object NotAnswering : MacLink
    data class NeedsPairing(val code: String, val message: String) : MacLink

    /** True once the computer has answered, false when it didn't, null while nothing is known (or pairing is the problem). */
    val reachable: Boolean? get() = when (this) { Connected -> true; NotAnswering -> false; Checking, is NeedsPairing -> null }

    /** After a request failed. One the computer refused for any other reason still proves it is there. */
    fun failed(error: CompanionException): MacLink = when {
        error.needsPairing -> NeedsPairing(error.code, error.message)
        error.isUnreachable -> NotAnswering
        else -> Connected
    }

    /** After any reply. */
    fun answered(): MacLink = Connected
}
