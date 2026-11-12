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
    /// A one-colour model is a model to turn in its spool's colour. A multi-part design (a 3MF a pass made) turns too, from
    /// the merged mesh beside its 3MF, in the neutral material until the MCPs report each part's colour (#645); the Mac's
    /// picture is its still (#769). A designer's published 3MF has no merged mesh: its picture stands for it.
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
        guard let mesh = partMesh else {
            // A designer's 3MF: its parts and colours are in the file, which only the printer MCP reads, and no merged mesh
            // is written beside it. A picture stands for it, the Mac's drawing of all its objects first (Nov 10: a 3MF with
            // four objects had none and couldn't be told apart). Always an entry (review B2 on #539): with no picture yet
            // ("") the stage says it is coming or that it can't be had.
            let render = pictures?["part"] ?? current.renders.first.map(Self.renderPath) ?? plates?.first?.thumbnail ?? ""
            return [PrintablePart(id: "result", label: label, drawing: .picture(render), colour: .own, sizeMm: current.sizeMm)]
        }
        // Several parts are several colours: neutral, never one spool's, until the MCPs report each part's (#645).
        let colour: ProjectGallery.Colour = preservesPublishedFilaments ? .neutral : spoolColour.map { .spool($0) } ?? .neutral
        return [PrintablePart(id: "result", label: label, drawing: .model(mesh), colour: colour, sizeMm: current.sizeMm)]
    }

    /// The mesh the part's stage turns and its AR is written from, as a project path the Mac serves (#769):
    /// - the page's own model, `model.stl`, for a one-colour design;
    /// - a sealed design's own file: `versions/<id>/touched.stl`;
    /// - for a multi-part design, the merged mesh beside its 3MF (`current/model.stl`, `versions/<id>/model.stl`), only
    ///   when the Mac lists it (`Result.mergedMesh`, there only while the file is: review of #770).
    /// Nil for a designer's published 3MF, and for a 3MF whose merged mesh isn't listed (none was written, or an older Mac
    /// that doesn't say): the stage shows its picture, as before #769, never a 3D model that can't come.
    /// `model.stl` stays the route for the file that prints (the 3MF itself for a multi-part design): Share and Print use it.
    public var partMesh: String? {
        guard let model = current?.model else { return nil }
        guard preservesPublishedFilaments else { return model.hasPrefix("versions/") ? model : "model.stl" }
        guard kind != "published", model.hasPrefix("current/") || model.hasPrefix("versions/"),
              let mesh = current?.mergedMesh, mesh == Self.versionMesh(model) else { return nil }
        return mesh
    }

    /// The colour the part's AR file is written in: its spool, none for a multi-part design or before a spool (neutral, as
    /// on the stage).
    public var arTint: String? {
        if case .spool(let hex)? = ProjectGallery(project: self).entries.first(where: { $0.kind == .part })?.colour { return hex }
        return nil
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

    /// A sealed design's mesh for the stage (#616): its STL, or for a multi-part design the merged STL sealed beside its 3MF.
    public static func versionMesh(_ model: String) -> String {
        guard model.lowercased().hasSuffix(".3mf") else { return model }
        return (model.split(separator: "/").dropLast() + ["model.stl"]).joined(separator: "/")
    }

    static func renderPath(_ render: String) -> String { if render.hasPrefix("versions/") { return render }; return "renders/\(render.split(separator: "/").last ?? Substring(render))" }

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

    /// The Mac's picture of one gallery entry, for layouts that show pictures rather than a model to turn. Nil when there
    /// is none yet (`still(for:)` says whether one is coming).
    public func picture(for entry: ProjectGallery.Entry) -> String? {
        let path: String? = switch entry.kind {
        case .part: if case .picture(let path) = entry.drawing { path } else { pictures?["part"] ?? current?.renders.first.map(Self.renderPath) }
        case .plate: if case .picture(let path) = entry.drawing { path } else { nil }
        case .together: pictures?["together"]
        case .scan: pictures?["scan"] ?? pictures?["photo"]
        }
        return path?.isEmpty == false ? path : nil
    }

    /// What the stage shows for an entry while it has no model drawn (PRD §5.4; docs/operations.md "Waiting, failed and
    /// empty are screens too"): its picture, or that one is coming, or that none can be had. Every layout uses this, so
    /// no stage is ever a bare backdrop. A picture of something else never stands in for this one.
    public enum Still: Equatable, Sendable {
        /// This entry's picture, a project path.
        case picture(String)
        /// None yet, and one is coming: the Mac hasn't drawn it (queued, or drawing now).
        case waiting
        /// None, and none is coming: the Mac's drawing of it failed, or a designer's plate came without its picture.
        case notAvailable
    }

    public func still(for entry: ProjectGallery.Entry) -> Still {
        if let path = picture(for: entry) { return .picture(path) }
        let role: String? = switch entry.kind {
        case .part: "part"
        case .together: "together"
        case .scan: "scan"
        case .plate: nil
        }
        // A plate's picture comes from the file or nowhere (the Mac draws the whole file, the project's picture).
        guard let role else { return .notAvailable }
        return pictureStates?[role] == "failed" ? .notAvailable : .waiting
    }
}

