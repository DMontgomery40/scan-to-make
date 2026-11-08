package com.scantomake.counterpart

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performScrollTo
import com.scantomake.counterpart.api.PrinterCatalog
import com.scantomake.counterpart.api.PrinterDestination
import com.scantomake.counterpart.ui.PrintersScreen
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertAll
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isSelected
import com.scantomake.counterpart.ui.ProjectPlates
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.hasContentDescription
import kotlinx.serialization.json.decodeFromJsonElement
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.PrintQuality
import com.scantomake.counterpart.api.PrintStrength
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingStore
import com.scantomake.counterpart.ui.HomeScreen
import com.scantomake.counterpart.ui.SettingsScreen
import com.scantomake.counterpart.ui.PrintSheetScreen
import com.scantomake.counterpart.ui.designerSettingsWords
import com.scantomake.counterpart.net.HttpReply
import kotlinx.coroutines.cancel
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import com.scantomake.counterpart.api.CounterpartEvent
import com.scantomake.counterpart.net.TransportException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

/**
 * Every layout reaches the same things (PRD §6.1, "Every layout"). David, Nov 5: "where did the 'start with these
 * things' thing go, to print the 3d scan rig and the calipers?" On the Mac and iPad they showed only with no projects
 * or nothing selected; these keep Android's Home and Settings honest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
class HomeLayoutTests {
    @get:Rule val compose = createComposeRule()
    private lateinit var app: Counterpart
    private lateinit var state: AppState

    @Before fun setup() {
        app = Counterpart()
        ReflectionHelpers.callInstanceMethod<Void>(app, "attach",
            ClassParameter.from(Context::class.java, RuntimeEnvironment.getApplication()))
        app.pairingStore = PairingStore(MemoryStore())
        val transport = FakeTransport { _, _ -> json(404, mapOf("error" to "not-found")) }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state = AppState(app)
        app.state = state
        ReflectionHelpers.setStaticField(Counterpart::class.java, "instance", app)
    }

    @After fun cleanup() { state.scope.cancel() }

    private fun project(id: String, title: String, status: String) = requireNotNull(Project.decode(WireJson.parseToJsonElement(
        """{"id":"$id","title":"$title","instructions":"A useful part","state":"$status","createdAtMs":1,"updatedAtMs":2}"""
    ).jsonObject))

    /** The screens find AppState through the application context, as in the app; the activity stays underneath it. */
    @Composable private fun WithApp(content: @Composable () -> Unit) {
        val activity = LocalContext.current
        val context = remember(activity) { object : ContextWrapper(activity) { override fun getApplicationContext(): Context = app } }
        CompositionLocalProvider(LocalContext provides context, content = content)
    }

    private fun home() = compose.setContent { WithApp { HomeScreen(open = { _, _ -> }, newProject = {}, printers = {}, settings = {}) } }

    @Test fun theStartersStayOnHomeWhileProjectsExist() {
        state.projects.value = listOf(project("a", "Stove gap filler", "ready"), project("b", "Cable clip", "printed"),
            project("c", "Guitar pick", "confirmed"))
        state.loaded.value = true
        home()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("3D scan platform")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Start with something useful").assertExists()
        compose.onNodeWithText("Vernier caliper with depth gauge").assertExists()
        // This is Home with projects, not the empty Home's job cards.
        compose.onNodeWithText("Make something that fits").assertDoesNotExist()
    }

    @Test fun theStartersAreOnTheEmptyHomeToo() {
        state.loaded.value = true
        home()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("3D scan platform")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Vernier caliper with depth gauge").assertExists()
    }

    /** F6: "…then try again" names a button; the banner carries it, plus the way to a different computer. */
    @Test fun theOfflineBannerOffersTryAgainAndADifferentComputerWithProjectsPresent() {
        state.projects.value = listOf(project("a", "Stove gap filler", "ready"))
        state.loaded.value = true
        state.error.value = com.scantomake.counterpart.api.CompanionException.unreachable
        home()
        compose.onNodeWithText("Try Again").assertExists()
        compose.onNodeWithText("Connect a Different Computer").assertExists()
    }

    @Test fun printerSoftwareShowsTheHiddenCopyAndExplicitMoveWithProjectsPresent() = printerSoftwareMove(false)

    @Test fun printerSoftwareShowsEventsEvenWhenTheMoveReplyIsLost() = printerSoftwareMove(true)

    @Test fun printerSoftwareKeepsWaitingMoveCompletionAfterReturningHome() = printerSoftwareMove(false, navigateHome = true)

    @Test fun printerSoftwareRetainsWaitingMoveWhenAnotherUpdateStarts() = printerSoftwareMove(false, secondUpdate = true)

    private fun printerSoftwareMove(lostReply: Boolean, navigateHome: Boolean = false, secondUpdate: Boolean = false) {
        val pkg = WireJson.decodeFromString<com.scantomake.counterpart.api.McpPackageCopies>(contractFixture("mcp-profile-copies.json").readText())
        app.pairingStore.save(v2Record(), false)
        val transport = FakeTransport { request, _ ->
            when {
                request.url.endsWith("/healthz") -> json(200, mapOf("status" to "ok", "capabilities" to mapOf("mcpCopies" to true, "mcpUpdates" to true)))
                request.url.endsWith("/mcps") -> HttpReply(200, ("{\"packages\":[" + contractFixture("mcp-profile-copies.json").readText() + "]}").toByteArray())
                request.url.endsWith("/update") -> if (lostReply) throw TransportException("network") else HttpReply(200, contractFixture("mcp-update-waiting.json").readBytes())
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state.projects.value = listOf(project("a", "Existing project", "ready"))
        state.mcpCopies.value = listOf(pkg)
        state.capabilities.value = setOf("mcpCopies", "mcpUpdates")
        state.loaded.value = true
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination(id = "current", name = "Bambu Lab P1S", backend = "bambu-printer-mcp")), "current")
        compose.setContent {
            WithApp {
                var showPrinters by remember { mutableStateOf(false) }
                if (showPrinters) PrintersScreen(back = { showPrinters = false })
                else HomeScreen(open = { _, _ -> }, newProject = {}, printers = { showPrinters = true }, settings = {})
            }
        }
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Existing project"))
        compose.onNodeWithText("Existing project").assertExists()
        compose.onNodeWithContentDescription("Printers").performClick()
        compose.onNodeWithText("Counterpart’s copy 1.2.45").assertExists()
        compose.onNodeWithText("Bambu Lab P1S uses your copy at /home/ada/mcp-3D-printer-server (1.2.25).").assertExists()
        compose.onNodeWithText("Move Bambu Lab P1S (mcp-3D-printer-server, your copy at /home/ada/mcp-3D-printer-server) to Counterpart’s updated copy").assertExists()
        compose.onNodeWithText("Move Bambu Lab P1S (mcp-3D-printer-server, your copy at /home/ada/mcp-3D-printer-server) to Counterpart’s updated copy").performScrollTo().performClick()
        if (lostReply) {
            val error = "Your computer isn't answering. Check it's on and awake, then try again."
            compose.waitUntil(5_000) { compose.onAllNodes(hasText(error)).fetchSemanticsNodes().isNotEmpty() }
            val events = WireJson.parseToJsonElement(contractFixture("mcp-copy-update-events.json").readText()).jsonArray
                .map { requireNotNull(CounterpartEvent.decode(it.jsonObject)) }
            for (event in events) {
                compose.runOnIdle { state.mcpUpdateEvents.value = mapOf(requireNotNull(event.data?.mcpId) to event) }
                compose.onNodeWithText(event.body).assertExists()
                compose.onNodeWithText(error).assertDoesNotExist()
            }
        } else {
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Updates as soon as Counterpart finishes its work on this printer.")).fetchSemanticsNodes().isNotEmpty() }
        }
        if (secondUpdate) {
            compose.onNodeWithText("Update Counterpart’s copy").performScrollTo().performClick()
            compose.waitUntil(5_000) { transport.calls.count { it.request.url.endsWith("/update") } == 2 }
            val done = WireJson.parseToJsonElement(contractFixture("mcp-copy-update-events.json").readText()).jsonArray
                .map { requireNotNull(CounterpartEvent.decode(it.jsonObject)) }.first { it.type.endsWith("done") }
            compose.runOnIdle { state.mcpUpdateEvents.value = mapOf(requireNotNull(done.data?.mcpId) to done) }
            compose.onNodeWithText(done.body).assertExists()
        }
        if (navigateHome) {
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNodeWithContentDescription("Printers").assertExists()
            val done = WireJson.parseToJsonElement(contractFixture("mcp-copy-update-events.json").readText()).jsonArray
                .map { requireNotNull(CounterpartEvent.decode(it.jsonObject)) }.first { it.type.endsWith("done") }
            compose.runOnIdle { state.mcpUpdateEvents.value = mapOf(requireNotNull(done.data?.mcpId) to done) }
            compose.onNodeWithContentDescription("Printers").performClick()
            compose.onNodeWithText(done.body).assertExists()
        }
        val moves = transport.calls.filter { it.request.url.endsWith("/update") }
        org.junit.Assert.assertEquals(if (secondUpdate) 2 else 1, moves.size)
        org.junit.Assert.assertTrue(moves.first().request.url.endsWith("/mcp-0000000000000002/update"))
        org.junit.Assert.assertEquals("{\"fresh\":true}", String(moves.first().request.body!!))
        org.junit.Assert.assertEquals(listOf("mcp-0000000000000002"), pkg.moveIds)
        org.junit.Assert.assertEquals("projects:read", CompanionClient.scope("GET", "/v1/printers/mcps"))
    }

    /**
     * David, Nov 6: "adding a printer is filling out a form that hsould be mostly autofilled by discovery". With projects
     * present, Home → Printers → Add a Printer lists what the MCPs found; the found P1S opens filled in, and only the access
     * code is typed before Check and Add, the companion's `printers.check` and `printers.add` as on the Mac.
     */
    @Test fun addAPrinterFillsAFoundPrinterAndAsksOnlyTheAccessCodeWithProjectsPresent() {
        val transport = addPrinterFixture()
        compose.onNodeWithTag("add-printer-found-ssdp:01P00A451601106").performClick()
        compose.onNodeWithTag("add-printer-host").assertTextContains("192.168.1.42")
        compose.onNodeWithTag("add-printer-serial").assertTextContains("01P00A451601106")
        compose.onNodeWithText("On the printer: Settings → Device").assertExists()
        compose.onNodeWithTag("add-printer-add").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("add-printer-secret").performScrollTo().performTextInput("12345678")
        compose.onNodeWithTag("add-printer-check").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("add-printer-connected")).fetchSemanticsNodes().isNotEmpty() }
        // Check went out to the companion (printers.check) with the filled-in form and the typed code.
        val checked = WireJson.parseToJsonElement(String(transport.calls.single { it.request.url.endsWith("/v1/printers/setup/check") }.request.body!!)).jsonObject["printer"]!!.jsonObject
        assertEquals("192.168.1.42", (checked["host"] as JsonPrimitive).content)
        assertEquals("12345678", (checked["secret"] as JsonPrimitive).content)
        compose.onNodeWithTag("add-printer-add").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Added.")).fetchSemanticsNodes().isNotEmpty() }
        val sent = transport.calls.filter { it.request.url.endsWith("/v1/printers/setup/add") }.single()
        val printer = WireJson.parseToJsonElement(String(sent.request.body!!)).jsonObject["printer"]!!.jsonObject
        assertEquals(mapOf("backend" to "bambu-printer-mcp", "printerType" to "bambu", "host" to "192.168.1.42", "serial" to "01P00A451601106",
            "model" to "p1s", "secret" to "12345678", "name" to "Workshop P1S"), printer.mapValues { (it.value as JsonPrimitive).content })
        assertEquals("projects:write", CompanionClient.scope("POST", "/v1/printers/setup/add"))
        compose.onNodeWithTag("add-printer-done").performClick()
        compose.onNodeWithTag("add-printer").assertExists()
    }

    /** The MCP fetches the key for the person (`obtain`, "Approve in OctoPrint"): the approved key fills the field. */
    @Test fun addAPrinterApprovalFromTheMcpFillsTheKey() {
        val transport = addPrinterFixture()
        compose.onNodeWithTag("add-printer-found-bonjour:octopi.local:80").performClick()
        compose.onNodeWithTag("add-printer-add").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Approve in OctoPrint").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("OctoPrint approved Counterpart.")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("add-printer-add").performScrollTo().assertIsEnabled().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("add-printer-added")).fetchSemanticsNodes().isNotEmpty() }
        val obtains = transport.calls.filter { it.request.url.endsWith("/v1/printers/setup/obtain") }
        assertEquals(2, obtains.size)
        val body = WireJson.parseToJsonElement(String(obtains.last().request.body!!)).jsonObject
        assertEquals("0b6b8a52-6f1e-4c5a-9d43-4c1c3f6a2e10", (body["session"] as JsonPrimitive).content)
        val added = WireJson.parseToJsonElement(String(transport.calls.last { it.request.url.endsWith("/setup/add") }.request.body!!)).jsonObject["printer"]!!.jsonObject
        assertEquals("OCTO-KEY-FROM-APPROVAL", (added["secret"] as JsonPrimitive).content)
    }

    /** Home with a project, then Printers → Add a Printer, answered from packages/contracts/fixtures/printer-setup-phone.json. */
    private fun addPrinterFixture(): FakeTransport {
        val answers = WireJson.parseToJsonElement(contractFixture("printer-setup-phone.json").readText()).jsonObject
        fun answer(key: String) = HttpReply(200, answers[key].toString().toByteArray())
        app.pairingStore.save(v2Record(), false)
        val transport = FakeTransport { request, _ ->
            val body = request.body?.let { WireJson.parseToJsonElement(String(it)).jsonObject }
            when {
                request.url.endsWith("/healthz") -> json(200, mapOf("status" to "ok", "capabilities" to mapOf("printerAdd" to true)))
                request.url.endsWith("/v1/printers/setup/discover") -> answer("discover")
                request.url.endsWith("/v1/printers/setup/check") -> answer("check")
                request.url.endsWith("/v1/printers/setup/obtain") -> answer(if (body?.get("session") == null) "obtainPending" else "obtainApproved")
                request.url.endsWith("/v1/printers/setup/add") -> answer("add")
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state.projects.value = listOf(project("a", "Existing project", "ready"))
        state.capabilities.value = setOf("printerAdd")
        state.loaded.value = true
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination(id = "current", name = "Bambu Lab P1S", backend = "bambu-printer-mcp")), "current")
        compose.setContent {
            WithApp {
                var showPrinters by remember { mutableStateOf(false) }
                if (showPrinters) PrintersScreen(back = { showPrinters = false })
                else HomeScreen(open = { _, _ -> }, newProject = {}, printers = { showPrinters = true }, settings = {})
            }
        }
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Existing project"))
        compose.onNodeWithContentDescription("Printers").performClick()
        compose.onNodeWithTag("add-printer").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("add-printer-found-ssdp:01P00A451601106")).fetchSemanticsNodes().isNotEmpty() }
        return transport
    }

    /** Settings → Printers follow-up (Nov 6): David's two P1S profiles each showed the same Move, ordered by id. */
    @Test fun twoProfilesOfOnePrinterGetMovesThatReadApartInScreenOrderInsideTheirMcpGroup() {
        val packages = printersWithMoves()
        val titles = packages.flatMap { it.moves.map { move -> move.title } }
        org.junit.Assert.assertEquals(2, titles.toSet().size)
        for (pkg in packages) org.junit.Assert.assertEquals(pkg.uses.filter { it.canMove }.map { it.mcpId }, pkg.moveIds)
        for ((pkg, title) in packages.zip(titles)) {
            // Each Move sits in its MCP's group, under that MCP's heading.
            compose.onNode(hasTestTag("mcp-package-${pkg.`package`}")).performScrollTo()
            compose.onNode(hasText(title) and hasAnyAncestor(hasTestTag("mcp-package-${pkg.`package`}"))).assertExists()
            compose.onNode(hasText(pkg.label) and isHeading() and hasAnyAncestor(hasTestTag("mcp-package-${pkg.`package`}"))).assertExists()
            compose.onNode(hasContentDescription("Update Counterpart’s copy of ${pkg.label}") and hasAnyAncestor(hasTestTag("mcp-package-${pkg.`package`}"))).assertExists()
        }
        compose.onNodeWithText(packages[0].uses[0].words).assertExists()
        org.junit.Assert.assertTrue(packages[0].uses[0].words.contains("older than Counterpart’s copy (1.1.69)"))
    }

    /** #357's deferred Codex P2: an update or Move started on another client shows here without a tap on this phone. */
    @Test fun aMoveStartedOnAnotherClientShowsItsProgressAndResult() {
        val packages = printersWithMoves()
        val id = packages[1].moves.single().mcpId
        for (type in listOf("mcp.update.started", "mcp.update.done")) {
            val event = requireNotNull(CounterpartEvent.decode(WireJson.parseToJsonElement(
                "{\"v\":1,\"seq\":${if (type.endsWith("done")) 8 else 7},\"id\":\"$type\",\"at\":\"2026-11-06T00:00:00Z\",\"type\":\"$type\",\"title\":\"t\",\"body\":\"$type on the Mac\",\"notify\":\"none\",\"data\":{\"mcpId\":\"$id\"}}").jsonObject))
            compose.runOnIdle { state.mcpUpdateEvents.value = mapOf(id to event) }
            compose.onNode(hasText("$type on the Mac") and hasAnyAncestor(hasTestTag("mcp-package-mcp-3d-printer-server"))).assertExists()
        }
        org.junit.Assert.assertTrue(state.mcpUpdateAttempts.value.isEmpty())
    }

    private fun printersWithMoves(): List<com.scantomake.counterpart.api.McpPackageCopies> {
        val fixture = contractFixture("mcp-printer-moves.json").readText()
        val packages = WireJson.parseToJsonElement(fixture).jsonObject["packages"]!!.jsonArray
            .map { WireJson.decodeFromJsonElement<com.scantomake.counterpart.api.McpPackageCopies>(it) }
        app.pairingStore.save(v2Record(), false)
        val transport = FakeTransport { request, _ ->
            when {
                request.url.endsWith("/healthz") -> json(200, mapOf("status" to "ok", "capabilities" to mapOf("mcpCopies" to true, "mcpUpdates" to true)))
                request.url.endsWith("/mcps") -> HttpReply(200, fixture.toByteArray())
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state.projects.value = listOf(project("a", "Existing project", "ready"))
        state.mcpCopies.value = packages
        state.capabilities.value = setOf("mcpCopies", "mcpUpdates")
        state.loaded.value = true
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination(id = "current", name = "Bambu Lab P1S", backend = "bambu-printer-mcp")), "current")
        compose.setContent { WithApp { PrintersScreen(back = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("mcp-package-mcp-3d-printer-server")).fetchSemanticsNodes().isNotEmpty() }
        return packages
    }

    /** Settings has Help and Printers, as on iPhone, Mac and Linux; the print sheet sends people to Settings → Printers. */
    @Test fun settingsReachesPrintersAndHelp() {
        var printers = 0
        compose.setContent {
            WithApp { SettingsScreen(back = {}, pairAgain = {}, openPrinters = { printers++ }) }
        }
        compose.onNodeWithText("Open the Guide").assertExists()
        compose.onNodeWithText("Print the Scan Rig by Kass 3D").assertExists()
        compose.onNodeWithText("Printers and Their MCPs").performClick()
        compose.runOnIdle { org.junit.Assert.assertEquals(1, printers) }
    }

    /** Nov 5, caliper card 1f1c5515: the print sheet says a designer's file prints with its own settings (PRD §6.1). */
    @Test fun aDesignersFileSaysItPrintsWithItsOwnSettings() {
        // The companion's project for a designer's copy, as packages/contracts/fixtures/designer-own-settings.json has it.
        val designer = requireNotNull(Project.decode(WireJson.parseToJsonElement(contractFixture("designer-own-settings.json").readText()).jsonObject))
        assertEquals(true, designer.current?.ownSettings)
        assertEquals("Prints with the designer’s settings saved in this file.",
            designerSettingsWords(designer, PrintQuality.Standard, PrintStrength.Standard))
        assertEquals("Changes the designer’s settings saved in this file.",
            designerSettingsWords(designer, PrintQuality.Fine, PrintStrength.Standard))
        assertNull(designerSettingsWords(project("p", "Mic mount", "ready"), PrintQuality.Standard, PrintStrength.Standard))
    }

    /**
     * PRD §6.1 / §8.0 item 7: a multi-colour model's print sheet shows one row per part, each on the printer MCP's proposed
     * spool in its words, with its note (#365, the Android side of #341's rows).
     */
    private val PROJECT = "1f1c5515-0000-4000-8000-000000000365"
    private fun multiColourSheet(mapping: (String) -> FakeTransport) {
        app.pairingStore.save(v2Record(ADDRESSES[0]), false)
        val fake = mapping(PROJECT)
        app.pairing = PairingClient(app.pairingStore, fake)
        app.companion = CompanionClient(app.pairing, fake, null, null, app.cacheDir)
        state.projects.value = listOf(requireNotNull(Project.decode(WireJson.parseToJsonElement(
            """{"id":"$PROJECT","title":"Caliper card","instructions":"A card","state":"ready","createdAtMs":1,"updatedAtMs":2,"printerDestinationId":"p1s"}""").jsonObject)))
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination("p1s", "Bambu Lab P1S", backend = "bambu-printer-mcp")), "p1s")
        compose.setContent { WithApp { PrintSheetScreen(PROJECT, close = {}, printing = {}) } }
    }

    @Test fun aMultiColourModelShowsEachPartsSpoolAsTheMcpProposesIt() {
        val tray = { slot: Int, label: String, name: String, colour: String ->
            mapOf("slot" to slot, "colour" to colour, "material" to "PLA", "name" to name, "filamentId" to "GFA00", "destinationId" to "p1s", "label" to label, "feed" to "ams") }
        multiColourSheet { id -> FakeTransport { request, _ -> when {
            request.url.endsWith("/v1/objects/$id/colour-mapping") -> json(200, mapOf(
                "filaments" to listOf(mapOf("index" to 1, "name" to "body", "colour" to "#000000", "material" to "PLA", "slot" to 0, "verdict" to "same-colour"),
                    mapOf("index" to 2, "name" to "markings", "colour" to "#FFFFFF", "material" to "PLA", "slot" to 1, "verdict" to "closest",
                        "note" to "White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.")),
                "trays" to listOf(tray(0, "A1", "Black PLA Basic", "#000000"), tray(1, "A2", "Sunflower Yellow PLA Basic", "#FEC600")), "modelVersion" to "v1"))
            request.url.endsWith("/v1/objects/$id/filaments") -> json(200, mapOf("filaments" to emptyList<Any>()))
            else -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        } } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("markings")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Colours").assertExists()
        compose.onNodeWithText("body").assertExists()
        compose.onNodeWithText("  A1 · Black PLA Basic").assertExists()
        compose.onNodeWithText("  A2 · Sunflower Yellow PLA Basic").assertExists()
        compose.onNodeWithText("White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.").assertExists()
    }

    @Test fun colourMappingThatFailsHoldsPrintAndSaysWhy() {
        var transport: FakeTransport? = null
        multiColourSheet { id -> FakeTransport { request, _ -> when {
            request.url.endsWith("/v1/objects/$id/colour-mapping") ->
                json(409, mapOf("error" to mapOf("code" to "invalid-state", "message" to "Update bambu-printer-mcp in Settings → Printers so Counterpart can match each colour to a loaded spool. Nothing was sent to the printer.")))
            request.url.endsWith("/v1/objects/$id/filaments") -> json(200, mapOf("filaments" to emptyList<Any>()))
            else -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        } }.also { transport = it } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Try Again")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Update bambu-printer-mcp in Settings → Printers so Counterpart can match each colour to a loaded spool. Nothing was sent to the printer.").assertExists()
        compose.waitForIdle()
        assertEquals("nothing is sliced while the colours are unread", emptyList<String>(), transport!!.paths.filter { it.endsWith("/estimate") })
    }

    /** David's six-plate rig on Nov 6, from the shared fixture the companion's own tests check: plate 1's start timed out
     *  ("unconfirmed"), then another plate was chosen ("switched", with `selected` the plate chosen). */
    private val sixPlates by lazy { WireJson.parseToJsonElement(contractFixture("six-plate-unconfirmed.json").readText()).jsonObject }
    private fun rig(selected: Int, unconfirmed: Boolean): JsonObject {
        val project = sixPlates[if (unconfirmed) "unconfirmed" else "switched"]!!.jsonObject
        val plates = JsonArray(project["plates"]!!.jsonArray.map { plate ->
            JsonObject(plate.jsonObject + ("selected" to JsonPrimitive(plate.jsonObject["plateIndex"].toString().toInt() == selected))) })
        return JsonObject(project + mapOf("id" to JsonPrimitive(PROJECT), "printerDestinationId" to JsonPrimitive("p1s"), "plates" to plates))
    }

    /** David, Nov 6: "i can't select which plate to print in the app i can see them but i can't click on them". On the
     *  project, every plate stays a button after an unconfirmed start; only plate 1 says to check its result. */
    @Test fun everyPlateStaysChoosableOnTheProjectAfterAnUnconfirmedStart() {
        val unconfirmed = requireNotNull(Project.decode(rig(0, true)))
        assertEquals(true, unconfirmed.canSelectPlate)
        assertEquals(true, unconfirmed.printNeedsCheck)
        assertEquals(false, requireNotNull(Project.decode(rig(3, false))).printNeedsCheck)
        compose.setContent { WithApp { ProjectPlates(unconfirmed, busy = false, select = {}, print = {}) } }
        assertEquals(5, compose.onAllNodes(hasText("Select")).fetchSemanticsNodes().size)
        compose.onAllNodes(hasText("Select")).assertAll(isEnabled())
        assertEquals(6, compose.onAllNodes(hasText("Print…")).fetchSemanticsNodes().size)
        compose.onAllNodes(hasText("Print…")).assertAll(isEnabled())
        compose.onNodeWithText("Check print result").assertExists()
        // A send cancelled before anything went out reads "unknown" too, but never asks (Codex on #380).
        assertEquals(false, requireNotNull(Project.decode(sixPlates["cancelled"]!!.jsonObject)).printNeedsCheck)
    }

    /** The same rig in Print: its plate row changes the plate, re-reads that plate's colours, and only plate 1 asks for the check. */
    @Test fun everyPlateStaysChoosableInPrintAfterAnUnconfirmedStart() {
        app.pairingStore.save(v2Record(ADDRESSES[0]), false)
        var selected = 0
        val mappingAsks = mutableListOf<Int>()
        val fake = FakeTransport { request, _ -> when {
            request.url.endsWith("/v1/objects/$PROJECT/plate-selection") -> {
                selected = WireJson.parseToJsonElement(String(request.body!!)).jsonObject["plateIndex"].toString().toInt()
                HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to rig(selected, false)))).toByteArray())
            }
            request.url.endsWith("/v1/objects/$PROJECT/colour-mapping") -> { synchronized(mappingAsks) { mappingAsks.add(selected) }; json(200, mapOf("filaments" to emptyList<Any>(), "trays" to emptyList<Any>())) }
            request.url.endsWith("/v1/objects/$PROJECT/filaments") -> json(200, mapOf("filaments" to emptyList<Any>()))
            else -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        } }
        app.pairing = PairingClient(app.pairingStore, fake)
        app.companion = CompanionClient(app.pairing, fake, null, null, app.cacheDir)
        state.projects.value = listOf(requireNotNull(Project.decode(rig(0, true))))
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination("p1s", "Bambu Lab P1S", backend = "bambu-printer-mcp")), "p1s")
        compose.setContent { WithApp { PrintSheetScreen(PROJECT, close = {}, printing = {}) } }
        try { compose.waitUntil(5_000) { synchronized(mappingAsks) { mappingAsks.isNotEmpty() } } }
        catch (e: Throwable) { throw AssertionError("asked: ${fake.paths}", e) }
        compose.onNode(hasTestTag("print-sheet-plate-0-0")).assertIsSelected()
        compose.onNodeWithText("The last send of this plate may have reached the printer. I checked: it isn't printing this.").assertExists()
        compose.onNode(hasTestTag("print-sheet-plate-0-3")).assertIsEnabled().performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("print-sheet-plate-0-3") and isSelected()).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(5_000) { synchronized(mappingAsks) { 3 in mappingAsks } }
        compose.onNodeWithText("The last send of this plate may have reached the printer. I checked: it isn't printing this.").assertDoesNotExist()
        compose.onNodeWithText("The selected plate changed. Close this sheet and open Print again.").assertDoesNotExist()
    }
}
