import SwiftUI
import CounterpartKit

/// The printer MCP's own confirmation, answered here (PRD §5.5, screens/phone-confirm.jpg). bambu-printer-mcp
/// asks through MCP elicitation before every print: one message and a form of switches. Nothing goes to the
/// printer until it's answered; an answer belongs to exactly this question and never carries over.
///
/// Guards: one answer at a time (`working`); an expired or replaced question can't be accepted
/// (`PrintConfirmation.response` checks id and time).
struct PrintConfirmSheet: View {
    let store: ProjectsStore
    let project: Project
    let question: Project.PrintConfirmation
    @Environment(\.dismiss) private var dismiss
    /// Each field's answer; fields start at their default (switches off).
    @State private var values: [String: JSONValue] = [:]
    @State private var working = false
    @State private var problem: String?

    private var printer: String { project.print?.destination?.name ?? store.catalog?.destination(project.printerDestinationId)?.name ?? "Your printer" }
    private var via: String { store.catalog?.destination(project.printerDestinationId)?.via ?? "the printer's MCP" }
    private var words: ConfirmationWords { ConfirmationWords(message: question.message, fileName: project.print?.jobName) }
    private var resuming: Bool { project.print?.live?.state == "paused" }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                let now = timeline.date.timeIntervalSince1970 * 1000
                let left = max(0, (question.expiresAtMs - now) / 1000)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: "checkmark.shield.fill").font(.title2).foregroundStyle(.blue)
                                .frame(width: 52, height: 52).glassEffect(.regular.tint(.blue.opacity(0.25)), in: .circle)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(printer) needs a yes before \(resuming ? "resuming" : "printing") \(ProjectWords.title(project))").font(.title3.bold()).fixedSize(horizontal: false, vertical: true)
                                Text("Asked by \(via) on \(store.macName ?? "your Mac")").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        messageCard
                        ForEach(question.fields, id: \.name) { field in
                            ConfirmationFieldView(field: field, value: Binding(get: { values[field.name] ?? field.initialValue }, set: { values[field.name] = $0 }))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                                .glassEffect(.regular, in: .rect(cornerRadius: 24))
                                .disabled(working || left == 0)
                        }
                        if let problem { Label(problem, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.red) }
                    }
                    .padding(20)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .safeAreaBar(edge: .bottom) {
                    VStack(spacing: 8) {
                        Button { answer(.accept) } label: {
                            Text(working ? (resuming ? "Resuming…" : "Starting…") : (resuming ? "Resume" : "Start Print")).fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44)
                        }
                        .buttonStyle(.glassProminent).controlSize(.large)
                        .disabled(working || !question.canAccept(values, atMs: now))
                        .accessibilityIdentifier("start-print")
                        Text(left > 0 ? "Nothing goes to the printer until you confirm · \(Self.clock(left)) left" : "This question expired. Try \(resuming ? "Resume" : "Print") again for a new question.")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 20)
                }
            }
            .navigationTitle(resuming ? "Confirm Resume" : "Confirm Print")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Closing leaves the question open; the project page offers it again, and Don't Print.
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }

    private var messageCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let question = words.question { Text(question).font(.headline) }
            ForEach(words.facts, id: \.label) { fact in FactRow(symbol: fact.symbol, label: fact.label, value: fact.value) }
            if words.isStructured {
                // The rest of what the MCP said, in its own words.
                ForEach(words.notes, id: \.self) { Text(verbatim: $0).font(.subheadline).fixedSize(horizontal: false, vertical: true) }
                DisclosureGroup("Full message") {
                    Text(verbatim: question.message).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled).padding(.top, 6)
                }
                .font(.footnote).foregroundStyle(.secondary)
            } else {
                Text(verbatim: question.message).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }

    static func clock(_ seconds: Double) -> String { String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60) }

    private func answer(_ action: PrintConfirmationResponse.Action) {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            guard let response = question.response(confirmationId: question.id, action: action, content: values, atMs: Date().timeIntervalSince1970 * 1000) else {
                await store.reload(project.id)
                problem = "This printer question has changed or expired. Review the current question before continuing."
                return
            }
            do { let ticket = store.startRequest(); store.replace(try await store.mac.answerPrintConfirmation(project.id, response: response), ticket: ticket); dismiss() }
            catch let failure as CompanionError { problem = failure.message }
            catch { problem = CompanionError.unreachable.message }
        }
    }
}

struct FactRow: View {
    let symbol: String, label: String, value: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 22)
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.subheadline.weight(.medium).monospacedDigit()).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

