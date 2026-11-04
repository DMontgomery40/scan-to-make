package com.scantomake.counterpart

import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.CounterpartEvent
import com.scantomake.counterpart.api.EventsPage
import com.scantomake.counterpart.api.Format
import com.scantomake.counterpart.api.PrintChoice
import com.scantomake.counterpart.api.PrintColour
import com.scantomake.counterpart.api.PrintLive
import com.scantomake.counterpart.api.PrintQuality
import com.scantomake.counterpart.api.PrintStrength
import com.scantomake.counterpart.api.PrinterDestination
import com.scantomake.counterpart.api.PrinterFilament
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectAction
import com.scantomake.counterpart.api.ProjectPhase
import com.scantomake.counterpart.api.ProjectUploader
import com.scantomake.counterpart.api.ProjectWords
import com.scantomake.counterpart.api.PublishedModelLink
import com.scantomake.counterpart.api.UploadFile
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.core.arr
import com.scantomake.counterpart.core.encodeURIComponent
import com.scantomake.counterpart.core.obj
import com.scantomake.counterpart.core.parseObject
import com.scantomake.counterpart.core.str
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.net.TransportException
import com.scantomake.counterpart.net.TrustPolicy
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingException
import com.scantomake.counterpart.pairing.PairingFreshness
import com.scantomake.counterpart.pairing.PairingInvitation
import com.scantomake.counterpart.pairing.PairingStatus
import com.scantomake.counterpart.pairing.PairingStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class PairingClientTests {
    private val code = "C".repeat(32)
    private fun paired(extra: Map<String, Any?> = emptyMap()): Map<String, Any?> = mapOf("deviceId" to DEVICE_ID, "token" to TOKEN, "protocolVersion" to "0.1.0",
        "expiresAt" to System.currentTimeMillis() + 30.0 * 86_400_000, "scopes" to SCOPES) + extra
    private fun invitation() = PairingInvitation(ADDRESSES[0], code, Long.MAX_VALUE, addresses = ADDRESSES, publicKeySha256 = KEY_PIN)

    @Test fun v2PairsAtTheFirstAddressThatAnswersAndKeepsTheInvitationsPin() = runBlocking {
        val fake = FakeTransport { request, _ ->
            if (request.url.contains("192.168.68.123")) throw TransportException("network")
            // A response can't move the address or pin.
            json(200, paired(mapOf("publicKeySha256" to "cd".repeat(32), "addresses" to listOf("https://evil"), "activeUrl" to "https://evil")))
        }
        val client = PairingClient(PairingStore(MemoryStore()), fake)
        val status = client.pair(invitation(), "David's Pixel")
        assertEquals(PairingStatus.State.Paired, status.state)
        assertEquals("https://davids-mac-mini.local:9077", status.baseUrl)
        assertEquals(listOf("https://192.168.68.123:9077/v1/pair", "https://davids-mac-mini.local:9077/v1/pair"), fake.paths)
        val record = client.store.read()!!
        assertEquals(KEY_PIN, record.publicKeySha256)
        assertNull(record.activeUrl)
        assertEquals(3, record.addresses?.size)
        val body = parseObject(fake.calls[1].request.body!!)!!
        assertEquals(code, body["code"].str)
        assertEquals("David's Pixel", body["deviceName"].str)
        assertEquals(43, body["installationKey"].str?.length)
        assertNull("no earlier pairing, no token sent", fake.calls[1].request.headers["Authorization"])
        val trust = fake.calls[1].trust
        assertTrue("pairing must be pinned", trust is TrustPolicy.Pending && trust.record.publicKeySha256 == KEY_PIN)
    }

    @Test fun repairingTheSameMacSendsTheOldTokenSoItReplacesThisPhone() = runBlocking {
        val store = PairingStore(MemoryStore())
        store.save(v2Record(), false)
        val fake = FakeTransport { _, _ -> json(200, paired()) }
        PairingClient(store, fake).pair(invitation(), "Pixel")
        assertEquals("Bearer $TOKEN", fake.calls[0].request.headers["Authorization"])
        assertEquals(DEVICE_ID, fake.calls[0].request.headers["X-Scan-Device"])
        // Another Mac never sees it.
        store.save(v2Record(), false)
        val fake2 = FakeTransport { _, _ -> json(200, paired()) }
        PairingClient(store, fake2).pair(invitation().copy(publicKeySha256 = "cd".repeat(32)), "Pixel")
        assertNull(fake2.calls[0].request.headers["Authorization"])
    }

    @Test fun failuresInPlainCodes() = runBlocking {
        for ((status, expected) in listOf(401 to PairingException.Code.Unauthorized, 403 to PairingException.Code.Forbidden,
            429 to PairingException.Code.RateLimited, 302 to PairingException.Code.WrongHost, 500 to PairingException.Code.Unavailable)) {
            val client = PairingClient(PairingStore(MemoryStore()), FakeTransport { _, _ -> json(status, emptyMap<String, Any>()) })
            try { client.pair(invitation(), "Pixel"); fail() } catch (e: PairingException) { assertEquals(expected, e.code) }
        }
        // A certificate that isn't the pinned one, everywhere: reported as changed, after trying every address.
        val fake = FakeTransport { _, _ -> throw TransportException("certificate-changed") }
        try { PairingClient(PairingStore(MemoryStore()), fake).pair(invitation(), "Pixel"); fail() } catch (e: PairingException) {
            assertEquals(PairingException.Code.CertificateChanged, e.code)
        }
        assertEquals(3, fake.calls.size)
        // An answer whose credential lasts too long is refused.
        val greedy = PairingClient(PairingStore(MemoryStore()), FakeTransport { _, _ -> json(200, paired(mapOf("expiresAt" to System.currentTimeMillis() + 90.0 * 86_400_000))) })
        try { greedy.pair(invitation(), "Pixel"); fail() } catch (e: PairingException) { assertEquals(PairingException.Code.InvalidResponse, e.code) }
    }

    @Test fun forgetWinsAndCheckMovesToTheAddressThatAnswers() = runBlocking {
        val store = PairingStore(MemoryStore())
        store.save(v2Record(), false)
        val fake = FakeTransport { request, _ ->
            if (request.url.startsWith(ADDRESSES[0])) throw TransportException("timeout")
            json(200, mapOf("status" to "ok", "protocolVersion" to "0.1.0"))
        }
        val client = PairingClient(store, fake)
        val status = client.check()
        assertEquals(ADDRESSES[1], status.activeUrl)
        assertEquals(listOf("${ADDRESSES[0]}/healthz", "${ADDRESSES[1]}/healthz"), fake.paths)
        assertTrue(store.read()!!.isSamePairing(v2Record()))
        client.forget()
        assertNull(store.read())
    }

    @Test fun refreshTakesOnlyTheExpiryAndScopes() = runBlocking {
        val store = PairingStore(MemoryStore())
        store.save(v2Record(expiresAt = System.currentTimeMillis() + 5.0 * 86_400_000), false)
        val later = System.currentTimeMillis() + 30.0 * 86_400_000
        val fake = FakeTransport { _, _ -> json(200, paired(mapOf("expiresAt" to later))) }
        assertEquals(PairingFreshness.Refreshed, PairingFreshness.keep(PairingClient(store, fake)))
        assertEquals("${ADDRESSES[0]}/v1/auth/refresh", fake.paths.single())
        assertEquals(later, store.read()!!.expiresAtMs, 1.0)
        assertEquals(KEY_PIN, store.read()!!.publicKeySha256)
        assertEquals(PairingFreshness.Fresh, PairingFreshness.keep(PairingClient(store, fake)))
        // A Mac that refuses the credential: pair again.
        store.save(v2Record(expiresAt = System.currentTimeMillis() + 86_400_000.0), false)
        assertEquals(PairingFreshness.PairAgain, PairingFreshness.keep(PairingClient(store, FakeTransport { _, _ -> json(401, emptyMap<String, Any>()) })))
    }
}

