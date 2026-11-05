package com.scantomake.counterpart

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.hasText
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.core.WireJson
import com.scantomake.counterpart.pairing.MemoryStore
import com.scantomake.counterpart.pairing.PairingClient
import com.scantomake.counterpart.pairing.PairingStore
import com.scantomake.counterpart.ui.HomeScreen
import com.scantomake.counterpart.ui.SettingsScreen
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.jsonObject
import org.junit.After
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
    /** The screens find AppState through the application context, as in the app. */
    private lateinit var context: Context

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
        Counterpart.instance = app
        context = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun getApplicationContext(): Context = app
        }
    }

    @After fun cleanup() { state.scope.cancel() }

    private fun project(id: String, title: String, status: String) = requireNotNull(Project.decode(WireJson.parseToJsonElement(
        """{"id":"$id","title":"$title","instructions":"A useful part","state":"$status","createdAtMs":1,"updatedAtMs":2}"""
    ).jsonObject))

    private fun home() = compose.setContent {
        CompositionLocalProvider(LocalContext provides context) { HomeScreen(open = { _, _ -> }, newProject = {}, printers = {}, settings = {}) }
    }

    @Test fun theStartersStayOnHomeWhileProjectsExist() {
        state.projects.value = listOf(project("a", "Stove gap filler", "ready"), project("b", "Cable clip", "printed"),
            project("c", "Guitar pick", "confirmed"))
        state.loaded.value = true
        home()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("3D scan platform")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Start with something useful").assertExists()
        compose.onNodeWithText("Long vernier caliper").assertExists()
        compose.onNodeWithText("Stove gap filler").assertExists()
    }

    @Test fun theStartersAreOnTheEmptyHomeToo() {
        state.loaded.value = true
        home()
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("3D scan platform")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Long vernier caliper").assertExists()
    }

    /** Settings has Help and Printers, as on iPhone, Mac and Linux; the print sheet sends people to Settings → Printers. */
    @Test fun settingsReachesPrintersAndHelp() {
        var printers = 0
        compose.setContent {
            CompositionLocalProvider(LocalContext provides context) { SettingsScreen(back = {}, pairAgain = {}, openPrinters = { printers++ }) }
        }
        compose.onNodeWithText("Open the Guide").assertExists()
        compose.onNodeWithText("Print the Scan Rig by Kass 3D").assertExists()
        compose.onNodeWithText("Printers and Their MCPs").performClick()
        compose.runOnIdle { org.junit.Assert.assertEquals(1, printers) }
    }
}
