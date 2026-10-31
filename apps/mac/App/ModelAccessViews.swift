import SwiftUI
import AgentKit
#if canImport(ControlKit)
import ControlKit
#endif

// The AI cleanup setting (journey.md §3.6, mockup 09): one default, the user's own Claude Code
// or Codex login, and a small "Other options" door for an API key or a custom endpoint.
// Choices go to the companion over the control socket; keys go straight into ModelKeychain.

private let clay = Color(red:0.77, green:0.32, blue:0.17)
/// Clay for small text: darker on light backgrounds and lighter on dark ones, so it keeps 4.5:1.
private let clayText = Color(nsColor:NSColor(name:nil) { appearance in
    appearance.bestMatch(from:[.aqua, .darkAqua]) == .darkAqua
        ? NSColor(red:0.96, green:0.58, blue:0.45, alpha:1)
        : NSColor(red:0.62, green:0.24, blue:0.10, alpha:1)
})

extension ModelAccessModel {
    convenience init(installation: Installation) { self.init(socketPath:Self.socketPath(for:installation)) }

    /// local-control.md: `<auth directory>/control.sock`, or SCAN_TO_MAKE_CONTROL_SOCKET when set.
    nonisolated static func socketPath(for installation: Installation) -> String {
        if let path = ProcessInfo.processInfo.environment["SCAN_TO_MAKE_CONTROL_SOCKET"], path.hasPrefix("/") { return path }
        return installation.state.appendingPathComponent("auth/control.sock").path
    }
}

/// The AI cleanup pane, shared by first run and Settings.
struct ModelAccessPane: View {
    enum Context { case firstRun, settings }
    @ObservedObject var model: ModelAccessModel
    let context: Context
    var onDone: () -> Void = {}
    private enum Door: Equatable { case key, endpoint }
    @State private var otherOptions = false
    @State private var door: Door?
    @State private var provider: ModelAPIProvider = .anthropic
    @State private var key = ""
    @State private var keyModel = "claude-opus-5-5"
    @State private var address = ""
    @State private var endpointModel = ""
    @State private var endpointKey = ""

    private var choice: ModelAccessChoice { model.snapshot?.choice ?? .none }

    var body: some View {
        VStack(alignment:.leading, spacing:0) {
            Text(context == .firstRun ? "Sharper details with AI (optional)" : "AI cleanup")
                .font(.system(size:20, weight:.semibold))
            Text("AI looks at your photos and tweaks the scan to match. Your scan and photos go to the AI service you pick.")
                .font(.system(size:13)).foregroundStyle(.secondary)
                .fixedSize(horizontal:false, vertical:true)
                .padding(.top,6).padding(.bottom,18)
            if model.unavailable {
                unavailable
            } else if model.snapshot == nil {
                ProgressView().controlSize(.small).frame(maxWidth:.infinity, minHeight:120)
            } else {
                ScrollViewReader { reader in
                    ScrollView { options.padding(.trailing,6) }
                        .onChange(of:door) { opened in
                            guard let opened else { return }
                            withAnimation { reader.scrollTo(opened == .key ? "key" : "endpoint", anchor:.bottom) }
                        }
                }
            }
            Spacer(minLength:12)
            if context == .firstRun { footer }
        }
        .task { await model.refresh() }
        .onChange(of:provider) { keyModel = $0 == .anthropic ? "claude-opus-5-5" : "gpt-6-astra" }
    }

    private var unavailable: some View {
        VStack(alignment:.leading, spacing:10) {
            Text("Scan to Make couldn’t start in the background.").font(.system(size:13))
            Button("Try again") { Task { await model.refresh() } }
        }
    }

