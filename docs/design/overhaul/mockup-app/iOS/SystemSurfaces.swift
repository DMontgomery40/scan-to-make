import SwiftUI

// System surfaces. The system draws the Lock Screen, Home Screen, notification chrome and the
// Dynamic Island, so these screens are approximations. The content inside them (words, frames,
// layout of the widget and Live Activity views) is the contract.

struct Wallpaper: View {
    var body: some View {
        LinearGradient(colors: [Color(red: 0.10, green: 0.12, blue: 0.30), Color(red: 0.45, green: 0.18, blue: 0.10)], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }
}

// MARK: Notifications on the Lock Screen (PRD §9.1). Every banner is shown expanded with its
// actions; on a real Lock Screen the actions appear when you press and hold one.

struct NotificationStackMock: View {
    var body: some View {
        ZStack {
            Wallpaper()
            VStack(spacing: 8) {
                VStack(spacing: 0) {
                    Text("Sunday, November 1").font(.headline).foregroundStyle(.white.opacity(0.85))
                    Text("9:41").font(.system(size: 64, weight: .bold, design: .rounded)).foregroundStyle(.white.opacity(0.9))
                }
                .padding(.top, 4).padding(.bottom, 6)

                LockNotification(title: "Mic mount is ready to print", detail: "48 × 50 × 54 mm · about 1 h 12 m on P1S",
                                 image: "thumb-mic.png", when: "now", actions: ["Print", "Ask for Changes…"])
                LockNotification(title: "Plush, underside: can you send a close-up?", detail: "The scan never saw the bottom.",
                                 image: "thumb-potato.png", when: "4m ago", actions: ["Camera", "Best Guess"], region: true)
                LockNotification(title: "Cable clip is done", detail: "Take it off the plate.",
                                 image: "bed.jpg", when: "9m ago", actions: ["Open"])
                LockNotification(title: "Cable clip is halfway", detail: "31 min left · layer 106 of 212 · P1S",
                                 image: "bed.jpg", when: "47m ago", actions: ["Open", "Pause"])
                LockNotification(title: "Something's on the P1S plate", detail: "Near the front left. Take it off and I'll look again.",
                                 image: "bed.jpg", when: "1h ago", actions: ["Look Again", "It's Clear"], region: true, urgent: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .foregroundStyle(.white)
        }
    }
}

struct LockNotification: View {
    let title: String, detail: String, image: String, when: String, actions: [String]
    var region = false
    var urgent = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                AppIconMock(size: 34)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if urgent { Text("TIME SENSITIVE").font(.caption2.weight(.semibold)).foregroundStyle(.white.opacity(0.6)) }
                        Spacer(minLength: 0)
                        Text(when).font(.caption2).foregroundStyle(.white.opacity(0.6))
                    }
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.85)
                    Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
                }
                Image(asset: image).resizable().scaledToFill().frame(width: 46, height: 46).clipShape(.rect(cornerRadius: 9))
                    .overlay {
                        if region { RoundedRectangle(cornerRadius: 4).strokeBorder(.orange, lineWidth: 2).frame(width: 20, height: 16).offset(x: -6, y: 8) }
                    }
            }
            HStack(spacing: 6) {
                ForEach(actions, id: \.self) { a in
                    Text(a).font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 6)
                        .glassEffect(.regular.interactive(), in: .capsule)
                }
            }
            .padding(.leading, 44)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

// MARK: Widgets (PRD §9.5). Sizes are Apple's for 393–402 pt wide iPhones: small 158, medium 338×158,
// Lock Screen circular 72 and rectangular 160×72.

struct WidgetsHomeMock: View {
    var body: some View {
        ZStack {
            Wallpaper()
            VStack(spacing: 22) {
                LabeledWidget(label: "Counterpart") { NowPrintingMedium().frame(width: 338, height: 158) }
                HStack(spacing: 22) {
                    LabeledWidget(label: "Counterpart") { NowPrintingSmall().frame(width: 158, height: 158) }
                    LabeledWidget(label: "Counterpart") { NeedsYouSmall().frame(width: 158, height: 158) }
                }
                HStack(spacing: 0) {
                    VStack(spacing: 6) {
                        AppIconMock(size: 62)
                        Text("Counterpart").font(.caption2.weight(.medium)).foregroundStyle(.white)
                    }
                    Spacer()
                }
                .padding(.horizontal, 32)
                Spacer()
                Label("Search", systemImage: "magnifyingglass").font(.footnote.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                    .padding(.bottom, 4)
            }
            .padding(.top, 24)
        }
    }
}

struct LabeledWidget<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 6) {
            content.clipShape(.rect(cornerRadius: 24, style: .continuous))
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(.white)
        }
    }
}

