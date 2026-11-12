package com.scantomake.counterpart.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import com.scantomake.counterpart.R
import com.scantomake.counterpart.api.CompanionClient
import com.scantomake.counterpart.api.CompanionException
import com.scantomake.counterpart.api.Project
import com.scantomake.counterpart.api.ProjectStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The buttons on Counterpart's notifications (PRD §9.1), as the iPhone has them (CounterpartKit `NotificationActions`):
 * one set per moment, chosen from the event type, so a cancelled print never offers It Works and a failure never offers
 * Resume. Background buttons make the same companion call as the app's own buttons. Android reaches the Mac over the
 * LAN only (no CloudKit, PRD §16), so away from home a button says the Mac didn't answer.
 */
object NotificationActions {
    enum class Action(val id: String, val title: String, val background: Boolean) {
        Print("PRINT", "Print", false), AskForChanges("ASK_FOR_CHANGES", "Ask for Changes…", true),
        Camera("CAMERA", "Take a Photo", false), BestGuess("BEST_GUESS", "Best Guess", true),
        OpenProject("OPEN", "Open Project", false), OpenPrint("OPEN_PRINT", "Open Print", false),
        Pause("PAUSE", "Pause", true), Resume("RESUME", "Resume", true),
        ItWorks("IT_WORKS", "It Works", true), NeedsChanges("NEEDS_CHANGES", "Needs Changes…", true),
        TryAgain("TRY_AGAIN", "Try Again", false);
        val takesWords get() = this == AskForChanges || this == NeedsChanges
        companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } }
    }

    const val AFTER_PRINTING = "After printing: "
    const val EXTRA_ACTION = "counterpart.action"
    const val EXTRA_TYPE = "counterpart.type"
    const val EXTRA_TITLE = "counterpart.title"
    const val EXTRA_TAG = "counterpart.tag"
    const val REPLY = "counterpart.reply"
    const val INTENT = "com.scantomake.counterpart.NOTIFICATION_ACTION"

    /** The buttons for an event type, in the order they show. */
    fun actions(type: String): List<Action> = when (type) {
        "pass.ready" -> listOf(Action.Print, Action.AskForChanges)
        "pass.ask" -> listOf(Action.Camera, Action.BestGuess)
        "print.confirm" -> listOf(Action.OpenProject)
        "print.started", "print.first-layer", "print.milestone" -> listOf(Action.OpenPrint, Action.Pause)
        // #630: the camera shows nothing coming out of the nozzle. The person looks, and pauses if they want to: never automatic.
        "print.check" -> listOf(Action.OpenPrint, Action.Pause)
        "print.paused" -> listOf(Action.OpenPrint, Action.Resume)
        "print.done" -> listOf(Action.ItWorks, Action.NeedsChanges, Action.OpenProject)
        "print.failed", "print.not-started", "pass.failed" -> listOf(Action.TryAgain, Action.OpenProject)
        "print.cancelled", "print.sent", "print.unreachable" -> listOf(Action.OpenProject)
        else -> emptyList()
    }

    /** Where a tap (or an opening button) goes: "printing", "print" or the project (null). Try Again never prints by itself. */
    fun screen(action: Action?, type: String): String? = when (action) {
        Action.Print -> "print"
        Action.TryAgain -> if (type.startsWith("print.")) "print" else null
        Action.OpenPrint -> "printing"
        Action.OpenProject, Action.Camera -> null
        else -> if (type.startsWith("print.") && type !in ENDED) "printing" else null
    }
    private val ENDED = setOf("print.done", "print.failed", "print.cancelled", "print.not-started", "print.sent")

    sealed class Command(val projectId: String) {
        class Status(id: String, val status: ProjectStatus) : Command(id)
        class NeedsChanges(id: String, val note: String?) : Command(id)
        class Correct(id: String, val note: String) : Command(id)
        class BestGuess(id: String) : Command(id)
        class Control(id: String, val action: CompanionClient.PrintControl) : Command(id)

        suspend fun run(client: CompanionClient): Project? = when (this) {
            is Status -> client.setStatus(projectId, status)
            is NeedsChanges -> client.setStatus(projectId, ProjectStatus.NeedsChanges).let { marked -> note?.let { client.correct(projectId, it) } ?: marked }
            is Correct -> client.correct(projectId, note)
            is BestGuess -> client.answerAsk(projectId, bestGuess = true)
            is Control -> client.control(projectId, action)
        }

        val failedWords: String get() = when (this) {
            is Status -> if (status == ProjectStatus.Works) "Couldn't mark it as working" else "Couldn't send your changes"
            is NeedsChanges, is Correct -> "Couldn't send your changes"
            is BestGuess -> "Couldn't send Best Guess"
            is Control -> when (action) {
                CompanionClient.PrintControl.Pause -> "Couldn't pause the print"
                CompanionClient.PrintControl.Resume -> "Couldn't resume the print"
                CompanionClient.PrintControl.Cancel -> "Couldn't stop the print"
            }
        }
    }

    /** The request for a background button on a notification of this type, or null when it doesn't belong to that moment. */
    fun command(action: String?, type: String, projectId: String?, text: String? = null): Command? {
        val a = Action.of(action) ?: return null
        if (!a.background || projectId.isNullOrEmpty()) return null
        val words = text?.trim()?.takeIf { it.isNotEmpty() }
        return when {
            a == Action.ItWorks && type == "print.done" -> Command.Status(projectId, ProjectStatus.Works)
            a == Action.NeedsChanges && type == "print.done" -> Command.NeedsChanges(projectId, words?.let { AFTER_PRINTING + it })
            a == Action.AskForChanges && type == "pass.ready" -> words?.let { Command.Correct(projectId, it) }
            a == Action.BestGuess && type == "pass.ask" -> Command.BestGuess(projectId)
            a == Action.Pause && type in setOf("print.started", "print.first-layer", "print.milestone", "print.check") -> Command.Control(projectId, CompanionClient.PrintControl.Pause)
            a == Action.Resume && type == "print.paused" -> Command.Control(projectId, CompanionClient.PrintControl.Resume)
            else -> null
        }
    }

    /**
     * Runs a background button from its intent. On success the notification goes (a reply that stays would keep
     * spinning); on failure it says what didn't happen. Returns the failure words, or null.
     */
    suspend fun handle(context: Context, intent: Intent): String? {
        val type = intent.getStringExtra(EXTRA_TYPE) ?: return null
        val projectId = intent.getStringExtra(Notifications.EXTRA_PROJECT)
        val tag = intent.getStringExtra(EXTRA_TAG) ?: projectId ?: return null
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REPLY)?.toString()
        val command = command(intent.getStringExtra(EXTRA_ACTION), type, projectId, text) ?: return null
        val app = Counterpart.instance
        val failure = try {
            command.run(app.companion)?.let { app.state.show(it) }
            null
        } catch (e: CompanionException) {
            if (e.needsPairing) "Open Counterpart to connect to your computer again." else e.message
        } catch (e: Exception) { CompanionException.unreachable.message }
        val manager = NotificationManagerCompat.from(context)
        if (failure == null) { manager.cancel(tag, 1); return null }
        val notice = NotificationCompat.Builder(context, Notifications.PROBLEMS)
            .setSmallIcon(R.drawable.ic_notification).setColor(0xFFFF732E.toInt())
            .setContentTitle("${command.failedWords}: ${intent.getStringExtra(EXTRA_TITLE) ?: ""}".trimEnd(' ', ':'))
            .setContentText(failure)
            .setAutoCancel(true)
            .setContentIntent(Notifications.openIntent(context, projectId, null, tag.hashCode()))
        try { manager.notify(tag, 1, notice.build()) } catch (_: SecurityException) {}
        return failure
    }
}

/** Background notification buttons: It Works, Needs Changes…, Ask for Changes…, Best Guess, Pause, Resume. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try { NotificationActions.handle(context.applicationContext, intent) } finally { pending.finish() }
        }
    }
}
