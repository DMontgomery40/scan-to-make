import ActivityKit
import SwiftUI
import WidgetKit
import CounterpartKit

@main struct CounterpartWidgets: WidgetBundle {
    var body: some Widget { PrintActivityWidget() }
}

struct PrintActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PrintAttributes.self) { context in
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: "printer.fill").foregroundStyle(.orange)
                    Text(context.attributes.title).font(.headline).lineLimit(1)
                    Spacer()
                    Text(context.state.progress / 100, format: .percent.precision(.fractionLength(0))).monospacedDigit()
                }
                ProgressView(value: min(100, max(0, context.state.progress)), total: 100).tint(.orange)
                HStack {
                    Text(context.isStale ? "Waiting for an update" : context.state.status)
                    Spacer()
                    if !context.isStale && context.state.state == "printing" && context.state.endsAt > Date() {
                        Text(timerInterval: Date()...context.state.endsAt, countsDown: true).monospacedDigit()
                    }
                }.font(.caption).foregroundStyle(.secondary)
                if let problem = context.state.problem { Text(problem).font(.caption).lineLimit(2) }
                else { Text(context.attributes.printerName).font(.caption2).foregroundStyle(.secondary) }
            }.padding(16)
                .activityBackgroundTint(.black.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "counterpart://printing/\(context.attributes.projectId)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "printer.fill").foregroundStyle(.orange) }
                DynamicIslandExpandedRegion(.trailing) { Text(context.state.progress / 100, format: .percent.precision(.fractionLength(0))).monospacedDigit() }
                DynamicIslandExpandedRegion(.center) { Text(context.attributes.title).lineLimit(1) }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack {
                        ProgressView(value: min(100, max(0, context.state.progress)), total: 100).tint(.orange)
                        Text(context.isStale ? "Waiting for an update" : context.state.status).font(.caption)
                    }
                }
            } compactLeading: { Image(systemName: "printer.fill").foregroundStyle(.orange) }
            compactTrailing: { Text(context.state.progress / 100, format: .percent.precision(.fractionLength(0))).monospacedDigit() }
            minimal: { Image(systemName: "printer.fill").foregroundStyle(.orange) }
            .widgetURL(URL(string: "counterpart://printing/\(context.attributes.projectId)"))
        }
    }
}