struct NowPrintingSmall: View {
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            FillImage(name: "bed.jpg", height: 158)
                .overlay(LinearGradient(colors: [.black.opacity(0.55), .clear, .black.opacity(0.9)], startPoint: .top, endPoint: .bottom))
            VStack(alignment: .leading, spacing: 2) {
                ZStack {
                    Circle().fill(.black.opacity(0.45))
                    ProgressRing(progress: 0.42, line: 4).padding(2)
                    Text("42%").font(.system(size: 11, weight: .bold).monospacedDigit())
                }
                .frame(width: 40, height: 40)
                Spacer()
                Text("Cable clip").font(.headline)
                Text("38 min left").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Color.okGreen)
                Text("P1S · 3 s ago").font(.caption2).foregroundStyle(.white.opacity(0.7))
            }
            .padding(14)
        }
        .foregroundStyle(.white)
    }
}

struct NowPrintingMedium: View {
    var body: some View {
        HStack(spacing: 14) {
            FillImage(name: "bed.jpg", height: 130).frame(width: 130).clipShape(.rect(cornerRadius: 14))
                .overlay(alignment: .topLeading) {
                    Text("3 s ago").font(.system(size: 9, weight: .heavy)).padding(.horizontal, 5).padding(.vertical, 2).background(.black.opacity(0.6), in: .capsule).padding(6)
                }
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text("Cable clip").font(.headline); Spacer(); Text("42%").font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen) }
                Text("P1S · layer 84 of 212").font(.caption).foregroundStyle(.secondary)
                ProgressView(value: 0.42).tint(.okGreen)
                Text("38 min left · done 12:51 PM").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(Color.okGreen)
                Spacer(minLength: 0)
                HStack(spacing: 6) { SpoolDot(spool: Mock.ams[0], size: 12); Text("A1 PLA Black").font(.caption2).foregroundStyle(.secondary) }
            }
            .padding(.vertical, 2)
        }
        .padding(14)
        .background(Color(white: 0.11))
        .foregroundStyle(.white)
    }
}

struct NeedsYouSmall: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Label("Needs you", systemImage: "hand.raised.fill").font(.caption2.weight(.bold)).foregroundStyle(.orange).lineLimit(1)
                Spacer(minLength: 4)
                FillImage(name: "thumb-potato.png", height: 30).frame(width: 30).clipShape(.rect(cornerRadius: 7))
            }
            Text("Plush, underside").font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            Text("Can you send a close-up of the underside?").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Spacer(minLength: 0)
            Label("Camera", systemImage: "camera.fill").font(.caption.weight(.semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(Color.filament, in: .capsule).foregroundStyle(.white)
        }
        .padding(14)
        .background(LinearGradient(colors: [Color(red: 0.24, green: 0.15, blue: 0.08), Color(white: 0.10)], startPoint: .top, endPoint: .bottom))
        .foregroundStyle(.white)
    }
}

struct ProgressRing: View {
    let progress: Double
    var line: CGFloat = 3
    var tint: Color = .okGreen
    var body: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.25), lineWidth: line)
            Circle().trim(from: 0, to: progress).stroke(tint, style: .init(lineWidth: line, lineCap: .round)).rotationEffect(.degrees(-90))
        }
    }
}

/// Lock Screen widgets render monochrome and vibrant: white at varying opacity, no brand colour.
struct WidgetsLockMock: View {
    var body: some View {
        ZStack {
            Wallpaper()
            VStack(spacing: 6) {
                Text("Sunday, November 1").font(.title3.weight(.semibold)).foregroundStyle(.white.opacity(0.85)).padding(.top, 52)
                Text("9:41").font(.system(size: 96, weight: .bold, design: .rounded)).foregroundStyle(.white.opacity(0.9))
                HStack(spacing: 14) {
                    LockCircular().frame(width: 72, height: 72)
                    LockRectangular().frame(width: 160, height: 72)
                }
                .padding(.top, 2)
                Spacer()
                HStack {
                    Image(systemName: "flashlight.off.fill").frame(width: 50, height: 50).glassEffect(.regular, in: .circle)
                    Spacer()
                    Image(systemName: "camera.fill").frame(width: 50, height: 50).glassEffect(.regular, in: .circle)
                }
                .padding(.horizontal, 42).padding(.bottom, 8)
            }
            .foregroundStyle(.white)
        }
    }
}

