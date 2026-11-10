package com.scantomake.counterpart

import kotlinx.serialization.json.jsonPrimitive

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
import org.junit.Assert.assertTrue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performScrollTo
import com.scantomake.counterpart.api.PrinterCatalog
import com.scantomake.counterpart.api.PrinterDestination
import com.scantomake.counterpart.ui.PrintersScreen
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertAll
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isSelected
import com.scantomake.counterpart.ui.ProjectPlates
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import androidx.compose.ui.test.hasText
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.hasContentDescription
import kotlinx.serialization.json.decodeFromJsonElement
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.AskPicture
import com.scantomake.counterpart.api.ScanPhotos
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
import com.scantomake.counterpart.ui.NewProjectScreen
import com.scantomake.counterpart.ui.SettingsScreen
import com.scantomake.counterpart.ui.PrintSheetScreen
import com.scantomake.counterpart.ui.designerSettingsWords
import com.scantomake.counterpart.ui.posterName
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
import java.io.File

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

    @Test fun inactivityStopShowsItsReasonAfterOpeningTheProjectWithProjectsPresent() {
        val rows = WireJson.parseToJsonElement(kitFixture("capped-projects.json").readText()).jsonArray
        val data = rows.first { it.jsonObject["name"]!!.jsonPrimitive.content == "limit-inactivity" }.jsonObject["expected"]!!.jsonObject
        val stopped = requireNotNull(Project.decode(data))
        val transport = FakeTransport { request, _ ->
            if (request.url.endsWith("/v1/objects/${stopped.id}")) HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to data))).toByteArray())
            else json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state.projects.value = listOf(project("other", "Existing project", "ready"), stopped)
        state.loaded.value = true
        compose.setContent { WithApp {
            var selected by remember { mutableStateOf<String?>(null) }
            if (selected == null) HomeScreen(open = { id, _ -> selected = id }, newProject = {}, printers = {}, settings = {})
            else com.scantomake.counterpart.ui.ProjectScreen(selected!!, back = { selected = null }, print = {}, printing = {}, scan = {})
        } }
        val title = com.scantomake.counterpart.api.ProjectWords(stopped).title
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(title))
        // Home names a stopped project twice: its Needs you card (which already says why it stopped) and its tile.
        compose.onAllNodesWithText(title, substring = true).onFirst().performClick()
        compose.onNodeWithText("Stopped after 10 minutes without worker activity. Try again or review the saved checkpoint.").performScrollTo().assertExists()
        compose.onNodeWithText("Try Again").performScrollTo().assertIsEnabled()
    }

    /** David's Nov 9 bottle project, with projects present (PRD §6.1): the question's picture spans the card with a caption
     *  true for any question, and What you sent shows the scan as one strip that fetches five of its 130 frames. */
    @Test fun theQuestionsPictureIsLargeAndTheScanIsOneStripWithProjectsPresent() {
        val id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04"
        val frames = (1..130).joinToString(",") { "\"%04d.heic\"".format(it) }
        val data = WireJson.parseToJsonElement(
            """{"id":"$id","title":"Wall holder for three","instructions":"Make something that holds three of these","state":"needs-closeup",
               "createdAtMs":1,"updatedAtMs":2,"photos":[],"capture":[$frames],"passes":[{"startedAtMs":1,"endedAtMs":2,"status":"needs_closeup"}],
               "ask":{"id":"1af638c1-ec63-46fc-aa2f-e74cd29df231","question":"Kroger doesn't publish this bottle's size. Can you confirm?",
                      "photo":"asks/1af638c1-ec63-46fc-aa2f-e74cd29df231.jpg","region":{"x":0.42,"y":0.3,"width":0.28,"height":0.34},
                      "answers":["camera","photos","best-guess","text"],"status":"open"}}""").jsonObject
        val picture = java.io.ByteArrayOutputStream().also {
            android.graphics.Bitmap.createBitmap(400, 300, android.graphics.Bitmap.Config.ARGB_8888).compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, it)
        }.toByteArray()
        app.pairingStore.save(v2Record(ADDRESSES[0]), false)
        val fake = FakeTransport { request, _ -> when {
            request.url.endsWith("/v1/objects/$id") -> HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to data))).toByteArray())
            request.url.contains("/v1/objects/$id/asks/") || request.url.contains("/v1/objects/$id/capture/") -> HttpReply(200, picture)
            else -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        } }
        app.pairing = PairingClient(app.pairingStore, fake)
        app.companion = CompanionClient(app.pairing, fake, null, null, app.cacheDir)
        state.projects.value = listOf(project("other", "Existing project", "ready"), requireNotNull(Project.decode(data)))
        state.loaded.value = true
        compose.setContent { WithApp { com.scantomake.counterpart.ui.ProjectScreen(id, back = {}, print = {}, printing = {}, scan = {}) } }
        val caption = "The outlined part is what this question is about."
        compose.onNode(hasTestTag("ask-picture")).performScrollTo().assertExists()
        compose.onNode(hasContentDescription(caption)).assertExists()
        compose.onNodeWithText(caption).assertExists()
        compose.onAllNodes(hasText("can't see", substring = true)).assertCountEquals(0)
        compose.onNode(hasTestTag("scan-strip")).performScrollTo().assertExists()
        compose.onNode(hasContentDescription("Your scan, 130 photos")).assertExists()
        compose.waitForIdle()
        val fetched = fake.paths.filter { "/capture/" in it }.toSet()
        assertTrue("only the strip's five frames: $fetched", fetched.size <= ScanPhotos.SHOWN)
        assertEquals(listOf(0, 32, 65, 97, 129), ScanPhotos.sample(130))
        assertEquals("Your project’s picture. No picture came with this question.", AskPicture.caption(null))
    }

    /** Review F2 on #456: a question picture that fails to load (the computer asleep) draws nothing, not an empty box
     *  under "The outlined part is what this question is about."; the question and its answers stay. */
    @Test fun aQuestionPictureThatFailsToLoadDrawsNothing() {
        val id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04"
        val data = WireJson.parseToJsonElement(
            """{"id":"$id","title":"Wall holder for three","state":"needs-closeup","createdAtMs":1,"updatedAtMs":2,"photos":[],
               "passes":[{"startedAtMs":1,"endedAtMs":2,"status":"needs_closeup"}],
               "ask":{"id":"1af638c1-ec63-46fc-aa2f-e74cd29df231","question":"Can you confirm the size?",
                      "photo":"asks/1af638c1-ec63-46fc-aa2f-e74cd29df231.jpg","region":{"x":0.42,"y":0.3,"width":0.28,"height":0.34},
                      "answers":["camera","photos","best-guess","text"],"status":"open"}}""").jsonObject
        app.pairingStore.save(v2Record(ADDRESSES[0]), false)
        val fake = FakeTransport { request, _ -> when {
            request.url.endsWith("/v1/objects/$id") -> HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to data))).toByteArray())
            else -> json(503, mapOf("error" to mapOf("code" to "unreachable", "message" to "asleep")))
        } }
        app.pairing = PairingClient(app.pairingStore, fake)
        app.companion = CompanionClient(app.pairing, fake, null, null, app.cacheDir)
        state.projects.value = listOf(project("other", "Existing project", "ready"), requireNotNull(Project.decode(data)))
        state.loaded.value = true
        compose.setContent { WithApp { com.scantomake.counterpart.ui.ProjectScreen(id, back = {}, print = {}, printing = {}, scan = {}) } }
        compose.waitUntil(5_000) { fake.paths.any { "/asks/" in it } }
        compose.waitForIdle()
        // The question shows in the status line and in its card; it stays, with its answers.
        compose.onAllNodesWithText("Can you confirm the size?").onFirst().assertExists()
        compose.onNodeWithText("Make Your Best Guess").assertExists()
        compose.onAllNodes(hasTestTag("ask-picture")).assertCountEquals(0)
        compose.onAllNodes(hasText("The outlined part is what this question is about.")).assertCountEquals(0)
    }

    /** Review F6 on #456: all eight EXIF orientations stand the photo upright, mirrored ones included. */
    @Test fun everyExifOrientationStandsThePhotoUpright() {
        val e = android.media.ExifInterface::class.java
        fun o(name: String) = e.getField(name).getInt(null)
        assertEquals(0f to false, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_NORMAL")))
        assertEquals(0f to true, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_FLIP_HORIZONTAL")))
        assertEquals(180f to false, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_ROTATE_180")))
        assertEquals(180f to true, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_FLIP_VERTICAL")))
        assertEquals(90f to true, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_TRANSPOSE")))
        assertEquals(90f to false, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_ROTATE_90")))
        assertEquals(-90f to true, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_TRANSVERSE")))
        assertEquals(-90f to false, com.scantomake.counterpart.ui.uprightTurn(o("ORIENTATION_ROTATE_270")))
    }

    @Test fun printerAttentionAndPrintingStayVisibleWithProjects() {
        state.projects.value = listOf(requireNotNull(Project.decode(WireJson.parseToJsonElement(
            """{"id":"clip","title":"Cable clip","state":"printing","createdAtMs":0,"updatedAtMs":0,"photos":[],"passes":[],"print":{"destinationId":"p1","monitor":{"phase":"watching"}}}"""
        ).jsonObject)))
        state.catalog.value = PrinterCatalog(listOf(PrinterDestination("p1", "P1S", model = "Bambu Lab P1S", state = "ready"),
            PrinterDestination("p2", "Desk", state = "offline")))
        state.macName.value = "Mac mini"
        state.link.value = com.scantomake.counterpart.api.MacLink.Connected
        state.loaded.value = true
        home()
        compose.onNodeWithContentDescription("Printers, 1 needs attention").assertExists()
        compose.onNodeWithText("Mac mini connected · Bambu Lab P1S printing").assertExists()
    }

    @Test fun failedProjectsAppearUnderNeedsYou() {
        state.projects.value = listOf(project("failed", "Failed scan", "failed"), project("ready", "Mic mount", "ready"))
        state.loaded.value = true
        home()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Needs you"))
        compose.onNodeWithText("Needs you").assertExists()
    }

    @Test fun aCardsLineNeverRepeatsItsPhaseWithProjectsPresent() {
        val asking = requireNotNull(Project.decode(WireJson.parseToJsonElement(
            """{"id":"asking","title":"Wall holder","instructions":"A useful part","state":"needs-closeup","createdAtMs":1,"updatedAtMs":2,""" +
                """"status":{"phase":"needs-you","text":"Needs you · Can you confirm these sizes?","detail":"Can you confirm these sizes?","symbol":"hand.raised","tint":"orange"}}"""
        ).jsonObject))
        state.projects.value = listOf(asking, project("other", "Mic mount", "ready"))
        state.loaded.value = true
        home()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Wall holder"))
        // The card is clickable and merges its children, so its line's tag is in the unmerged tree.
        compose.onNodeWithTag("row-line-asking", useUnmergedTree = true).assertTextEquals("Can you confirm these sizes?")
        compose.onAllNodes(SemanticsMatcher("text starts with the phase") { node ->
            node.config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text.startsWith("Needs you · ") }
        }, useUnmergedTree = true).assertCountEquals(0)
        // With no detail from the computer (an older one), the line shows as before.
        val plain = project("plain", "Cable clip", "ready")
        assertEquals("Ready to print", com.scantomake.counterpart.api.rowLine(plain, "Ready to print"))
    }

    @Test fun anOngoingPrintShowsTheCounterpartMarkAndTheRealObjectsPicture() = kotlinx.coroutines.runBlocking {
        val p = project("4a4c5c44-7379-4a92-8a20-11a4710331a2", "Bottle holder", "printing")
            .copy(photos = listOf("bottle.jpg"), capture = listOf("0001.heic"))
        state.projects.value = listOf(p, project("other", "Another project", "ready"))
        val folder = File(app.cacheDir, "${p.id}/${p.mediaVersion}").apply { mkdirs() }
        val photo = File(folder, "photos_bottle.jpg")
        val bitmap = android.graphics.Bitmap.createBitmap(40, 40, android.graphics.Bitmap.Config.ARGB_8888)
        photo.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        try {
            assertEquals("photos/bottle.jpg", p.posterName())
            org.junit.Assert.assertNotNull(com.scantomake.counterpart.app.NotificationPictures.refresh(p))
            val service = org.robolectric.Robolectric.buildService(com.scantomake.counterpart.app.WatchService::class.java).get()
            val notification = service.ongoing("Bottle holder", "Printing · 50%", p)
            assertEquals(R.drawable.ic_notification, notification.smallIcon.resId)
            org.junit.Assert.assertNotNull(notification.getLargeIcon())
            assertEquals("Bottle holder", notification.extras.getString(android.app.Notification.EXTRA_TITLE))
            val intent = org.robolectric.Shadows.shadowOf(notification.contentIntent).savedIntent
            assertEquals(p.id, intent.getStringExtra(MainActivity.EXTRA_PROJECT))
        } finally { photo.delete(); folder.delete(); folder.parentFile?.delete() }
    }

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

    @Test fun aFinishedScanAsksCopyFitOrSaveBeforeItCanSend() {
        state.projects.value = listOf(project("a", "Existing project", "ready"))
        app.prefs.edit().putString("CounterpartNewDraftId", "scan-draft").commit()
        val capture = File(File(app.filesDir, "Captures"), "scan-draft").apply { mkdirs() }
        File(capture, "finished").writeText("")
        File(capture, "0000.jpg").writeBytes(byteArrayOf(1))
        compose.setContent { WithApp { NewProjectScreen(job = null, close = {}, started = {}, scan = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("scan-use")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("scan-use-copy").assertExists()
        compose.onNodeWithTag("scan-use-fit").performScrollTo().performClick()
        compose.onNodeWithTag("fit-size-lookup").assertExists()
        compose.onNodeWithTag("fit-caliper-photo").assertExists()
        compose.onNodeWithTag("scan-use-later").assertExists()
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

    /** Home's line and its banner read one value: a request the computer refused is not a connection problem, and
     *  the connection problem it replaces goes from both at once. */
    @Test fun homesConnectionLineAndBannerNeverDisagreeWithProjectsPresent() {
        state.projects.value = listOf(project("a", "Stove gap filler", "ready"))
        state.loaded.value = true
        state.requestFailed(com.scantomake.counterpart.api.CompanionException.unreachable)
        home()
        // The line, exactly; the banner says the same thing in its longer sentence.
        compose.onNodeWithText("Your computer isn't answering").assertExists()
        compose.onNodeWithText("Try Again").assertExists()
        // The computer answers, with a refusal about something else.
        state.requestFailed(com.scantomake.counterpart.api.CompanionException("invalid-state", "That project is printing."))
        compose.waitForIdle()
        compose.onNodeWithText("Try Again").assertDoesNotExist()
        compose.onNode(hasText("connected", substring = true)).assertExists()
        assertEquals(com.scantomake.counterpart.api.MacLink.Connected, state.link.value)
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
     * Q9, PRD §6.1: with projects present, Home → Printers has "Keep printer software up to date" once, after the printers
     * and their MCP copies, on as the computer sends it; turning it off sends `general.autoUpdateMcps: false`. A computer
     * that doesn't send the key shows no switch.
     */
    @Test fun keepPrinterSoftwareUpToDateIsInPrintersWithProjectsPresent() {
        val pkg = WireJson.decodeFromString<com.scantomake.counterpart.api.McpPackageCopies>(contractFixture("mcp-profile-copies.json").readText())
        app.pairingStore.save(v2Record(), false)
        val patches = mutableListOf<String>()
        var sendsKey = true
        var on = true
        var reads = 0
        val transport = FakeTransport { request, _ ->
            when {
                request.url.endsWith("/healthz") -> json(200, mapOf("status" to "ok", "capabilities" to mapOf("mcpCopies" to true, "mcpUpdates" to true)))
                request.url.endsWith("/mcps") -> HttpReply(200, ("{\"packages\":[" + contractFixture("mcp-profile-copies.json").readText() + "]}").toByteArray())
                request.url.endsWith("/v1/settings") && request.method == "PATCH" -> {
                    patches += String(request.body!!)
                    on = WireJson.parseToJsonElement(String(request.body!!)).jsonObject["general"]!!.jsonObject["autoUpdateMcps"]!!.jsonPrimitive.content == "true"
                    json(200, mapOf("settings" to mapOf("milestones" to "50", "general" to mapOf("autoUpdateMcps" to on))))
                }
                request.url.endsWith("/v1/settings") -> { reads++; json(200, mapOf("settings" to mapOf("milestones" to "50",
                    "general" to if (sendsKey) mapOf("autoUpdateMcps" to on) else emptyMap<String, Any>()))) }
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
        var showPrinters by mutableStateOf(false)
        compose.setContent {
            WithApp {
                if (showPrinters) PrintersScreen(back = { showPrinters = false })
                else HomeScreen(open = { _, _ -> }, newProject = {}, printers = { showPrinters = true }, settings = {})
            }
        }
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Existing project"))
        compose.onNodeWithText("Existing project").assertExists()
        compose.onNodeWithContentDescription("Printers").performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("auto-update-mcps")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(hasTestTag("auto-update-mcps")).assertCountEquals(1)
        compose.onNodeWithText("Counterpart’s copy 1.2.45").assertExists()
        val switch = compose.onNodeWithTag("auto-update-mcps")
        switch.performScrollTo().assertIsOn().assertTextContains("Keep printer software up to date")
        compose.onNodeWithText(com.scantomake.counterpart.ui.AUTO_UPDATE_MCPS_WORDS).assertExists()
        switch.performClick()
        compose.waitUntil(5_000) { patches.isNotEmpty() }
        assertEquals("{\"general\":{\"autoUpdateMcps\":false}}", patches.single())
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("auto-update-mcps") and androidx.compose.ui.test.isOff()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("auto-update-mcps").assertIsOff()
        // An older computer: no switch.
        compose.onNodeWithContentDescription("Back").performClick()
        sendsKey = false
        compose.onNodeWithContentDescription("Printers").performClick()
        compose.onNodeWithText("Counterpart’s copy 1.2.45").assertExists()
        compose.waitUntil(5_000) { reads == 2 }
        compose.waitForIdle()
        compose.onAllNodes(hasTestTag("auto-update-mcps")).assertCountEquals(0)
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

    /** PRD §8.9, §6.1: Settings shows the code design engine from the computer's settings, and Set Up asks the computer to set it up. */
    @Test fun settingsShowsTheCodeDesignEngineAndSetsItUpOnTheComputer() {
        app.pairingStore.save(v2Record(), false)
        val paths = mutableListOf<String>()
        // As the computer does: once Set Up starts, the row's own read says it is setting up.
        val settingUp = mapOf("state" to "setting-up", "message" to "Setting up… 0 s so far.", "seconds" to 0, "canSetUp" to false)
        var started = false
        val transport = FakeTransport { request, _ ->
            paths += "${request.method} ${request.url.substringAfter("/v1/")}"
            when {
                request.url.endsWith("/v1/settings/cad/setup") -> { started = true; json(200, mapOf("settings" to mapOf("milestones" to "50", "cad" to settingUp))) }
                request.url.endsWith("/v1/settings/cad") -> json(200, mapOf("cad" to if (started) settingUp
                    else mapOf("state" to "not-set-up", "message" to "Not set up yet.", "server" to "bambu-printer-mcp", "canSetUp" to true,
                        "size" to "Set Up downloads about 367 MB and uses about 1.6 GB on this computer.")))
                request.url.endsWith("/v1/settings") -> json(200, mapOf("settings" to mapOf("milestones" to "50")))
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state.projects.value = listOf(project("a", "Existing project", "ready"))
        state.loaded.value = true
        compose.setContent { WithApp { SettingsScreen(back = {}, pairAgain = {}, openPrinters = {}) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("code-engine")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Not set up yet.").assertExists()
        compose.onNodeWithText("Set Up downloads about 367 MB and uses about 1.6 GB on this computer.").assertExists()
        // The card is below the fold on a phone: scroll to it as a person would, then press Set Up.
        compose.onNodeWithText("Set Up").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Setting up… 0 s so far.")).fetchSemanticsNodes().isNotEmpty() }
        org.junit.Assert.assertTrue(paths.contains("POST settings/cad/setup"))
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

    // UX walkthrough Nov 8 (F1, F3, F7): after the print, and the notifications that land there.

    private val CLIP = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a03"
    private fun finishedClip(status: String? = null): JsonObject = WireJson.parseToJsonElement(
        """{"id":"$CLIP","title":"Cable clip","instructions":"A clip","state":"${if (status == "works") "confirmed" else "printed"}","createdAtMs":1,"updatedAtMs":2,
           "print":{"destinationId":"p1s","live":{"state":"finished","job":{"progress":100,"layer":212,"totalLayers":212},"temps":{"nozzle":{"actual":220,"target":0},"bed":{"actual":55,"target":0}}},
                    "monitor":{"phase":"ended","endState":"done","endedAt":"2026-11-08T10:00:00Z"}}${status?.let { ""","settings":{"status":"$it"}""" } ?: ""}}"""
    ).jsonObject

    private fun companionAnswering(): FakeTransport {
        app.pairingStore.save(v2Record(ADDRESSES[0]), false)
        var status: String? = null
        val fake = FakeTransport { request, _ -> when {
            request.method == "PATCH" && request.url.endsWith("/v1/objects/$CLIP/settings") -> {
                status = WireJson.parseToJsonElement(String(request.body!!)).jsonObject["status"].toString().trim('"')
                HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to finishedClip(status)))).toByteArray())
            }
            request.url.endsWith("/v1/objects/$CLIP") || request.url.contains("/v1/objects/$CLIP/") ->
                HttpReply(200, WireJson.encodeToString(JsonElement.serializer(), JsonObject(mapOf("object" to finishedClip(status)))).toByteArray())
            else -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "not here")))
        } }
        app.pairing = PairingClient(app.pairingStore, fake)
        app.companion = CompanionClient(app.pairing, fake, null, null, app.cacheDir)
        return fake
    }

    /** F1: a finished print's Printing screen asks "Did it fit?" and goes on to the project, instead of old temperatures. */
    @Test fun aFinishedPrintAsksDidItFitOnPrintingAndOpensTheProject() {
        val fake = companionAnswering()
        state.projects.value = listOf(requireNotNull(Project.decode(finishedClip())))
        var opened = 0
        compose.setContent { WithApp { com.scantomake.counterpart.ui.PrintingScreen(CLIP, back = {}, project = { opened++ }) } }
        compose.onNodeWithText("Did it fit?").assertExists()
        compose.onNodeWithText("Nozzle 220 °C", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Stop").assertDoesNotExist()
        compose.onNodeWithText("It Works").performScrollTo().performClick()
        compose.waitUntil(5_000) { fake.calls.any { it.request.method == "PATCH" } }
        val patch = fake.calls.first { it.request.method == "PATCH" }.request
        assertEquals("\"works\"", WireJson.parseToJsonElement(String(patch.body!!)).jsonObject["status"].toString())
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Did it fit?")).fetchSemanticsNodes().isEmpty() }
        compose.onNode(hasTestTag("open-project")).performScrollTo().performClick()
        assertEquals(1, opened)
    }

    /** F3: the done notification carries It Works and Needs Changes… (with a reply), and It Works asks the Mac. */
    @Test fun theDoneNotificationAnswersDidItFitFromItsButtons() {
        val fake = companionAnswering()
        org.robolectric.Shadows.shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        com.scantomake.counterpart.app.Notifications.createChannels(app)
        val done = CounterpartEvent(seq = 7, id = "e7", at = "2026-11-08T10:00:00Z", type = "print.done", projectId = CLIP, printId = "p",
            printerName = "P1S", title = "Cable clip is done", body = "Take it off the plate.", notify = "active", data = null, frame = null)
        com.scantomake.counterpart.app.Notifications.post(app, done)
        val manager = app.getSystemService(android.app.NotificationManager::class.java)
        val posted = org.robolectric.Shadows.shadowOf(manager).allNotifications.single()
        assertEquals(listOf("It Works", "Needs Changes…", "Open Project"), posted.actions.map { it.title.toString() })
        assertEquals("Needs Changes takes words", 1, posted.actions[1].remoteInputs?.size)
        val itWorks = org.robolectric.Shadows.shadowOf(posted.actions[0].actionIntent).savedIntent
        val failure = kotlinx.coroutines.runBlocking { com.scantomake.counterpart.app.NotificationActions.handle(app, itWorks) }
        assertNull(failure)
        val patch = fake.calls.single { it.request.method == "PATCH" }.request
        assertEquals(true, patch.url.endsWith("/v1/objects/$CLIP/settings"))
        assertEquals("\"works\"", WireJson.parseToJsonElement(String(patch.body!!)).jsonObject["status"].toString())
        assertEquals("answered: the notification goes", 0, org.robolectric.Shadows.shadowOf(manager).allNotifications.size)
    }

    /** F3: Needs Changes… sends the words after "After printing: ", as the project page's Ask for changes does. */
    @Test fun needsChangesFromTheNotificationSendsTheWords() {
        val fake = companionAnswering()
        val intent = android.content.Intent().apply {
            putExtra(com.scantomake.counterpart.app.NotificationActions.EXTRA_ACTION, "NEEDS_CHANGES")
            putExtra(com.scantomake.counterpart.app.NotificationActions.EXTRA_TYPE, "print.done")
            putExtra(com.scantomake.counterpart.app.Notifications.EXTRA_PROJECT, CLIP)
        }
        androidx.core.app.RemoteInput.addResultsToIntent(arrayOf(androidx.core.app.RemoteInput.Builder(com.scantomake.counterpart.app.NotificationActions.REPLY).build()),
            intent, android.os.Bundle().apply { putCharSequence(com.scantomake.counterpart.app.NotificationActions.REPLY, "2 mm wider") })
        kotlinx.coroutines.runBlocking { com.scantomake.counterpart.app.NotificationActions.handle(app, intent) }
        assertEquals(listOf("PATCH", "POST"), fake.calls.map { it.request.method })
        assertEquals(true, fake.calls[1].request.url.endsWith("/v1/objects/$CLIP/corrections"))
        assertEquals("\"After printing: 2 mm wider\"", WireJson.parseToJsonElement(String(fake.calls[1].request.body!!)).jsonObject["note"].toString())
    }

    /** F3: each moment's buttons, and a button never acts on another moment (no It Works on a cancelled print). */
    @Test fun eachMomentGetsItsOwnButtons() {
        val actions = com.scantomake.counterpart.app.NotificationActions
        assertEquals(listOf("Open Print", "Pause"), actions.actions("print.milestone").map { it.title })
        assertEquals(listOf("Open Print", "Resume"), actions.actions("print.paused").map { it.title })
        assertEquals(listOf("Try Again", "Open Project"), actions.actions("print.failed").map { it.title })
        assertEquals(listOf("Open Project"), actions.actions("print.cancelled").map { it.title })
        assertEquals(listOf("Print", "Ask for Changes…"), actions.actions("pass.ready").map { it.title })
        assertEquals(listOf("Take a Photo", "Best Guess"), actions.actions("pass.ask").map { it.title })
        assertNull(actions.command("IT_WORKS", "print.cancelled", CLIP))
        assertNull(actions.command("RESUME", "print.failed", CLIP))
        assertNull(actions.command("PAUSE", "print.done", CLIP))
        assertNull("Try Again opens Print; it never prints", actions.command("TRY_AGAIN", "print.failed", CLIP))
        assertEquals("print", actions.screen(com.scantomake.counterpart.app.NotificationActions.Action.TryAgain, "print.failed"))
        assertNull(actions.screen(com.scantomake.counterpart.app.NotificationActions.Action.TryAgain, "pass.failed"))
        assertEquals("printing", actions.screen(null, "print.milestone"))
    }

    /** F7: in the foreground an event shows unless its own project's page or Printing screen is showing. */
    @Test fun inTheForegroundOnlyTheShowingProjectsEventsStayQuiet() {
        state.showing(CLIP, true); state.showing(CLIP, true); state.showing(CLIP, false)
        assertEquals("a push then a pop keeps it", true, CLIP in state.onScreen.value)
        state.showing(CLIP, false)
        assertEquals(false, CLIP in state.onScreen.value)
    }
}

