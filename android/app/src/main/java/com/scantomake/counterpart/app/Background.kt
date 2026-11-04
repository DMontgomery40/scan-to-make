package com.scantomake.counterpart.app

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.scantomake.counterpart.MainActivity
import com.scantomake.counterpart.R
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.ProjectWords
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/** Reads events the phone hasn't seen and posts them. Shared by the periodic worker and the watch service. */
object EventCheck {
    /** One pass over the log; returns false when the Mac couldn't be asked. `wait` > 0 makes it a long poll. */
    suspend fun once(context: Context, wait: Int = 0): Boolean {
        val app = Counterpart.instance
        if (app.state.needsMac) return true
        val cursor = Notifications.cursor(context)
        return try {
            if (cursor == null) {
                // First run: start from now, never from history.
                val page = app.companion.events(0, 0, 0)
                Notifications.setCursor(context, page.next)
                return true
            }
            var after: Int = cursor
            var first = true
            while (true) {
                val page = app.companion.events(after, if (first) wait else 0, 100)
                first = false
                for (event in page.events) Notifications.post(context, event)
                Notifications.setCursor(context, page.next)
                if (page.events.size < 100 || page.next <= after) break
                after = page.next
            }
            true
        } catch (e: CompanionException) { false } catch (e: Exception) { false }
    }
}

/** Every 15 minutes (Android's shortest period) while on a network: the background fallback for notifications. */
class EventCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result { EventCheck.once(applicationContext); return Result.success() }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<EventCheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("counterpart-events", ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}

/**
 * While a print or a design runs and the app is in the background: a foreground service that long-polls the Mac,
 * so "halfway", "done" and "paused" arrive within seconds (the iPhone's Live Activity and pushes do this job).
 * Its own notification shows the running project's line. It stops when nothing runs, or after 6 hours.
 */
class WatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopSelf(); return START_NOT_STICKY }
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        try { ServiceCompat.startForeground(this, 7, ongoing("Following your computer"), type) } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
        if (job == null) job = scope.launch { watch() }
        return START_NOT_STICKY
    }

    private suspend fun watch() {
        val state = Counterpart.instance.state
        val started = System.currentTimeMillis()
        while (System.currentTimeMillis() - started < 6 * 3600_000L) {
            val ok = EventCheck.once(this, wait = 25)
            state.load()
            val running = state.projects.value.firstOrNull { state.words(it).busy }
            if (running == null && state.sending.value.isEmpty()) break
            running?.let { updateOngoing(state.words(it)) }
            if (!ok) delay(15_000)
        }
        stopSelf()
    }

    private fun updateOngoing(words: ProjectWords) {
        val manager = getSystemService(android.app.NotificationManager::class.java)
        try { manager.notify(7, ongoing(words.title, words.line)) } catch (_: SecurityException) {}
    }

    private fun ongoing(title: String, text: String? = null): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, Notifications.WATCHING)
            .setSmallIcon(R.drawable.ic_notification).setColor(0xFFFF732E.toInt())
            .setContentTitle(title).setContentText(text ?: "You'll get a notification when it changes.")
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open).build()
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    companion object {
        private const val STOP = "stop"
        fun start(context: Context) {
            try { androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, WatchService::class.java)) } catch (_: Exception) {}
        }
        fun stop(context: Context) {
            try { context.startService(Intent(context, WatchService::class.java).setAction(STOP)) } catch (_: Exception) {}
        }
    }
}
