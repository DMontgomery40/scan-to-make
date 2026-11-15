package com.scantomake.counterpart

import android.app.Application
import android.content.Context
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.RecentFailures
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.Diagnostics
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.net.TransportException
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingRecord
import com.scantomake.counterpart.pairing.PairingStore
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.io.ByteArrayInputStream
import java.io.File
import java.util.zip.ZipInputStream

/** Settings → Share Diagnostics… (#799): what the ZIP holds, and that nothing secret comes out. */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
class DiagnosticsTests {
    private lateinit var app: Counterpart
    private lateinit var state: AppState
    private lateinit var transport: FakeTransport

    /** A token, a nearby-pairing PIN and an e-mail address, planted where they could leak. */
    private val plantedToken = "Zq3vK9xT2mWb7NcR4pLs8YdF1hGj6UeA0oIk5BnVt_w"
    private val plantedPin = "482913"
    private val plantedEmail = "tester.one@example.com"

    @Before fun setup() {
        app = Counterpart()
        ReflectionHelpers.callInstanceMethod<Void>(app, "attach", ClassParameter.from(Context::class.java, RuntimeEnvironment.getApplication()))
        app.pairingStore = PairingStore(MemoryStore())
        transport = FakeTransport { _, _ -> json(404, mapOf("error" to "not-found")) }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir, failures = app.failures)
        state = AppState(app)
        app.state = state
        ReflectionHelpers.setStaticField(Counterpart::class.java, "instance", app)
        File(app.filesDir, "Captures").deleteRecursively()
    }

    @After fun cleanup() { state.scope.cancel() }

    private fun record(): PairingRecord = v2Record(active = ADDRESSES[2]).with("token", JsonPrimitive(plantedToken))

    private fun unzip(bytes: ByteArray): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) { val entry = zip.nextEntry ?: break; out[entry.name] = zip.readBytes().toString(Charsets.UTF_8) }
        }
        return out
    }

    /** A scan on this phone: [frames] JPEG frames, finished or not, AR or photos. */
    private fun scan(id: String, frames: Int, finished: Boolean, ar: Boolean) {
        val folder = File(File(app.filesDir, "Captures"), id).apply { mkdirs() }
        repeat(frames) { File(folder, "%04d.jpg".format(it + 1)).writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 1, 2, 3)) }
        File(folder, "capture-kind").writeText(if (ar) "ar" else "photos")
        if (ar) File(folder, "capture-camera.json").writeText("""{"frames":[]}""")
        if (finished) File(folder, "finished").writeText("")
    }

    @Test fun theZipHoldsAboutTheConnectionErrorsAndScansWithoutPictures() = runBlocking {
        app.pairingStore.save(record(), notify = false)
        state.readStatus()
        val scanned = "11111111-2222-4333-8444-555555555555"
        val stopped = "66666666-7777-4888-8999-aaaaaaaaaaaa"
        scan(scanned, frames = 3, finished = true, ar = true)
        scan(stopped, frames = 2, finished = false, ar = false)
        // Two real failures through the client: a refusal and a transport error.
        transport.answer = { request, _ -> if (request.url.endsWith("/v1/settings")) throw TransportException("timeout") else HttpReply(409, "{}".toByteArray()) }
        runCatching { app.companion.request("GET", "/v1/objects/$scanned?since=4") }
        runCatching { app.companion.settings() }

        val now = java.util.Calendar.getInstance().apply { clear(); set(2026, java.util.Calendar.NOVEMBER, 17, 12, 0) }.timeInMillis
        val files = unzip(Diagnostics.zip(Diagnostics.files(Diagnostics.input(app, now)), now))
        assertEquals(listOf("about.txt", "connection.json", "request-errors.json", "captures.json", "notes.txt"), files.keys.toList())
        assertEquals("Counterpart Android Diagnostics 2026-11-17.zip", Diagnostics.fileName(now))

        val about = files.getValue("about.txt")
        assertTrue(about, about.startsWith("Counterpart for Android "))
        assertTrue(about, Regex("""Android \S+ \(API 35\)""").containsMatchIn(about))
        assertTrue(about, about.contains("Device: "))

        val connection = parseObject(files.getValue("connection.json").toByteArray())!!
        assertEquals("paired", connection["state"]!!.jsonPrimitive.content)
        assertEquals("public key pin", connection["trust"]!!.jsonPrimitive.content)
        assertEquals("local network address (IPv4)", connection["address"]!!.jsonPrimitive.content)
        assertEquals("Tailscale address (IPv4)", connection["addressInUse"]!!.jsonPrimitive.content)
        assertEquals(listOf("local network address (IPv4)", "local network name (.local)"), connection["otherAddresses"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(SCOPES.sorted(), connection["scopes"]!!.jsonArray.map { it.jsonPrimitive.content })

        val errors = WireJsonArray(files.getValue("request-errors.json"))
        assertEquals(2, errors.size)
        assertEquals("/v1/objects/$scanned", errors[0]["route"]!!.jsonPrimitive.content)
        assertEquals("409", errors[0]["status"]!!.jsonPrimitive.content)
        assertEquals("/v1/settings", errors[1]["route"]!!.jsonPrimitive.content)
        assertEquals("timeout", errors[1]["code"]!!.jsonPrimitive.content)

        val captures = WireJsonArray(files.getValue("captures.json"))
        assertEquals(listOf(scanned, stopped), captures.map { it["id"]!!.jsonPrimitive.content })
        assertEquals(listOf("3", "2"), captures.map { it["frames"]!!.jsonPrimitive.content })
        assertEquals(listOf("true", "false"), captures.map { it["finished"]!!.jsonPrimitive.content })
        assertEquals(listOf("ar", "photos"), captures.map { it["kind"]!!.jsonPrimitive.content })
        // The pictures themselves never go in.
        assertFalse(files.keys.any { it.endsWith(".jpg") })

        val all = files.values.joinToString("\n")
        for (secret in listOf(plantedToken, KEY_PIN, DEVICE_ID, "192.168.68.123", "100.101.102.103", "davids-mac-mini")) assertFalse(secret, all.contains(secret))
    }

    @Test fun aPlantedTokenPinAndEmailNeverComeOut() = runBlocking {
        app.pairingStore.save(record(), notify = false)
        // Routes are the one free-form text the ZIP carries: plant the secrets there, as a careless caller might.
        app.failures.record("GET", "/v1/objects/a/asks/$plantedEmail")
        app.failures.record("POST", "/v1/pair/pin=$plantedPin")
        app.failures.record("GET", "/v1/x/Bearer $plantedToken")
        app.failures.record("GET", "/v1/x/scantomake://pair?code=$plantedPin&key=abc")
        app.failures.record("GET", "/v1/x/$plantedToken")

        val files = Diagnostics.files(Diagnostics.input(app, System.currentTimeMillis()))
        val all = files.values.joinToString("\n")
        assertFalse(all.contains(plantedToken))
        assertFalse(all.contains(plantedPin))
        assertFalse(all.contains(plantedEmail))
        assertTrue(all.contains("[redacted email]"))
    }

    /** The companion's rules (#813), carried over, with the same safe markers and words kept. */
    @Test fun redactionMatchesTheCompanionsRules() {
        fun r(text: String) = Diagnostics.redact(text)
        assertEquals("""{"accessCode": "[redacted]", "BAMBU_ACCESS_CODE": "[set]", "token": "", "apiKey": null}""",
            r("""{"accessCode": "12345678", "BAMBU_ACCESS_CODE": "[set]", "token": "", "apiKey": null}"""))
        assertEquals("""say \"refresh_token\":\"[redacted]\"""", r("""say \"refresh_token\":\"abc.def\""""))
        assertEquals("PASSWORD=[redacted] --api-key [redacted] pin: [redacted]", r("PASSWORD=hunter22 --api-key sk_live_x pin: 482913"))
        assertEquals("Authorization: [redacted] [redacted]", r("Authorization: Bearer abcdefghij"))
        assertEquals("authorization=[redacted] [redacted]", r("authorization=Basic dXNlcjpwYXNz"))
        assertEquals("Bearer [redacted]", r("Bearer abcdefghij"))
        assertEquals("Cookie: [redacted]", r("Cookie: session=1"))
        assertEquals("https://[redacted]@printer.local/", r("https://me:pw@printer.local/"))
        assertEquals("[redacted token]", r("eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"))
        assertEquals("[redacted key]", r("sk-abcdefghijklmnopqrst"))
        assertEquals("mail [redacted email] now", r("mail someone@example.co.uk now"))
        assertEquals("scantomake://pair?[redacted]", r("scantomake://pair?v=2&code=123456"))
        assertEquals("[redacted private key]", r("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"))
        assertEquals("[redacted hash]", r(KEY_PIN))
        // Words that only look like secret names keep their words.
        assertEquals("Failed to authenticate: retry", r("Failed to authenticate: retry"))
        assertEquals("pinned: yes, colour-mapping: auto", r("pinned: yes, colour-mapping: auto"))
        // Known values go whatever their shape.
        assertEquals("x [redacted] y", Diagnostics.redact("x 10.0.0.5 y", listOf("10.0.0.5")))
    }

    @Test fun anAddressIsOnlyItsKind() {
        assertEquals("Tailscale name", Diagnostics.addressKind("https://mac.tail1234.ts.net"))
        assertEquals("Tailscale address (IPv4)", Diagnostics.addressKind("https://100.64.0.1:9077"))
        assertEquals("local network address (IPv4)", Diagnostics.addressKind("https://172.20.1.1:9077"))
        assertEquals("other address (IPv4)", Diagnostics.addressKind("https://8.8.8.8:9077"))
        assertEquals("local network name (.local)", Diagnostics.addressKind("https://someones-mac.local:9077"))
        assertEquals("Tailscale address (IPv6)", Diagnostics.addressKind("https://[fd7a:115c:a1e0::1]:9077"))
        assertEquals("link-local address (IPv6)", Diagnostics.addressKind("https://[fe80::1]:9077"))
        assertEquals("none", Diagnostics.addressKind(null))
    }

    @Test fun notPairedSaysSoAndStillMakesTheZip() {
        val files = Diagnostics.files(Diagnostics.input(app, System.currentTimeMillis()))
        val connection = parseObject(files.getValue("connection.json").toByteArray())!!
        assertEquals("not paired", connection["state"]!!.jsonPrimitive.content)
        assertEquals("[]", files.getValue("captures.json").trim())
    }

    @Test fun theRingKeepsTheLastFailuresWithoutQueries() {
        var t = 0L
        val ring = RecentFailures(limit = 3) { t++ }
        repeat(5) { ring.record("GET", "/v1/objects/$it?token=secret") }
        assertEquals(listOf("/v1/objects/2", "/v1/objects/3", "/v1/objects/4"), ring.list().map { it.route })
    }

    private fun WireJsonArray(text: String) = com.scantomake.counterpart.core.WireJson.parseToJsonElement(text).jsonArray.map { it.jsonObject }
}
