import SwiftUI

// Throwaway design mockup. Static data only. Not product code.

extension Color {
    static let filament = Color(red: 1.0, green: 0.45, blue: 0.18)      // Counterpart accent
    static let stageTop = Color(red: 0.13, green: 0.14, blue: 0.17)
    static let stageBottom = Color(red: 0.05, green: 0.05, blue: 0.07)
    static let okGreen = Color(red: 0.25, green: 0.84, blue: 0.47)
}

enum Stage {
    case capturing, working, needsYou, ready, preparing, printing, printed, failed
    var label: String {
        switch self {
        case .capturing: "Sending to your Mac"
        case .working: "Your Mac is working"
        case .needsYou: "Needs you"
        case .ready: "Ready to print"
        case .preparing: "Getting the print ready"
        case .printing: "Printing"
        case .printed: "Printed"
        case .failed: "Couldn't finish"
        }
    }
    var tint: Color {
        switch self {
        case .capturing, .working: .blue
        case .needsYou: .orange
        case .ready, .preparing: .filament
        case .printing: .okGreen
        case .printed: .secondary
        case .failed: .red
        }
    }
    var symbol: String {
        switch self {
        case .capturing: "arrow.up.circle"
        case .working: "wand.and.sparkles"
        case .needsYou: "hand.raised.fill"
        case .ready: "checkmark.seal.fill"
        case .preparing: "gearshape.fill"
        case .printing: "printer.fill"
        case .printed: "shippingbox.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }
}

enum Thumb { case mic, scanA, scanB }

struct Project: Identifiable {
    let id: Int
    let title: String
    let request: String
    let stage: Stage
    let status: String
    let thumb: Thumb
    let when: String
    var progress: Double? = nil
}

struct Spool: Identifiable {
    let id: String
    let material: String
    let color: Color
    let name: String
}

struct PrinterInfo: Identifiable {
    let id: Int
    let name: String
    let model: String
    let via: String
    let state: String
    let ready: Bool
    let spools: [Spool]
    let symbol: String
    // Capability profile, read from `counterpart_printer_info` (PRD §8.4). Never assumed.
    var filaments: FilamentSource = .ams
    var camera = true
    var progress = true
    var firmware = "Bambu"
    var mcpVersion = ""
}

/// Where the print sheet's colour section gets its answer (PRD §5.5, §8.4).
enum FilamentSource { case ams, single, unknown }

enum Mock {
    static let projects: [Project] = [
        Project(id: 1, title: "Mic mount", request: "Something that holds this mic on top of my monitor arm pole. Both are in the photos.", stage: .ready, status: "Ready to print · 48 × 50 × 54 mm", thumb: .mic, when: "2 min ago"),
        Project(id: 2, title: "Crochet potato", request: "Copy this. Close up the bottom and keep the stitches.", stage: .working, status: "Matching your photos · about 4 min", thumb: .scanB, when: "Now", progress: 0.62),
        Project(id: 3, title: "Cable clip", request: "Copy this clip, 20% bigger.", stage: .printing, status: "Printing on P1S · 42% · 38 min left", thumb: .scanA, when: "Now", progress: 0.42),
        Project(id: 4, title: "Plush, underside", request: "Copy this plush, including the bottom.", stage: .needsYou, status: "Needs a close-up of the underside", thumb: .scanB, when: "12 min ago"),
        Project(id: 5, title: "Potato, first try", request: "Copy this, keep the stitches.", stage: .printed, status: "Printed yesterday", thumb: .scanB, when: "Yesterday"),
        Project(id: 6, title: "Mic mount v1", request: "Something that holds this mic on my monitor arm.", stage: .printed, status: "Printed Oct 30", thumb: .mic, when: "Oct 30"),
    ]

    static let ams: [Spool] = [
        Spool(id: "A1", material: "PLA", color: Color(white: 0.08), name: "Black"),
        Spool(id: "A2", material: "PLA", color: Color(red: 0.98, green: 0.78, blue: 0.10), name: "Yellow"),
        Spool(id: "A3", material: "PETG", color: Color(red: 0.75, green: 0.92, blue: 0.86), name: "Translucent"),
        Spool(id: "A4", material: "PLA", color: Color(red: 0.42, green: 0.45, blue: 0.52), name: "Blue Grey"),
    ]

    static let printers: [PrinterInfo] = [
        PrinterInfo(id: 1, name: "P1S", model: "Bambu Lab P1S", via: "bambu-printer-mcp", state: "Ready · plate clear", ready: true, spools: ams, symbol: "printer.fill",
                    filaments: .ams, camera: true, progress: true, firmware: "Bambu · LAN", mcpVersion: "1.1.46"),
        PrinterInfo(id: 2, name: "Garage MK4", model: "Prusa MK4S", via: "mcp-3D-printer-server", state: "Ready · PLA Galaxy Black loaded", ready: true, spools: [Spool(id: "Ext", material: "PLA", color: Color(red: 0.15, green: 0.15, blue: 0.2), name: "Galaxy Black")], symbol: "printer",
                    filaments: .single, camera: false, progress: true, firmware: "Klipper · Spoolman", mcpVersion: "1.2.17"),
        PrinterInfo(id: 3, name: "Ender", model: "Creality Ender-3 V3", via: "mcp-3D-printer-server", state: "Offline", ready: false, spools: [], symbol: "printer",
                    filaments: .unknown, camera: false, progress: false, firmware: "OctoPrint", mcpVersion: "1.2.9"),
    ]

    /// The Ender when it's switched on: OctoPrint behind an older mcp-3D-printer-server,
    /// so filament is unknown and progress and camera wait for an update (PRD §8.2).
    static let enderOnline = PrinterInfo(id: 3, name: "Ender", model: "Creality Ender-3 V3", via: "mcp-3D-printer-server", state: "Ready", ready: true, spools: [], symbol: "printer",
                                         filaments: .unknown, camera: false, progress: false, firmware: "OctoPrint", mcpVersion: "1.2.9")

    /// The failed project (PRD §5.4 failed card, §9.1 `pass.failed`).
    static let failedProject = Project(id: 7, title: "Crochet potato", request: "Copy this. Close up the bottom and keep the stitches.", stage: .failed, status: "Couldn't finish · Blender closed on your Mac", thumb: .scanB, when: "4 min ago")

    static let trace: [(String, String, Bool)] = [
        ("Got your scan", "Walk-around scan, 4 photos, your note", true),
        ("Filled the gaps", "Closed the underside the camera couldn't see", true),
        ("Matching your photos", "Photo 3 shows stitches on the left side the scan smoothed over. Restoring them there only.", false),
        ("Making it printable", "", false),
        ("Measuring", "", false),
    ]

    static let failedToolLines = [
        "11:02:14  look       photo-3.jpg  left side, stitch rows",
        "11:02:31  blender    select_region  left_side  (1,412 faces)",
        "11:02:41  blender    connection closed: Blender quit",
    ]

    static let toolLines = [
        "11:02:14  look       photo-3.jpg  left side, stitch rows",
        "11:02:31  blender    select_region  left_side  (1,412 faces)",
        "11:02:33  blender    sculpt  draw_sharp  strength 0.25",
        "11:02:40  render     front, left  → compare with photo 3",
        "11:02:52  check      stitch depth 0.8 mm (photo est. 0.8 mm)",
    ]
}

/// Dark "stage" behind models.
struct StageBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [.stageTop, .stageBottom], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color.white.opacity(0.10), .clear], center: .init(x: 0.5, y: 0.62), startRadius: 4, endRadius: 220)
        }
    }
}

