import ActivityKit
import SwiftUI
import UIKit
import WidgetKit
import CounterpartKit

@main struct CounterpartWidgets: WidgetBundle {
    var body: some Widget { PrintActivityWidget() }
}

/// The print's Live Activity (PRD §9.4). It wears the same identity as the print notifications (§9.1): the
/// Counterpart mark in filament orange, the project's own picture, and the notifications' words ("38 min
/// left · layer 84 of 212 · P1S"), so a Lock Screen with both reads as one app.
///
/// Apple's HIG (Live Activities): "If you include a logo mark, display it without a container … Don't use the
/// entire app icon", and on the Lock Screen "Don't replicate notification layouts". So the mark, colour,
/// picture and wording are shared with the notification; the layout is the activity's own.
/// The Mac menu bar, Apple Watch Smart Stack and CarPlay draw the compact, minimal and expanded views below
/// unchanged, so the mark carries there too.
struct PrintActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PrintAttributes.self) { context in
            PrintActivityLockScreen(context: context)
                .widgetURL(PrintActivityLink.url(projectId: context.attributes.projectId, state: context.state))
        } dynamicIsland: { context in
            let artwork = PrintActivityThumbnails.shared()?.artwork(for: context.attributes.projectId) ?? .mark
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityArtwork(artwork: artwork, side: 52).padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ActivityPercent(state: context.state).font(.title2.weight(.semibold)).padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    ActivityTitle(title: context.attributes.title, showsMark: artwork != .mark).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        ActivityBar(state: context.state)
                        ActivityDetail(context: context, includesStatus: true).font(.footnote)
                    }
                }
            } compactLeading: {
                PrintActivityMark().frame(width: 20, height: 20)
            } compactTrailing: {
                CompactProgress(state: context.state)
            } minimal: {
                ProgressMark(state: context.state, side: 24)
            }
            .keylineTint(CounterpartBrand.orange)
            .widgetURL(PrintActivityLink.url(projectId: context.attributes.projectId, state: context.state))
        }
    }
}

// MARK: - Lock Screen

/// The Lock Screen (and StandBy, scaled up by the system): the picture, the mark beside the title, the
/// percent, a bar running on its own toward `endsAt`, and the notifications' detail line. The default
/// system background follows Light and Dark like the notifications around it.
struct PrintActivityLockScreen: View {
    let context: ActivityViewContext<PrintAttributes>

    var body: some View {
        let artwork = PrintActivityThumbnails.shared()?.artwork(for: context.attributes.projectId) ?? .mark
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                ActivityArtwork(artwork: artwork, side: 56)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        ActivityTitle(title: context.attributes.title, showsMark: artwork != .mark).font(.headline)
                        Spacer(minLength: 4)
                        ActivityPercent(state: context.state).font(.title3.weight(.semibold))
                    }
                    ActivityStatus(context: context).font(.subheadline.weight(.medium))
                    ActivityDetail(context: context, includesStatus: false).font(.footnote).foregroundStyle(.secondary)
                }
            }
            ActivityBar(state: context.state)
        }
        .padding(14)
    }
}

// MARK: - Pieces shared by every presentation

/// The Counterpart mark, in the brand orange, without a container (HIG). It joins the accent group when
/// the system tints the activity.
struct PrintActivityMark: View {
    var body: some View {
        CounterpartMark().fill(CounterpartBrand.orange).widgetAccentable()
            .accessibilityLabel("Counterpart")
    }
}

/// The project's picture, or the mark when there is none yet: never a generic printer.
struct ActivityArtwork: View {
    let artwork: PrintActivityArtwork
    let side: CGFloat

    var body: some View {
        switch artwork {
        case .thumbnail(let url):
            if let image = UIImage(contentsOfFile: url.path) {
                Image(uiImage: image).resizable().widgetAccentedRenderingMode(.accentedDesaturated)
                    .aspectRatio(contentMode: .fill)
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: side * 0.24, style: .continuous))
                    .accessibilityHidden(true)
            } else { mark }
        case .mark: mark
        }
    }

    private var mark: some View {
        PrintActivityMark().frame(width: side * 0.62, height: side * 0.62).frame(width: side, height: side)
    }
}

