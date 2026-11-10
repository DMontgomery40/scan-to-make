import Foundation

/// The one action a project's page leads with. Every state has exactly one, or none while Counterpart itself is the
/// one working. Named apart from `ProjectAction` because a page's lead can be something the action list never held
/// (answering with the size card, opening the Printing screen).
public enum MainAction: String, Codable, Equatable, Sendable {
    case scan, finishSending, confirmSizes, openCamera, chooseFile, review, print, openPrinting, itWorks, retry
}

/// What a project's page offers, as one decision (PRD §5.4 "One main action"; board U17).
///
/// Before this, `ProjectWords.actions` was a list and "main" was whatever each view filled in: every state card
/// filled its own first button and the bottom bar filled Print whenever the list held a print action, so a failed
/// pass on a project that already had a result showed Try Again, Print Again and a floating Print at once (seen with
/// real projects, Nov 10). Now the page reads this and decides nothing itself:
/// - one filled control, `main`: in the state's card when the state has a card, otherwise in the bottom bar;
/// - an action appears once on the page;
/// - the bar keeps Ask for changes whenever changes can be asked, and shows Print only where `printPlace` is `.bar`,
///   filled only when Print is `main`.
public struct PageActions: Equatable, Sendable {
    public enum PrintPlace: String, Codable, Equatable, Sendable { case bar, card }

    public let main: MainAction?
    /// Everything else the page may offer, in order. Never holds the action `main` stands for.
    public let others: [ProjectAction]
    /// What printing is called here, when it is offered at all: "Print", "Print Another", "Print Again" (this file
    /// was sent to the printer before) or "Print the last version" (a later pass stopped; this is the one before it).
    public let printWords: String?
    public let printPlace: PrintPlace?
    /// Said beside a card's print button, so the person knows what would be printed: the version before the pass
    /// that stopped, or the same file that was sent before.
    public let printNote: String?

    /// Print is offered in the bottom bar, filled or not.
    public var printInBar: Bool { printPlace == .bar }
    public var printIsMain: Bool { main == .print }

    public init(_ project: Project, phase: ProjectPhase, actions: [ProjectAction], sending: Bool = false, localScan: Bool = false) {
        let prints = actions.filter { $0 == .print || $0 == .printChecked }
        let rest = { (dropped: [ProjectAction]) in actions.filter { !dropped.contains($0) } }
        func printing(_ main: MainAction?, _ others: [ProjectAction], _ words: String, _ place: PrintPlace) -> (MainAction?, [ProjectAction], String?, PrintPlace?) {
            prints.isEmpty ? (main == .print ? nil : main, others.filter { !prints.contains($0) }, nil, nil) : (main, others, words, place)
        }
        let decided: (MainAction?, [ProjectAction], String?, PrintPlace?)
        // Marked Works: Done, whatever state it was marked in.
        if phase == .confirmed {
            decided = printing(.print, rest(prints), "Print Another", .bar)
        } else {
            switch project.state {
            case .new:
                if sending { decided = (nil, [], nil, nil) }
                else if actions.contains(.finishSending) { decided = (.finishSending, rest([.finishSending]), nil, nil) }
                else { decided = (.scan, rest([.scan]), nil, nil) }
            case .touchingUp:
                // No Print while a change is being made: the version shown is the one they asked to change.
                decided = (nil, [], nil, nil)
            case .needsCloseup:
                let ask = project.openAsk
                if ask?.answerable == false { decided = (nil, [], nil, nil) }
                else if let ask, AskSizesForm(ask) != nil { decided = (.confirmSizes, [.openCamera], nil, nil) }
                else if ask?.type == "file" { decided = (.chooseFile, [], nil, nil) }
                // A choice is one of several equal options: none of them leads.
                else if ask?.type == "choice" { decided = (nil, [], nil, nil) }
                else { decided = (.openCamera, rest([.openCamera]), nil, nil) }
            case .ready:
                decided = printing(.print, rest(prints), "Print", .bar)
            case .printing:
                // The printer's own question first; otherwise the Printing screen is where this project is.
                decided = (project.printConfirmation != nil ? .review : .openPrinting, [], nil, nil)
            case .printed:
                if actions.contains(.itWorks) {
                    // "Did it fit?": It Works leads, Needs Changes beside it; printing another stays in the bar, plain.
                    decided = printing(.itWorks, rest([.itWorks]), "Print Another", .bar)
                } else if phase == .printed {
                    decided = printing(.print, rest(prints), "Print Another", .bar)
                } else {
                    // Accepted by the printer but never seen to finish: the same as Sent.
                    decided = printing(.print, rest(prints), "Print", .bar)
                }
            case .sent:
                decided = printing(.print, rest(prints), "Print", .bar)
            case .confirmed:
                decided = printing(.print, rest(prints), "Print Another", .bar)
            case .failed:
                if actions.contains(.retry) {
                    // A pass stopped. With an earlier result, that result can still be printed: said as what it is,
                    // once, in the card; never "Print Again" (nothing says it was printed) and never in the bar too.
                    decided = printing(.retry, rest([.retry]), "Print the last version", .card)
                } else if project.print?.dispatchedAt != nil {
                    // The print failed and the model is fine: the same file goes again.
                    decided = printing(.print, rest(prints), "Print Again", .card)
                } else if project.print != nil {
                    // Refused before anything was sent: it has not been printed, so it is not "again".
                    decided = printing(.print, rest(prints), "Print", .card)
                } else {
                    // A pass failed and can't be picked up again; the result from before it is what there is.
                    decided = printing(.print, rest(prints), "Print the last version", .card)
                }
            case .unknown:
                decided = (nil, [], nil, nil)
            }
        }
        (main, others, printWords, printPlace) = decided
        switch decided.2 {
        case "Print the last version": printNote = "Your last version is still here."
        case "Print Again": printNote = "The same file is sent to the printer again."
        default: printNote = nil
        }
    }
}
