import SwiftUI
import CoreImage.CIFilterBuiltins

// MARK: First run (PRD §5.10): Welcome → Find your Mac → Notifications → Done.

struct WelcomeView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(colors: [Color.filament.opacity(0.30), .clear], center: .init(x: 0.5, y: 0.08), startRadius: 10, endRadius: 360)
                .ignoresSafeArea()
            GeometryReader { g in
            ScrollView {
                VStack(spacing: 0) {
                    AppIconMock(size: 88)
                        .shadow(color: Color.filament.opacity(0.5), radius: 26, y: 10)
                        .padding(.top, 24)
                    Text("Counterpart").font(.largeTitle.bold()).padding(.top, 18)
                    Text("Make things that fit your life, with your iPhone, your Mac and your 3D printer.")
                        .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .padding(.top, 8).padding(.horizontal, 28)

                    VStack(spacing: 14) {
                        JobCard(thumb: .mic, title: "Make something that fits",
                                detail: "Describe it and show what it fits. Your Mac designs the part.",
                                chips: [("text.bubble", "Describe"), ("camera", "Show")])
                        JobCard(thumb: .scanB, title: "Copy something",
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
                Button { } label: { Text("Continue").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                    .buttonStyle(.glassProminent).controlSize(.large)
                    .padding(.horizontal, 20).padding(.bottom, 8)
                    .frame(maxWidth: 520)
            }
        }
    }
}

/// One of the two jobs, with a real render as its illustration.
struct JobCard: View {
    let thumb: Thumb, title: String, detail: String
    var chips: [(String, String)] = []
    var body: some View {
        HStack(spacing: 14) {
            ModelStage(thumb: thumb, yaw: thumb == .mic ? 0.7 : 1.2, pitch: -0.35, interactive: false, fit: thumb == .mic ? 0.27 : 0.3)
                .frame(width: 96, height: 112)
                .clipShape(.rect(cornerRadius: 18))
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
                Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    ForEach(chips, id: \.1) { c in
                        Label(c.1, systemImage: c.0).font(.caption2.weight(.semibold)).labelStyle(.titleAndIcon)
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
    }
}

// MARK: Find your Mac (approximation: the live camera is replaced by a still)

struct FindMacView: View {
    var body: some View {
        ZStack {
            // The camera, drawn: a blurred desk with the Mac's pairing window held in the frame.
            GeometryReader { g in
                Image(asset: "photo2.jpg").resizable().scaledToFill().frame(width: g.size.width, height: g.size.height)
                    .blur(radius: 18).clipped().overlay(Color.black.opacity(0.45))
            }
            .ignoresSafeArea()

            PairingWindowShot()
                .rotation3DEffect(.degrees(7), axis: (x: 0.15, y: -1, z: 0), perspective: 0.25)
                .offset(y: -30)
            ViewfinderCorners().frame(width: 270, height: 270).offset(y: -30)

            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    Text("Find your Mac").font(.title2.bold())
                    Text("On your Mac, open Counterpart. Point your camera at the code it shows.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(.horizontal, 22).padding(.vertical, 16)
                .glassEffect(.regular, in: .rect(cornerRadius: 26))
                .padding(.horizontal, 16).padding(.top, 8)

                Spacer()

                VStack(alignment: .leading, spacing: 12) {
                    Text("NEARBY").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    HStack(spacing: 14) {
                        Image(systemName: "macmini.fill").font(.title2).frame(width: 50, height: 50)
                            .glassEffect(.regular, in: .rect(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("David's Mac mini").font(.headline)
                            Text("On this Wi-Fi · Counterpart is open").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    Button { } label: { Text("Pair with David's Mac mini").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40) }
                        .buttonStyle(.glassProminent).controlSize(.large)
                    Text("You'll both see the same 6-digit code. Click Allow on the Mac.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(18)
                .glassEffect(.regular, in: .rect(cornerRadius: 28))
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
            .frame(maxWidth: 520)
        }
        .foregroundStyle(.white)
    }
}

/// The Mac's pairing window as the camera sees it: the QR code and nothing else (journey.md §3.4).
struct PairingWindowShot: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Circle().fill(.red.opacity(0.85)).frame(width: 9); Circle().fill(.yellow.opacity(0.85)).frame(width: 9); Circle().fill(.green.opacity(0.85)).frame(width: 9)
                Spacer()
            }
            .padding(9)
            QRCode(text: "scantomake://pair?v=2&c=K7QX2M&f=9f3a6c21&a=192.168.1.20,mac-mini.local,100.88.4.12")
                .frame(width: 160, height: 160)
                .padding(.bottom, 22).padding(.horizontal, 22)
        }
        .frame(width: 204)
        .background(Color(white: 0.96), in: .rect(cornerRadius: 16))
        .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
    }
}

struct QRCode: View {
    let text: String
    var body: some View {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        let ctx = CIContext()
        if let out = f.outputImage, let cg = ctx.createCGImage(out, from: out.extent) {
            return AnyView(Image(decorative: cg, scale: 1).interpolation(.none).resizable().scaledToFit())
        }
        return AnyView(Color.white)
    }
}

struct ViewfinderCorners: View {
    var body: some View {
        Canvas { ctx, size in
            let l: CGFloat = 38, r: CGFloat = 22
            var p = Path()
            // top-left
            p.move(to: .init(x: 0, y: l)); p.addLine(to: .init(x: 0, y: r)); p.addQuadCurve(to: .init(x: r, y: 0), control: .zero); p.addLine(to: .init(x: l, y: 0))
            // top-right
            p.move(to: .init(x: size.width - l, y: 0)); p.addLine(to: .init(x: size.width - r, y: 0)); p.addQuadCurve(to: .init(x: size.width, y: r), control: .init(x: size.width, y: 0)); p.addLine(to: .init(x: size.width, y: l))
            // bottom-right
            p.move(to: .init(x: size.width, y: size.height - l)); p.addLine(to: .init(x: size.width, y: size.height - r)); p.addQuadCurve(to: .init(x: size.width - r, y: size.height), control: .init(x: size.width, y: size.height)); p.addLine(to: .init(x: size.width - l, y: size.height))
            // bottom-left
            p.move(to: .init(x: l, y: size.height)); p.addLine(to: .init(x: r, y: size.height)); p.addQuadCurve(to: .init(x: 0, y: size.height - r), control: .init(x: 0, y: size.height)); p.addLine(to: .init(x: 0, y: size.height - l))
            ctx.stroke(p, with: .color(Color.filament), style: .init(lineWidth: 5, lineCap: .round))
        }
        .shadow(color: Color.filament.opacity(0.6), radius: 8)
    }
}

// MARK: Notifications permission, asked with its reason (PRD §5.10 step 3)

struct NotifyPermissionView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(colors: [Color.okGreen.opacity(0.16), .clear], center: .init(x: 0.5, y: 0.3), startRadius: 10, endRadius: 340).ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer(minLength: 20)
                // A preview of what they'll get, in the app's own words (§9.1).
                ZStack(alignment: .top) {
                    RoundedRectangle(cornerRadius: 22).fill(.white.opacity(0.08))
                        .frame(height: 70).padding(.horizontal, 16).offset(y: 14)
                    PreviewBanner(title: "Mic mount is ready to print", detail: "About 1 h 12 m on P1S.", image: "thumb-mic.png", when: "now")
                        .background(Color.black.opacity(0.6), in: .rect(cornerRadius: 24))
                }
                .padding(.horizontal, 20)
                .frame(height: 96, alignment: .top)

                Image(systemName: "bell.badge.fill").font(.system(size: 34)).symbolRenderingMode(.palette).foregroundStyle(Color.filament, .white)
                    .frame(width: 72, height: 72).glassEffect(.regular, in: .circle)
                    .padding(.top, 30)
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
                        Button { } label: { Text("Turn On Notifications").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 44) }
                            .buttonStyle(.glassProminent)
                        Button { } label: { Text("Not Now").frame(maxWidth: .infinity).frame(height: 44) }
                            .buttonStyle(.glass)
                    }
                    .controlSize(.large)
                }
                .padding(.horizontal, 20)
                Text("Choose which ones in Settings, any time.").font(.caption).foregroundStyle(.secondary).padding(.top, 10).padding(.bottom, 6)
            }
            .frame(maxWidth: 520)
        }
    }
}

struct BenefitRow: View {
    let symbol: String, tint: Color, text: String
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 26)
            Text(text).font(.subheadline)
            Spacer(minLength: 0)
        }
    }
}

/// A notification banner, drawn (system UI). Used in onboarding and the Lock Screen mocks.
struct PreviewBanner: View {
    let title: String, detail: String, image: String, when: String
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            AppIconMock(size: 36)
            VStack(alignment: .leading, spacing: 1) {
                HStack { Text(title).font(.subheadline.weight(.semibold)).lineLimit(1); Spacer(minLength: 4); Text(when).font(.caption2).foregroundStyle(.secondary) }
                Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
            Image(asset: image).resizable().scaledToFill().frame(width: 40, height: 40).clipShape(.rect(cornerRadius: 8))
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}