class CompanionClientTests {
    private val id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"

    private fun client(fake: FakeTransport, record: com.scantomake.counterpart.pairing.PairingRecord = v2Record()): CompanionClient {
        val store = PairingStore(MemoryStore())
        store.save(record, false)
        return CompanionClient(PairingClient(store, fake), fake, "Pixel 8", "David’s Pixel", File(System.getProperty("java.io.tmpdir"), "cp-test-${System.nanoTime()}"))
    }

    @Test fun scopes() {
        assertEquals("projects:read", CompanionClient.scope("GET", "/v1/objects"))
        assertEquals("generation:health", CompanionClient.scope("GET", "/healthz"))
        assertEquals("projects:read", CompanionClient.scope("GET", "/v1/objects/printers"))
        assertEquals("printer-handoff:use", CompanionClient.scope("GET", "/v1/objects/$id/filaments"))
        assertEquals("printer-handoff:use", CompanionClient.scope("GET", "/v1/objects/$id/camera.jpg"))
        assertEquals("printer-handoff:use", CompanionClient.scope("GET", "/v1/objects/printers/mcp-1a2b/camera.jpg"))
        assertEquals("printer-handoff:use", CompanionClient.scope("POST", "/v1/objects/$id/print/pause"))
        assertEquals("printer-handoff:use", CompanionClient.scope("POST", "/v1/objects/$id/estimate"))
        assertEquals("captures:import", CompanionClient.scope("POST", "/v1/objects/$id/corrections"))
        assertEquals("captures:import", CompanionClient.scope("POST", "/v1/objects/$id/capture"))
        assertEquals("captures:import", CompanionClient.scope("PUT", "/v1/objects/$id/scan"))
        assertEquals("projects:read", CompanionClient.scope("GET", "/v1/objects/$id/scan/original.usdz"))
        assertEquals("projects:read", CompanionClient.scope("GET", "/v1/events"))
        assertEquals("projects:write", CompanionClient.scope("PATCH", "/v1/settings"))
        assertNull("the phone never calls routes it doesn't know", CompanionClient.scope("GET", "/v1/auth/devices"))
        assertNull(CompanionClient.scope("DELETE", "/v1/objects"))
    }

