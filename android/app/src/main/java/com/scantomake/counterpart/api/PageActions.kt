package com.scantomake.counterpart.api

/** The one action a project's page leads with, or none while Counterpart itself is the one working. Apart from
 *  `ProjectAction` because a page's lead can be something the action list never held (answering with the size card,
 *  opening the Printing screen). Port of CounterpartKit `MainAction`. */
enum class MainAction { Scan, FinishSending, ConfirmSizes, OpenCamera, ChooseFile, Review, Print, OpenPrinting, ItWorks, Retry }

/**
 * What a project's page offers, as one decision (PRD §5.4 "One main action"; board U17). Port of CounterpartKit
 * `PageActions`; the table every client is held to is `Fixtures/main-actions.json`.
 *
 * Before this each button picked its own fill, so a finished print showed It Works and Print both filled, and a
 * stopped pass with an earlier result showed a filled Print above Try Again. The page now reads this and decides
 * nothing itself: one filled control, `main`; an action appears once; Print filled only when it is `main`.
 */
class PageActions(project: Project, phase: ProjectPhase, actions: List<ProjectAction>, sending: Boolean = false) {
    enum class PrintPlace { Bar, Card }

    val main: MainAction?
    /** Everything else the page may offer, in order. Never holds the action `main` stands for. */
    val others: List<ProjectAction>
    /** What printing is called here, when it is offered at all: "Print", "Print Another", "Print Again" (this file was
     *  sent to the printer before) or "Print the last version" (a later pass stopped; this is the one before it). */
    val printWords: String?
    val printPlace: PrintPlace?
    /** Said beside a card's print button, so the person knows what would be printed. */
    val printNote: String?

    val printIsMain: Boolean get() = main == MainAction.Print

    private data class Decided(val main: MainAction?, val others: List<ProjectAction>, val words: String? = null, val place: PrintPlace? = null)

    init {
        val prints = actions.filter { it == ProjectAction.Print || it == ProjectAction.PrintChecked }
        fun rest(vararg dropped: ProjectAction) = actions.filter { it !in dropped }
        fun restOfPrints() = actions.filter { it !in prints }
        // With no print action on offer, nothing about printing is said and Print cannot lead.
        fun printing(main: MainAction?, others: List<ProjectAction>, words: String, place: PrintPlace) =
            if (prints.isEmpty()) Decided(if (main == MainAction.Print) null else main, others.filter { it !in prints })
            else Decided(main, others, words, place)
        val none = Decided(null, emptyList())
        val decided = if (phase == ProjectPhase.Confirmed) printing(MainAction.Print, restOfPrints(), "Print Another", PrintPlace.Bar)
        else when (project.state) {
            Project.State.New -> when {
                sending -> none
                ProjectAction.FinishSending in actions -> Decided(MainAction.FinishSending, rest(ProjectAction.FinishSending))
                else -> Decided(MainAction.Scan, rest(ProjectAction.Scan))
            }
            // No Print while a change is being made: the version shown is the one they asked to change.
            Project.State.TouchingUp -> none
            Project.State.NeedsCloseup -> {
                val ask = project.openAsk
                when {
                    ask != null && !AskSizesForm.answerable(ask.kind) -> none
                    ask != null && AskSizesForm.of(ask) != null -> Decided(MainAction.ConfirmSizes, listOf(ProjectAction.OpenCamera))
                    ask?.type == "file" -> Decided(MainAction.ChooseFile, emptyList())
                    // A choice is one of several equal options: none of them leads.
                    ask?.type == "choice" -> none
                    else -> Decided(MainAction.OpenCamera, rest(ProjectAction.OpenCamera))
                }
            }
            Project.State.Ready, Project.State.Sent -> printing(MainAction.Print, restOfPrints(), "Print", PrintPlace.Bar)
            // The printer's own question first; otherwise the Printing screen is where this project is.
            Project.State.Printing -> Decided(if (project.printConfirmation != null) MainAction.Review else MainAction.OpenPrinting, emptyList())
            Project.State.Printed -> when {
                // "Did it fit?": It Works leads, Needs Changes beside it; printing another stays plain.
                ProjectAction.ItWorks in actions -> printing(MainAction.ItWorks, rest(ProjectAction.ItWorks), "Print Another", PrintPlace.Bar)
                phase == ProjectPhase.Printed -> printing(MainAction.Print, restOfPrints(), "Print Another", PrintPlace.Bar)
                // Accepted by the printer but never seen to finish: the same as Sent.
                else -> printing(MainAction.Print, restOfPrints(), "Print", PrintPlace.Bar)
            }
            Project.State.Confirmed -> printing(MainAction.Print, restOfPrints(), "Print Another", PrintPlace.Bar)
            Project.State.Failed -> when {
                // A pass stopped. An earlier result can still be printed: said as what it is, once, in the card; never
                // "Print Again" (nothing says it was printed).
                ProjectAction.Retry in actions -> printing(MainAction.Retry, rest(ProjectAction.Retry), "Print the last version", PrintPlace.Card)
                // The print failed and the model is fine: the same file goes again.
                project.print?.dispatchedAt != null -> printing(MainAction.Print, restOfPrints(), "Print Again", PrintPlace.Card)
                // Refused before anything was sent: it has not been printed, so it is not "again".
                project.print != null -> printing(MainAction.Print, restOfPrints(), "Print", PrintPlace.Card)
                // A pass failed and can't be picked up again. Nothing leads: a filled "Print the last version" would
                // steer the person to print the very version they asked to change. It is offered plain.
                else -> printing(null, actions, "Print the last version", PrintPlace.Card)
            }
            Project.State.Unknown -> none
        }
        main = decided.main; others = decided.others; printWords = decided.words; printPlace = decided.place
        printNote = when (printWords) {
            "Print the last version" -> "Your last version is still here."
            "Print Again" -> "The same file is sent to the printer again."
            else -> null
        }
    }
}