struct LockCircular: View {
    var body: some View {
        ZStack {
            Circle().fill(.white.opacity(0.14))
            ProgressRing(progress: 0.42, line: 5, tint: .white).padding(5)
            VStack(spacing: -1) {
                Image(systemName: "printer.fill").font(.system(size: 13, weight: .semibold))
                Text("38m").font(.system(size: 15, weight: .bold).monospacedDigit())
            }
        }
        .foregroundStyle(.white)
    }
}

struct LockRectangular: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) { Image(systemName: "printer.fill").font(.caption2); Text("Cable clip").font(.headline) }
            Text("38 min left · P1S").font(.subheadline.monospacedDigit()).opacity(0.8)
            ProgressView(value: 0.42).tint(.white).padding(.top, 2)
        }
        .padding(.horizontal, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(.white)
    }
}

// MARK: Dynamic Island (PRD §9.4). Drawn: the system owns the island's shape and placement.

struct DynamicIslandMock: View {
    var body: some View {
        ZStack(alignment: .top) {
            Wallpaper()
            VStack(spacing: 14) {
                // Expanded, where the island sits.
                IslandExpanded()
                    .padding(.horizontal, 10)
                    .padding(.top, -48)
                Text("Expanded: press and hold the island").font(.caption).foregroundStyle(.white.opacity(0.65))
                Spacer(minLength: 0)

                VStack(alignment: .leading, spacing: 20) {
                    IslandSpec(title: "Compact", detail: "The ring and minutes left") {
                        HStack(spacing: 0) {
                            ProgressRing(progress: 0.42, line: 3).frame(width: 20, height: 20)
                            Spacer()
                            Text("38m").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Color.okGreen)
                        }
                        .padding(.horizontal, 12)
                        .frame(width: 250, height: 37)
                        .background(.black, in: .capsule)
                    }
                    IslandSpec(title: "Minimal", detail: "Sharing the island with another activity") {
                        HStack(spacing: 8) {
                            Capsule().fill(.black).frame(width: 168, height: 37)
                            ProgressRing(progress: 0.42, line: 3).frame(width: 20, height: 20)
                                .frame(width: 37, height: 37).background(.black, in: .circle)
                        }
                    }
                    IslandSpec(title: "Limited width", detail: "Landscape, new in iOS 27") {
                        HStack(spacing: 8) {
                            ProgressRing(progress: 0.42, line: 3).frame(width: 18, height: 18)
                        }
                        .frame(width: 126, height: 37)
                        .background(.black, in: .capsule)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 28))
                .padding(.horizontal, 16)
                .padding(.top, 18)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
        }
        .statusBarHidden(true)
    }
}

struct IslandSpec<Content: View>: View {
    let title: String, detail: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.white.opacity(0.65))
            }
            content.frame(maxWidth: .infinity)
        }
    }
}

/// The Lock Screen layout plus the stage text (§9.4), with the camera still, Pause and Open (§5.7).
struct IslandExpanded: View {
    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                AppIconMock(size: 30)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Cable clip").font(.headline)
                    Text("Printing · layer 84 of 212").font(.caption).foregroundStyle(.white.opacity(0.65))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("38 min").font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen)
                    Text("left").font(.caption).foregroundStyle(.white.opacity(0.65))
                }
            }
            HStack(spacing: 12) {
                FillImage(name: "bed.jpg", height: 58).frame(width: 78).clipShape(.rect(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: 0.42).tint(.okGreen)
                    Label("P1S · done 12:51 PM", systemImage: "printer.fill").font(.caption).foregroundStyle(.white.opacity(0.65))
                }
                HStack(spacing: 8) {
                    Image(systemName: "pause.fill").frame(width: 38, height: 38).background(.white.opacity(0.16), in: .circle)
                    Image(systemName: "arrow.up.forward.app.fill").frame(width: 38, height: 38).background(.white.opacity(0.16), in: .circle)
                }
                .font(.subheadline)
            }
        }
        .padding(.horizontal, 22).padding(.top, 62).padding(.bottom, 18)
        .background(.black, in: .rect(cornerRadius: 46, style: .continuous))
    }
}