    @Test fun requestsCarryTheCredentialAndModelAndArePinned() = runBlocking {
        val data = kitFixture("objects.json").readBytes()
        val fake = FakeTransport { _, _ -> HttpReply(200, data) }
        val projects = client(fake).list()
        assertEquals(8, projects.size)
        val request = fake.calls[0].request
        assertEquals("https://192.168.68.123:9077/v1/objects", request.url)
        assertEquals("Bearer $TOKEN", request.headers["Authorization"])
        assertEquals(DEVICE_ID, request.headers["X-Scan-Device"])
        assertEquals("Pixel 8", request.headers["X-Scan-Device-Model"])
        assertEquals("David%E2%80%99s%20Pixel", request.headers["X-Scan-Device-Name"])
        assertTrue(fake.calls[0].trust is TrustPolicy.Record)
    }

    @Test fun anExpiredOrScopelessPairingNeverLeavesThePhone() = runBlocking {
        val fake = FakeTransport { _, _ -> fail("no request"); json(200, emptyMap<String, Any>()) }
        try { client(fake, v2Record(expiresAt = 10.0)).list(); fail() } catch (e: CompanionException) { assertEquals("pairing-required", e.code) }
        val limited = v2Record().with("scopes", com.scantomake.counterpart.core.toJson(listOf("generation:health", "projects:read")))
        try { client(fake, limited).filaments(id); fail() } catch (e: CompanionException) { assertEquals("scope-denied", e.code) }
    }

