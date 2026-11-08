package com.scantomake.counterpart.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.scantomake.counterpart.MainActivity
import com.scantomake.counterpart.R
import com.scantomake.counterpart.api.CounterpartEvent

/**
 * Notifications from the Mac's event log. The iPhone app gets these through CloudKit pushes that the Mac writes;
 * Android has no CloudKit, so the phone reads `GET /v1/events` itself (EventCheckWorker, WatchService) and shows
 * the companion's own words. Levels follow events.md: none (never shown), passive, active, timeSensitive.
 */
object Notifications {
    const val READY = "ready"
    const val NEEDS_YOU = "needs-you"
    const val PRINT = "print"
    const val PROBLEMS = "problems"
    const val WATCHING = "watching"
    const val EXTRA_PROJECT = MainActivity.EXTRA_PROJECT
    /** "printing" or "print": the screen a tap or an opening button goes to; none is the project. */
    const val EXTRA_SCREEN = "counterpart.screen"
    private const val CURSOR = "eventsCursor"
    private const val SEEN = "eventsSeen"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel(READY, "Ready to print", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Your computer finished a design or a scan" },
            NotificationChannel(NEEDS_YOU, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "It needs a photo or a yes from you" },
            NotificationChannel(PRINT, "Print progress", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "The print is halfway, done, or cancelled" },
            NotificationChannel(PROBLEMS, "Print problems", NotificationManager.IMPORTANCE_HIGH).apply { description = "The printer paused, stopped or needs a yes" },
            NotificationChannel(WATCHING, "Following your computer", NotificationManager.IMPORTANCE_LOW).apply { description = "Shown while Counterpart follows a print or a design" },
        ))
    }

    fun allowed(context: Context): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** The newest event seq already handled, or null before the first read. */
    fun cursor(context: Context): Int? = Counterpart.instance.prefs.getInt(CURSOR, -1).takeIf { it >= 0 }

    fun setCursor(context: Context, seq: Int) {
        val prefs = Counterpart.instance.prefs
        if (seq > prefs.getInt(CURSOR, -1)) prefs.edit().putInt(CURSOR, seq).apply()
    }

    @Synchronized fun markSeen(context: Context, id: String, seq: Int) {
        val prefs = Counterpart.instance.prefs
        val seen = (prefs.getString(SEEN, "") ?: "").split(",").filter { it.isNotEmpty() }.takeLast(199) + id
        prefs.edit().putString(SEEN, seen.joinToString(",")).apply()
        setCursor(context, seq)
    }

    @Synchronized fun wasSeen(id: String): Boolean = (Counterpart.instance.prefs.getString(SEEN, "") ?: "").split(",").contains(id)

    private fun channel(event: CounterpartEvent): String = when {
        event.notify == "timeSensitive" -> PROBLEMS
        event.type == "pass.ask" -> NEEDS_YOU
        event.type.startsWith("pass.") -> READY
        else -> PRINT
    }

    /** Opens the app at a project, its Printing screen or its Print sheet. */
    fun openIntent(context: Context, projectId: String?, screen: String?, code: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            projectId?.let { putExtra(EXTRA_PROJECT, it) }
            screen?.let { putExtra(EXTRA_SCREEN, it) }
        }
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Shows one event, once (de-duplicated by its id), with the buttons for its moment (PRD §9.1). */
    fun post(context: Context, event: CounterpartEvent) {
        if (event.notify == "none" || wasSeen(event.id)) { markSeen(context, event.id, event.seq); return }
        markSeen(context, event.id, event.seq)
        if (!allowed(context)) return
        val tag = event.projectId ?: event.id
        val pending = openIntent(context, event.projectId, NotificationActions.screen(null, event.type), event.seq * 16)
        val builder = NotificationCompat.Builder(context, channel(event))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFFFF732E.toInt())
            .setContentTitle(event.title)
            .setContentText(event.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setPriority(if (event.notify == "timeSensitive") NotificationCompat.PRIORITY_HIGH else if (event.notify == "passive") NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_DEFAULT)
            .setOnlyAlertOnce(event.notify == "passive")
        if (event.projectId != null) NotificationActions.actions(event.type).forEachIndexed { index, action ->
            builder.addAction(action(context, event, tag, action, event.seq * 16 + index + 1))
        }
        try { NotificationManagerCompat.from(context).notify(tag, 1, builder.build()) } catch (_: SecurityException) {}
    }

    private fun action(context: Context, event: CounterpartEvent, tag: String, action: NotificationActions.Action, code: Int): NotificationCompat.Action {
        if (!action.background) {
            return NotificationCompat.Action.Builder(0, action.title, openIntent(context, event.projectId, NotificationActions.screen(action, event.type), code)).build()
        }
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            this.action = NotificationActions.INTENT
            putExtra(NotificationActions.EXTRA_ACTION, action.id)
            putExtra(NotificationActions.EXTRA_TYPE, event.type)
            putExtra(NotificationActions.EXTRA_TITLE, event.title)
            putExtra(NotificationActions.EXTRA_TAG, tag)
            putExtra(EXTRA_PROJECT, event.projectId)
        }
        // A reply needs a mutable intent so the system can add the words; the others stay immutable.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (action.takesWords && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
        val broadcast = PendingIntent.getBroadcast(context, code, intent, flags)
        val builder = NotificationCompat.Action.Builder(0, action.title, broadcast)
        if (action.takesWords) {
            builder.addRemoteInput(RemoteInput.Builder(NotificationActions.REPLY)
                .setLabel(if (action == NotificationActions.Action.NeedsChanges) "What didn't fit?" else "What should change?").build())
                .setAllowGeneratedReplies(false)
        }
        return builder.build()
    }
}