struct StatusCapsule: View {
    let stage: Stage
    var text: String? = nil
    var body: some View {
        Label(text ?? stage.label, systemImage: stage.symbol)
            .font(.caption.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .foregroundStyle(stage == .printed ? Color.secondary : stage.tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .glassEffect(.regular, in: .capsule)
    }
}

struct SpoolDot: View {
    let spool: Spool
    var size: CGFloat = 30
    var selected = false
    var body: some View {
        ZStack {
            Circle().fill(spool.color)
            Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1)
            Circle().fill(.black.opacity(0.35)).frame(width: size * 0.32)
        }
        .frame(width: size, height: size)
        .overlay {
            if selected { Circle().strokeBorder(Color.filament, lineWidth: 3).padding(-5) }
        }
    }
}

struct ThumbImage: View {
    let thumb: Thumb
    var body: some View {
        Color.clear.overlay { Image(asset: thumb == .mic ? "thumb-mic.png" : (thumb == .scanA ? "bed.jpg" : "thumb-potato.png")).resizable().scaledToFill() }.clipped()
    }
}

/// Fills a fixed-height box without widening the layout.
struct FillImage: View {
    let name: String
    var height: CGFloat
    var body: some View {
        Color.clear.frame(height: height).overlay { Image(asset: name).resizable().scaledToFill() }.clipped()
    }
}

func assetURL(_ name: String, _ ext: String) -> URL? { Bundle.main.url(forResource: name, withExtension: ext) }

#if os(iOS)
typealias PlatformImage = UIImage
extension Image { init(asset: String) { self.init(uiImage: UIImage(contentsOfFile: Bundle.main.path(forResource: asset, ofType: nil) ?? "") ?? UIImage()) } }
#else
typealias PlatformImage = NSImage
extension Image { init(asset: String) { self.init(nsImage: NSImage(contentsOfFile: Bundle.main.path(forResource: asset, ofType: nil) ?? "") ?? NSImage()) } }
#endif