    @Test fun refusalsInPlainWords() = runBlocking {
        val conflict = client(FakeTransport { _, _ -> json(409, mapOf("error" to mapOf("code" to "invalid-state", "message" to "Wait until the print ends."))) })
        try { conflict.get(id); fail() } catch (e: CompanionException) { assertEquals("Wait until the print ends.", e.message) }
        val old = client(FakeTransport { _, _ -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "x"))) })
        try { old.control(id, CompanionClient.PrintControl.Pause); fail() } catch (e: CompanionException) { assertTrue(e.isUnsupported) }
        val gone = client(FakeTransport { _, _ -> throw TransportException("timeout") })
        try { gone.health(); fail() } catch (e: CompanionException) { assertTrue(e.isUnreachable) }
    }

    @Test fun printBodyIsWhatEveryCompanionAcceptsUnlessYouChooseMore() {
        val filament = PrinterFilament(0, "#141414", "PLA", "Bambu PLA Basic", "GFA00", "current")
        assertEquals(setOf("checked", "filament"), PrintChoice(PrintColour.Tray(filament)).body.keys)
        assertNull(PrintChoice(PrintColour.Tray(filament)).body["copies"])
        assertEquals(JsonPrimitive(1), PrintChoice(PrintColour.Tray(filament), copies = 0).body["copies"])
        val more = PrintChoice(PrintColour.Tray(filament), PrintQuality.Fine, PrintStrength.Strong).body
        assertEquals("fine", more["quality"].str)
        assertEquals("strong", more["strength"].str)
        assertEquals("""{"auto":true}""", PrintChoice(PrintColour.Auto).body["colour"].toString())
        assertEquals("""{"material":"PETG"}""", PrintChoice(PrintColour.Material("PETG")).body["colour"].toString())
        assertEquals(setOf("checked"), PrintChoice(null).body.keys)
        assertEquals("Bambu PLA Basic", filament.displayName)
        assertEquals("Ext", PrinterFilament(254, "#FFFFFF", "PETG", "Generic PETG #FFFFFF", "", "x").slotLabel)
    }

    @Test fun uploadsSkipWhatTheMacHasAndUseTheCaptureRoute() = runBlocking {
        val project = mapOf("id" to id, "createdAtMs" to 1, "updatedAtMs" to 2, "state" to "new", "photos" to listOf("photo-a.jpg"), "capture" to listOf("0001.jpg"), "passes" to emptyList<Any>())
        val fake = FakeTransport { _, _ -> json(200, mapOf("object" to project)) }
        val c = client(fake)
        val sent = ProjectUploader(c).send(listOf(
            UploadFile(UploadFile.Kind.Photo, "photo-a.jpg", bytes = byteArrayOf(1), type = "image/jpeg"),
            UploadFile(UploadFile.Kind.Photo, "photo b&c.jpg", bytes = byteArrayOf(1), type = "image/jpeg"),
            UploadFile(UploadFile.Kind.Capture, "0001.jpg", bytes = byteArrayOf(1), type = "image/jpeg"),
            UploadFile(UploadFile.Kind.Capture, "0002.jpg", bytes = byteArrayOf(1), type = "image/jpeg"),
        ), id)
        assertEquals(2, sent)
        assertEquals(listOf("https://192.168.68.123:9077/v1/objects/$id",
            "https://192.168.68.123:9077/v1/objects/$id/photos?name=photo%20b%26c.jpg",
            "https://192.168.68.123:9077/v1/objects/$id/capture?name=0002.jpg"), fake.paths)
        assertEquals("image/jpeg", fake.calls[2].request.contentType)
    }

    @Test fun startWithoutManifestAndCreateWithKind() = runBlocking {
        val project = mapOf("id" to id, "createdAtMs" to 1, "updatedAtMs" to 2, "state" to "touching-up")
        val fake = FakeTransport { _, _ -> json(200, mapOf("object" to project)) }
        val c = client(fake)
        c.start(id)
        assertEquals("{}", String(fake.calls[0].request.body!!))
        c.create("A mount", "fit")
        assertEquals("""{"instructions":"A mount","kind":"fit"}""", String(fake.calls[1].request.body!!))
        c.create("", "published", "https://makerworld.com/en/models/12345")
        assertEquals("""{"kind":"published","url":"https://makerworld.com/en/models/12345"}""", String(fake.calls[2].request.body!!))
        c.answerAsk(id, bestGuess = true)
        assertEquals("""{"bestGuess":true,"photoNames":[]}""", String(fake.calls[3].request.body!!))
    }
}

