import SwiftUI

// MARK: Lock Screen (approximation: real Live Activities and notifications are drawn by the system)

struct LockScreenMock: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.10, green: 0.12, blue: 0.30), Color(red: 0.45, green: 0.18, blue: 0.10)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 12) {
                // Dynamic Island, compact
                HStack(spacing: 8) {
                    ZStack {
                        Circle().stroke(.white.opacity(0.25), lineWidth: 3)
                        Circle().trim(from: 0, to: 0.42).stroke(Color.okGreen, style: .init(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
                    }.frame(width: 18, height: 18)
                    Spacer()
                    Text("38m").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(Color.okGreen)
                }
                .padding(.horizontal, 12)
                .frame(width: 210, height: 36)
                .background(.black, in: .capsule)
                .padding(.top, 2)

                Text("Sunday, November 1").font(.title3.weight(.semibold)).foregroundStyle(.white.opacity(0.85)).padding(.top, 20)
                Text("9:41").font(.system(size: 96, weight: .bold, design: .rounded)).foregroundStyle(.white.opacity(0.9))

                Spacer()

                // Notification: ready to print, with actions expanded
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 10) {
                        AppIconMock(size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text("COUNTERPART").font(.caption2.weight(.semibold)).foregroundStyle(.secondary); Spacer(); Text("now").font(.caption2).foregroundStyle(.secondary) }
                            Text("Mic mount is ready to print").font(.subheadline.weight(.semibold))
                            Text("Fits the pole top, 48 × 50 × 54 mm. About 1 h 12 m on P1S.").font(.subheadline)
                        }
                        Image(asset: "thumb-mic.png").resizable().scaledToFill().frame(width: 48, height: 48).clipShape(.rect(cornerRadius: 8))
                    }
                    .padding(14)
                    Divider()
                    HStack(spacing: 0) {
                        Text("Print").frame(maxWidth: .infinity).padding(.vertical, 11)
                        Divider().frame(height: 40)
                        Text("Ask for Changes…").frame(maxWidth: .infinity).padding(.vertical, 11)
                    }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Color.filament)
                }
                .glassEffect(.regular, in: .rect(cornerRadius: 24))

                // Live Activity
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        AppIconMock(size: 26)
                        Text("Cable clip").font(.headline)
                        Spacer()
                        Text("38 min left").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Color.okGreen)
                    }
                    ProgressView(value: 0.42).tint(.okGreen)
                    HStack {
                        Label("P1S · layer 84/212", systemImage: "printer.fill").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 6) {
                            Image(systemName: "pause.fill").frame(width: 30, height: 30).glassEffect(.regular.interactive(), in: .circle)
                            Image(systemName: "video.fill").frame(width: 30, height: 30).glassEffect(.regular.interactive(), in: .circle)
                        }
                        .font(.caption)
                    }
                }
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 24))

                HStack {
                    Image(systemName: "flashlight.off.fill").frame(width: 50, height: 50).glassEffect(.regular, in: .circle)
                    Spacer()
                    Image(systemName: "camera.fill").frame(width: 50, height: 50).glassEffect(.regular, in: .circle)
                }
                .padding(.horizontal, 30).padding(.top, 8)
            }
            .padding(.horizontal, 12)
            .foregroundStyle(.white)
        }
    }
}

struct AppIconMock: View {
    var size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.23).fill(LinearGradient(colors: [Color.filament, Color(red: 0.85, green: 0.2, blue: 0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            // Two interlocking parts: the object and its counterpart.
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.08).fill(.white).frame(width: size * 0.34, height: size * 0.5).offset(x: -size * 0.1)
                RoundedRectangle(cornerRadius: size * 0.08).strokeBorder(.white, lineWidth: size * 0.07).frame(width: size * 0.34, height: size * 0.5).offset(x: size * 0.1, y: size * 0.06)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: In-hand capture HUD (approximation: the live camera is replaced by a still)

struct InHandCaptureMock: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
                .background { Image(asset: "photo2.jpg").resizable().scaledToFill().ignoresSafeArea() }
                .overlay(Color.black.opacity(0.25).ignoresSafeArea())
                .opacity(0)
            GeometryReader { g in Image(asset: "photo2.jpg").resizable().scaledToFill().frame(width: g.size.width, height: g.size.height).clipped().overlay(Color.black.opacity(0.25)) }.ignoresSafeArea()

            // Object outline (from the live object mask) and coverage ring
            ZStack {
                Capsule().strokeBorder(Color.filament, style: .init(lineWidth: 3, dash: [2, 0]))
                    .frame(width: 120, height: 290).rotationEffect(.degrees(-8))
                    .shadow(color: .filament.opacity(0.8), radius: 12)
                CoverageRing(filled: 13, total: 24).frame(width: 330, height: 330)
            }
            .offset(y: -40)

            VStack {
                HStack {
                    Button { } label: { Image(systemName: "xmark") }.buttonStyle(.glass).controlSize(.large)
                    Spacer()
                    HStack(spacing: 6) {
                        Image(systemName: "camera.aperture"); Text("1/500 s · LiDAR on")
                    }
                    .font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                    Spacer()
                    Button { } label: { Image(systemName: "questionmark") }.buttonStyle(.glass).controlSize(.large)
                }
                .padding(.horizontal, 16)

                VStack(spacing: 6) {
                    Text("Turn it so the top faces you").font(.title3.bold())
                    HStack(spacing: 6) { Image(systemName: "arrow.uturn.up"); Text("Keep it inside the ring. Change your grip any time.") }
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))
                .padding(.top, 8)

                Spacer()

                HStack(spacing: 10) {
                    Label("62 sharp", systemImage: "checkmark.circle.fill").foregroundStyle(Color.okGreen)
                    Label("4 blurry, skipped", systemImage: "drop.halffull").foregroundStyle(.secondary)
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 8).glassEffect(.regular, in: .capsule)

                GlassEffectContainer(spacing: 14) {
                    HStack(spacing: 14) {
                        Picker("Mode", selection: .constant(1)) { Text("Walk around").tag(0); Text("In hand").tag(1) }
                            .pickerStyle(.segmented).frame(width: 210)
                        Button { } label: { Text("Done").fontWeight(.semibold).padding(.horizontal, 10) }.buttonStyle(.glassProminent).controlSize(.large)
                    }
                }
                .padding(.bottom, 12)
            }
        }
        .foregroundStyle(.white)
    }
}

