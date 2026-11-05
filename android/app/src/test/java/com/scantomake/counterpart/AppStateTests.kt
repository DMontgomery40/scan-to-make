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
}