class ContractTests {
    private val samples = parseObject(contractFixture("counterpart-v1.json").readText())!!

    @Test fun objectsFromTheCompanionDecode() {
        val objects = parseObject(kitFixture("objects.json").readText())!!["objects"].arr!!.map { Project.decode(it.obj!!)!! }
        assertEquals(8, objects.size)
        assertTrue(objects.any { it.state == Project.State.Ready && it.current != null })
        // Every project has words, whatever its state.
        objects.forEach { ProjectWords(it).line.isNotEmpty().let(::assertTrue) }
        // An unknown state from a newer Mac decodes as unknown instead of dropping the project.
        val newer = Project.decode(parseObject("""{"id":"x","createdAtMs":1,"updatedAtMs":2,"state":"teleporting","passes":"oops"}""")!!)!!
        assertEquals(Project.State.Unknown, newer.state)
        assertTrue(newer.passes.isEmpty())
        assertEquals(ProjectPhase.Unknown, ProjectWords(newer).phase)
    }

    @Test fun cappedPassesOfferRetryAndChangesAsTheSwiftDoes() {
        val rows = com.scantomake.counterpart.core.WireJson.parseToJsonElement(kitFixture("capped-projects.json").readText()).arr!!
        assertEquals(5, rows.size)
        for (row in rows) {
            val r = row.obj!!
            val name = r["name"].str
            val expected = Project.decode(r["expected"].obj!!)!!
            val actions = ProjectWords(expected).actions
            assertEquals(name, r["retry"].toString() == "true", ProjectAction.Retry in actions)
            assertTrue(name, ProjectAction.Correct in actions)
            assertTrue(name, (if (r["checkedPrint"].toString() == "true") ProjectAction.PrintChecked else ProjectAction.Print) in actions)
        }
    }

    @Test fun everyEventSampleDecodes() {
        val events = samples["events"].arr!!.mapNotNull { it.obj?.let(CounterpartEvent::decode) }
        assertEquals(samples["events"].arr!!.size, events.size)
        assertTrue(events.any { it.type == "print.milestone" })
        val macEvents = samples["macEvents"].arr!!.mapNotNull { it.obj?.let(CounterpartEvent::decode) }
        assertEquals(samples["macEvents"].arr!!.size, macEvents.size)
        assertTrue(macEvents.all { it.projectId == null })
        val page = EventsPage.decode(samples["eventsPage"].obj!!)!!
        assertEquals(page.events.last().seq, page.next)
        assertTrue(EventsPage.decode(samples["eventsPageTruncated"].obj!!)!!.needsResync)
        assertTrue(EventsPage.decode(samples["eventsPageReset"].obj!!)!!.needsResync)
        // One unreadable event never costs the page.
        val mixed = EventsPage.decode(parseObject("""{"events":[{"seq":"x"},${samples["events"].arr!![0]}],"next":1,"latest":1}""")!!)!!
        assertEquals(1, mixed.events.size)
    }

    @Test fun liveDestinationsAndStatusesDecode() {
        val live: PrintLive = WireJson.decodeFromJsonElement(samples["printLive"]!!)
        assertTrue(live.state.isNotEmpty())
        val destinations = samples["destinations"].arr!!.map { WireJson.decodeFromJsonElement<PrinterDestination>(it) }
        assertTrue(destinations.isNotEmpty())
        assertEquals(samples["destinations"].arr!!.map { it.obj!!["id"].str }, destinations.map { it.id })
        samples["statuses"].arr!!.forEach { s ->
            val phase = s.obj!!["phase"].str
            assertTrue("every status phase is known: $phase", ProjectPhase.of(phase) != null)
        }
    }
}

class WordsTests {
    private fun project(json: String) = Project.decode(parseObject("""{"id":"0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11","createdAtMs":1,"updatedAtMs":2,"photos":[],"passes":[],$json}""")!!)!!

