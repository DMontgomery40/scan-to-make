import SwiftUI

@main
struct CounterpartMacMock: App {
    init() { Task { @MainActor in WindowCapture.runIfRequested() } }

    private let screen = UserDefaults.standard.string(forKey: "screen") ?? "main"

    var body: some Scene {
        WindowGroup {
            Group {
                switch screen {
                case "popover": MenuPopoverMock().frame(width: 360)
                case "print": MacMainWindow().frame(width: 1320, height: 820).sheet(isPresented: .constant(true)) { MacPrintSheet() }
                case "inspector-activity": MacMainWindow(tab: 1).frame(width: 1320, height: 820)
                case "inspector-print": MacMainWindow(tab: 2).frame(width: 1320, height: 820)
                case "new": MacMainWindow(newProject: true).frame(width: 1320, height: 820)
                case "devices", _ where screen.hasPrefix("settings-"): SettingsLauncher()
                default: MacMainWindow().frame(width: 1320, height: 820)
                }
            }
            .tint(.filament)
            .preferredColorScheme(.dark)
        }
        .windowResizability(.contentSize)

        Settings {
            MacSettingsView(tab: settingsTab, fusionInstalled: screen != "settings-ai-nofusion")
        }
    }

    private var settingsTab: SettingsTab {
        switch screen {
        case "settings-general": .general
        case "settings-printers": .printers
        case "settings-ai", "settings-ai-nofusion": .ai
        case "settings-advanced": .advanced
        default: .devices
        }
    }
}

struct MacMainWindow: View {
    /// Inspector tab: 0 Request, 1 Activity, 2 Print (PRD §7.2).
    @State var tab = 0
    /// New Project: the detail becomes the drop target (PRD §7.2).
    var newProject = false
    @State private var selection: Int? = 1
    @State private var inspector = true
    @State private var note = ""

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
            .onAppear { if newProject { selection = nil } }
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
            if newProject { NewProjectPane() } else { projectDetail }
        }
    }

    private var projectDetail: some View {
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
                        Group {
                            switch tab {
                            case 1: InspectorActivity()
                            case 2: InspectorPrint()
                            default: InspectorRequest()
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                    }
                }
                .inspectorColumnWidth(min: 280, ideal: 320)
            }
    }
}

struct InspectorHeading: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View { Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
}

/// Request: the request, the photos, and what changed.
struct InspectorRequest: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            InspectorHeading("YOUR REQUEST")
            Text(Mock.projects[0].request)
            InspectorHeading("PHOTOS")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(["photo1.jpg", "photo2.jpg", "photo3.jpg", "photo4.jpg"], id: \.self) {
                    FillImage(name: $0, height: 96).clipShape(.rect(cornerRadius: 10))
                }
            }
            InspectorHeading("WHAT CHANGED")
            VStack(alignment: .leading, spacing: 8) {
                Label("Cup slides over the pole top, 24 mm deep", systemImage: "plus.circle.fill")
                Label("Snap cradle holds the mic level", systemImage: "plus.circle.fill")
                Label("Mic size from published specs", systemImage: "ruler")
                Label("Pole size estimated ±0.5 mm", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
            }
            .font(.callout)
            InspectorHeading("YOUR FOLLOW-UPS")
            Text("“Make the clamp a bit tighter.” · 11:04").font(.callout).foregroundStyle(.secondary)
        }
    }
}

/// Activity: the passes, their stages, and the tool lines of each step.
struct InspectorActivity: View {
    private let pass2: [(String, String, String)] = [
        ("Read your note", "“Make the clamp a bit tighter.”", "11:04"),
        ("Tightened the clamp", "Inner diameter 25.4 → 25.0 mm", "11:05"),
        ("Made it printable", "Laid flat, no supports needed", "11:06"),
        ("Measured it", "48 × 50 × 54 mm · 22 g · 1 h 12 m on P1S", "11:07"),
    ]
    private let pass1: [(String, String, String)] = [
        ("Read your request and photos", "4 photos, no scan", "10:51"),
        ("Looked up the mic", "Published size 21 × 108 mm", "10:52"),
        ("Measured the pole from photos", "25.4 mm ±0.5", "10:53"),
        ("Designed the cup and cradle", "Blender, through bambu-printer-mcp", "10:58"),
        ("Made it printable and measured it", "", "11:00"),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PassHeader(title: "Pass 2 · Ask for changes", detail: "11:04 – 11:07 · 3 min", current: true)
            ForEach(Array(pass2.enumerated()), id: \.offset) { i, s in
                StageRow(title: s.0, detail: s.1, time: s.2, last: i == pass2.count - 1)
                if i == 1 {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(["11:05:02  blender  select  clamp_inner", "11:05:09  blender  scale  0.984  (x, z)", "11:05:20  measure  inner ⌀ 25.0 mm", "11:05:31  render   front → compare photo 1"], id: \.self) {
                            Text($0).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(white: 0.12), in: .rect(cornerRadius: 10))
                    .padding(.leading, 28).padding(.top, -6)
                }
            }
            Divider().padding(.vertical, 4)
            PassHeader(title: "Pass 1 · New project", detail: "10:51 – 11:00 · 9 min", current: false)
            ForEach(Array(pass1.enumerated()), id: \.offset) { i, s in
                StageRow(title: s.0, detail: s.1, time: s.2, last: i == pass1.count - 1)
            }
        }
    }
}

