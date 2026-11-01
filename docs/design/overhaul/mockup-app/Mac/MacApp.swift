import SwiftUI

@main
struct CounterpartMacMock: App {
    var body: some Scene {
        let screen = UserDefaults.standard.string(forKey: "screen") ?? "main"
        WindowGroup {
            Group {
                switch screen {
                case "popover": MenuPopoverMock().frame(width: 360)
                case "devices": DevicesSettingsMock().frame(width: 620, height: 460)
                case "print": MacMainWindow().frame(width: 1320, height: 820).sheet(isPresented: .constant(true)) { MacPrintSheet() }
                default: MacMainWindow().frame(width: 1320, height: 820)
                }
            }
            .tint(.filament)
            .preferredColorScheme(.dark)
        }
        .windowResizability(.contentSize)
    }
}

struct MacMainWindow: View {
    @State private var selection: Int? = 1
    @State private var inspector = true
    @State private var note = ""
    @State private var tab = 0

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Now") {
                    MacRow(project: Mock.projects[2]).tag(3)
                    MacRow(project: Mock.projects[1]).tag(2)
                }
                Section("Needs you") { MacRow(project: Mock.projects[3]).tag(4) }
                Section("Ready") { MacRow(project: Mock.projects[0]).tag(1) }
                Section("Printed") { MacRow(project: Mock.projects[4]).tag(5); MacRow(project: Mock.projects[5]).tag(6) }
                Section("Printers") {
                    ForEach(Mock.printers) { p in
                        Label { HStack { Text(p.name); Spacer(); Circle().fill(p.ready ? Color.okGreen : .gray).frame(width: 7, height: 7) } } icon: { Image(systemName: p.symbol) }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 260)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 8) {
                    Circle().fill(Color.okGreen).frame(width: 7)
                    Text("David's iPhone connected").font(.caption)
                    Spacer()
                    Text("Claude").font(.caption).foregroundStyle(.secondary)
                }
                .padding(10)
            }
        } detail: {
            ZStack(alignment: .bottom) {
                ModelStage(thumb: .mic, fit: 0.15)
                    .overlay(alignment: .topLeading) { StatusCapsule(stage: .ready).padding(.top, 70).padding(.leading, 24) }
                    .overlay(alignment: .topTrailing) {
                        Text("48 × 50 × 54 mm").font(.callout.monospacedDigit().weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7).glassEffect(.regular, in: .capsule).padding(28)
                    }
                    .ignoresSafeArea(edges: .top)
                GlassEffectContainer(spacing: 10) {
                    HStack(spacing: 10) {
                        HStack {
                            Image(systemName: "text.bubble").foregroundStyle(.secondary)
                            TextField("Ask for changes. Drop photos here too…", text: $note).textFieldStyle(.plain)
                        }
                        .padding(.horizontal, 16).frame(height: 44)
                        .glassEffect(.regular.interactive(), in: .capsule)
                        Button { } label: { Label("Print…", systemImage: "printer.fill").padding(.horizontal, 6).frame(height: 30) }
                            .buttonStyle(.glassProminent).controlSize(.extraLarge)
                    }
                }
                .frame(maxWidth: 680)
                .padding(24)
            }
            .navigationTitle("Mic mount")
            .navigationSubtitle("Ready to print · holds the mic on the monitor arm pole")
            .toolbar {
                ToolbarItemGroup {
                    Button { } label: { Label("Open in Blender", systemImage: "cube") }
                    Menu { Button("Bambu Studio") { }; Button("OrcaSlicer") { }; Divider(); Button("Choose Another App…") { } } label: { Label("Open in Slicer", systemImage: "slider.horizontal.3") }
                    Button { } label: { Label("Show in Finder", systemImage: "folder") }
                }
                ToolbarSpacer(.fixed)
                ToolbarItem { Button { } label: { Label("New Project", systemImage: "plus") } }
                ToolbarItem { Button { inspector.toggle() } label: { Label("Inspector", systemImage: "sidebar.trailing") } }
            }
            .inspector(isPresented: $inspector) {
                VStack(alignment: .leading, spacing: 0) {
                    Picker("", selection: $tab) { Text("Request").tag(0); Text("Activity").tag(1); Text("Print").tag(2) }
                        .pickerStyle(.segmented).labelsHidden().padding(14)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("YOUR REQUEST").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(Mock.projects[0].request)
                            Text("PHOTOS").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                                ForEach(["photo1.jpg", "photo2.jpg", "photo3.jpg", "photo4.jpg"], id: \.self) {
                                    FillImage(name: $0, height: 96).clipShape(.rect(cornerRadius: 10))
                                }
                            }
                            Text("WHAT CHANGED").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 8) {
                                Label("Cup slides over the pole top, 24 mm deep", systemImage: "plus.circle.fill")
                                Label("Snap cradle holds the mic level", systemImage: "plus.circle.fill")
                                Label("Mic size from published specs", systemImage: "ruler")
                                Label("Pole size estimated ±0.5 mm", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                            }
                            .font(.callout)
                            Text("ACTIVITY").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(Mock.toolLines, id: \.self) { Text($0).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                .inspectorColumnWidth(min: 280, ideal: 320)
            }
        }
    }
}

