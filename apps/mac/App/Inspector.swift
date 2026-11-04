import SwiftUI
import AppKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

/// The inspector (PRD §7.2): Request (what you asked for, your photos, what changed), Activity (each pass,
/// its stages and tool lines) and Print (printer, settings, colours and the last print's events).
struct InspectorView: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    let print: () -> Void
    @State private var tab = Tab.initial
    enum Tab: Hashable {
        case request, activity, print
        @MainActor static var initial: Tab {
            #if DEBUG
            switch DesignFixtures.assets == nil ? "" : DesignFixtures.tab { case "activity": return .activity; case "print": return .print; default: break }
            #endif
            return .request
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Picker("", selection: $tab) {
                Text("Request").tag(Tab.request)
                Text("Activity").tag(Tab.activity)
                Text("Print").tag(Tab.print)
            }
            .pickerStyle(.segmented).labelsHidden().padding(14)
            ScrollView {
                Group {
                    switch tab {
                    case .request: RequestTab(object: object, model: model)
                    case .activity: ActivityTab(object: object, model: model)
                    case .print: PrintTab(object: object, model: model, print: print)
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: Request

private struct RequestTab: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    @State private var shown: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // PRD §8.11: a published model credits its designer and links back to the page.
            if let credit = model.extras[object.id]?.credit {
                SectionHeading("Model")
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: credit.title ?? object.words.title).font(.body.weight(.semibold))
                    if let line = credit.line { Text(verbatim: line).font(.callout).foregroundStyle(.secondary) }
                    if let licence = credit.licence { Text(verbatim: licence).font(.caption).foregroundStyle(.secondary) }
                    if let page = URL(string: credit.url) {
                        Link("Open the model page", destination: page).font(.callout)
                    }
                }
            }
            let conversation = ProjectConversation(project: object, queued: model.corrections.messages[object.id] ?? [],
                                                   queueFailed: model.corrections.failures[object.id] != nil)
            LazyVStack(alignment: .leading, spacing: 16) {
                ForEach(conversation.entries) { entry in
                    ConversationBubble(entry: entry) { pictures(entry.photos) }
                }
            }
            if conversation.entries.isEmpty { Text("No request was saved with this project.").foregroundStyle(.secondary) }
            if !conversation.otherPhotos.isEmpty {
                SectionHeading("Other project photos")
                Text("These photos aren't linked to a message.").font(.caption).foregroundStyle(.secondary)
                pictures(conversation.otherPhotos)
            }
            if let current = object.current {
                if !(current.changes ?? []).isEmpty || current.summary?.isEmpty == false { SectionHeading("What changed") }
                if !(current.changes ?? []).isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array((current.changes ?? []).enumerated()), id: \.offset) { _, change in ChangeLine(change: change) }
                    }
                    .font(.callout)
                } else if let summary = current.summary, !summary.isEmpty {
                    Text(summary).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }

        }
        .sheet(isPresented: Binding(get: { shown != nil }, set: { if !$0 { shown = nil } })) {
            VStack(spacing: 16) {
                if let shown { FileImage(url: shown, version: object.updatedAtMs).frame(maxWidth: .infinity, maxHeight: .infinity) }
                Button("Done") { shown = nil }.keyboardShortcut(.cancelAction)
            }
            .padding(20).frame(minWidth: 600, minHeight: 500)
        }
    }

    @ViewBuilder private func pictures(_ paths: [String]) -> some View {
        if !paths.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 8)], spacing: 8) {
                ForEach(paths, id: \.self) { path in
                    if let url = object.file(path) {
                        Button { shown = url } label: { FillImage(url: url, version: object.updatedAtMs).frame(height: 96).clipShape(.rect(cornerRadius: 10)) }
                            .buttonStyle(.plain).accessibilityLabel(path.hasPrefix("photos/") ? "Photo" : "Scan image")
                    }
                }
            }
        }
    }

}