/// A question this app can't show (PRD §5.5, screens/phone-confirm-mac.jpg). When the Mac answers any printer
/// question (`genericConfirmations`), it's answered there; otherwise the way on is to stop this print.
/// Nothing reaches the printer meanwhile.
struct AnswerOnMacSheet: View {
    let store: ProjectsStore
    let project: Project
    let question: Project.PrintConfirmation
    @Environment(\.dismiss) private var dismiss
    @State private var working = false
    @State private var problem: String?

    private var printer: String { project.print?.destination?.name ?? "Your printer" }
    private var via: String { store.catalog?.destination(project.printerDestinationId)?.via ?? "The printer's MCP" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            let left = max(0, question.expiresAtMs / 1000 - timeline.date.timeIntervalSince1970)
            VStack(spacing: 0) {
                Image(systemName: "macmini.fill").font(.system(size: 30)).foregroundStyle(.white)
                    .frame(width: 72, height: 72).glassEffect(.regular.tint(.blue.opacity(0.3)), in: .circle)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "questionmark").font(.caption.weight(.heavy)).foregroundStyle(.white)
                            .frame(width: 26, height: 26).background(.orange, in: .circle).offset(x: 4, y: 4)
                    }
                    .padding(.top, 30)
                    .accessibilityHidden(true)
                Text("\(printer) has a question for you").font(.title2.bold()).multilineTextAlignment(.center).padding(.top, 18)
                Text("\(via) needs an answer before it prints \(ProjectWords.title(project)), and Counterpart can't show that kind of question yet.")
                    .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8).padding(.horizontal, 28)
                Group {
                    if store.macCapabilities.contains("genericConfirmations") {
                        Text("Answer it on \(store.macName ?? "your Mac").").fontWeight(.semibold)
                    } else {
                        Text("Counterpart can't answer this kind on your Mac yet either, so the only way forward is to stop this print.")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8).padding(.horizontal, 28)
                HStack(spacing: 12) {
                    Image(systemName: "clock").foregroundStyle(.secondary)
                    Text("Waiting on \(store.macName ?? "your Mac")").font(.subheadline)
                    Spacer()
                    Text(PrintConfirmSheet.clock(left)).font(.subheadline.monospacedDigit().weight(.semibold)).foregroundStyle(.orange)
                }
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 20))
                .padding(.horizontal, 20).padding(.top, 22)
                if let problem { Text(problem).font(.footnote).foregroundStyle(.red).padding(.top, 10).padding(.horizontal, 20) }
                Spacer(minLength: 16)
                GlassEffectContainer(spacing: 10) {
                    VStack(spacing: 10) {
                        if store.macCapabilities.contains("genericConfirmations") {
                            // The question is waiting in Counterpart on the Mac; this steps aside for it.
                            Button { dismiss() } label: {
                                Label("Answer on your Mac", systemImage: "macmini").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44)
                            }
                            .buttonStyle(.glassProminent)
                            Button(role: .destructive) { cancel() } label: { Text(working ? "Stopping…" : "Don't Print").frame(maxWidth: .infinity).frame(height: 44) }
                                .buttonStyle(.glass).disabled(working)
                        } else {
                            Button(role: .destructive) { cancel() } label: {
                                Text(working ? "Stopping…" : "Don't Print").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44)
                            }
                            .buttonStyle(.glassProminent).tint(.red).disabled(working)
                            Button { dismiss() } label: { Text("Not Now").frame(maxWidth: .infinity).frame(height: 44) }
                                .buttonStyle(.glass)
                        }
                    }
                    .controlSize(.large)
                }
                .padding(.horizontal, 20)
                Text("Nothing is sent to the printer until it's answered.").font(.caption).foregroundStyle(.secondary).padding(.top, 10).padding(.bottom, 12)
            }
        }
        .presentationDetents([.fraction(0.72)])
    }

    private func cancel() {
        guard !working else { return }
        working = true; problem = nil
        Task {
            defer { working = false }
            guard let response = question.response(confirmationId: question.id, action: .cancel, content: [:], atMs: Date().timeIntervalSince1970 * 1000) else {
                await store.reload(project.id); dismiss(); return
            }
            do { let ticket = store.startRequest(); store.replace(try await store.mac.answerPrintConfirmation(project.id, response: response), ticket: ticket); dismiss() }
            catch let failure as CompanionError { problem = failure.message }
            catch { problem = CompanionError.unreachable.message }
        }
    }
}

/// Shows the printer's own question as a sheet once when it arrives (from Print, Pause, Resume or Stop),
/// wherever the project is on screen; `confirming` reopens it.
struct PrinterQuestion: ViewModifier {
    let store: ProjectsStore
    let project: Project?
    @Binding var confirming: IdentifiedProject?
    @State private var shown: Set<String> = []