struct MacRow: View {
    let project: Project
    var body: some View {
        HStack(spacing: 10) {
            ThumbImage(thumb: project.thumb).frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(project.title).font(.body.weight(.medium))
                Text(project.status).font(.caption).foregroundStyle(project.stage == .printed ? .secondary : project.stage.tint).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

struct MacPrintSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Print Mic mount").font(.title2.bold())
            HStack(spacing: 10) { ForEach(Mock.printers) { p in PrinterChoiceMac(printer: p, selected: p.id == 1) } }
            HStack(alignment: .top, spacing: 16) {
                ModelStage(thumb: .mic, yaw: 0.9, pitch: -0.5, interactive: false, fit: 0.2).frame(width: 300, height: 220).clipShape(.rect(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 12) {
                    Text("Colors").font(.headline)
                    ColorMapRowMac(part: "Cup", partColor: Color(white: 0.16), spool: Mock.ams[0])
                    ColorMapRowMac(part: "Cradle", partColor: Color(red: 0.8, green: 0.62, blue: 0.36), spool: Mock.ams[1])
                    Text("Quality").font(.headline)
                    Picker("", selection: .constant(1)) { Text("Draft").tag(0); Text("Standard").tag(1); Text("Fine").tag(2) }.pickerStyle(.segmented).labelsHidden()
                    Text("1 h 12 m · 22 g · 0.20 mm · 15% infill").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            HStack {
                Toggle("Check the plate with the camera first", isOn: .constant(true))
                Spacer()
                Button("Cancel") { }.controlSize(.large)
                Button("Print on P1S") { }.buttonStyle(.glassProminent).controlSize(.large)
            }
        }
        .padding(24)
        .frame(width: 720)
    }
}

struct PrinterChoiceMac: View {
    let printer: PrinterInfo, selected: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Image(systemName: printer.symbol); Text(printer.name).font(.headline); Spacer(); Circle().fill(printer.ready ? Color.okGreen : .gray).frame(width: 7) }
            Text(printer.via).font(.caption2).foregroundStyle(.secondary)
            HStack(spacing: 3) { ForEach(printer.spools.prefix(4)) { SpoolDot(spool: $0, size: 11) } }
        }
        .padding(12).frame(width: 200, alignment: .leading)
        .glassEffect(selected ? .regular.tint(Color.filament.opacity(0.3)) : .regular, in: .rect(cornerRadius: 14))
        .opacity(printer.ready ? 1 : 0.5)
    }
}

