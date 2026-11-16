package com.scantomake.counterpart

import android.app.Application
import android.content.Context
import org.robolectric.RuntimeEnvironment
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingStore
import com.scantomake.counterpart.net.HttpReply
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AppStateTests {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var app: Counterpart
    private lateinit var state: AppState
    private lateinit var transport: FakeTransport

    @Before fun setup() {
        // Attach Android context without starting notification workers or real transport.
        app = Counterpart()
        ReflectionHelpers.callInstanceMethod<Void>(app, "attach",
            ClassParameter.from(Context::class.java, RuntimeEnvironment.getApplication()))
        Dispatchers.setMain(dispatcher)
        app.pairingStore = PairingStore(MemoryStore())
        transport = FakeTransport { request, _ ->
            when (java.net.URI(request.url).path) {
                "/v1/objects" -> json(value = mapOf("objects" to emptyList<Any>()))
                "/v1/objects/printers" -> json(value = mapOf("destinations" to emptyList<Any>()))
                "/healthz" -> json(value = mapOf("name" to "Test computer"))
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        app.pairing = PairingClient(app.pairingStore, transport)
        app.companion = CompanionClient(app.pairing, transport, null, null, app.cacheDir)
        state = AppState(app)
        dispatcher.scheduler.runCurrent()
    }

    @After fun cleanup() {
        state.scope.cancel()
        Dispatchers.resetMain()
    }

    private fun pair() {
        app.pairingStore.save(v2Record(expiresAt = System.currentTimeMillis() + 30.0 * 86_400_000), notify = true)
        dispatcher.scheduler.runCurrent()
    }

    /** #691: a design's parts land after the project is ready, with `project.updated` (keys `current`): the project is read
     *  again and the stage's parts revision moves, so the open page draws them without the person leaving it. */
    @Test fun partsThatLandAfterTheProjectIsReadyAreReadAgainAndRedrawn() {
        val id = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a95"
        fun record(parts: Boolean) = mapOf("id" to id, "createdAtMs" to 1, "updatedAtMs" to 2, "state" to "ready", "kind" to "copy", "photos" to emptyList<Any>(),
            "passes" to emptyList<Any>(), "current" to mapOf("model" to "current/model.3mf", "renders" to emptyList<Any>(), "mergedMesh" to "current/model.stl") +
                (if (parts) mapOf("parts" to listOf(mapOf("id" to "1/1", "colour" to "#B0855D", "mesh" to "current/parts/part-1.stl"),
                    mapOf("id" to "1/2", "colour" to "#111111", "mesh" to "current/parts/part-2.stl"))) else emptyMap()))
        var landed = false
        var reads = 0
        transport.answer = { request, _ ->
            val uri = java.net.URI(request.url)
            when (uri.path) {
                "/v1/objects" -> json(value = mapOf("objects" to listOf(record(landed))))
                "/v1/objects/$id" -> json(value = mapOf("object" to record(landed)))
                "/v1/objects/printers" -> json(value = mapOf("destinations" to emptyList<Any>()))
                "/healthz" -> json(value = mapOf("name" to "Test computer"))
                "/v1/events" -> when (reads++) {
                    0 -> json(value = mapOf("next" to 5, "events" to emptyList<Any>()))
                    1 -> { landed = true; json(value = mapOf("next" to 6, "events" to listOf(mapOf("seq" to 6, "id" to "e6", "type" to "project.updated", "projectId" to id,
                        "title" to "Desk sign", "body" to "Project updated", "notify" to "none", "data" to mapOf("keys" to listOf("current")))))) }
                    else -> HttpReply(503, ByteArray(0))
                }
                else -> json(404, mapOf("error" to "not-found"))
            }
        }
        pair()
        state.startFollowing()
        dispatcher.scheduler.runCurrent()
        val shown = state.projects.value.single { it.id == id }
        assertEquals(listOf("current/parts/part-1.stl", "current/parts/part-2.stl"), shown.current!!.parts.map { it.mesh })
        assertEquals(6, state.designRevisions.value[id])
        // The gallery now draws the design part by part.
        assertTrue(com.scantomake.counterpart.api.ProjectGallery.of(shown).first!!.drawing is com.scantomake.counterpart.api.ProjectGallery.Drawing.Parts)
    }

    @Test fun pairingWhileVisibleLoadsProjectsWithoutAScreenCallbackOrRelaunch() {
        state.startFollowing()
        pair()
        assertTrue("Pairing must replace the initial spinner with a loaded project list", state.loaded.value)
        assertEquals("Test computer", state.macName.value)
    }

    @Test fun replacingPairingWhileVisibleRestartsTheProjectRead() {
        pair()
        state.startFollowing()
        dispatcher.scheduler.runCurrent()
        transport.calls.clear()
        pair()
        assertTrue(state.loaded.value)
        assertEquals(1, transport.paths.count { it.endsWith("/v1/objects") })
    }

    @Test fun pairingWhileBackgroundedWaitsForResumeAndDisconnectClearsProjects() {
        state.startFollowing()
        state.stopFollowing()
        pair()
        assertFalse(state.loaded.value)
        assertTrue(transport.paths.isEmpty())
        state.startFollowing()
        dispatcher.scheduler.runCurrent()
        assertTrue(state.loaded.value)
        app.pairingStore.disconnect()
        dispatcher.scheduler.runCurrent()
        assertTrue(state.needsMac)
        assertFalse(state.loaded.value)
    }

    /** A project refresh reports every failure to the link, not only "didn't answer": pairing lost on a refresh must
     *  not leave Home saying "connected", and a refusal ends a stale "isn't answering". */
    @Test fun aProjectRefreshThatFailsForAnyReasonUpdatesTheLink() = kotlinx.coroutines.test.runTest(dispatcher) {
        pair()
        dispatcher.scheduler.runCurrent()
        val id = "d79d4c15-d786-461c-b76e-ec687c8e2dad"
        state.link.value = com.scantomake.counterpart.api.MacLink.Connected
        transport.answer = { _, _ -> json(401, mapOf("error" to mapOf("code" to "pairing-changed", "message" to "Refused."))) }
        val lost = state.reload(id)
        assertTrue(lost!!.needsPairing)
        assertTrue(state.link.value is com.scantomake.counterpart.api.MacLink.NeedsPairing)
        assertTrue(state.error.value!!.needsPairing)
        state.link.value = com.scantomake.counterpart.api.MacLink.NotAnswering
        state.error.value = com.scantomake.counterpart.api.CompanionException.unreachable
        transport.answer = { _, _ -> json(409, mapOf("error" to mapOf("code" to "invalid-state", "message" to "Refused."))) }
        state.reload(id)
        assertEquals(com.scantomake.counterpart.api.MacLink.Connected, state.link.value)
        assertNull(state.error.value)
        // "Not found" is an answer too, and the project goes.
        state.link.value = com.scantomake.counterpart.api.MacLink.NotAnswering
        transport.answer = { _, _ -> json(404, mapOf("error" to mapOf("code" to "not-found", "message" to "Gone."))) }
        state.reload(id)
        assertEquals(com.scantomake.counterpart.api.MacLink.Connected, state.link.value)
        // No answer at all: the link stops saying connected and the banner says why.
        transport.answer = { _, _ -> throw com.scantomake.counterpart.net.TransportException("network") }
        assertTrue(state.reload(id)!!.isUnreachable)
        assertEquals(com.scantomake.counterpart.api.MacLink.NotAnswering, state.link.value)
        assertTrue(state.error.value!!.isUnreachable)
        // A refresh that works is an answer, and clears the "not answering" banner.
        val objects = com.scantomake.counterpart.core.WireJson.parseToJsonElement(kitFixture("objects.json").readText())
            .jsonObject["objects"]!!.jsonArray
        val project = objects[0].jsonObject
        transport.answer = { _, _ -> HttpReply(200, """{"object":$project}""".toByteArray()) }
        assertNull(state.reload(project["id"]!!.jsonPrimitive.content))
        assertEquals(com.scantomake.counterpart.api.MacLink.Connected, state.link.value)
        assertNull(state.error.value)
    }

    /** Review of #527 part 4, S1: the production words read the computer's capabilities. On one that doesn't keep a
     *  project's status, a finished print leads with Print and asks nothing; on one that does, It Works leads. */
    @Test fun aFinishedPrintAsksDidItFitOnlyWhenTheComputerKeepsTheAnswer() {
        val rows = com.scantomake.counterpart.core.WireJson.parseToJsonElement(kitFixture("main-actions.json").readText()).jsonObject["rows"]!!.jsonArray
        val row = rows.first { it.jsonObject["name"]!!.jsonPrimitive.content == "printed-older-mac" }.jsonObject
        val printed = com.scantomake.counterpart.api.Project.decode(row["project"]!!.jsonObject)!!
        state.capabilities.value = emptySet()
        val older = state.words(printed)
        assertTrue("an older computer: Print leads", older.page.printIsMain)
        assertTrue(com.scantomake.counterpart.api.ProjectAction.ItWorks !in older.actions)
        state.capabilities.value = setOf("projectSettings")
        val keeps = state.words(printed)
        assertTrue("a computer that keeps the answer asks Did it fit?", com.scantomake.counterpart.api.ProjectAction.ItWorks in keeps.actions)
    }
}
