import SwiftUI

// MARK: Print sheet

struct PrintSheet: View {
    @State private var printer = 1
    @State private var quality = 1
    @State private var strength = 0
    @State private var checkPlate = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    // Printer picker
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(Mock.printers) { p in PrinterChoice(printer: p, selected: p.id == printer) }
                        }
                        .padding(.horizontal, 20)
                    }
                    .padding(.horizontal, -20)

                    // Plate preview
                    ZStack(alignment: .bottomLeading) {
                        ModelStage(thumb: .mic, yaw: 0.9, pitch: -0.5, interactive: false)
                            .frame(height: 220)
                            .overlay(alignment: .bottom) { PlateGrid().frame(height: 70).opacity(0.5).allowsHitTesting(false) }
                            .clipShape(.rect(cornerRadius: 24))
                        HStack(spacing: 8) {
                            Metric(symbol: "clock", text: "1 h 12 m")
                            Metric(symbol: "scalemass", text: "22 g")
                            Metric(symbol: "square.stack.3d.up", text: "212 layers")
                        }
                        .padding(12)
                    }

                    // Colours
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Text("Colors").font(.headline); Spacer(); Text("AMS · 4 slots").font(.caption).foregroundStyle(.secondary) }
                        ColorMapRow(part: "Cup", partColor: Color(white: 0.16), spool: Mock.ams[0], grams: "14 g")
                        ColorMapRow(part: "Cradle", partColor: Color(red: 0.8, green: 0.62, blue: 0.36), spool: Mock.ams[1], grams: "8 g")
                        HStack(spacing: 16) {
                            ForEach(Mock.ams) { s in
                                VStack(spacing: 4) {
                                    SpoolDot(spool: s, size: 34, selected: s.id == "A2")
                                    Text("\(s.id) \(s.material)").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 4)
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                    // Quality
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Quality").font(.headline)
                        Picker("Quality", selection: $quality) { Text("Draft").tag(0); Text("Standard").tag(1); Text("Fine").tag(2) }.pickerStyle(.segmented)
                        Text("Strength").font(.headline)
                        Picker("Strength", selection: $strength) { Text("Standard").tag(0); Text("Strong").tag(1); Text("Max").tag(2) }.pickerStyle(.segmented)
                        Text("0.20 mm layers · 2 walls · 15% infill · Bambu PLA Basic profile").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                    Toggle(isOn: $checkPlate) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Check the plate first")
                            Text("Your Mac looks through the printer camera. You'll only hear about it if something's there.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
                .padding(20)
                .padding(.bottom, 80)
            }
            .navigationTitle("Print Mic mount")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { } }
                ToolbarItem(placement: .topBarTrailing) { Button { } label: { Image(systemName: "slider.horizontal.3") } }
            }
            .safeAreaInset(edge: .bottom) {
                Button { } label: {
                    VStack(spacing: 0) {
                        Text("Print on P1S").fontWeight(.semibold)
                        Text("Done around 1:24 PM").font(.caption).opacity(0.8)
                    }
                    .frame(maxWidth: .infinity).frame(height: 44)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.horizontal, 20)
            }
        }
        .presentationDetents([.large])
    }
}

struct PrinterChoice: View {
    let printer: PrinterInfo
    let selected: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: printer.symbol).font(.title3)
                Spacer()
                Circle().fill(printer.ready ? Color.okGreen : .gray).frame(width: 8, height: 8)
            }
            Text(printer.name).font(.headline)
            Text(printer.model).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 3) {
                ForEach(printer.spools.prefix(4)) { SpoolDot(spool: $0, size: 12) }
                if printer.spools.isEmpty { Text("Offline").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .frame(width: 136, alignment: .leading)
        .padding(14)
        .glassEffect(selected ? .regular.tint(Color.filament.opacity(0.35)).interactive() : .regular.interactive(), in: .rect(cornerRadius: 22))
        .overlay { if selected { RoundedRectangle(cornerRadius: 22).strokeBorder(Color.filament, lineWidth: 2) } }
        .opacity(printer.ready ? 1 : 0.5)
    }
}

struct ColorMapRow: View {
    let part: String, partColor: Color, spool: Spool, grams: String
    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6).fill(partColor).frame(width: 26, height: 26).overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.2)) }
            Text(part).font(.body)
            Spacer()
            Image(systemName: "arrow.right").font(.caption).foregroundStyle(.secondary)
            SpoolDot(spool: spool, size: 26)
            VStack(alignment: .leading, spacing: 0) {
                Text("\(spool.id) · \(spool.material) \(spool.name)").font(.subheadline)
                Text(grams).font(.caption).foregroundStyle(.secondary)
            }
            .frame(width: 128, alignment: .leading)
        }
    }
}

struct Metric: View {
    let symbol: String, text: String
    var body: some View {
        Label(text, systemImage: symbol).font(.caption.weight(.semibold).monospacedDigit())
            .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule)
    }
}

