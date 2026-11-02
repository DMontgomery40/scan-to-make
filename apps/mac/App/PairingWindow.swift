import SwiftUI
import AgentKit
#if canImport(ControlKit)
import ControlKit
#endif

/// First run, then "Add a Phone": the pairing code, and once a phone connects on first run, setup (the AI
/// choice). One SwiftUI window whose content decides its size.
@MainActor final class PairingFlow: ObservableObject {
    static let shared = PairingFlow()
    enum Phase: Equatable { case code, setup }
    @Published private(set) var phase = Phase.code
    /// Set when setup is finished: the window closes and the Counterpart window opens.
    @Published var finished = false
    private var watch: Task<Void, Never>?

    /// While the code is on screen, a newly paired phone (or one paired before setup finished) moves first run on.
    func watchForPhone() {
        watch?.cancel()
        finished = false
        let socket = ModelAccessModel.socketPath(for:Installation(bundle:.main))
        watch = Task { [weak self] in
            var baseline: Int?
            while !Task.isCancelled {
                if let count = try? await ControlClient(socketPath:socket).status().pairedDeviceCount {
                    let unfinished = !UserDefaults.standard.bool(forKey:"setupFinished")
                    if let baseline, count > baseline { self?.phoneConnected(); return }
                    if baseline == nil, count > 0, unfinished { self?.phoneConnected(); return }
                    baseline = baseline ?? count
                }
                try? await Task.sleep(for:.seconds(2))
            }
        }
    }
    func stopWatching() { watch?.cancel(); watch = nil }

    private func phoneConnected() {
        if UserDefaults.standard.bool(forKey:"setupFinished") { finished = true } else { phase = .setup }
    }
    func finishSetup() {
        UserDefaults.standard.set(true, forKey:"setupFinished")
        phase = .code
        finished = true
    }
}

struct PairingWindow: View {
    @ObservedObject var flow: PairingFlow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch flow.phase {
            case .code:
                PairingWindowContent(model:CompanionModel.shared)
                    .containerBackground(Color.white, for:.window)
            case .setup:
                SetupView(model:AppModels.modelAccess) { flow.finishSetup() }
            }
        }
        .onAppear { if flow.phase == .code { flow.watchForPhone() } }
        .onDisappear { flow.stopWatching() }
        .onChange(of:flow.finished) { _, done in
            guard done else { return }
            dismissWindow(id:"pairing")
            openWindow(id:"main")
        }
    }
}

/// The pairing code and nothing else (journey.md §3.4, mockup 09): no title, caption or status line.
/// Without a code it shows a spinner, or one plain sentence and Try again.
struct PairingView: View {
    @ObservedObject var model: CompanionModel
    let side: CGFloat
    @State private var presentationID = UUID()
    var body: some View {
        ZStack {
            if let qr = model.qr {
                Image(nsImage:qr).interpolation(.none).resizable().scaledToFit()
                    .accessibilityLabel("Pairing QR code")
            } else if let message = failureMessage {
                VStack(spacing:14) {
                    Text(message).font(.system(size:13)).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).fixedSize(horizontal:false,vertical:true)
                    Button("Try again") { Task { await model.preparePairing() } }.disabled(model.working)
                }
                .padding(.horizontal,12)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width:side,height:side)
        .environment(\.colorScheme,.light)
        .task { await model.presentPairing(presentationID) }
        .onDisappear { model.hidePairing(presentationID) }
    }
    private var failureMessage: String? {
        guard let failure = model.failure else { return nil }
        switch failure as? AgentError {
        case .approvalRequired?: return "Allow Counterpart in System Settings → General → Login Items."
        case .companionUnavailable?: return "Counterpart couldn’t start in the background."
        default: return "Counterpart couldn’t make a code."
        }
    }
}

/// Mockup 09's QR-only window: 360 wide, white, the code at 292 pt. The title bar is transparent over the
/// white window, so the traffic lights are the only chrome; its 32 pt plus the top padding make the mockup's 49.
struct PairingWindowContent: View {
    @ObservedObject var model: CompanionModel
    var body: some View {
        PairingView(model:model,side:292)
            .padding(EdgeInsets(top:17,leading:34,bottom:51,trailing:34))
            .background(Color.white)
    }
}

extension NSImage {
    /// Mockup 08's `logo-mono` cube (24-unit viewBox), drawn as a template so the menu bar tints it.
    static let menuBarCube = cube(dot:false)
    /// The same cube with a dot cut into its corner while a phone waits for Allow.
    static let menuBarCubeWaiting = cube(dot:true)
    private static func cube(dot: Bool) -> NSImage {
        let image = NSImage(size:NSSize(width:18,height:18), flipped:true) { _ in
            let scale: CGFloat = 18.0 / 24.0
            func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x:x * scale, y:y * scale) }
            let path = NSBezierPath()
            path.move(to:point(12,3)); path.line(to:point(20,7.6)); path.line(to:point(20,16.4))
            path.line(to:point(12,21)); path.line(to:point(4,16.4)); path.line(to:point(4,7.6)); path.close()
            path.move(to:point(4,7.6)); path.line(to:point(12,12.2)); path.line(to:point(20,7.6))
            path.move(to:point(12,12.2)); path.line(to:point(12,21))
            path.lineWidth = 1.7 * scale
            path.lineJoinStyle = .round
            NSColor.black.setStroke()
            path.stroke()
            if dot {
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn:NSRect(x:11.75, y:-0.25, width:7, height:7)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                NSColor.black.setFill()
                NSBezierPath(ovalIn:NSRect(x:13, y:1, width:4.5, height:4.5)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = dot ? "Counterpart, a phone is waiting to pair" : "Counterpart"
        return image
    }
}

