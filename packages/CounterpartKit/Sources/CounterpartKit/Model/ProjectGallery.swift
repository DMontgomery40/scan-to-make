import Foundation

/// The pictures at the top of a project's page (PRD §5.4 "Pictures"), derived from the project's data, in order: each
/// thing that will print, the result with the scanned object in place ("Together") when the pass recorded where it
/// sits, and each scan. One entry shows no control; several show a row of labels. Mirrored on Android
/// (`ProjectGallery.kt`) and Linux (`gallery.ts`), all three checked against `packages/contracts/fixtures/project-gallery.json`.
public struct ProjectGallery: Equatable, Sendable {
    public var entries: [Entry]

    public struct Entry: Equatable, Identifiable, Sendable {
        public enum Kind: String, Sendable { case part, plate, together, scan }
        public var id: String
        public var kind: Kind
        /// What a person calls it: "Your part", "Screws", "Together", "What you scanned".
        public var label: String
        public var drawing: Drawing
        /// What wears which colour (PRD §5.4): a part its spool, a scan its own photos.
        public var colour: Colour
        /// The size chip's word for what it measures: "Part", "Scan", "Together".
        public var measures: String
        /// The size the Mac measured, when it did (a result's `sizeMm`); otherwise the view measures what it draws.
        public var sizeMm: [Double]?
        /// For a scan: its photos (project paths), one tap further.
        public var photos: [String]
    }

    public enum Drawing: Equatable, Sendable {
        /// A model to turn, at a project path (`model.stl`, `scan/scan.usdz`).
        case model(String)
        /// A still: a render, a designer's plate picture. Empty when the plate has no picture yet (the placeholder).
        case picture(String)
        /// The part (a project path) with the scanned object (a project path) in each seat.
        case assembly(part: String, object: String, seats: [Project.Seat])
    }

    public enum Colour: Equatable, Sendable {
        /// No spool chosen yet: the stage's neutral material.
        case neutral
        /// The one spool it prints in, `#RRGGBB`.
        case spool(String)
        /// Its own colours: a scan's photo texture, a designer's or a design pass's picture.
        case own
    }

    /// Which entry shows first: the thing that will print once there is one, the scan before that.
    public var first: Entry? { entries.first }

    /// `parts` is the seam a project's part list will feed (several bodies, a lid on its own, one part changed or
    /// printed by itself; that model is being designed separately). Today it is `project.printableParts`.
    public init(project: Project, parts: [PrintablePart]? = nil, scanOnThisDevice: Bool = false) {
        let parts = parts ?? project.printableParts
        var entries: [Entry] = parts.map { part in
            Entry(id: part.id, kind: part.isPlate ? .plate : .part, label: part.label, drawing: part.drawing, colour: part.colour,
                  measures: part.isPlate ? "Plate" : "Part", sizeMm: part.sizeMm, photos: [])
        }
        let scans = project.scanModels(onThisDevice: scanOnThisDevice)
        // Together: the one result with the scanned object in every seat, only where the pass said where it sits.
        // Only where it is drawn right today: a USDZ scan, whose frame (metres, Y up) the stages and the Mac's picture
        // assume. A scan in another frame (a handheld STL) gets no Together until the project carries its frame.
        if let part = parts.first, parts.count == 1, case .model(let model) = part.drawing,
           let seats = project.current?.seats, !seats.isEmpty, let scan = scans.first, scan.lowercased().hasSuffix(".usdz") {
            entries.append(Entry(id: "together", kind: .together, label: "Together", drawing: .assembly(part: model, object: scan, seats: seats),
                                 colour: part.colour, measures: "Together", sizeMm: nil, photos: []))
        }
        for (index, scan) in scans.enumerated() {
            entries.append(Entry(id: "scan-\(index)", kind: .scan, label: scans.count > 1 ? "Scan \(index + 1)" : "What you scanned",
                                 drawing: .model(scan), colour: .own, measures: "Scan", sizeMm: nil, photos: project.scanPhotos))
        }
        // A copy before a spool is chosen: the scanned object in its own colours is the truest picture of it (the
        // mockup's potato), so it leads, and the project's picture is the same (§5.1). A spool puts the copy first.
        if project.usesCopyWorkflow, project.spoolColour == nil, let scan = entries.firstIndex(where: { $0.kind == .scan }) {
            entries.insert(entries.remove(at: scan), at: 0)
        }
        self.entries = entries
    }
}