/// One line of "what changed", with its tag as a symbol and (for guesses) a colour.
private struct ChangeLine: View {
    let change: Project.Change
    var body: some View {
        switch change.tag {
        case "added": Label(change.text, systemImage: "plus.circle.fill")
        case "changed": Label(change.text, systemImage: "arrow.triangle.2.circlepath")
        case "assumed": Label(change.text, systemImage: "ruler")
        case "estimated": Label(change.toleranceMm.map { "\(change.text) ±\($0.formatted()) mm" } ?? change.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        default: Label(change.text, systemImage: "circle.fill")
        }
    }
}

enum ToolLine {
    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
    static func format(_ entry: Project.Activity) -> String {
        let time = clock.string(from: Date(timeIntervalSince1970: entry.atMs / 1000))
        return "\(time)  \(entry.text)"
    }
}

// MARK: Activity

private struct ActivityTab: View {
    let object: Project
    @ObservedObject var model: ObjectsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(object.passes.enumerated().reversed()), id: \.offset) { index, pass in
                PassHeader(title: "Pass \(index + 1) · \(Self.trigger(pass, first: index == 0))", detail: Self.span(pass),
                           current: index == object.passes.count - 1)
                if let note = pass.note, !note.isEmpty {
                    StageRow(title: "Read your note", detail: "“\(note)”", time: Self.clock(pass.startedAtMs), done: true)
                }
                if let stages = pass.stages, !stages.isEmpty {
                    ForEach(Array(stages.enumerated()), id: \.offset) { _, stage in
                        StageRow(title: stage.words, detail: "", time: Self.clock(stage.startedAtMs),
                                 done: stage.endedAtMs != nil, running: stage.endedAtMs == nil && pass.endedAtMs == nil)
                    }
                } else {
                    StageRow(title: pass.endedAtMs == nil ? "Working on it" : Self.outcome(pass), detail: pass.summary.map(Self.firstSentence) ?? "",
                             time: pass.endedAtMs.map(Self.clock) ?? "", done: pass.endedAtMs != nil, running: pass.endedAtMs == nil)
                }
                if (pass.activityCount ?? pass.activity?.count ?? 0) > 0 {
                    PassToolLines(object: object, model: model, index: index, count: pass.activityCount ?? pass.activity?.count ?? 0,
                                  preview: pass.activity ?? [], open: index == object.passes.count - 1)
                }
                Divider().padding(.vertical, 4)
            }
            Label("Project started \(Date(timeIntervalSince1970: object.createdAtMs / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute()))",
                  systemImage: "plus.circle")
                .font(.caption).foregroundStyle(.secondary)
            if object.passes.isEmpty { Text("Each round of work on your Mac shows here.").font(.callout).foregroundStyle(.secondary) }
        }
    }

    static func trigger(_ pass: Project.Pass, first: Bool) -> String {
        switch pass.trigger {
        case "changes": return "Ask for changes"
        case "late-photos": return "New photos"
        case "ask-answer": return "Your answer"
        case "new": return "New project"
        default: return pass.note == nil ? (first ? "New project" : "Again") : "Ask for changes"
        }
    }
    static func clock(_ ms: Double) -> String { Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened) }
    static func span(_ pass: Project.Pass) -> String {
        guard let ended = pass.endedAtMs else { return "since \(clock(pass.startedAtMs))" }
        let minutes = max(1, Int(((ended - pass.startedAtMs) / 60_000).rounded()))
        return "\(clock(ended)) · \(minutes) min"
    }
    static func outcome(_ pass: Project.Pass) -> String {
        switch pass.status {
        case "done"?, "ready"?: return "Finished"
        case "needs-closeup"?: return "Asked for a close-up"
        case "interrupted"?: return "Stopped when your Mac restarted"
        case let status?: return status.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: return "Finished"
        }
    }
    static func firstSentence(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 140 ? String(line.prefix(139)) + "…" : line
    }
}

private struct PassHeader: View {
    let title: String, detail: String, current: Bool
    var body: some View {
        HStack {
            Text(title).font(.headline).lineLimit(1)
            Spacer(minLength: 6)
            Text(detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
        }
        .foregroundStyle(current ? .primary : .secondary)
    }
}

private struct StageRow: View {
    let title: String, detail: String, time: String
    var done = true
    var running = false
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                if running { ProgressView().controlSize(.mini) }
                // A step still to come is dashed: an empty circle reads as a checkbox to click.
                else { Image(systemName: done ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(done ? Color.green : .secondary) }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium))
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            Spacer()
            Text(time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
        }
    }
}

