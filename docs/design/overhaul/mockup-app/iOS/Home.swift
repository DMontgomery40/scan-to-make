import SwiftUI

struct HomeView: View {
    @State var showNew = false
    /// No projects yet: the two jobs as cards (PRD §5.1 empty state).
    var empty = false
    @State private var query = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                if empty { EmptyHome().padding(.horizontal, 16).padding(.bottom, 24) } else {
                VStack(alignment: .leading, spacing: 26) {
                    SectionTitle("Now")
                    VStack(spacing: 12) {
                        NowPrintingCard(project: Mock.projects[2])
                        NowWorkingCard(project: Mock.projects[1])
                    }
                    SectionTitle("Needs you")
                    NeedsYouCard(project: Mock.projects[3])
                    SectionTitle("Projects")
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        ForEach([Mock.projects[0], Mock.projects[4], Mock.projects[5], Mock.projects[1]]) { ProjectCard(project: $0) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                }
            }
            .background(Color.black)
            .navigationTitle("Counterpart")
            .navigationSubtitle("Mac mini connected · 2 printers ready")
            .searchable(text: $query, prompt: "Projects, printers, notes")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { } label: { Image(systemName: "printer.fill") }
                        .badge(empty ? 0 : 1)
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    Button { } label: { Image(systemName: "person.crop.circle") }
                }
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.fixed, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) {
                    Button { showNew = true } label: { Label("New", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold).padding(.horizontal, 6) }
                        .buttonStyle(.glassProminent)
                }
            }
            .sheet(isPresented: $showNew) { NewSheet().presentationDetents([.large]) }
        }
    }
}

/// Home with no projects: each card opens New with that job preselected.
struct EmptyHome: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What do you want to make?").font(.title3.weight(.bold)).padding(.top, 6)
            JobHeroCard(thumb: .mic, title: "Make something that fits",
                        detail: "Describe it and show what it fits. Your Mac designs the part.",
                        steps: [("text.bubble.fill", "Describe it"), ("camera.fill", "Show it"), ("printer.fill", "Print it")])
            JobHeroCard(thumb: .scanB, title: "Copy something",
                        detail: "Scan it. Your Mac fixes what the scanner missed.",
                        steps: [("cube.transparent.fill", "Scan it"), ("wand.and.sparkles", "Fixed for you"), ("printer.fill", "Print it")])
            Label("You'll get a notification when it's ready.", systemImage: "bell.badge")
                .font(.footnote).foregroundStyle(.secondary).padding(.top, 4).padding(.horizontal, 4)
        }
    }
}

struct JobHeroCard: View {
    let thumb: Thumb, title: String, detail: String
    let steps: [(String, String)]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ModelStage(thumb: thumb, yaw: thumb == .mic ? 0.75 : 1.25, pitch: -0.3, interactive: false, fit: thumb == .mic ? 0.2 : 0.22)
                .frame(height: 132)
                .overlay(alignment: .bottomLeading) {
                    HStack(spacing: 6) {
                        ForEach(steps, id: \.1) { s in
                            Label(s.1, systemImage: s.0).labelStyle(.titleAndIcon).font(.caption2.weight(.semibold))
                                .padding(.horizontal, 9).padding(.vertical, 5).glassEffect(.regular, in: .capsule)
                        }
                    }
                    .padding(12)
                }
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.title3.weight(.semibold))
                    Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").font(.headline).foregroundStyle(.white)
                    .frame(width: 40, height: 40).glassEffect(.regular.tint(Color.filament).interactive(), in: .circle)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
        }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .clipShape(.rect(cornerRadius: 28))
    }
}

struct SectionTitle: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View { Text(text).font(.title3.weight(.bold)).foregroundStyle(.white) }
}

struct MacPill: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Color.okGreen).frame(width: 8, height: 8)
            Text("Mac mini").font(.subheadline.weight(.semibold))
        }
        .padding(.horizontal, 6)
    }
}

struct NowPrintingCard: View {
    let project: Project
    var body: some View {
        HStack(spacing: 14) {
            ZStack(alignment: .topLeading) {
                FillImage(name: "bed.jpg", height: 96).frame(width: 96)
                Text("3 s ago").font(.system(size: 9, weight: .heavy)).padding(.horizontal, 5).padding(.vertical, 2).background(.black.opacity(0.6), in: .capsule).padding(6)
            }
            .clipShape(.rect(cornerRadius: 18))
            VStack(alignment: .leading, spacing: 6) {
                HStack { Text(project.title).font(.headline); Spacer(); Text("42%").font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen) }
                Text("P1S · layer 84 of 212 · 38 min left").font(.subheadline).foregroundStyle(.secondary)
                ProgressView(value: 0.42).tint(.okGreen)
                HStack(spacing: 6) {
                    SpoolDot(spool: Mock.ams[0], size: 14); Text("PLA Black").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
    }
}

struct NowWorkingCard: View {
    let project: Project
    var body: some View {
        HStack(spacing: 14) {
            ThumbImage(thumb: project.thumb).frame(width: 96, height: 96).clipShape(.rect(cornerRadius: 18))
            VStack(alignment: .leading, spacing: 6) {
                HStack { Text(project.title).font(.headline); Spacer(); Text("~4 min").font(.subheadline.monospacedDigit()).foregroundStyle(.blue) }
                Text("Matching your photos: restoring stitches on the left side").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                ProgressView(value: 0.62).tint(.blue)
                Text("Step 3 of 5 · your Mac · Claude").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
    }
}

struct NeedsYouCard: View {
    let project: Project
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ThumbImage(thumb: project.thumb).frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.title).font(.headline)
                    Text("“Can you send a close-up of the underside? The scan never saw the bottom.”")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button { } label: { StackLabel(text: "Camera", symbol: "camera.fill") }.buttonStyle(.glassProminent)
                    Button { } label: { StackLabel(text: "Photos", symbol: "photo") }.buttonStyle(.glass)
                    Button { } label: { StackLabel(text: "Best guess", symbol: "sparkles") }.buttonStyle(.glass)
                }
                .controlSize(.large)
                .labelStyle(.titleAndIcon)
                .font(.footnote.weight(.semibold))
            }
        }
        .padding(14)
        .glassEffect(.regular.tint(.orange.opacity(0.18)), in: .rect(cornerRadius: 26))
    }
}