/// One thing that will print, as the gallery shows it. Today a project has one result, or one per plate of a designer's
/// file; a project's own part list (being designed separately) replaces `Project.printableParts` as the source.
public struct PrintablePart: Equatable, Sendable {
    public var id: String
    public var label: String
    public var drawing: ProjectGallery.Drawing
    public var colour: ProjectGallery.Colour
    public var sizeMm: [Double]?
    public var isPlate: Bool
    public init(id: String, label: String, drawing: ProjectGallery.Drawing, colour: ProjectGallery.Colour, sizeMm: [Double]? = nil, isPlate: Bool = false) {
        self.id = id; self.label = label; self.drawing = drawing; self.colour = colour; self.sizeMm = sizeMm; self.isPlate = isPlate
    }
}

extension Project {
    /// The things that will print, from today's data: each plate of a designer's file (its own picture), or the result.
    /// A one-colour model is a model to turn in its spool's colour; a multi-colour 3MF is its pass's picture until the
    /// app has each part's own mesh (the seam in `ProjectGallery.init`).
    public var printableParts: [PrintablePart] {
        if let plates, plates.count > 1 {
            // Every plate the file has is an entry; one whose picture the MCP didn't send shows the placeholder ("").
            return plates.enumerated().map { index, plate in
                PrintablePart(id: "plate-\(plate.id)", label: plate.name.isEmpty ? "Plate \(index + 1)" : plate.name,
                              drawing: .picture(plate.thumbnail ?? ""), colour: .own, isPlate: true)
            }
        }
        guard let current else { return [] }
        let label = usesCopyWorkflow ? "Your copy" : kind == "published" ? "Model" : "Your part"
        if preservesPublishedFilaments {
            // A 3MF's parts and colours are in the file, which only the printer MCP reads: its picture stands for it.
            guard let render = current.renders.first.map(Self.renderPath) ?? plates?.first?.thumbnail else { return [] }
            return [PrintablePart(id: "result", label: label, drawing: .picture(render), colour: .own, sizeMm: current.sizeMm)]
        }
        return [PrintablePart(id: "result", label: label, drawing: .model("model.stl"), colour: spoolColour.map { .spool($0) } ?? .neutral, sizeMm: current.sizeMm)]
    }

    /// The one spool the result prints in (PRD §5.4): the spool its last print was sent with, as the printer MCP reported
    /// it, else the colour the printer reported while printing it. Nil (neutral) until then, and for a print in several spools.
    public var spoolColour: String? {
        if let spools = print?.spools, !spools.isEmpty {
            let colours = Set(spools.map { Self.hex($0.colour) ?? $0.colour })
            return colours.count == 1 ? Self.hex(spools[0].colour) : nil
        }
        return print?.live?.activeFilament?.color.flatMap(Self.hex)
    }

    /// The scan models this project holds, as project paths. A project holds one today; modelled as a list.
    public func scanModels(onThisDevice: Bool = false) -> [String] {
        if let scan, ["usdz", "usdc", "usda", "stl"].contains((scan as NSString).pathExtension.lowercased()) {
            // A designer's 3MF sent as the "scan" is a model file, not a scanned object: it is the result's source.
            return ["scan/\(scan)"]
        }
        return onThisDevice ? ["scan/scan.usdz"] : []
    }

    /// The scan's photos: the ones sent with it, else its capture frames.
    public var scanPhotos: [String] {
        photos.isEmpty ? (capture ?? []).map { "capture/\($0)" } : photos.map { "photos/\($0)" }
    }

    static func renderPath(_ render: String) -> String { "renders/\(render.split(separator: "/").last ?? Substring(render))" }

    static func hex(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let digits = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard digits.count >= 6, Int(digits.prefix(6), radix: 16) != nil else { return nil }
        return "#" + digits.prefix(6).uppercased()
    }
}

extension Project {
    /// The project's picture everywhere it appears (Projects, sidebar rows, Home cards, search, notifications, the Live
    /// Activity, widgets): the gallery's first entry drawn as the object alone on the stage, by the Mac (`picture`).
    /// Until the Mac has drawn it, a designer's plate or a design's render, which are the object alone too; never a
    /// photo with its room (David, Nov 10). Nil: the neutral placeholder.
    public var picturePath: String? {
        if let picture { return picture }
        if let thumbnail = selectedPlate?.thumbnail ?? plates?.first?.thumbnail { return thumbnail }
        if let render = current?.renders.first { return Self.renderPath(render) }
        return nil
    }

