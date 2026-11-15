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
        // The notes still read as sentences.
        assertTrue(files.getValue("notes.txt"), files.getValue("notes.txt").contains("Left out on purpose: the pairing token, the computer's pin"))
    }

    /**
     * Every leak the review of #813's redactor found (comment 6886304221, probes in ~/stm-gates/probes), and the lead's
     * list for Android: each is planted, and its secret must not survive.
     */
    @Test fun everyPlantedSecretIsRemoved() {
        val cases = listOf(
            // Auth schemes and headers, any case.
            "authorization: bearer abcDEF123456ghiJKL789" to "abcDEF123456ghiJKL789",
            "Authorization: Bearer abcDEF123456ghiJKL789" to "abcDEF123456ghiJKL789",
            "AUTHORIZATION: BASIC dXNlcjpwYXNzd29yZA==" to "dXNlcjpwYXNzd29yZA==",
            "Proxy-Authorization: basic dXNlcjpwYXNzd29yZA==" to "dXNlcjpwYXNzd29yZA==",
            "authorization: digest abcdef0123456789" to "abcdef0123456789",
            "authorization=Basic dXNlcjpwYXNz" to "dXNlcjpwYXNz",
            "sent with bearer abc-def_123456 to it" to "abc-def_123456",
            "set-cookie: sid=lowcookie123; HttpOnly" to "lowcookie123",
            """{"headers":{"authorization":"Bearer abcdefghijkl"}}""" to "abcdefghijkl",
            // Names with key, passphrase, pin, session, token, secret, password, cookie, credential.
            "SCAN_TO_MAKE_MODEL_KEY=hf_9f8e7d6c5b4a39281706f5e4d3c2b1a0" to "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
            """{"SCAN_TO_MAKE_LAN_TLS_KEY":"/k/p.key","SCAN_TO_MAKE_AI_KEY":"plainhex0123456789abcdef0123"}""" to "plainhex0123456789abcdef0123",
            """{"session_key":"s3ss10nV4lue98765"}""" to "s3ss10nV4lue98765",
            "session_key=s3ss10nV4lue98765" to "s3ss10nV4lue98765",
            "encryption_key: deadbeefcafe0123456789" to "deadbeefcafe0123456789",
            "passphrase=hunter2-horse-battery" to "hunter2-horse-battery",
            "PAIRING_PIN=482910" to "482910",
            """{"pin":"482913"}""" to "482913",
            """{"pairingCode":482913}""" to "482913",
            "pin: 482913" to "482913",
            "The pairing code is 482913" to "482913",
            "Enter PIN 482913 on the Mac" to "482913",
            """{"otp":"731204"}""" to "731204",
            """{"sessionId":"7f3a9c1e88b24d6fa015"}""" to "7f3a9c1e88b24d6fa015",
            """{"cookie":"sid=zzz999yyy888"}""" to "zzz999yyy888",
            "access-code: 31415926" to "31415926",
            "lan_code=87654321" to "87654321",
            "client_secret=cs_9876543210abcdef" to "cs_9876543210abcdef",
            "refresh token: rt_abcdef0123456789" to "rt_abcdef0123456789",
            "X-Api-Key: headervalue123456" to "headervalue123456",
            """{"privateKey":"MIIEvQIBADANBgkq"}""" to "MIIEvQIBADANBgkq",
            """{"credentials":{"user":"x"},"bambuCredential":"cred-value-77"}""" to "cred-value-77",
            "MY_SECRET=topsecret77 DB_PASSWORD='correct horse battery'" to "correct horse",
            """{"password":"correct horse battery"}""" to "correct horse",
            """{"\u0070assword":"unicodesecret1"}""" to "unicodesecret1",
            """say \"refresh_token\":\"abc.def.ghi\"""" to "abc.def.ghi",
            "--api-key sk_live_0123456789abcdefgh" to "sk_live_0123456789abcdefgh",
            "--token=tok0123456789" to "tok0123456789",
            "GET https://api.example.com/x?access_token=tokABC123456&y=1" to "tokABC123456",
            "https://ex.com/cb#id_token=tokXYZ987654" to "tokXYZ987654",
            "https://me:pw0rd99@printer.local/" to "pw0rd99",
            // Safe-looking values that are still secrets: a safe word only when it is the whole value.
            "token=[set]hunter2value" to "hunter2value",
            "password=true-secret-value" to "true-secret-value",
            "api_key=null-123456789" to "null-123456789",
            "secret=false_value99" to "false_value99",
            """{"password":"true-secret"}""" to "true-secret",
            """{"token":"[set]hunter2"}""" to "hunter2",
            // Bare tokens by their shape, and PEM blocks.
            "cloned with ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" to "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz" to "11ABCDEFG0123456789_abcdefghij",
            "aws id AKIAIOSFODNN7EXAMPLE ok" to "IOSFODNN7EXAMPLE",
            "key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r done" to "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r",
            "k sk-ant-api03-abcdefghijklmnopqrstuvwx" to "abcdefghijklmnopqrstuvwx",
            "t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart99" to "eyJzdWIiOiIxIn0",
            "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZZZ\n-----END CERTIFICATE-----" to "MIIBszCCAVmgAwIBAgIUZZZ",
            "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAbc123\n-----END EC PRIVATE KEY-----" to "MHQCAQEEIAbc123",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----" to "b3BlbnNzaC1rZXk=",
            """{"pem":"-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUYYY\n-----END CERTIFICATE-----"}""" to "MIIBszCCAVmgAwIBAgIUYYY",
            "der MIIBszCCAVmgAwIBAgIUZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ== end" to "MIIBszCCAVmgAwIBAgIUZZZZ",
            // E-mail addresses, and paths with the user's name.
            "a.b+tag@sub.example.co.uk" to "a.b+tag@sub.example.co.uk",
            "mail someone@example.com now" to "someone@example.com",
            "/Users/someoneelse/Library/x" to "someoneelse",
            "/home/otherperson/y" to "otherperson",
            "C:\\Users\\DavidM\\z" to "DavidM",
            """{\"path\":\"\/Users\/davidm\/Library\"}""" to "davidm",
            "log at ~davidm/Library/Logs" to "davidm",
            // The pairing link, PIN and certificate pin in any form.
            "scantomake://pair?v=2&code=482913&pk=abc" to "482913",
            KEY_PIN to KEY_PIN,
            KEY_PIN.uppercase() to KEY_PIN.uppercase(),
            KEY_PIN.chunked(2).joinToString(":") to KEY_PIN.chunked(2).joinToString(":"),
            java.util.Base64.getEncoder().encodeToString(KEY_PIN.chunked(2).map { it.toInt(16).toByte() }.toByteArray()) to
                java.util.Base64.getEncoder().encodeToString(KEY_PIN.chunked(2).map { it.toInt(16).toByte() }.toByteArray()),
            """{"publicKeySha256":"q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k"}""" to "q83vASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4k",
            """{"certificateSha256":"short-but-secret"}""" to "short-but-secret",
            "token $plantedToken" to plantedToken,
        )
        val leaks = cases.filter { (input, secret) -> Diagnostics.redact(input).contains(secret) }
            .map { (input, _) -> "$input -> ${Diagnostics.redact(input)}" }
        assertTrue("Leaked:\n" + leaks.joinToString("\n"), leaks.isEmpty())
    }

    /** A known value goes in any form: the pin as hex in either case, colon pairs, base64 and base64url. */
    @Test fun aKnownPinGoesInEveryForm() {
        val bytes = KEY_PIN.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val forms = listOf(KEY_PIN, KEY_PIN.uppercase(), KEY_PIN.chunked(2).joinToString(":"),
            java.util.Base64.getEncoder().encodeToString(bytes), java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes))
        for (form in forms) assertFalse(form, Diagnostics.redact("pinned to $form here", listOf(KEY_PIN)).contains(form))
        assertEquals("x [redacted] y", Diagnostics.redact("x 10.0.0.5 y", listOf("10.0.0.5")))
    }

    /** Markers that only say whether a secret is set stay whole, and ordinary words keep their words. */
    @Test fun markersAndOrdinaryWordsStay() {
        fun r(text: String) = Diagnostics.redact(text)
        assertEquals("""{"accessCode": "[set]", "token": "", "apiKey": null, "PASSWORD": true}""",
            r("""{"accessCode": "[set]", "token": "", "apiKey": null, "PASSWORD": true}"""))
        assertEquals("TOKEN=[set] password=false KEY=", r("TOKEN=[set] password=false KEY="))
        for (kept in listOf("Failed to authenticate: retry", "pinned: yes, colour-mapping: auto", "keyboard: us", "code: unreachable",
            """{"code":"timeout","route":"/v1/objects/x/passes/2/activity","status":409}""", "Device: Google Pixel 8",
            "/data/user/0/com.scantomake/files/Captures", "Tailscale address (IPv4)")) assertEquals(kept, r(kept))
    }

    @Test fun aBadFileNameOrAFailingFileNeverFailsTheExport() {
        val now = System.currentTimeMillis()
        val bytes = Diagnostics.zip(linkedMapOf("about.txt" to "a", "../escape.txt" to "x", "/abs.txt" to "y",
            "x".repeat(300) to "z", "notes.txt" to "Everything was read.\n"), now)
        val files = unzip(bytes)
        assertEquals(listOf("about.txt", "notes.txt"), files.keys.toList())
        assertEquals(3, Regex("A file was left out").findAll(files.getValue("notes.txt")).count())
    }

    @Test fun anUnreadableSourceGetsANoteAndTheExportCarriesOn() {
        // The pairing can't be read (the Keystore failing) and one scan's folder can't be listed.
        app.pairingStore = PairingStore(object : com.scantomake.counterpart.pairing.SecureStore {
            override fun read(account: String): ByteArray? = throw IllegalStateException("keystore")
            override fun write(account: String, data: ByteArray) {}
            override fun add(account: String, data: ByteArray) = false
            override fun delete(account: String) {}
        })
        scan("11111111-2222-4333-8444-555555555555", frames = 2, finished = true, ar = false)
        val locked = File(File(app.filesDir, "Captures"), "66666666-7777-4888-8999-aaaaaaaaaaaa").apply { mkdirs() }
        File(locked, "0001.jpg").writeBytes(byteArrayOf(1))
        assertTrue(locked.setReadable(false))
        try {
            val files = unzip(Diagnostics.zip(Diagnostics.files(Diagnostics.input(app, System.currentTimeMillis())), System.currentTimeMillis()))
            assertEquals(listOf("about.txt", "connection.json", "request-errors.json", "captures.json", "notes.txt"), files.keys.toList())
            val notes = files.getValue("notes.txt")
            assertTrue(notes, notes.contains("The pairing couldn't be read"))
            assertTrue(notes, notes.contains("The scan 66666666-7777-4888-8999-aaaaaaaaaaaa couldn't be read"))
            assertTrue(files.getValue("captures.json").contains("11111111-2222-4333-8444-555555555555"))
        } finally { locked.setReadable(true) }
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