    func body(content: Content) -> some View {
        content
            .onChange(of: project?.printConfirmation?.id, initial: true) { _, id in
                guard let id else { confirming = nil; return }
                guard !shown.contains(id) else { return }
                shown.insert(id)
                confirming = IdentifiedProject(id: id)
            }
            .sheet(item: $confirming) { item in
                if let project, let question = project.printConfirmation, question.id == item.id {
                    if question.isRenderable { PrintConfirmSheet(store: store, project: project, question: question) }
                    else { AnswerOnMacSheet(store: store, project: project, question: question) }
                }
            }
    }
}

/// One field of the printer's question, native for its type: a switch, a choice, text, a date or a number.
struct ConfirmationFieldView: View {
    let field: Project.PrintConfirmation.Field
    @Binding var value: JSONValue?
    @State private var text = ""

    var body: some View {
        switch field.type {
        case .boolean:
            Toggle(isOn: Binding(get: { value == .bool(true) }, set: { value = .bool($0) })) { label }
        case .string where field.enumValues != nil:
            VStack(alignment: .leading, spacing: 8) {
                label
                Picker(field.title, selection: Binding(get: { if case .string(let s) = value { s } else { "" } }, set: { value = .string($0) })) {
                    if value == nil { Text("Choose").tag("") }
                    ForEach(field.enumValues ?? [], id: \.self) { Text(field.displayName(of: $0)).tag($0) }
                }
                .pickerStyle(.menu)
            }
        case .string where field.format == "date" || field.format == "date-time":
            DatePicker(selection: Binding(get: { date ?? Date() }, set: { value = .string(format($0)) }),
                       displayedComponents: field.format == "date" ? [.date] : [.date, .hourAndMinute]) { label }
        case .string:
            VStack(alignment: .leading, spacing: 8) {
                label
                // Cleared is `.null`: the person emptied it, so its default doesn't come back.
                TextField(field.title, text: Binding(get: { if case .string(let s) = value { s } else { "" } }, set: { value = $0.isEmpty ? .null : .string($0) }))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(field.format == "email" ? .emailAddress : field.format == "uri" ? .URL : .default)
                    .textInputAutocapitalization(field.format == nil ? .sentences : .never)
                limits
            }
        case .number, .integer:
            VStack(alignment: .leading, spacing: 8) {
                label
                TextField(field.title, text: $text)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(field.type == .integer ? .numberPad : .decimalPad)
                    // Empty is cleared (`.null`); text that isn't a number yet stays text, which blocks Start Print until it is.
                    .onChange(of: text) { _, new in
                        let trimmed = new.trimmingCharacters(in: .whitespaces)
                        if trimmed.isEmpty { value = .null }
                        else if let number = Double(trimmed.replacingOccurrences(of: ",", with: ".")) { value = .number(number) }
                        else { value = .string(trimmed) }
                    }
                    .onAppear { if case .number(let n) = value { text = field.type == .integer ? String(Int(n)) : String(n) } }
                limits
            }
        case .unknown:
            label
        }
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(verbatim: field.title).font(.body.weight(.medium))
                if field.required && field.type != .boolean { Text("Required").font(.caption).foregroundStyle(.secondary) }
            }
            if let description = field.description { Text(verbatim: description).font(.caption).foregroundStyle(.secondary) }
        }
    }

    /// "Between 40 and 110", "Up to 200 characters": what the printer accepts, said before it refuses.
    @ViewBuilder private var limits: some View {
        let words: String? = switch field.type {
        case .number, .integer:
            switch (field.minimum, field.maximum) {
            case let (min?, max?): "Between \(Self.number(min)) and \(Self.number(max))"
            case let (min?, nil): "At least \(Self.number(min))"
            case let (nil, max?): "At most \(Self.number(max))"
            default: nil
            }
        default:
            switch (field.minLength, field.maxLength) {
            case let (min?, max?): "\(min) to \(max) characters"
            case let (min?, nil): "At least \(min) characters"
            case let (nil, max?): "Up to \(max) characters"
            default: nil
            }
        }
        if let words { Text(words).font(.caption).foregroundStyle(.secondary) }
    }

    private static func number(_ n: Double) -> String { n.rounded() == n ? String(Int(n)) : String(n) }

    private var date: Date? { if case .string(let s) = value { field.format == "date" ? Self.day.date(from: s) : ISO.date(s) } else { nil } }
    private func format(_ date: Date) -> String { field.format == "date" ? Self.day.string(from: date) : ISO8601DateFormatter().string(from: date) }
    private static let day: DateFormatter = { let f = DateFormatter(); f.calendar = Calendar(identifier: .iso8601); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f }()
}

