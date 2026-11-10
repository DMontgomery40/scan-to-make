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
}