/// A pass's tool lines in a dark block: the last few at once, every one when opened.
private struct PassToolLines: View {
    let object: Project
    let model: ObjectsModel
    let index: Int
    let count: Int
    let preview: [Project.Activity]
    let open: Bool
    @State private var all: [Project.Activity]?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            let shown = all ?? Array(preview.filter { $0.kind == "tool" }.suffix(4))
            ForEach(Array(shown.enumerated()), id: \.offset) { _, entry in
                Text(ToolLine.format(entry)).font(.caption2.monospaced())
                    .foregroundStyle(entry.kind == "tool" ? .secondary : .primary)
                    .textSelection(.enabled)
            }
            if all == nil && count > shown.count {
                Button(failed ? "Couldn’t load them. Try again." : "Show all \(count)") { Task { await load() } }
                    .buttonStyle(.link).font(.caption2)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(white: 0.12), in: .rect(cornerRadius: 10))
        .environment(\.colorScheme, .dark)
        .padding(.leading, 28)
        // Once opened, the full list follows a running pass as new lines arrive.
        .task(id: count) { if all != nil { await load() } }
    }
    private func load() async {
        do { all = try await model.passActivity(object.id, index: index); failed = false }
        catch { failed = true }
    }
}

// MARK: Print

private struct PrintTab: View {
    let object: Project
    @ObservedObject var model: ObjectsModel
    let print: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading("Printer")
            if let printer = model.printer(for: object) {
                HStack(spacing: 10) {
                    Image(systemName: printer.mcpName == "bambu-printer-mcp" ? "printer.fill" : "printer").font(.title3)
                        .frame(width: 34, height: 34).glassEffect(.regular, in: .rect(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(printer.name).font(.headline)
                        Text([printer.mcpName, printer.state.map(Self.readiness)].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    ReadyDot(state: printer.state, size: 8)
                }
            } else {
                Text(model.missingPrinterText).font(.callout).foregroundStyle(.secondary)
            }
            if let estimate = object.print?.estimate, estimate.seconds != nil || estimate.grams != nil {
                SectionHeading("Profile")
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your printer MCP’s preset")
                    Text([estimate.seconds.map { ObjectWords.formatMinutes($0 / 60) }, Format.grams(estimate.grams)]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if let print = object.print {
                SectionHeading("Last print" + (print.destination.map { " · \($0.name)" } ?? ""))
                if print.uncertain == true {
                    Label("It may have started. Check the printer before printing again.", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.orange)
                }
                if let events = print.events, !events.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(events.suffix(12).enumerated()), id: \.offset) { _, event in
                            HStack(alignment: .top, spacing: 10) {
                                Text(Date(timeIntervalSince1970: event.atMs / 1000), format: .dateTime.hour().minute())
                                    .font(.caption.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 44, alignment: .leading)
                                Text(event.message).font(.callout.weight(.medium))
                                Spacer(minLength: 0)
                            }
                        }
                    }
                } else if let status = print.printerStatus {
                    Text("The printer said \(status.state.lowercased()) at \(Date(timeIntervalSince1970: status.checkedAtMs / 1000).formatted(date: .omitted, time: .shortened)).")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    Text("Sent to the printer.").font(.callout).foregroundStyle(.secondary)
                }
            } else {
                SectionHeading("Last print")
                Text("Not printed yet.").font(.callout).foregroundStyle(.secondary)
            }
            if object.words.actions.contains(.print) || object.words.actions.contains(.printChecked) {
                Button(action: print) { Label(object.print == nil ? "Print…" : "Print Again…", systemImage: "printer.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(.glass).controlSize(.large)
                    .disabled(model.printer(for: object) == nil || model.working.contains(object.id))
            }
        }
    }

    static func readiness(_ state: String) -> String {
        switch state { case "ready": return "ready"; case "busy": return "busy"; case "offline": return "offline"; default: return "not checked yet" }
    }
}