    /// See it together (PRD §5.4): a part made to fit a scanned object, made before passes said where the object sits;
    /// the Mac can find it, changing nothing. Only for a USDZ scan, the one frame Together is drawn in today (§6.1).
    public var canLocate: Bool {
        kind == "fit" && (scan?.lowercased().hasSuffix(".usdz") ?? false) && current != nil && !preservesPublishedFilaments
            && (current?.seats ?? []).isEmpty && state != .printing && state != .touchingUp
    }

    /// What a stage fetches to draw a scan (PRD §5.4). Nov 10: every "What you scanned" on David's phone was blank; one
    /// rebuild was 192 MB, the Mac refused it, and the stage had nothing else to draw.
    public enum ScanModel: Equatable, Sendable {
        /// A file this device may fetch: `scan/<name>`.
        case file(String)
        /// Every file of this scan is larger than this device takes: its picture stays, and says so.
        case tooLarge
        /// No scan model to fetch.
        case none
    }

    /// The scan model a stage draws, never a file over `limit` (the bytes this device downloads). What you scanned draws
    /// the phone's own model when a Mac rebuild sits beside it: made to be shown on a phone, a few MB where the rebuild
    /// can be hundreds. Together draws the scan itself, the frame its seats are in (docs/protocols/seats.md); the two
    /// models' frames differ. A Mac that doesn't list its scan files is asked for the scan as before; a refusal leaves
    /// the picture.
    public func scanModel(together: Bool = false, limit: Double) -> ScanModel {
        guard let scan, ["usdz", "usdc", "usda", "stl"].contains((scan as NSString).pathExtension.lowercased()) else { return .none }
        guard let files = scanFiles else { return .file("scan/\(scan)") }
        for name in together ? [scan] : ["phone-preview.usdz", scan] {
            if let file = files.first(where: { $0.name == name }), file.bytes <= limit { return .file("scan/\(name)") }
        }
        return files.contains { $0.name == scan } ? .tooLarge : .none
    }

    /// The page's picture when the gallery has nothing yet (photos sent, no scan model or result): the subject the Mac
    /// cut out of the photo, the same picture the project's card shows.
    public var photoPicture: String? { pictures?["photo"] }

    /// The Mac's picture of one gallery entry, for layouts that show pictures rather than a model to turn.
    public func picture(for entry: ProjectGallery.Entry) -> String? {
        switch entry.kind {
        case .part: if case .picture(let path) = entry.drawing { return path }; return pictures?["part"] ?? current?.renders.first.map(Self.renderPath)
        case .plate: if case .picture(let path) = entry.drawing { return path }; return nil
        case .together: return pictures?["together"]
        case .scan: return pictures?["scan"] ?? pictures?["photo"]
        }
    }
}

extension ProjectGallery.Entry {
    /// The size chip: what it measures and its size ("Part · 213 × 43 × 82 mm"), when the size is known.
    public func sizeText(_ measured: [Double]? = nil) -> String? {
        guard let size = Format.size(measured ?? sizeMm ?? []) else { return nil }
        return "\(measures) · \(size)"
    }
}

/// Which stage keeps a part readable (PRD §5.4): the dark stage, or a light one when the part's colour would be a
/// silhouette on it (black, a dark slate blue). The one with more contrast for the part's colour (WCAG relative
/// luminance), so white and yellow stay on the dark stage and black moves to the light one. Every layout and the
/// Mac's pictures use the same rule (`mac-reconstruct picture`, Linux `gallery.ts`).
public enum StageContrast {
    /// The stages' own colours, `#RRGGBB`: the dark stage's middle and the light stage's middle.
    public static let dark = "#22242B"
    public static let light = "#C8CACF"

    /// True when the part reads better on the light stage. Neutral and own colours stay on the dark stage.
    public static func lightStage(for colour: ProjectGallery.Colour) -> Bool {
        guard case .spool(let hex) = colour else { return false }
        return lightStage(hex: hex)
    }

    public static func lightStage(hex: String) -> Bool {
        guard let part = luminance(hex), let onDark = luminance(dark), let onLight = luminance(light) else { return false }
        return ratio(part, onLight) > ratio(part, onDark)
    }

    static func ratio(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }

    static func luminance(_ hex: String) -> Double? {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count >= 6, let value = Int(digits.prefix(6), radix: 16) else { return nil }
        func channel(_ shift: Int) -> Double {
            let c = Double((value >> shift) & 255) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }
}
