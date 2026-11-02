import SwiftUI
import CounterpartKit

/// Find your Mac (PRD §5.10, journey.md §3.4): point the camera at the code in Counterpart on your Mac, or
/// pair with a Mac on this Wi-Fi from the card underneath (both screens show the same 6 digits; click Allow
/// on the Mac). Both paths end at the same pinned device credential. An already-paired phone sees its Mac.
///
/// Guards (each async entry point, its guard, and when it releases):
/// - QR code or link → `pairQR`: `working` (single flight, kind `.qr`); released when the pairing settles.
/// - Look again → `look`: one browse at a time (`nearby == .searching`), an attempt id; a browse stopped
///   on the way changes nothing.
/// - Pair (nearby) → `pairNearby`: `working` (kind `.nearby`) and the attempt id; released only by the
///   current attempt, or by Cancel/leaving for a nearby attempt (never a QR pairing's).
/// - Cancel → bumps the attempt, cancels the nearby session and browser, then looks again.
/// - Leaving the screen → cancels nearby work only if this screen started it.
/// - A pairing link mid-session waits for `working` to clear, and asks before replacing a paired Mac.
/// - The camera only scans while nothing else is pairing and the nearby code isn't showing.
struct FindYourMacView: View {
    enum Mode { case firstRun, replace }
    let mode: Mode

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    enum Phase: Equatable { case scanning, explain(String), pairing, failed(String, retry: String?), connected }
    enum Nearby: Equatable {
        case idle, explain, searching, found([NearbyMac]), none, localNetwork, code(NearbyStarted, String), failed(String)
    }
    enum Work { case qr, nearby }

    @State private var phase = Phase.scanning
    @State private var nearby = Nearby.idle
    @State private var working: Work?
    @State private var attempt = 0
    @State private var nearbyOwned = false
    @State private var camera: CameraAccess?
    @State private var cameraUnavailable = false
    @State private var scannerID = UUID()
    /// The name the Mac lists this phone under (chosen in Settings, else the device's own name).
    @State private var deviceName = "iPhone"
    @State private var replacing = false
    @State private var reachable: Bool?
    @State private var refused: String?
    @State private var askReplace: String?
    @State private var confirmForget = false
    /// The pairing in flight (QR, link or nearby): cancelled when the screen closes, so a request still
    /// queued or answering can never replace the stored pairing afterwards.
    @State private var pairingTask: Task<Void, Never>?
    @AppStorage("CounterpartLocalNetworkExplained") private var explained = false

    private var paired: Bool { app.status?.state == .paired && !replacing && phase != .connected }
    private var armed: Bool {
        working == nil && phase == .scanning && !paired && camera == .allowed && scenePhase == .active
            && { if case .code = nearby { return false }; return true }()
    }