struct PlateGrid: View {
    var body: some View {
        Canvas { ctx, size in
            for i in 0...14 {
                let x = size.width * CGFloat(i) / 14
                var p = Path(); p.move(to: .init(x: size.width/2 + (x - size.width/2) * 0.55, y: 0)); p.addLine(to: .init(x: x, y: size.height))
                ctx.stroke(p, with: .color(.white.opacity(0.18)), lineWidth: 1)
            }
            for j in 0...4 {
                let y = size.height * CGFloat(j) / 4
                var p = Path(); p.move(to: .init(x: 0, y: y)); p.addLine(to: .init(x: size.width, y: y))
                ctx.stroke(p, with: .color(.white.opacity(0.12)), lineWidth: 1)
            }
        }
    }
}

// MARK: Plate check (only shown when something is on the plate)

struct PlateCheckSheet: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("Something's on the plate").font(.title2.bold())
            }
            Text("Your P1S camera sees something near the front left. Take it off and I'll look again.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            FillImage(name: "bed.jpg", height: 260)
                .overlay(alignment: .bottomLeading) {
                    RoundedRectangle(cornerRadius: 10).strokeBorder(.orange, lineWidth: 3)
                        .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.15)))
                        .frame(width: 110, height: 70).offset(x: 40, y: -40)
                }
                .clipShape(.rect(cornerRadius: 22))
            Spacer(minLength: 0)
            GlassEffectContainer(spacing: 10) {
                VStack(spacing: 10) {
                    Button { } label: { Text("I cleared it. Look again").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40) }.buttonStyle(.glassProminent)
                    Button { } label: { Text("The plate is clear. Print anyway").frame(maxWidth: .infinity).frame(height: 40) }.buttonStyle(.glass)
                }
                .controlSize(.large)
            }
            Text("Glare, glue and the printer's own parts can fool the camera. Saying it's clear teaches it.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .presentationDetents([.fraction(0.78)])
    }
}

// MARK: Printing

struct PrintingView: View {
    let project: Project
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                FillImage(name: "bed.jpg", height: 380)
                    .overlay(alignment: .topLeading) {
                        HStack(spacing: 6) { Circle().fill(.red).frame(width: 7); Text("LIVE · P1S").font(.caption.weight(.bold)) }
                            .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule).padding(.top, 110).padding(.leading, 16)
                    }
                    .overlay(alignment: .bottomTrailing) {
                        Button { } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.buttonStyle(.glass).padding(14)
                    }
                    .ignoresSafeArea(edges: .top)

                HStack(alignment: .center, spacing: 20) {
                    ZStack {
                        Circle().stroke(.quaternary, lineWidth: 10)
                        Circle().trim(from: 0, to: 0.42).stroke(Color.okGreen, style: .init(lineWidth: 10, lineCap: .round)).rotationEffect(.degrees(-90))
                        VStack(spacing: 0) { Text("42%").font(.title.bold().monospacedDigit()); Text("printing").font(.caption).foregroundStyle(.secondary) }
                    }
                    .frame(width: 118, height: 118)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(project.title).font(.title2.bold())
                        Text("38 min left · done 12:51 PM").foregroundStyle(.secondary)
                        Text("Layer 84 of 212").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        HStack(spacing: 6) { SpoolDot(spool: Mock.ams[0], size: 14); Text("A1 PLA Black").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .padding(.horizontal, 20)

                HStack(spacing: 12) {
                    InfoTile(title: "Nozzle", value: "220 °C", symbol: "flame")
                    InfoTile(title: "Bed", value: "55 °C", symbol: "square.fill")
                    InfoTile(title: "Speed", value: "Standard", symbol: "gauge.with.dots.needle.33percent")
                }
                .padding(.horizontal, 16)

                Text("You'll get a notification when it's done, or if the printer stops.").font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20)
            }
        }
        .background(Color.black)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { } label: { Image(systemName: "chevron.left") } }
        }
        .safeAreaInset(edge: .bottom) {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button { } label: { Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity).frame(height: 36) }.buttonStyle(.glass)
                    Button(role: .destructive) { } label: { Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity).frame(height: 36) }.buttonStyle(.glass).tint(.red)
                }
                .controlSize(.large).fontWeight(.semibold)
            }
            .padding(.horizontal, 16)
        }
    }
}

// MARK: Printers

struct PrintersView: View {
    var body: some View {
        List {
            Section {
                ForEach(Mock.printers) { p in
                    HStack(spacing: 14) {
                        Image(systemName: p.symbol).font(.title2).frame(width: 48, height: 48).glassEffect(.regular, in: .rect(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(p.name).font(.headline)
                            Text(p.state).font(.subheadline).foregroundStyle(p.ready ? Color.okGreen : .secondary)
                            HStack(spacing: 4) { ForEach(p.spools) { SpoolDot(spool: $0, size: 14) } }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
            } footer: {
                Text("These come from bambu-printer-mcp and mcp-3D-printer-server on your Mac. Add or change printers there; Counterpart picks them up.")
            }
        }
        .navigationTitle("Printers")
    }
}