extension ProjectGallery.Entry {
    /// The STL the part's AR file is written from (#769): the mesh its stage turns, whatever the design's file is called (an
    /// earlier design's `versions/<id>/touched.stl`, a multi-part design's merged mesh). None for a picture, a plate or
    /// Together; a scan's AR is its own USDZ, decided by the stage.
    public var arMesh: String? {
        guard kind == .part, case .model(let path) = drawing else { return nil }
        return path
    }

    /// The size chip: what it measures and its size ("Part · 213 × 43 × 82 mm"), when the size is known.
    public func sizeText(_ measured: [Double]? = nil) -> String? {
        guard let size = Format.size(measured ?? sizeMm ?? []) else { return nil }
        return "\(measures) · \(size)"
    }
}

/// How a part stays readable on the stage (PRD §5.4). The stage is the dark stage, always (David, Nov 11, on the
/// stage switching to light grey for a dark part: "we just entered light mode without a flashbang alert" — the app
/// never changes mode). A dark spool is kept readable in the material instead: its drawn colour keeps its hue but
/// is lifted to a minimum brightness that separates it from the stage, the same floor the Mac's still pictures use
/// (`mac-reconstruct picture`, `plasticRGB`'s `floorLum` for the dark stage), so a still and the live model match.
/// Only the stage's drawn material is floored; the spool's real colour still shows in swatches and names.
public enum StageMaterial {
    /// The dark stage's middle, `#RRGGBB`: the only stage.
    public static let stage = "#22242B"
    /// The drawn colour's minimum brightness (sRGB channels weighted 0.2126/0.7152/0.0722, as the Mac's pictures
    /// compute it): 0.20 against the stage's own 0.14, before the stage's lights add their edge highlight. A true
    /// black filament is drawn as charcoal; a silhouette is wrong.
    public static let minimumBrightness = 0.20

    /// The colour the stage draws an entry's model in: a spool's hex floored, nil for neutral and own colours
    /// (the stage's neutral material, or the model's own textures).
    public static func drawnHex(for colour: ProjectGallery.Colour) -> String? {
        guard case .spool(let hex) = colour else { return nil }
        return drawnHex(hex: hex)
    }

    /// `hex` lifted to the floor, `#RRGGBB` uppercase; a colour already at or above it (white, yellow, blue grey)
    /// is unchanged, and one that doesn't parse is returned as given.
    public static func drawnHex(hex: String) -> String {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count >= 6, let value = Int(digits.prefix(6), radix: 16) else { return hex }
        var rgb = [16, 8, 0].map { Double((value >> $0) & 255) / 255 }
        let brightness = Self.brightness(rgb)
        if brightness < minimumBrightness {
            // The Mac's pictures' lift: toward the floor grey (f, f·1.01, f·1.04) by how far under the floor it is.
            let lift = (minimumBrightness - brightness) / minimumBrightness
            for i in rgb.indices { rgb[i] += lift * minimumBrightness * [1.0, 1.01, 1.04][i] }
        }
        let bytes = rgb.map { Int((min(1, max(0, $0)) * 255).rounded()) }
        return "#" + bytes.map { String(format: "%02X", $0) }.joined()
    }