    private var options: some View {
        VStack(alignment:.leading, spacing:10) {
            card(selected:choice.usesLogin && door == nil,
                 title:"Use my Claude Code or Codex login",
                 caption:"Uses the app you already sign in to on this Mac. Nothing to copy or paste.",
                 select:{ door = nil; if !choice.usesLogin { Task { await model.choose(.claudeCode) } } }) {
                Picker("Login", selection:Binding(get:{ choice == .codexCLI ? 1 : 0 },
                                                  set:{ value in
                                                      let next: ModelAccessChoice = value == 1 ? .codexCLI : .claudeCode
                                                      if next != choice { Task { await model.choose(next) } } })) {
                    Text("Claude Code").tag(0)
                    Text("Codex").tag(1)
                }
                .pickerStyle(.segmented).labelsHidden().frame(width:220)
                .disabled(model.saving)
                statusRow
            }
            // First run skips with its footer button; Settings needs a way back to no AI.
            if context == .settings {
                card(selected:choice == .none && door == nil,
                     title:"Don't use AI",
                     caption:"Cleanup still fills the gaps. The scanned surface stays as captured.",
                     select:{ door = nil; if choice != .none { Task { await model.choose(.none) } } }) { EmptyView() }
            }
            DisclosureGroup("Other options", isExpanded:$otherOptions) {
                VStack(alignment:.leading, spacing:10) {
                    card(selected:door == .key || (door == nil && choice.isAPIKey),
                         title:"Use an API key",
                         caption:"Anthropic or OpenAI. The key stays in your keychain on this Mac.",
                         select:{ door = .key }) {
                        if door == .key { keyForm } else if choice.isAPIKey { statusRow }
                    }
                    .id("key")
                    card(selected:door == .endpoint || (door == nil && choice.isEndpoint),
                         title:"Use a custom endpoint",
                         caption:"Any OpenAI-compatible address, such as a model running on this Mac.",
                         select:{ door = .endpoint }) {
                        if door == .endpoint { endpointForm } else if choice.isEndpoint { statusRow }
                    }
                    .id("endpoint")
                }
                .padding(.top,8)
            }
            .font(.system(size:13))
            .onAppear { otherOptions = choice.isAPIKey || choice.isEndpoint }
            if let problem = model.problem {
                Text(problem).font(.system(size:12)).foregroundStyle(clayText)
            }
        }
    }

    @ViewBuilder private var statusRow: some View {
        switch model.status {
        case .idle:
            if choice != .none {
                Button("Check connection") { Task { await model.checkAgain() } }.controlSize(.small)
            }
        case .checking:
            HStack(spacing:6) { ProgressView().controlSize(.small); Text("Checking…") }
                .font(.system(size:12)).foregroundStyle(.secondary)
        case .connected:
            Label("Connected · \(choice.displayName)", systemImage:"checkmark.circle.fill")
                .font(.system(size:12, weight:.medium)).foregroundStyle(.green)
        case .failed(let text):
            HStack(spacing:8) {
                Text(text).font(.system(size:12)).foregroundStyle(clayText)
                Button("Check again") { Task { await model.checkAgain() } }.controlSize(.small)
            }
        }
    }

    private var keyForm: some View {
        VStack(alignment:.leading, spacing:8) {
            Picker("Service", selection:$provider) {
                Text("Anthropic").tag(ModelAPIProvider.anthropic)
                Text("OpenAI").tag(ModelAPIProvider.openai)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width:220)
            SecureField("Key", text:$key).textFieldStyle(.roundedBorder)
            TextField("Model", text:$keyModel).textFieldStyle(.roundedBorder)
            HStack {
                Button("Use this key") {
                    Task { await model.useKey(provider:provider, model:keyModel, key:key); if model.problem == nil { key = ""; door = nil } }
                }
                .disabled(key.isEmpty || keyModel.isEmpty || model.saving)
                Button("Cancel") { key = ""; door = nil }.buttonStyle(.link)
            }
        }
        .frame(maxWidth:360)
    }

    private var endpointForm: some View {
        VStack(alignment:.leading, spacing:8) {
            TextField("Address", text:$address, prompt:Text(verbatim:"Address, like http://127.0.0.1:11434/v1"))
                .textFieldStyle(.roundedBorder)
            TextField("Model", text:$endpointModel).textFieldStyle(.roundedBorder)
            SecureField("Key (if it needs one)", text:$endpointKey).textFieldStyle(.roundedBorder)
            HStack {
                Button("Use this endpoint") {
                    Task {
                        await model.useEndpoint(address:address, model:endpointModel, key:endpointKey)
                        if model.problem == nil { endpointKey = ""; door = nil }
                    }
                }
                .disabled(address.isEmpty || endpointModel.isEmpty || model.saving)
                Button("Cancel") { endpointKey = ""; door = nil }.buttonStyle(.link)
            }
        }
        .frame(maxWidth:360)
    }

