package com.scantomake.counterpart

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.scantomake.counterpart.api.PublishedModelLink
import com.scantomake.counterpart.app.AppState
import com.scantomake.counterpart.app.Counterpart
import com.scantomake.counterpart.app.Notifications
import com.scantomake.counterpart.app.WatchService
import com.scantomake.counterpart.pairing.PairingLink
import com.scantomake.counterpart.scan.ScanScreen
import com.scantomake.counterpart.ui.CounterpartTheme
import com.scantomake.counterpart.ui.FindYourMacScreen
import com.scantomake.counterpart.ui.HomeScreen
import com.scantomake.counterpart.ui.NewProjectScreen
import com.scantomake.counterpart.ui.NotifyPermissionScreen
import com.scantomake.counterpart.ui.PrintSheetScreen
import com.scantomake.counterpart.ui.PrintersScreen
import com.scantomake.counterpart.ui.PrintingScreen
import com.scantomake.counterpart.ui.ProjectScreen
import com.scantomake.counterpart.ui.SettingsScreen
import com.scantomake.counterpart.ui.WelcomeScreen

class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PROJECT = "projectId"
        const val WELCOMED = "CounterpartWelcomed"
        const val ASKED_NOTIFICATIONS = "CounterpartAskedNotifications"
        /** A link shared into the app (a MakerWorld page), waiting for the New screen. */
        var sharedText: String? = null
    }

    private val state: AppState get() = AppState.of(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent { CounterpartTheme { Root() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(EXTRA_PROJECT)?.let { state.route.value = it }
        val data = intent.dataString
        if (intent.action == Intent.ACTION_VIEW && data != null && PairingLink.isPairingLink(data)) state.pendingLink.value = data
        if (intent.action == Intent.ACTION_SEND) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
            if (PairingLink.isPairingLink(text.trim())) state.pendingLink.value = text.trim()
            else if (PublishedModelLink.find(text) != null) { sharedText = text; state.route.value = "new" }
        }
    }

    override fun onResume() {
        super.onResume()
        WatchService.stop(this)
        state.startFollowing()
    }

    override fun onPause() {
        super.onPause()
        // Leaving while a print or a design runs: keep following it, so notifications arrive in seconds.
        if (!isChangingConfigurations && !state.needsMac && state.anyRunning && Notifications.allowed(this)) WatchService.start(this)
        state.stopFollowing()
    }

    @Composable
    private fun Root() {
        val prefs = Counterpart.instance.prefs
        val status by state.status.collectAsState()
        val pendingLink by state.pendingLink.collectAsState()
        var welcomed by remember { mutableStateOf(prefs.getBoolean(WELCOMED, false)) }
        var asked by remember { mutableStateOf(prefs.getBoolean(ASKED_NOTIFICATIONS, false)) }
        var justPaired by remember { mutableStateOf(false) }
        val paired = status?.state == com.scantomake.counterpart.pairing.PairingStatus.State.Paired

        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when {
                status == null -> {}
                !paired && !welcomed -> WelcomeScreen { prefs.edit().putBoolean(WELCOMED, true).apply(); welcomed = true }
                !paired -> FindYourMacScreen(onPaired = { justPaired = true; state.startFollowing() })
                justPaired && !asked && !Notifications.allowed(this@MainActivity) -> NotifyPermissionScreen {
                    prefs.edit().putBoolean(ASKED_NOTIFICATIONS, true).apply(); asked = true
                }
                else -> Main()
            }
        }
    }

    @Composable
    private fun Main() {
        val nav = rememberNavController()
        val route by state.route.collectAsState()
        val pendingLink by state.pendingLink.collectAsState()
        LaunchedEffect(route) {
            val r = route ?: return@LaunchedEffect
            state.route.value = null
            if (r == "new") nav.navigate("new") else nav.navigate("project/$r")
        }
        LaunchedEffect(pendingLink) { if (pendingLink != null) nav.navigate("pair") }
        NavHost(nav, startDestination = "home") {
            composable("home") {
                HomeScreen(
                    open = { id, printing -> nav.navigate(if (printing) "printing/$id" else "project/$id") },
                    newProject = { job -> nav.navigate(if (job != null) "new?job=$job" else "new") },
                    printers = { nav.navigate("printers") },
                    settings = { nav.navigate("settings") },
                )
            }
            composable("new?job={job}", arguments = listOf(navArgument("job") { type = NavType.StringType; nullable = true; defaultValue = null })) { entry ->
                NewProjectScreen(job = entry.arguments?.getString("job"), close = { nav.popBackStack() },
                    started = { id -> nav.popBackStack(); nav.navigate("project/$id") },
                    scan = { id -> nav.navigate("scan/$id") })
            }
            composable("project/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ProjectScreen(id, back = { nav.popBackStack() }, print = { nav.navigate("print/$id") }, printing = { nav.navigate("printing/$id") },
                    scan = { nav.navigate("scan/$id") })
            }
            composable("print/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                PrintSheetScreen(id, close = { nav.popBackStack() }, printing = { nav.popBackStack(); nav.navigate("printing/$id") })
            }
            composable("printing/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                PrintingScreen(id, back = { nav.popBackStack() }, project = { nav.navigate("project/$id") })
            }
            composable("scan/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ScanScreen(id, done = { nav.popBackStack() })
            }
            composable("printers") { PrintersScreen(back = { nav.popBackStack() }) }
            composable("settings") { SettingsScreen(back = { nav.popBackStack() }, pairAgain = { nav.navigate("pair") }, openPrinters = { nav.navigate("printers") }) }
            composable("pair") { FindYourMacScreen(replace = true, onPaired = { nav.popBackStack(); state.startFollowing() }, cancel = { state.pendingLink.value = null; nav.popBackStack() }) }
        }
    }
}