    static func brightness(_ rgb: [Double]) -> Double { 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] }

    /// A hex colour's brightness on the floor's scale; nil when it doesn't parse.
    static func brightness(hex: String) -> Double? {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count >= 6, let value = Int(digits.prefix(6), radix: 16) else { return nil }
        return brightness([16, 8, 0].map { Double((value >> $0) & 255) / 255 })
    }
}

/// Why an entry's 3D model isn't on the stage, from how its fetch actually ended (board X100). Nov 10, under refused
/// downloads: a part read "This scan is too detailed to show in 3D on a phone", a scan's words for a size it never had,
/// beside a stage already saying the picture didn't come. One line under the stage, naming the right thing.
public enum ModelUnavailable: Equatable, Sendable {
    /// The Mac isn't answering: it comes when it does.
    case notAnswering
    /// It didn't come (a dropped transfer, a timeout).
    case didntCome
    /// The Mac answered and would not send it.
    case refused
    /// Too large a file for a phone (the Mac said so, or the size it lists is over the phone's limit).
    case tooLarge
    /// Here, but this phone couldn't draw it.
    case undrawable

    /// Trying again can change the answer.
    public var retryable: Bool { self == .notAnswering || self == .didntCome || self == .refused }

    /// The one line under the stage. `pictureToo`: the stage's picture didn't come either, so this is the stage's own
    /// line for both (the gallery then shows no second line).
    /// `neverDrawn`: the Mac couldn't draw a picture at all (not "didn't come"), so the line says that.
    public func line(_ kind: ProjectGallery.Entry.Kind, pictureToo: Bool = false, neverDrawn: Bool = false) -> String {
        let thing = switch kind { case .part: "this part"; case .plate: "this plate"; case .scan: "your scan"; case .together: "the part and your scan" }
        let model = kind == .together ? "\(thing) in 3D" : "\(thing)’s 3D model"
        let Model = model.prefix(1).uppercased() + model.dropFirst()
        if pictureToo && neverDrawn {
            let first = kind == .plate ? "No picture of this plate came with the file" : "Your Mac couldn’t draw a picture of \(thing)"
            switch self {
            case .notAnswering: return "\(first), and it isn’t answering, so \(model) can’t come yet."
            case .didntCome: return "\(first), and \(model) didn’t come."
            case .refused: return "\(first), and it didn’t send \(model)."
            case .tooLarge: return "\(first), and \(model) is too large a file to show on a phone."
            case .undrawable: return "\(first), and \(model) couldn’t be shown on this phone."
            }
        }
        if pictureToo {
            switch self {
            case .notAnswering: return "Your Mac isn’t answering, so the picture and 3D model of \(thing) can’t come yet."
            case .refused: return "Your Mac didn’t send the picture or 3D model of \(thing)."
            case .didntCome: return "The picture and 3D model of \(thing) didn’t come from your Mac."
            case .tooLarge: return "The picture didn’t come from your Mac, and \(model) is too large a file to show on a phone."
            case .undrawable: return "The picture didn’t come from your Mac, and \(model) couldn’t be shown on this phone."
            }
        }
        switch self {
        case .notAnswering: return "Your Mac isn’t answering, so \(model) can’t come yet."
        case .didntCome: return "\(Model) didn’t come from your Mac."
        case .refused: return "Your Mac didn’t send \(model)."
        case .tooLarge: return "\(Model) is too large a file to show on a phone. Open it on your Mac to see it from every side."
        case .undrawable: return "\(Model) couldn’t be shown on this phone. Open it on your Mac."
        }
    }
}


/// An AR file the phone wrote for a part, and what it was written from (#769, review of #770). The stage's AR chip and the
/// page's Share both ask it for the file, so neither ever offers a USDZ of another model or colour than the stage shows
/// (a change pass finished, the spool changed, an earlier design opened).
public struct PreparedAR: Equatable, Sendable {
    /// The mesh the USDZ was written from.
    public var from: URL
    /// The spool colour it was written in; nil for neutral.
    public var tint: String?
    public var usdz: URL
    public init(from: URL, tint: String?, usdz: URL) { self.from = from; self.tint = tint; self.usdz = usdz }
    /// The USDZ when it was written from `model` in `tint`; nil otherwise.
    public func usdz(for model: URL?, tint: String?) -> URL? { model == from && tint == self.tint ? usdz : nil }
}