struct ColorMapRowMac: View {
    let part: String, partColor: Color, spool: Spool
    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 4).fill(partColor).frame(width: 18, height: 18)
            Text(part).frame(width: 60, alignment: .leading)
            Image(systemName: "arrow.right").foregroundStyle(.secondary)
            SpoolDot(spool: spool, size: 18)
            Text("\(spool.id) · \(spool.material) \(spool.name)")
        }
    }
}

// MARK: Menu bar popover

struct MenuPopoverMock: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                AppIconMac(size: 22)
                Text("Counterpart").font(.headline)
                Spacer()
                Circle().fill(Color.okGreen).frame(width: 7)
                Text("Ready").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("Cable clip").font(.subheadline.weight(.semibold)); Spacer(); Text("42% · 38m").font(.caption.monospacedDigit()).foregroundStyle(Color.okGreen) }
                ProgressView(value: 0.42).tint(.okGreen)
                HStack { Text("Crochet potato").font(.subheadline.weight(.semibold)); Spacer(); Text("~4 min").font(.caption).foregroundStyle(.blue) }
                Text("Matching your photos").font(.caption).foregroundStyle(.secondary)
            }
            .padding(12).glassEffect(.regular, in: .rect(cornerRadius: 14))
            HStack(alignment: .top) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Plush needs a close-up").font(.subheadline.weight(.semibold))
                    Text("Asked on your iPhone too").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading).glassEffect(.regular.tint(.orange.opacity(0.15)), in: .rect(cornerRadius: 14))
            HStack(spacing: 12) {
                ForEach(Mock.printers) { p in
                    HStack(spacing: 5) { Circle().fill(p.ready ? Color.okGreen : .gray).frame(width: 6); Text(p.name).font(.caption) }
                }
            }
            Divider()
            HStack {
                Button("Open Counterpart") { }.buttonStyle(.glassProminent)
                Spacer()
                Button { } label: { Image(systemName: "qrcode") }.buttonStyle(.glass)
                Button { } label: { Image(systemName: "gearshape") }.buttonStyle(.glass)
            }
        }
        .padding(16)
    }
}

struct AppIconMac: View {
    var size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.23).fill(LinearGradient(colors: [Color.filament, Color(red: 0.85, green: 0.2, blue: 0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            RoundedRectangle(cornerRadius: size * 0.08).fill(.white).frame(width: size * 0.34, height: size * 0.5).offset(x: -size * 0.1)
            RoundedRectangle(cornerRadius: size * 0.08).strokeBorder(.white, lineWidth: size * 0.07).frame(width: size * 0.34, height: size * 0.5).offset(x: size * 0.1, y: size * 0.06)
        }.frame(width: size, height: size)
    }
}

// MARK: Settings → Phones (no duplicates)

struct DevicesSettingsMock: View {
    var body: some View {
        Form {
            Section("Phones and iPads") {
                DeviceRow(name: "David's iPhone 18 Pro", detail: "iPhone · connected now · paired Oct 30", symbol: "iphone", live: true)
                DeviceRow(name: "David's iPad Pro", detail: "iPad · last seen yesterday · paired Oct 31", symbol: "ipad", live: false)
                Button("Add a Phone…") { }
            }
            Section("Printers") {
                ForEach(Mock.printers) { p in
                    LabeledContent { Text(p.via).foregroundStyle(.secondary) } label: { Label(p.model, systemImage: p.symbol) }
                }
            }
            Section("AI") {
                LabeledContent("Touch-ups and designs") { Text("Claude · your subscription · connected").foregroundStyle(Color.okGreen) }
            }
        }
        .formStyle(.grouped)
    }
}

struct DeviceRow: View {
    let name: String, detail: String, symbol: String, live: Bool
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title2).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) { Text(name).font(.body.weight(.medium)); Text(detail).font(.caption).foregroundStyle(live ? Color.okGreen : .secondary) }
            Spacer()
            Button("Remove…") { }
        }
    }
}
