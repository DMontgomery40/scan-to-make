package com.scantomake.counterpart

import android.app.Application
import android.content.Context
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.OnDeviceLibrary
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.LibraryFill
import com.scantomake.counterpart.net.HttpReply
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.io.File
import java.nio.file.Files

/** The library's background fill (`LibraryFill`): the review of #741's items, as on iOS (`AppTests`). */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
class LibraryFillTests {
    private lateinit var app: Counterpart
    private lateinit var transport: FakeTransport
    private lateinit var base: File
    private lateinit var library: OnDeviceLibrary
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Before fun setup() {
        app = Counterpart()
        ReflectionHelpers.callInstanceMethod<Void>(app, "attach", ClassParameter.from(Context::class.java, RuntimeEnvironment.getApplication()))
        app.pairingStore = PairingStore(MemoryStore())
        app.pairingStore.save(v2Record(expiresAt = System.currentTimeMillis() + 30.0 * 86_400_000), notify = false)
        transport = FakeTransport { _, _ -> HttpReply(200, "file".toByteArray()) }
        app.pairing = PairingClient(app.pairingStore, transport)
        base = Files.createTempDirectory("fill").toFile()
        library = OnDeviceLibrary(File(base, "library")).apply { use("m") }
        app.companion = CompanionClient(app.pairing, transport, null, null, File(base, "cache"), library)
    }

    @After fun cleanup() { scope.cancel(); base.deleteRecursively() }

    private fun project(id: String = "d79d4c15-d786-461c-b76e-ec687c8e2dad") = Project.decode(Json.parseToJsonElement(
        """{"id":"$id","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[{"startedAtMs":1,"endedAtMs":1000,"status":"done"}],"current":{"model":"current/model.stl","renders":[]},"picture":"pictures/part-0123456789abcdef.png"}""").jsonObject)!!

    private fun waitFor(condition: () -> Boolean): Boolean {
        repeat(100) { if (condition()) return true; Thread.sleep(50) }
        return condition()
    }

    /** P1: the computer's empty list is the truth (every project deleted): every kept file goes. A saved one never prunes. */
    @Test fun anEmptyListFromTheComputerPrunesAndASavedOneDoesNot() {
        val fill = LibraryFill(app, scope)
        library.commit("png".toByteArray(), "gone", "pictures/a.png", 1, "a.png")
        fill.fill(emptyList(), fromComputer = false)
        Thread.sleep(300)
        assertNotNull("a saved empty list prunes nothing", library.latest("gone", "pictures/a.png"))
        fill.fill(emptyList(), fromComputer = true)
        assertTrue("the computer's empty list: the deleted project's files go", waitFor { library.latest("gone", "pictures/a.png") == null })
    }

    /** P2: on a metered link a queued model is not started; its picture still comes. */
    @Test fun aModelWaitsOnAMeteredLinkAndThePictureComes() {
        val fill = LibraryFill(app, scope)
        // Unmetered when the fill plans (the first call), metered when each queued file's turn comes: the check runs again
        // before each start.
        var calls = 0
        fill.meteredNow = { synchronized(this) { calls++ > 0 } }
        fill.fill(listOf(project()), fromComputer = true)
        // The fill runs on IO: wait for its picture to be asked for and the queue to empty (not just an empty start).
        assertTrue("the picture is asked for: ${transport.paths}", waitFor { transport.paths.any { it.contains("/pictures/") } && fill.pending.isEmpty() })
        assertFalse("no model on a metered link: ${transport.paths}", transport.paths.any { it.endsWith("/model.stl") })
        assertTrue("pictures come on any link: ${transport.paths}", transport.paths.any { it.contains("/pictures/") })
    }

    /** P2: Clear releases what was queued, so the next list queues those files again. */
    @Test fun clearReleasesWhatWasQueued() {
        val fill = LibraryFill(app, scope)
        fill.meteredNow = { false }
        fill.fill(listOf(project()), fromComputer = true)
        fill.clear()
        assertTrue("Clear leaves no queued key behind: ${fill.pending}", waitFor { fill.pending.isEmpty() })
        Thread.sleep(300)
        assertTrue("nothing queued before Clear starts after it: ${transport.paths}", transport.paths.none { it.contains("/v1/objects/") })
        assertNull(library.latest("d79d4c15-d786-461c-b76e-ec687c8e2dad", "model.stl"))
    }
}