/// The title, led by a small mark when the picture slot shows the project instead of the mark.
struct ActivityTitle: View {
    let title: String
    let showsMark: Bool

    var body: some View {
        HStack(spacing: 6) {
            if showsMark { PrintActivityMark().frame(width: 14, height: 14) }
            Text(title).lineLimit(1)
        }
    }
}

struct ActivityPercent: View {
    let state: PrintAttributes.ContentState
    var body: some View {
        Text(state.progress / 100, format: .percent.precision(.fractionLength(0))).monospacedDigit()
    }
}

/// "Printing · 37:59 left": the state in the notifications' words, and the time left counting down on its
/// own between updates (PRD §8.8).
struct ActivityStatus: View {
    let context: ActivityViewContext<PrintAttributes>

    var body: some View {
        let state = context.state
        if context.isStale {
            Text("Waiting for an update")
        } else if state.state == "printing", state.endsAt > Date() {
            Text("\(state.status) · \(Text(timerInterval: Date()...state.endsAt, countsDown: true).monospacedDigit()) left")
        } else if state.state == "preparing", !state.stage.isEmpty {
            Text("\(state.status) · \(state.stage)")
        } else {
            Text(state.status)
        }
    }
}

/// The detail line the milestone notification uses: "layer 84 of 212 · P1S", or the printer's problem.
struct ActivityDetail: View {
    let context: ActivityViewContext<PrintAttributes>
    let includesStatus: Bool

    var body: some View {
        if let problem = context.state.problem {
            Text(problem).lineLimit(2)
        } else {
            let detail = PrintActivityWords.detail(context.state, printer: context.attributes.printerName)
            if includesStatus {
                HStack(spacing: 0) {
                    ActivityStatus(context: context)
                    Text(" · \(detail)")
                }.lineLimit(1).foregroundStyle(.secondary)
            } else {
                Text(detail).lineLimit(1)
            }
        }
    }
}

struct ActivityBar: View {
    let state: PrintAttributes.ContentState
    var body: some View {
        ProgressView(value: min(100, max(0, state.progress)), total: 100).tint(CounterpartBrand.orange)
    }
}

/// Compact trailing: the percent; at limited width (iPhone Duo, landscape, two activities), a 22 pt ring,
/// inside the HIG's 28 pt circle.
struct CompactProgress: View {
    @Environment(\.isDynamicIslandLimitedInWidth) private var limited
    let state: PrintAttributes.ContentState

    var body: some View {
        if limited {
            ProgressRing(progress: state.progress, lineWidth: 2.5).frame(width: 22, height: 22)
        } else {
            ActivityPercent(state: state).foregroundStyle(CounterpartBrand.orange)
        }
    }
}

/// Minimal: the print's progress around the mark, so it shows something current and is still recognisably
/// Counterpart (HIG: "display updated information rather than just a logo").
struct ProgressMark: View {
    let state: PrintAttributes.ContentState
    let side: CGFloat

    var body: some View {
        ZStack {
            ProgressRing(progress: state.progress, lineWidth: 2.5)
            PrintActivityMark().frame(width: side * 0.46, height: side * 0.46)
        }
        .frame(width: side, height: side)
    }
}

struct ProgressRing: View {
    let progress: Double
    let lineWidth: CGFloat

    var body: some View {
        ZStack {
            Circle().stroke(CounterpartBrand.orange.opacity(0.25), lineWidth: lineWidth)
            Circle().trim(from: 0, to: min(1, max(0, progress / 100)))
                .stroke(CounterpartBrand.orange, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .widgetAccentable()
        }
        .accessibilityLabel(Text(progress / 100, format: .percent.precision(.fractionLength(0))))
    }
}