    private var footer: some View {
        HStack {
            Spacer()
            // Finish only once the companion confirms "no AI"; a failed save keeps setup open with its message.
            Button("Continue without AI") {
                Task { if await model.skipAI() { onDone() } }
            }
            .disabled(model.saving)
            Button("Continue") { onDone() }
                .keyboardShortcut(.defaultAction)
                .disabled(model.status != .connected || model.saving)
        }
    }

    private func card<Content: View>(selected: Bool, title: String, caption: String,
                                     select: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment:.leading, spacing:8) {
            Button(action:select) {
                HStack(alignment:.top, spacing:10) {
                    Image(systemName:selected ? "largecircle.fill.circle" : "circle")
                        .font(.system(size:15)).foregroundStyle(selected ? clay : Color.secondary)
                    VStack(alignment:.leading, spacing:2) {
                        Text(title).font(.system(size:13, weight:.semibold)).foregroundStyle(.primary)
                        Text(caption).font(.system(size:12)).foregroundStyle(.secondary)
                            .fixedSize(horizontal:false, vertical:true)
                    }
                    Spacer(minLength:0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.saving)
            .accessibilityAddTraits(selected ? .isSelected : [])
            if selected { content().padding(.leading,25) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius:10).fill(Color(nsColor:.controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius:10).strokeBorder(selected ? clay : Color.secondary.opacity(0.25), lineWidth:selected ? 1.5 : 1))
    }
}

/// First run, once a phone is connected (mockup 09, second and third scenes). Printer setup joins this rail with MAC-6.
struct SetupView: View {
    @ObservedObject var model: ModelAccessModel
    let onDone: () -> Void
    var body: some View {
        HStack(spacing:0) {
            VStack(alignment:.leading, spacing:14) {
                HStack(spacing:8) {
                    Image(nsImage:.menuBarCube).renderingMode(.template).foregroundStyle(clay)
                    Text("Scan to Make").font(.system(size:13, weight:.semibold))
                }
                Text("Set up your Mac").font(.system(size:12)).foregroundStyle(.secondary)
                Label("Your iPhone", systemImage:"checkmark.circle.fill").foregroundStyle(.secondary)
                Label("AI cleanup", systemImage:"circle.inset.filled").foregroundStyle(.primary)
                Spacer()
            }
            .font(.system(size:13))
            .padding(EdgeInsets(top:20, leading:20, bottom:20, trailing:16))
            .frame(width:190, alignment:.leading)
            .frame(maxHeight:.infinity, alignment:.top)
            .background(Color(nsColor:.underPageBackgroundColor))
            ModelAccessPane(model:model, context:.firstRun, onDone:onDone)
                .padding(EdgeInsets(top:20, leading:28, bottom:20, trailing:28))
        }
        .frame(width:720, height:520)
    }
}

/// Settings → AI cleanup (M3). The other tabs arrive with their plumbing.
struct ModelSettingsView: View {
    @ObservedObject var model: ModelAccessModel
    var body: some View {
        ModelAccessPane(model:model, context:.settings)
            .padding(24)
            .frame(width:520, height:500, alignment:.topLeading)
    }
}

/// Opens Settings from the popover; one window, reused.
@MainActor final class SettingsWindow {
    static let shared = SettingsWindow()
    private var window: NSWindow?
    private lazy var model = ModelAccessModel(installation:Installation(bundle:.main))
    func show() {
        if window != nil { Task { await model.refresh() } }
        if window == nil {
            let window = NSWindow(contentRect:NSRect(x:0, y:0, width:520, height:500),
                                  styleMask:[.titled, .closable], backing:.buffered, defer:false)
            window.title = "Settings"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView:ModelSettingsView(model:model))
            window.center()
            self.window = window
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
    }
}