struct CoverageRing: View {
    let filled: Int, total: Int
    var body: some View {
        ZStack {
            ForEach(0..<total, id: \.self) { i in
                Capsule().fill(i < filled ? Color.okGreen : Color.white.opacity(0.25))
                    .frame(width: 5, height: i < filled ? 22 : 14)
                    .offset(y: -165)
                    .rotationEffect(.degrees(Double(i) / Double(total) * 360))
            }
        }
    }
}


// MARK: Scan-rig capture HUD (approximation: the live camera is replaced by a render on a green backdrop)

struct RigCaptureMock: View {
    var body: some View {
        ZStack {
            ModelStage(thumb: .scanB, yaw: 1.4, pitch: -0.2, interactive: false, fit: 0.11, backdrop: Color(red: 0.16, green: 0.62, blue: 0.30))
                .ignoresSafeArea()
            // Platform edge
            Ellipse().fill(Color(red: 0.25, green: 0.42, blue: 0.62).opacity(0.85)).frame(width: 300, height: 60).offset(y: 95)
            VStack {
                HStack {
                    Button { } label: { Image(systemName: "xmark") }.buttonStyle(.glass).controlSize(.large)
                    Spacer()
                    HStack(spacing: 6) { Image(systemName: "camera.aperture"); Text("1/250 s · LiDAR on · masks ✓") }
                        .font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                    Spacer()
                    Button { } label: { Image(systemName: "questionmark") }.buttonStyle(.glass).controlSize(.large)
                }
                .padding(.horizontal, 16)

                VStack(spacing: 6) {
                    Text("Ring 1 of 3 · swing the arm slowly").font(.title3.bold())
                    Text("Shots fire by themselves every 10°. Keep going until the ring is full.").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(.horizontal, 20).padding(.vertical, 14)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))
                .padding(.top, 8).padding(.horizontal, 16)

                Spacer()

                VStack(alignment: .leading, spacing: 10) {
                    RingRow(name: "Ring 1 · clamp low, level", done: 22, total: 36, active: true)
                    RingRow(name: "Ring 2 · clamp high, tilted down", done: 0, total: 36, active: false)
                    RingRow(name: "Ring 3 · flip it over, clamp low", done: 0, total: 36, active: false)
                }
                .padding(16)
                .glassEffect(.regular, in: .rect(cornerRadius: 24))
                .padding(.horizontal, 16)

                GlassEffectContainer(spacing: 14) {
                    HStack(spacing: 14) {
                        Picker("Mode", selection: .constant(2)) { Text("Walk").tag(0); Text("In hand").tag(1); Text("Rig").tag(2) }
                            .pickerStyle(.segmented).frame(width: 230)
                        Button { } label: { Text("Done").fontWeight(.semibold).padding(.horizontal, 10) }.buttonStyle(.glassProminent).controlSize(.large)
                    }
                }
                .padding(.vertical, 12)
            }
        }
        .foregroundStyle(.white)
    }
}

struct RingRow: View {
    let name: String, done: Int, total: Int, active: Bool
    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().stroke(.white.opacity(0.2), lineWidth: 4)
                Circle().trim(from: 0, to: CGFloat(done) / CGFloat(total)).stroke(Color.okGreen, style: .init(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
            }.frame(width: 26, height: 26)
            Text(name).font(.subheadline.weight(active ? .semibold : .regular)).foregroundStyle(active ? .white : .secondary)
            Spacer()
            Text("\(done)/\(total)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}
