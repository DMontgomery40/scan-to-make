package com.scantomake.counterpart

import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.toJson
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.net.HttpRequest
import com.scantomake.counterpart.net.HttpTransport
import com.scantomake.counterpart.net.TrustPolicy
import com.scantomake.counterpart.pairing.PairingRecord
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/**
 * The repository root, found by walking up from the test's working directory, so the Android tests read the
 * very same fixtures the TypeScript contracts and the Swift CounterpartKit tests check (they can't drift apart).
 */
val repoRoot: File by lazy {
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    while (dir != null && !File(dir, "packages/contracts/fixtures").isDirectory) dir = dir.parentFile
    dir ?: error("Run the tests inside the scan-to-make repository")
}

fun contractFixture(name: String) = File(repoRoot, "packages/contracts/fixtures/$name")
fun kitFixture(name: String) = File(repoRoot, "packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/$name")

/** A transport that answers from a closure and records what it was asked (CounterpartKit's FakeTransport). */
class FakeTransport(var answer: (HttpRequest, TrustPolicy) -> HttpReply) : HttpTransport {
    data class Call(val request: HttpRequest, val trust: TrustPolicy)
    val calls = mutableListOf<Call>()
    override suspend fun send(request: HttpRequest, trust: TrustPolicy, limit: Int, resourceTimeoutMs: Long): HttpReply {
        synchronized(calls) { calls.add(Call(request, trust)) }
        return answer(request, trust)
    }
    val paths: List<String> get() = synchronized(calls) { calls.map { it.request.url } }
}

fun json(status: Int = 200, value: Any): HttpReply = HttpReply(status, WireJson.encodeToString(JsonElement.serializer(), toJson(value)).toByteArray())

const val DEVICE_ID = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a99"
val TOKEN = "t".repeat(43)
val KEY_PIN = "ab".repeat(32)
val SCOPES = listOf("generation:health", "projects:read", "projects:write", "captures:read", "captures:import", "printer-handoff:use")
val ADDRESSES = listOf("https://192.168.68.123:9077", "https://davids-mac-mini.local:9077", "https://100.101.102.103:9077")

/** A valid v2 record: three addresses, a public-key pin (Support.swift `v2Record`). */
fun v2Record(active: String? = null, expiresAt: Double = System.currentTimeMillis() + 10.0 * 86_400_000): PairingRecord {
    val fields = mutableMapOf<String, JsonElement>(
        "baseUrl" to JsonPrimitive(ADDRESSES[0]), "addresses" to toJson(ADDRESSES), "publicKeySha256" to JsonPrimitive(KEY_PIN),
        "deviceId" to JsonPrimitive(DEVICE_ID), "token" to JsonPrimitive(TOKEN), "protocolVersion" to JsonPrimitive("0.1.0"),
        "expiresAt" to JsonPrimitive(expiresAt), "scopes" to toJson(SCOPES))
    if (active != null) fields["activeUrl"] = JsonPrimitive(active)
    return PairingRecord(fields)
}