struct PassHeader: View {
    let title: String, detail: String, current: Bool
    var body: some View {
        HStack {
            Text(title).font(.headline)
            Spacer()
            Text(detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        .foregroundStyle(current ? .primary : .secondary)
    }
}

struct StageRow: View {
    let title: String, detail: String, time: String, last: Bool
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium))
                if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Text(time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
        }
    }
}

/// Print: printer, profile, colours, and the last print's events.
struct InspectorPrint: View {
    private let events: [(String, String, String, Bool)] = [
        ("10:02", "Plate checked", "Clear, so nothing was shown", false),
        ("10:03", "Started", "Heating the bed", false),
        ("10:05", "First layer's down", "", true),
        ("10:39", "Halfway", "36 min left · layer 106 of 212", true),
        ("11:14", "Done", "Took it off the plate", true),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            InspectorHeading("PRINTER")
            HStack(spacing: 10) {
                Image(systemName: "printer.fill").font(.title3).frame(width: 34, height: 34).glassEffect(.regular, in: .rect(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 1) {
                    Text("P1S").font(.headline)
                    Text("bambu-printer-mcp · ready · plate clear").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Circle().fill(Color.okGreen).frame(width: 8)
            }
            InspectorHeading("PROFILE")
            VStack(alignment: .leading, spacing: 4) {
                Text("Bambu PLA Basic @ P1S 0.4 nozzle")
                Text("Standard · 0.20 mm · 2 walls · 15% infill").font(.caption).foregroundStyle(.secondary)
            }
            InspectorHeading("COLORS")
            VStack(alignment: .leading, spacing: 8) {
                ColorMapRowMac(part: "Cup", partColor: Color(white: 0.16), spool: Mock.ams[0])
                ColorMapRowMac(part: "Cradle", partColor: Color(red: 0.8, green: 0.62, blue: 0.36), spool: Mock.ams[1])
            }
            .font(.callout)
            InspectorHeading("LAST PRINT · MIC MOUNT V1 · OCT 30")
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(events.enumerated()), id: \.offset) { _, e in
                    HStack(alignment: .top, spacing: 10) {
                        Text(e.0).font(.caption.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 36, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(e.1).font(.callout.weight(.medium))
                            if !e.2.isEmpty { Text(e.2).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if e.3 { FillImage(name: "bed.jpg", height: 30).frame(width: 40).clipShape(.rect(cornerRadius: 6)) }
                    }
                }
            }
            Button { } label: { Label("Print Again…", systemImage: "printer.fill").frame(maxWidth: .infinity) }
                .buttonStyle(.glass).controlSize(.large)
        }
    }
}

// MARK: New Project (PRD §7.2): drop photos, STL, 3MF or USDZ, or type a request.

struct NewProjectPane: View {
    @State private var text = "A wall hook for my headphones that matches this mic mount, same arm pole."
    @State private var kind = 0
    var body: some View {
        ZStack {
            StageBackground().ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                Picker("", selection: $kind) { Text("Make something that fits").tag(0); Text("Copy something").tag(1) }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 380)
                VStack(spacing: 14) {
                    HStack(spacing: 18) {
                        Image(systemName: "photo.on.rectangle.angled"); Image(systemName: "cube"); Image(systemName: "rotate.3d")
                    }
                    .font(.system(size: 30, weight: .light)).foregroundStyle(Color.filament)
                    Text("Drop photos, STL, 3MF or USDZ files").font(.title3.weight(.semibold))
                    Text("or choose them, or just describe it below").font(.callout).foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        DroppedChip(image: "photo1.jpg", name: "IMG_4021.jpg")
                        DroppedChip(image: "thumb-mic.png", name: "Mic mount.3mf")
                    }
                    .padding(.top, 6)
                }
                .frame(maxWidth: .infinity).frame(height: 300)
                .glassEffect(.regular.tint(Color.filament.opacity(0.10)), in: .rect(cornerRadius: 28))
                .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(Color.filament, style: .init(lineWidth: 2, dash: [8, 6])) }

                VStack(alignment: .leading, spacing: 8) {
                    Text("What do you need?").font(.headline)
                    TextField("A hook for my stroller handle…", text: $text, axis: .vertical)
                        .textFieldStyle(.plain).lineLimit(3...5)
                        .padding(14).glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                }
                HStack {
                    Label("It shows up on David's iPhone too.", systemImage: "iphone").font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { }.controlSize(.extraLarge)
                    Button { } label: { Text("Create Project").padding(.horizontal, 6) }.buttonStyle(.glassProminent).controlSize(.extraLarge)
                }
            }
            .frame(maxWidth: 640)
            .padding(32)
        }
        .focusEffectDisabled()
        .navigationTitle("New Project")
        .navigationSubtitle("Your Mac starts as soon as you create it")
    }
}

struct DroppedChip: View {
    let image: String, name: String
    var body: some View {
        HStack(spacing: 8) {
            Image(asset: image).resizable().scaledToFill().frame(width: 30, height: 30).clipShape(.rect(cornerRadius: 6))
            Text(name).font(.callout)
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
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
            Section {
                DeviceRow(name: "David's iPhone 18 Pro", detail: "iPhone · connected now · paired Oct 30", symbol: "iphone", live: true)
                DeviceRow(name: "David's iPad Pro", detail: "iPad · last seen yesterday · paired Oct 31", symbol: "ipad", live: false)
                Button("Add a Phone…") { }
            } header: { Text("Phones and iPads") } footer: {
                Text("Pairing a phone again replaces its row. It never adds a second one.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .focusEffectDisabled()
        .frame(height: 300)
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
