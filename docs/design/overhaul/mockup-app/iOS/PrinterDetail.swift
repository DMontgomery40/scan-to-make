import SwiftUI

// MARK: Printer detail (PRD §5.8): live camera, job, filament, and prints from Counterpart.

struct PrinterDetailView: View {
    let printer: PrinterInfo

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                hero
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        StatusDot(text: printer.progress ? "Printing" : "Ready", tint: .okGreen)
                        Spacer()
                        Text("\(printer.firmware) · \(printer.via) \(printer.mcpVersion)").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(printer.name).font(.largeTitle.bold())
                    Text(printer.model).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)

                if !printer.progress { updateCard.padding(.horizontal, 16) }

                if printer.progress {
                    PanelTitle("Now printing")
                    jobCard.padding(.horizontal, 16)
                }

                PanelTitle("Filament")
                filamentCard.padding(.horizontal, 16)

                PanelTitle("Printed from Counterpart")
                VStack(spacing: 0) {
                    ForEach(Array(history.enumerated()), id: \.offset) { i, h in
                        HistoryRow(thumb: h.0, title: h.1, detail: h.2, ok: h.3)
                        if i < history.count - 1 { Divider().padding(.leading, 70) }
                    }
                }
                .padding(.vertical, 6)
                .background(Color(white: 0.09), in: .rect(cornerRadius: 22))
                .padding(.horizontal, 16)

                Text("\(printer.name) comes from \(printer.via) on Mac mini. Change its settings there; Counterpart picks them up.")
                    .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20)
            }
            .padding(.bottom, 40)
        }
        .background(Color.black)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { } label: { Image(systemName: "chevron.left") } }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(printer.filaments == .ams ? "Open in Bambu Studio on Mac" : "Open \(printer.firmware) on Mac", systemImage: "slider.horizontal.3") { }
                    Button("Show MCP Settings on Mac", systemImage: "gearshape") { }
                } label: { Image(systemName: "ellipsis") }
            }
        }
    }

    private var history: [(Thumb, String, String, Bool)] {
        printer.camera
            ? [(.mic, "Mic mount v1", "Done · Oct 30 · 1 h 12 m · 22 g", true),
               (.scanB, "Potato, first try", "Done · yesterday · 3 h 40 m · 41 g", true),
               (.scanA, "Cable clip", "Paused, then finished · Oct 29", true)]
            : [(.scanA, "Cable clip", "Done · Oct 28 · 58 m", true)]
    }

    // Live camera: a photo refreshed every 3 s, labelled honestly (PRD §8.6).
    @ViewBuilder private var hero: some View {
        if printer.camera {
            FillImage(name: "bed.jpg", height: 330)
                .overlay(alignment: .topLeading) {
                    HStack(spacing: 6) { Image(systemName: "camera.fill"); Text("Updated 3 s ago").font(.caption.weight(.bold)) }
                        .padding(.horizontal, 10).padding(.vertical, 6).glassEffect(.regular, in: .capsule).padding(.top, 110).padding(.leading, 16)
                }
                .overlay(alignment: .bottomTrailing) {
                    Button { } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.buttonStyle(.glass).padding(14)
                }
                .ignoresSafeArea(edges: .top)
        } else {
            StageBackground()
                .frame(height: 300)
                .overlay {
                    VStack(spacing: 10) {
                        Image(systemName: "video.slash.fill").font(.system(size: 34)).foregroundStyle(.secondary)
                        Text("No camera yet").font(.headline).foregroundStyle(.secondary)
                    }
                    .padding(.top, 60)
                }
                .ignoresSafeArea(edges: .top)
        }
    }

    /// A missing tool says exactly which update unlocks it (PRD §8.2).
    private var updateCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "arrow.down.app.fill").font(.title2).foregroundStyle(Color.filament).frame(width: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Update mcp-3D-printer-server to see progress and camera").font(.headline).fixedSize(horizontal: false, vertical: true)
                    Text("Version \(printer.mcpVersion) on your Mac can start prints but can't report them. The update runs your own npm on Mac mini.")
                        .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack {
                Text("npm i -g mcp-3d-printer-server").font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button { } label: { Text("Update").fontWeight(.semibold).padding(.horizontal, 8) }
                    .buttonStyle(.glassProminent).controlSize(.regular)
            }
        }
        .padding(16)
        .glassEffect(.regular.tint(Color.filament.opacity(0.12)), in: .rect(cornerRadius: 24))
    }

    private var jobCard: some View {
        HStack(spacing: 14) {
            ThumbImage(thumb: .scanA).frame(width: 64, height: 64).clipShape(.rect(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 6) {
                HStack { Text("Cable clip").font(.headline); Spacer(); Text("42%").font(.headline.monospacedDigit()).foregroundStyle(Color.okGreen) }
                ProgressView(value: 0.42).tint(.okGreen)
                Text("Layer 84 of 212 · 38 min left").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(14)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24))
    }

    @ViewBuilder private var filamentCard: some View {
        switch printer.filaments {
        case .ams:
            HStack(spacing: 0) {
                ForEach(printer.spools) { s in
                    VStack(spacing: 6) {
                        SpoolDot(spool: s, size: 40, selected: s.id == "A1")
                        Text(s.id).font(.caption.weight(.semibold))
                        Text("\(s.material) \(s.name)").font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 16).padding(.horizontal, 8)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            .overlay(alignment: .topTrailing) { Text("A1 in use").font(.caption2.weight(.bold)).foregroundStyle(Color.filament).padding(10) }
        case .single:
            HStack(spacing: 12) {
                SpoolDot(spool: printer.spools[0], size: 36)
                Text("\(printer.spools[0].material) \(printer.spools[0].name)").font(.body.weight(.medium))
                Spacer()
            }
            .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        case .unknown:
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "questionmark.circle").font(.title3).foregroundStyle(.secondary)
                Text("\(printer.firmware) doesn't report its filament. You'll pick what's loaded when you print.")
                    .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(16).glassEffect(.regular, in: .rect(cornerRadius: 24))
        }
    }
}

struct PanelTitle: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View { Text(text).font(.title3.weight(.bold)).padding(.horizontal, 20).padding(.bottom, -10) }
}

struct StatusDot: View {
    let text: String, tint: Color
    var body: some View {
        HStack(spacing: 6) { Circle().fill(tint).frame(width: 8, height: 8); Text(text).font(.caption.weight(.semibold)).foregroundStyle(tint) }
            .padding(.horizontal, 10).padding(.vertical, 5).glassEffect(.regular, in: .capsule)
    }
}

struct HistoryRow: View {
    let thumb: Thumb, title: String, detail: String, ok: Bool
    var body: some View {
        HStack(spacing: 12) {
            ThumbImage(thumb: thumb).frame(width: 44, height: 44).clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(ok ? Color.okGreen : .red)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
}
