import SwiftUI
import UserNotifications
import CounterpartKit

/// First run (PRD §5.10): Welcome → Find your Mac → Notifications → Done. Each step is shown once; pairing
/// again later goes straight to Find your Mac.
enum FirstRun {
    static let welcomedKey = "CounterpartWelcomed"
    static let notificationsAskedKey = "CounterpartAskedNotifications"
}

/// Welcome (screens/phone-welcome.jpg): the two jobs, with real renders.
struct WelcomeView: View {
    let next: () -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(colors: [Color.filament.opacity(0.30), .clear], center: .init(x: 0.5, y: 0.08), startRadius: 10, endRadius: 360)
                .ignoresSafeArea()
            GeometryReader { g in
                ScrollView {
                    VStack(spacing: 0) {
                        AppIcon(size: 88)
                            .shadow(color: Color.filament.opacity(0.5), radius: 26, y: 10)
                            .padding(.top, 24)
                        Text("Counterpart").font(.largeTitle.bold()).padding(.top, 18)
                        Text("Make things that fit your life, with your iPhone, your Mac and your 3D printer.")
                            .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            .padding(.top, 8).padding(.horizontal, 28)

                        VStack(spacing: 14) {
                            WelcomeJobCard(model: nil, image: "example-fit", title: "Make something that fits",
                                           detail: "Describe it and show what it fits. Your Mac designs the part.",
                                           chips: [("text.bubble", "Describe"), ("camera", "Show")])
                            WelcomeJobCard(model: nil, image: "example-copy", title: "Copy something",
                                           detail: "Scan it. Your Mac fixes what the scanner missed and makes it printable.",
                                           chips: [("cube.transparent", "Scan"), ("wand.and.sparkles", "Fix")])
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 30)
                        Text("Either way, you'll get a notification when it's ready, and another when the print is done.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 36).padding(.top, 22).padding(.bottom, 12)
                    }
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity, minHeight: g.size.height, alignment: .center)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .safeAreaBar(edge: .bottom) {
                Button(action: next) { Text("Continue").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .padding(.horizontal, 20).padding(.bottom, 8)
                    .frame(maxWidth: 520)
                    .accessibilityIdentifier("welcome-continue")
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// One of the two jobs, with a render as its illustration.
struct WelcomeJobCard: View {
    let model: (String, String)?
    let image: String?
    let title: String, detail: String
    var chips: [(String, String)] = []

    var body: some View {
        HStack(spacing: 14) {
            Group {
                if let model {
                    ModelStage(url: Bundle.main.url(forResource: model.0, withExtension: model.1), yaw: 0.7, pitch: -0.35, interactive: false, fit: 0.27, twoTone: true)
                } else if let image {
                    ZStack { StageBackground(); Image(image).resizable().scaledToFit().scaleEffect(1.5).blendMode(.lighten) }
                }
            }
            .frame(width: 96, height: 112)
            .clipShape(.rect(cornerRadius: 18))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
                Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    ForEach(chips, id: \.1) { chip in
                        Label(chip.1, systemImage: chip.0).font(.caption2.weight(.semibold)).labelStyle(.titleAndIcon)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .glassEffect(.regular, in: .capsule)
                    }
                }
                .foregroundStyle(Color.filament)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .accessibilityElement(children: .combine)
    }
}

/// Notifications, asked with their reason (PRD §5.10 step 3, screens/phone-notify.jpg). The permission is
/// the system's; this screen only explains it first. Delivery arrives with the notifications milestone.
struct NotifyPermissionView: View {
    let done: () -> Void
    @State private var asking = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(colors: [Color.okGreen.opacity(0.16), .clear], center: .init(x: 0.5, y: 0.3), startRadius: 10, endRadius: 340).ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer(minLength: 20)
                // What they'll get, in the app's own words (§9.1).
                ZStack(alignment: .top) {
                    RoundedRectangle(cornerRadius: 22).fill(.white.opacity(0.08))
                        .frame(height: 70).padding(.horizontal, 16).offset(y: 14)
                    PreviewBanner(title: "Mic mount is ready to print", detail: "About 1 h 12 m on P1S.", when: "now")
                        .background(Color.black.opacity(0.6), in: .rect(cornerRadius: 24))
                }
                .padding(.horizontal, 20)
                .frame(height: 96, alignment: .top)
                .accessibilityHidden(true)

                Image(systemName: "bell.badge.fill").font(.system(size: 34)).symbolRenderingMode(.palette).foregroundStyle(Color.filament, .white)
                    .frame(width: 72, height: 72).glassEffect(.regular, in: .circle)
                    .padding(.top, 30)
                    .accessibilityHidden(true)
                Text("Know when it's ready").font(.title.bold()).padding(.top, 18)
                Text("So you know when it's ready and when the print is done.")
                    .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.top, 8).padding(.horizontal, 32)
                VStack(alignment: .leading, spacing: 12) {
                    BenefitRow(symbol: "checkmark.seal.fill", tint: .filament, text: "Your Mac finished a design or a scan")
                    BenefitRow(symbol: "hand.raised.fill", tint: .orange, text: "It needs a photo or a yes from you")
                    BenefitRow(symbol: "printer.fill", tint: .okGreen, text: "The print is halfway, done, or stopped")
                }
                .padding(.top, 26).padding(.horizontal, 40)
                Spacer(minLength: 20)
                GlassEffectContainer(spacing: 10) {
                    VStack(spacing: 10) {
                        Button { ask() } label: { Text("Turn On Notifications").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                            .buttonStyle(.glassProminent).disabled(asking)
                        Button(action: done) { Text("Not Now").frame(maxWidth: .infinity).frame(height: 44) }
                            .buttonStyle(.glass)
                    }
                    .controlSize(.large)
                }
                .padding(.horizontal, 20)
                Text("Choose which ones in Settings, any time.").font(.caption).foregroundStyle(.secondary).padding(.top, 10).padding(.bottom, 6)
            }
            .frame(maxWidth: 520)
        }
        .preferredColorScheme(.dark)
    }

    private func ask() {
        asking = true
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            asking = false
            done()
        }
    }
}

/// A notification as it will look, for the permission screen.
struct PreviewBanner: View {
    let title: String, detail: String, when: String
    var body: some View {
        HStack(spacing: 12) {
            AppIcon(size: 38)
            VStack(alignment: .leading, spacing: 2) {
                HStack { Text(title).font(.subheadline.weight(.semibold)).lineLimit(1); Spacer(); Text(when).font(.caption).foregroundStyle(.secondary) }
                Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

struct BenefitRow: View {
    let symbol: String, tint: Color, text: String
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 26).accessibilityHidden(true)
            Text(text).font(.subheadline)
            Spacer(minLength: 0)
        }
    }
}
