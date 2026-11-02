import SwiftUI

enum ProjectSection: String, CaseIterable { case result = "Result", inputs = "What you sent", activity = "Activity" }

struct ProjectView: View {
    let project: Project
    @State var section: ProjectSection = .result
    @State private var note = ""
    @State private var showTrace = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                hero
                VStack(alignment: .leading, spacing: 6) {
                    HStack { StatusCapsule(stage: project.stage); Spacer(); Text(project.when).font(.caption).foregroundStyle(.secondary) }
                    Text(project.title).font(.largeTitle.bold())
                    Text(project.request).font(.body).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)

                if project.stage == .needsYou { askCard.padding(.horizontal, 16) }
                if project.stage == .working { workingCard.padding(.horizontal, 16) }
                if project.stage == .failed { failedCard.padding(.horizontal, 16) }

                Picker("Section", selection: $section) {
                    ForEach(ProjectSection.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)

                Group {
                    switch section {
                    case .result: resultSection
                    case .inputs: inputsSection
                    case .activity: activitySection
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 120)
        }
        .background(Color.black)
        .scrollEdgeEffectStyle(.soft, for: .all)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { } label: { Image(systemName: "chevron.left") } }
            ToolbarItem(placement: .topBarTrailing) { Button { } label: { Image(systemName: "square.and.arrow.up") } }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Open on Mac in Blender", systemImage: "cube") { }
                    Button("Open on Mac in Bambu Studio", systemImage: "slider.horizontal.3") { }
                    Button("Compare versions", systemImage: "square.split.2x1") { }
                    Divider()
                    Button("Delete Project", systemImage: "trash", role: .destructive) { }
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .safeAreaBar(edge: .bottom) { if project.stage != .needsYou && project.stage != .failed { bottomBar } }
    }

    // MARK: Hero

    private var hero: some View {
        ModelStage(thumb: project.thumb)
            .frame(height: project.stage == .failed ? 300 : 380)
            .overlay(alignment: .bottom) {
                GlassEffectContainer(spacing: 10) {
                    HStack(spacing: 10) {
                        Button { } label: { Label("AR", systemImage: "arkit") }.buttonStyle(.glass)
                        Button { } label: { Label("Compare", systemImage: "square.split.2x1") }.buttonStyle(.glass)
                        Spacer()
                        Text(project.thumb == .mic ? "48 × 50 × 54 mm" : "92 × 61 × 58 mm").font(.caption.monospacedDigit().weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 8).glassEffect(.regular, in: .capsule)
                    }
                    .labelStyle(.titleAndIcon).font(.caption.weight(.semibold))
                }
                .padding(14)
            }
            .overlay(alignment: .topTrailing) {
                Image(systemName: "rotate.3d").font(.caption).padding(8).glassEffect(.regular, in: .circle).padding(.top, 104).padding(.trailing, 14)
            }
            .ignoresSafeArea(edges: .top)
    }

    // MARK: State cards

    private var workingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "wand.and.sparkles").foregroundStyle(.blue)
                Text("Your Mac is working on it").font(.headline)
                Spacer()
                Text("about 4 min").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
            }
            ProgressView(value: 0.62).tint(.blue)
            Text("You can put your phone down. We'll let you know when it's ready.").font(.footnote).foregroundStyle(.secondary)
        }
        .padding(16)
        .glassEffect(.regular.tint(.blue.opacity(0.15)), in: .rect(cornerRadius: 24))
    }

    /// What happened and what to do, in plain words; raw codes stay under Details (PRD §2.6, §5.4).
    private var failedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Your Mac couldn't finish", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.red)
            Text("Blender closed on your Mac during the touch-up, before the stitches were restored.")
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lightbulb.fill").foregroundStyle(.yellow).frame(width: 20)
                Text("Open Blender on your Mac, then try again. Your scan and photos are kept.").font(.subheadline).foregroundStyle(.secondary)
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button { } label: { Label("Try Again", systemImage: "arrow.clockwise").fontWeight(.semibold).lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30) }
                        .buttonStyle(.glassProminent)
                    Button { } label: { Label("Open on Mac", systemImage: "macmini").lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: .infinity).frame(height: 30) }
                        .buttonStyle(.glass)
                }
                .controlSize(.large).font(.subheadline)
            }
            DisclosureGroup("Details") {
                Text("blender_mcp_call · connection closed · 11:02:41").font(.caption2.monospaced()).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
            }
            .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(16)
        .glassEffect(.regular.tint(.red.opacity(0.14)), in: .rect(cornerRadius: 24))
    }

    private var askCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Your Mac has a question", systemImage: "questionmark.bubble.fill").font(.headline).foregroundStyle(.orange)
            Text("Can you send a close-up of the underside? The scan never saw the bottom.")
            HStack(spacing: 10) {
                FillImage(name: "thumb-potato.png", height: 64).frame(width: 64).clipShape(.rect(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.orange, lineWidth: 2) }
                Text("This is the closest view I have. The bottom is in shadow.").font(.footnote).foregroundStyle(.secondary)
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button { } label: { StackLabel(text: "Camera", symbol: "camera.fill") }.buttonStyle(.glassProminent)
                    Button { } label: { StackLabel(text: "Photos", symbol: "photo") }.buttonStyle(.glass)
                    Button { } label: { StackLabel(text: "Best guess", symbol: "sparkles") }.buttonStyle(.glass)
                }
                .controlSize(.large).font(.footnote.weight(.semibold))
            }
        }
        .padding(16)
        .glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 24))
    }

    // MARK: Sections

    private var resultSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What changed").font(.headline)
            VStack(alignment: .leading, spacing: 10) {
                ChangeRow(symbol: "plus.circle.fill", tint: .green, text: "Built a cup that slides over the pole top, 24 mm deep")
                ChangeRow(symbol: "plus.circle.fill", tint: .green, text: "Added a snap cradle that holds the mic level, ports left clear")
                ChangeRow(symbol: "ruler", tint: .blue, text: "Used published size for the mic: 21 mm × 108 mm")
                ChangeRow(symbol: "exclamationmark.triangle.fill", tint: .yellow, text: "Pole diameter estimated from photos (±0.5 mm). Print a test ring first?")
            }
            .padding(16)
            .background(Color(white: 0.09), in: .rect(cornerRadius: 22))

            HStack(spacing: 12) {
                InfoTile(title: "Print time", value: "1 h 12 m", symbol: "clock")
                InfoTile(title: "Filament", value: "22 g", symbol: "scalemass")
                InfoTile(title: "Printer", value: "P1S", symbol: "printer")
            }
        }
    }

    private var inputsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your request").font(.headline)
            Text(project.request).padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(white: 0.09), in: .rect(cornerRadius: 22))
            Text("Photos and scans").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                ForEach(["photo1.jpg", "photo2.jpg", "photo3.jpg", "photo4.jpg"], id: \.self) {
                    FillImage(name: $0, height: 110).clipShape(.rect(cornerRadius: 14))
                }
            }
            Text("Your follow-ups").font(.headline)
            Text("“Make the clamp a bit tighter.”  · 11:04").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var failed: Bool { project.stage == .failed }

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Mock.trace.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 0) {
                        Image(systemName: step.2 ? "checkmark.circle.fill" : (i == 2 ? (failed ? "xmark.circle.fill" : "circle.dotted.circle") : "circle"))
                            .foregroundStyle(step.2 ? .green : (i == 2 ? (failed ? .red : .blue) : .secondary))
                            .symbolEffect(.pulse, isActive: i == 2 && !failed)
                        if i < Mock.trace.count - 1 { Rectangle().fill(.quaternary).frame(width: 2).frame(minHeight: 22) }
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.0).font(.body.weight(.semibold)).foregroundStyle(step.2 || i == 2 ? .primary : .secondary)
                        if !step.1.isEmpty { Text(step.1).font(.subheadline).foregroundStyle(.secondary) }
                        if i == 2 && showTrace {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(failed ? Mock.failedToolLines : Mock.toolLines, id: \.self) { Text($0).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                            }
                            .padding(10).background(Color(white: 0.07), in: .rect(cornerRadius: 12)).padding(.top, 6)
                        }
                    }
                    .padding(.bottom, 14)
                }
            }
        }
    }

    // MARK: Bottom bar

    @ViewBuilder private var bottomBar: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                HStack {
                    TextField("Ask for changes…", text: $note)
                    Image(systemName: "mic.fill").foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).frame(height: 50)
                .glassEffect(.regular.interactive(), in: .capsule)

                if project.stage == .ready {
                    Button { } label: { Label("Print", systemImage: "printer.fill").fontWeight(.semibold).padding(.horizontal, 8).frame(height: 36) }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }
}

struct ChangeRow: View {
    let symbol: String, tint: Color, text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 20)
            Text(text).font(.subheadline)
        }
    }
}

struct InfoTile: View {
    let title: String, value: String, symbol: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol).foregroundStyle(.secondary)
            Text(value).font(.headline.monospacedDigit())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(white: 0.09), in: .rect(cornerRadius: 20))
    }
}