    @Test fun sizesTimesAndGrams() {
        assertEquals("48 × 50 × 54 mm", Format.size(listOf(48.2, 49.6, 54.0)))
        assertEquals("45 s", Format.duration(45.0))
        assertEquals("38 min", Format.duration(38 * 60.0))
        assertEquals("1 h 12 m", Format.duration(72 * 60.0))
        assertEquals("3 h", Format.duration(180 * 60.0))
        assertEquals("less than a minute", Format.about(20.0))
        assertEquals("4.5 g", Format.grams(4.5))
        assertEquals("22 g", Format.grams(22.4))
        assertEquals("42%", Format.percent(42.9))
    }

    @Test fun phasesAndActions() {
        assertEquals(ProjectPhase.Draft, ProjectWords(project(""""state":"new"""")).phase)
        assertEquals(ProjectPhase.Sending, ProjectWords(project(""""state":"new""""), sending = true).phase)
        val ready = ProjectWords(project(""""state":"ready","current":{"model":"m.stl","renders":[],"sizeMm":[10,20,30]}"""))
        assertEquals(ProjectPhase.Ready, ready.phase)
        assertEquals("Ready to print · 10 × 20 × 30 mm", ready.line)
        assertEquals(listOf(ProjectAction.Print, ProjectAction.Correct), ready.actions)
        val printing = project(""""state":"printing","print":{"bundleId":"b","printId":"p","live":{"state":"printing","job":{"name":"j","progress":42,"remainingSec":2280}}}""")
        assertEquals("Printing on P1S · 42% · 38 min left", ProjectWords(printing, printerName = "P1S").line)
        val done = project(""""state":"printed","current":{"model":"m.stl","renders":[]},"print":{"bundleId":"b","monitor":{"phase":"ended","endState":"done"}}""")
        assertTrue(ProjectAction.ItWorks in ProjectWords(done).actions)
        val sentOnly = project(""""state":"printed","print":{"bundleId":"b"}""")
        assertEquals(ProjectPhase.Sent, ProjectWords(sentOnly).phase)
        val mac = project(""""state":"touching-up","status":{"phase":"working","text":"Your Mac is working · Designing it","symbol":"x","tint":"blue"}""")
        assertEquals("Your Mac is working · Designing it", ProjectWords(mac).line)
        assertEquals("A hook for my stroller handle", ProjectWords.title(project(""""state":"new","instructions":"A hook for my stroller handle. It is 3 cm wide."""")))
    }

    @Test fun publishedLinksAndHeaderEncoding() {
        assertEquals("https://makerworld.com/en/models/12345", PublishedModelLink.find("Print this https://makerworld.com/en/models/12345."))
        assertEquals("https://www.printables.com/model/1-hook", PublishedModelLink.find("https://www.printables.com/model/1-hook"))
        assertNull(PublishedModelLink.find("see https://example.com/thing"))
        assertEquals("https://example.com/files/hook.3mf", PublishedModelLink.find("https://example.com/files/hook.3mf"))
        assertEquals("David%E2%80%99s%20Pixel", encodeURIComponent("David’s Pixel"))
    }

    @Test fun printConfirmationAnswers() {
        val c: com.scantomake.counterpart.api.PrintConfirmation = WireJson.decodeFromJsonElement(parseObject("""{"id":"c1","message":"Is the plate clear?","expiresAtMs":9999999999999,"supported":true,
            "fields":[{"name":"clear","title":"Plate clear","required":true},{"name":"speed","title":"Speed","type":"string","enum":["a","b"],"enumNames":["Slow","Fast"],"default":"a"}]}""")!!)
        val now = System.currentTimeMillis()
        assertFalse("a required switch starts off", c.canAccept(emptyMap(), now))
        assertTrue(c.canAccept(mapOf("clear" to JsonPrimitive(true)), now))
        val body = c.response("accept", mapOf("clear" to JsonPrimitive(true)), now)!!
        assertEquals("""{"confirmationId":"c1","answer":{"action":"accept","content":{"clear":true,"speed":"a"}}}""", body.toString())
        assertEquals("""{"confirmationId":"c1","answer":{"action":"cancel"}}""", c.response("cancel", emptyMap(), now).toString())
        assertEquals("Fast", c.fields[1].displayName("b"))
    }
}