struct ProjectCard: View {
    let project: Project
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ThumbImage(thumb: project.thumb)
                .frame(height: 150)
                .overlay(alignment: .topLeading) { StatusCapsule(stage: project.stage, text: project.stage == .printed ? "Printed" : nil).padding(8) }
            VStack(alignment: .leading, spacing: 2) {
                Text(project.title).font(.headline)
                Text(project.when).font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
        }
        .background(Color(white: 0.09))
        .clipShape(.rect(cornerRadius: 24))
    }
}

// MARK: New

struct NewSheet: View {
    @State private var text = "A cup holder that clamps on this stroller handle. Fits a 90 mm cup, opening facing up."
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What do you need?").font(.headline)
                        TextField("A hook for my stroller handle…", text: $text, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(14)
                            .glassEffect(.regular, in: .rect(cornerRadius: 20))
                        Text("Describe it, scan it, or both. Your Mac can look up published sizes, like a phone or a mic.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }

                    Text("Show it").font(.headline)
                    RigTile()
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        SourceTile(symbol: "cube.transparent", title: "Scan it", detail: "Walk around it. LiDAR measures it.", tint: .filament, hero: true)
                        SourceTile(symbol: "hand.raised.fingers.spread", title: "Scan in hand", detail: "Hold it up and turn it.", tint: .blue)
                        SourceTile(symbol: "camera", title: "Take photos", detail: "A few angles is plenty.", tint: .purple)
                        SourceTile(symbol: "photo.on.rectangle.angled", title: "From Photos", detail: "Pick what you have.", tint: .green)
                    }

                    Text("Added").font(.headline)
                    HStack(spacing: 10) {
                        AttachmentChip(image: "photo1.jpg", label: "Scan · 42 s")
                        AttachmentChip(image: "photo3.jpg", label: "Photo")
                        Spacer()
                    }
                }
                .padding(20)
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { } }
            }
            .safeAreaInset(edge: .bottom) {
                Button { } label: { Label("Send to Mac mini", systemImage: "arrow.up").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40) }
                    .buttonStyle(.glassProminent).controlSize(.large).padding(.horizontal, 20)
            }
        }
    }
}

struct RigTile: View {
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "rotate.3d.fill").font(.title2.weight(.semibold)).foregroundStyle(Color.okGreen)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.tint(Color.okGreen.opacity(0.25)), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) { Text("On a scan rig").font(.headline); Text("BEST QUALITY").font(.caption2.weight(.bold)).foregroundStyle(Color.okGreen) }
                Text("Clamp your phone to the 360° rig and swing it around.").font(.caption).foregroundStyle(.secondary)
                Text("Don't have one? Print the rig by Kass 3D →").font(.caption.weight(.semibold)).foregroundStyle(Color.filament)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
    }
}

struct StackLabel: View {
    let text: String, symbol: String
    var body: some View {
        VStack(spacing: 4) { Image(systemName: symbol); Text(text).lineLimit(1).minimumScaleFactor(0.8) }
            .frame(maxWidth: .infinity).padding(.vertical, 4)
    }
}

struct SourceTile: View {
    let symbol: String, title: String, detail: String, tint: Color
    var hero = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol).font(.title2.weight(.semibold)).foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.tint(tint.opacity(0.25)), in: .circle)
            Text(title).font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
        .padding(14)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
    }
}

struct AttachmentChip: View {
    let image: String, label: String
    var body: some View {
        VStack(spacing: 6) {
            Image(asset: image).resizable().scaledToFill().frame(width: 76, height: 76).clipShape(.rect(cornerRadius: 16))
                .overlay(alignment: .topTrailing) { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6)).padding(4) }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

// MARK: iPad / unfolded Duo

struct SplitHome: View {
    var body: some View {
        NavigationSplitView {
            List {
                Section("Now") {
                    SidebarRow(project: Mock.projects[2]); SidebarRow(project: Mock.projects[1])
                }
                Section("Needs you") { SidebarRow(project: Mock.projects[3]) }
                Section("Ready") { SidebarRow(project: Mock.projects[0]).listRowBackground(Color.filament.opacity(0.18)) }
                Section("Printed") { SidebarRow(project: Mock.projects[4]); SidebarRow(project: Mock.projects[5]) }
            }
            .navigationTitle("Counterpart")
            .navigationSubtitle("Mac mini connected")
            .toolbar {
                ToolbarItem(placement: .bottomBar) {
                    Button { } label: { Label("New", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold) }.buttonStyle(.glassProminent)
                }
            }
        } detail: {
            NavigationStack { ProjectView(project: Mock.projects[0]) }
        }
    }
}

struct SidebarRow: View {
    let project: Project
    var body: some View {
        HStack(spacing: 12) {
            ThumbImage(thumb: project.thumb).frame(width: 44, height: 44).clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(project.title).font(.body.weight(.semibold))
                Text(project.status).font(.caption).foregroundStyle(project.stage.tint).lineLimit(1)
            }
        }
    }
}