    var body: some View {
        NavigationStack {
            Group {
                if phase == .connected { connected }
                else if paired { yourMac }
                else { finding }
            }
            .background(Color.black.ignoresSafeArea())
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .toolbar {
                if mode == .replace && phase != .connected {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .close) { close() } }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .task {
            if mode == .firstRun { app.holdPairingScreen = true }
            deviceName = (try? app.pairing.store.deviceName()) ?? "iPhone"
            camera = await CameraAccess.current()
            if paired { await checkMac() } else if explained { look() } else { nearby = .explain }
        }
        .onDisappear {
            pairingTask?.cancel(); pairingTask = nil
            if nearbyOwned { app.nearby.cancel(); nearbyOwned = false }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { camera = await CameraAccess.current() }
            if nearby == .localNetwork { look() }
        }
        .onChange(of: app.pendingLink, initial: true) { _, _ in takeLink() }
        .onChange(of: working == nil) { _, idle in if idle { takeLink() } }
        .alert("Pair with another Mac?", isPresented: Binding(get: { askReplace != nil }, set: { if !$0 { askReplace = nil } })) {
            Button("Pair", role: .destructive) { if let link = askReplace { replacing = true; askReplace = nil; use(link) } }
            Button("Cancel", role: .cancel) { askReplace = nil }
        } message: { Text("This phone is paired with a Mac. Pairing with another one replaces it.") }
    }

    // MARK: Finding (screens/phone-pair.jpg)

    private var finding: some View {
        ZStack {
            cameraView.ignoresSafeArea()
            ViewfinderCorners().frame(width: 270, height: 270).offset(y: -30).allowsHitTesting(false)
            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    Text("Find your Mac").font(.title2.bold())
                    Text("On your Mac, open Counterpart. Point your camera at the code it shows.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 22).padding(.vertical, 16)
                .glassEffect(.regular, in: .rect(cornerRadius: 26))
                .padding(.horizontal, 16).padding(.top, 8)
                Spacer()
                VStack(spacing: 10) {
                    status
                    nearbyCard
                }
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
            .frame(maxWidth: 520)
        }
        .foregroundStyle(.white)
    }

    /// The live camera reading the code, or why it can't.
    @ViewBuilder private var cameraView: some View {
        if camera == .allowed && QRScanner.isSupported && !cameraUnavailable {
            QRScanner(armed: armed, found: { use($0) }, unavailable: { cameraUnavailable = true })
                .id(scannerID)
                .accessibilityLabel("Camera, looking for your Mac's code")
        } else {
            ZStack {
                Color.black
                RadialGradient(colors: [Color.filament.opacity(0.18), .clear], center: .init(x: 0.5, y: 0.42), startRadius: 10, endRadius: 320)
                VStack(spacing: 12) {
                    Image(systemName: camera == .denied ? "camera.badge.ellipsis" : "qrcode.viewfinder").font(.system(size: 40))
                        .foregroundStyle(.secondary)
                    Text(camera == .denied ? "Counterpart can't use the camera." : cameraUnavailable ? "Camera unavailable" : camera == nil ? "Starting the camera…" : "This device can't read codes with its camera.")
                        .font(.headline).multilineTextAlignment(.center)
                    if camera == .denied {
                        Button("Open Settings") { openSettings() }.buttonStyle(.glass)
                    } else if cameraUnavailable || camera == .unavailable {
                        Text("Open the link from your Mac, or pair with a Mac nearby.").font(.subheadline)
                            .foregroundStyle(.secondary).multilineTextAlignment(.center)
                        if cameraUnavailable {
                            Button("Try Camera Again") { scannerID = UUID(); cameraUnavailable = false }.buttonStyle(.glass)
                        }
                    }
                }
                .frame(width: 230)
                .offset(y: -30)
            }
        }
    }

    @ViewBuilder private var nearbyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("NEARBY").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            switch nearby {
            case .idle, .searching:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Looking for your Mac on this Wi-Fi…").font(.subheadline).foregroundStyle(.secondary)
                }
            case .explain:
                Text("To find your Mac, Counterpart needs to look on your Wi-Fi.").font(.subheadline).foregroundStyle(.secondary)
                Button { explained = true; look() } label: { Text("Look on This Wi-Fi").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40) }
                    .buttonStyle(.glassProminent).controlSize(.large)
            case .found(let macs):
                ForEach(macs) { mac in
                    HStack(spacing: 14) {
                        Image(systemName: "macmini.fill").font(.title2).frame(width: 50, height: 50)
                            .glassEffect(.regular, in: .rect(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(mac.name).font(.headline)
                            Text("On this Wi-Fi · Counterpart is open").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    Button { pairNearby(mac) } label: { Text("Pair with \(mac.name)").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40) }
                        .buttonStyle(.glassProminent).controlSize(.large).disabled(working != nil)
                }
                Text("You'll both see the same 6-digit code. Click Allow on the Mac.").font(.caption).foregroundStyle(.secondary)
            case .none:
                Text("No Mac found on this Wi-Fi.").font(.headline)
                Text("Open Counterpart on your Mac, or point your camera at its code.").font(.subheadline).foregroundStyle(.secondary)
                Button("Look Again") { look() }.buttonStyle(.glass)
            case .localNetwork:
                Text("Counterpart can't look on your Wi-Fi.").font(.headline)
                Text("Turn on Local Network for Counterpart in Settings.").font(.subheadline).foregroundStyle(.secondary)
                HStack { Button("Open Settings") { openSettings() }.buttonStyle(.glassProminent); Button("Look Again") { look() }.buttonStyle(.glass) }
            case .code(let started, let name):
                Text("Pair with \(name)?").font(.headline)
                Text(NearbyCrypto.display(started.code))
                    .font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit())
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Code \(started.code.map(String.init).joined(separator: " "))")
                Text("Make sure your Mac shows the same number, then click Allow on your Mac.").font(.subheadline).foregroundStyle(.secondary)
                HStack {
                    ProgressView()
                    Text("Waiting for your Mac…").font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { cancelNearby() }.buttonStyle(.glass)
                }
            case .failed(let message):
                Text(message).font(.subheadline)
                Button("Try Again") { look() }.buttonStyle(.glass)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .animation(.smooth, value: nearby)
    }

    @ViewBuilder private var status: some View {
        switch phase {
        case .pairing:
            HStack(spacing: 12) { ProgressView(); Text("Pairing with your Mac…").font(.headline) }
                .frame(maxWidth: .infinity).padding(16).glassEffect(.regular, in: .capsule)
        case .explain(let value):
            VStack(alignment: .leading, spacing: 10) {
                Text("Your Mac is on your Wi-Fi").font(.headline)
                Text("To reach it, Counterpart needs to look on your Wi-Fi. If your iPhone asks, tap Allow.").font(.subheadline).foregroundStyle(.secondary)
                Button { explained = true; use(value) } label: { Text("Continue").frame(maxWidth: .infinity).frame(height: 36) }
                    .buttonStyle(.glassProminent)
            }
            .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        case .failed(let message, let retry):
            VStack(alignment: .leading, spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.white)
                    .symbolRenderingMode(.multicolor)
                HStack {
                    if let retry { Button("Try Again") { use(retry) }.buttonStyle(.glassProminent) }
                    Button("Scan Again") { phase = .scanning }.buttonStyle(.glass)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).glassEffect(.regular.tint(.red.opacity(0.15)), in: .rect(cornerRadius: 24))
        default: EmptyView()
        }
    }

    // MARK: Paired

    private var yourMac: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Your Mac").font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Circle().fill(reachable == true ? Color.okGreen : reachable == false ? .gray : .secondary.opacity(0.4)).frame(width: 10, height: 10)
                        Text(reachable == nil ? "Looking for your Mac…" : reachable == true ? "Connected" : refused ?? "Your phone can't reach your Mac right now.")
                            .font(.headline)
                    }
                    if let host = app.status?.host { Text(host).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary) }
                    if reachable == false && refused == nil {
                        Text("Are they on the same Wi-Fi, or is your VPN on?").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
                Button { replacing = true; phase = .scanning; if explained { look() } else { nearby = .explain } } label: {
                    Label("Connect a Different Mac", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).frame(height: 40)
                }
                .buttonStyle(.glass)
                Button(role: .destructive) { confirmForget = true } label: {
                    Label("Forget This Mac", systemImage: "trash").frame(maxWidth: .infinity).frame(height: 40)
                }
                .buttonStyle(.glass)
                .confirmationDialog("Forget this Mac?", isPresented: $confirmForget, titleVisibility: .visible) {
                    Button("Forget This Mac", role: .destructive) { forget() }
                } message: {
                    Text("This phone stops connecting to it. Your projects stay on your Mac; pair again to see them.")
                }
            }
            .padding(20)
        }
    }

    /// Removes the stored pairing; the app then opens on Find your Mac.
    private func forget() {
        pairingTask?.cancel(); pairingTask = nil
        if nearbyOwned { app.nearby.cancel(); nearbyOwned = false }
        do {
            try app.pairing.forget()
            app.showPairing = false
            app.readStatus()
            dismiss()
        } catch {
            refused = PairingWords.message(.secureStorage)
            reachable = false
        }
    }

    // MARK: Connected

    private var connected: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark").font(.system(size: 44, weight: .bold)).foregroundStyle(.white)
                .frame(width: 110, height: 110).glassEffect(.regular.tint(Color.okGreen.opacity(0.6)), in: .circle)
            Text("Connected to your Mac").font(.title.bold()).accessibilityAddTraits(.isHeader)
            Text("Your Mac designs what you need, touches up your scans and sends them to your printer.")
                .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
            Button { finish() } label: { Text(mode == .replace ? "Done" : "Continue").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                .buttonStyle(.glassProminent).controlSize(.large).padding(.horizontal, 20).padding(.bottom, 12)
        }
    }

    // MARK: Actions

    private func close() {
        pairingTask?.cancel(); pairingTask = nil
        if nearbyOwned { app.nearby.cancel(); nearbyOwned = false }
        app.showPairing = false
        dismiss()
    }

    private func finish() {
        app.holdPairingScreen = false
        app.paired()
        if mode == .replace { dismiss() }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
    }

    /// A pairing link from the app, used once: it waits while something else is pairing, and asks before
    /// replacing a paired Mac.
    private func takeLink() {
        guard working == nil, let link = app.pendingLink else { return }
        app.pendingLink = nil
        if paired { askReplace = link } else { use(link) }
    }

    /// A code from the camera or a link: parsed first, then the Wi-Fi sentence the first time, then pairing.
    private func use(_ value: String) {
        guard working == nil else { return }
        let invitation: PairingInvitation
        do { invitation = try PairingInvitation.parse(value) }
        catch { phase = .failed(PairingWords.failure(error), retry: nil); return }
        if invitation.isLocal && !explained { phase = .explain(value); return }
        pairQR(invitation, value: value)
    }

    private func pairQR(_ invitation: PairingInvitation, value: String) {
        working = .qr
        phase = .pairing
        let name = deviceName
        pairingTask = Task {
            defer { working = nil }
            do {
                _ = try await app.pairing.pair(invitation, deviceName: name)
                if Task.isCancelled { return }
                UserDefaults.standard.set(invitation.name ?? "", forKey: ProjectsStore.macNameKey)
                if nearbyOwned { app.nearby.cancel(); nearbyOwned = false }
                replacing = false
                phase = .connected
            } catch {
                let code = (error as? PairingError)?.code
                if code == .cancelled || Task.isCancelled { phase = .scanning; return }
                // The code may never have reached the Mac, so it can be tried again while it's valid.
                let retry = code == .network || code == .timeout ? value : nil
                phase = .failed(PairingWords.failure(error), retry: retry)
            }
        }
    }

    private func look() {
        if case .searching = nearby { return }
        guard working == nil else { return }
        attempt += 1
        let mine = attempt
        nearby = .searching
        nearbyOwned = true
        Task {
            do {
                let macs = try await app.nearby.browse(timeout: .seconds(3))
                guard mine == attempt else { return }
                nearby = macs.isEmpty ? .none : .found(macs)
            } catch {
                guard mine == attempt else { return }
                let code = (error as? PairingError)?.code
                if code == .cancelled { return }
                nearby = code == .localNetwork ? .localNetwork : .failed(PairingWords.failure(error))
            }
        }
    }

    private func pairNearby(_ mac: NearbyMac) {
        guard working == nil else { return }
        working = .nearby
        attempt += 1
        let mine = attempt
        let name = deviceName
        pairingTask = Task {
            defer { if mine == attempt, working == .nearby { working = nil } }
            do {
                _ = try await app.nearby.pair(with: mac, deviceName: name) { started in
                    if mine == attempt { nearby = .code(started, mac.name) }
                }
                guard mine == attempt else { return }
                UserDefaults.standard.set(mac.name, forKey: ProjectsStore.macNameKey)
                nearbyOwned = false
                app.nearby.cancel()
                replacing = false
                phase = .connected
            } catch {
                guard mine == attempt else { return }
                let code = (error as? PairingError)?.code
                if code == .cancelled { return }
                nearby = .failed(PairingWords.failure(error))
            }
        }
    }

    private func cancelNearby() {
        attempt += 1
        if working == .nearby { pairingTask?.cancel(); pairingTask = nil }
        app.nearby.cancel()
        if working == .nearby { working = nil }
        nearby = .idle
        look()
    }

    private func checkMac() async {
        do { _ = try await app.pairing.check(); reachable = true; refused = nil }
        catch {
            reachable = false
            let code = (error as? PairingError)?.code ?? .network
            refused = [.network, .timeout, .unavailable, .busy, .cancelled].contains(code) ? nil
                : PairingWords.turnedAway(code) ? PairingWords.message(.pairingRequired) : PairingWords.message(code)
        }
    }
}

/// The viewfinder's four rounded corners, in the accent colour (screens/phone-pair.jpg).
private struct ViewfinderCorners: View {
    var body: some View {
        Canvas { ctx, size in
            let l: CGFloat = 38, r: CGFloat = 22
            var p = Path()
            p.move(to: .init(x: 0, y: l)); p.addLine(to: .init(x: 0, y: r)); p.addQuadCurve(to: .init(x: r, y: 0), control: .zero); p.addLine(to: .init(x: l, y: 0))
            p.move(to: .init(x: size.width - l, y: 0)); p.addLine(to: .init(x: size.width - r, y: 0)); p.addQuadCurve(to: .init(x: size.width, y: r), control: .init(x: size.width, y: 0)); p.addLine(to: .init(x: size.width, y: l))
            p.move(to: .init(x: size.width, y: size.height - l)); p.addLine(to: .init(x: size.width, y: size.height - r)); p.addQuadCurve(to: .init(x: size.width - r, y: size.height), control: .init(x: size.width, y: size.height)); p.addLine(to: .init(x: size.width - l, y: size.height))
            p.move(to: .init(x: l, y: size.height)); p.addLine(to: .init(x: r, y: size.height)); p.addQuadCurve(to: .init(x: 0, y: size.height - r), control: .init(x: 0, y: size.height)); p.addLine(to: .init(x: 0, y: size.height - l))
            ctx.stroke(p, with: .color(Color.filament), style: .init(lineWidth: 5, lineCap: .round))
        }
        .shadow(color: Color.filament.opacity(0.6), radius: 8)
    }
}
