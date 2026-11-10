import Foundation

/// A printer configured in the user's MCPs on the Mac (`GET /v1/objects/printers`). These are
/// configured destinations, not claims about live connectivity. Settings are never duplicated in the app.
public struct PrinterDestination: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: String
    public var name: String
    /// `bambu-printer-mcp` or `mcp-3d-printer-server`.
    public var backend: String
    public var model: String?
    public var address: String?
    /// `current` (the Mac app's own configuration) or `mcp-profile`.
    public var source: String
    /// Which client config it came from: claude-code, claude-desktop, cursor, codemode, codex, printer-handoff (PR 1).
    public var origin: String?
    /// ready, busy, offline, unknown (PR 1). Absent on older Macs.
    public var state: String?
    public var stateCheckedAt: String?
    /// What its installed MCP can do. Absent until the MCP has connected once since the Mac started (PR 1).
    public var capabilities: Capabilities?
    /// The MCP install that serves it, for `POST /v1/printers/mcp/<mcpId>/update` (PRD §8.10).
    public var mcpId: String?
    /// The same printer reached through both MCPs, the one in use first (`PUT …/printers/<id>/mcp`). Absent on older Macs.
    public var mcps: [McpChoice]?
    /// Other catalog ids that now stand for this same printer (a duplicate profile, an earlier MCP's id), as the Mac
    /// resolves them. Absent on older Macs.
    public var aliases: [String]?

    /// One MCP that reaches this printer, and the printer's id through it.
    public struct McpChoice: Codable, Equatable, Hashable, Sendable {
        public var backend: String
        public var destinationId: String
        public init(backend: String, destinationId: String) { self.backend = backend; self.destinationId = destinationId }
        /// The MCP as people know it.
        public var name: String { PrinterDestination.mcpName(backend) }
    }

    public struct Capabilities: Codable, Equatable, Hashable, Sendable {
        public struct Server: Codable, Equatable, Hashable, Sendable { public var name: String; public var version: String }
        public struct Update: Codable, Equatable, Hashable, Sendable {
            public var message: String; public var package: String?; public var command: [String]?
            /// The newest published version, when the Mac knows it (PRD §8.10).
            public var latestVersion: String?
        }
        public var server: Server?
        public var contract: String?
        public var progress: Bool
        public var layers: Bool
        /// bambu-tcp, rtsp, http-snapshot, none
        public var camera: String
        /// ams, single, none
        public var filaments: String
        public var pause: Bool
        public var resume: Bool
        public var cancel: Bool
        /// `slice_stl` takes `layer_height`.
        public var quality: Bool
        /// `slice_stl` takes `wall_loops` and `sparse_infill_density`.
        public var strength: Bool
        public var multiColour: Bool?
        /// `slice_stl` takes `repetitions` and really makes them (KAN-214 PR 8b): Print and Estimate take `copies`.
        public var copies: Bool?
        /// `slice_stl` takes `pause_at_layers`: Print takes `pauseBeforeLayers` (the slicer's "Add pause", e.g. for magnets).
        public var layerPauses: Bool?
        public var materialChoice: Bool?
        public var missing: [String]?
        public var update: Update?
        public var detectedAt: String?

        public init(progress: Bool = true, layers: Bool = true, camera: String = "bambu-tcp", filaments: String = "ams", pause: Bool = true,
                    resume: Bool = true, cancel: Bool = true, quality: Bool = true, strength: Bool = true, update: Update? = nil) {
            self.progress = progress; self.layers = layers; self.camera = camera; self.filaments = filaments; self.pause = pause
            self.resume = resume; self.cancel = cancel; self.quality = quality; self.strength = strength; self.update = update
        }
    }

    public init(id: String, name: String, backend: String, model: String? = nil, address: String? = nil, source: String = "mcp-profile",
                origin: String? = nil, state: String? = nil, capabilities: Capabilities? = nil) {
        self.id = id; self.name = name; self.backend = backend; self.model = model; self.address = address; self.source = source
        self.origin = origin; self.state = state; self.capabilities = capabilities
    }

    public var isBambu: Bool { backend == "bambu-printer-mcp" }
    /// The MCP that reaches it, as the user knows it.
    public var via: String { Self.mcpName(backend) }
    public static func mcpName(_ backend: String) -> String { backend == "bambu-printer-mcp" ? "bambu-printer-mcp" : "mcp-3D-printer-server" }
    /// Both MCPs reach it: Settings → Printers offers the choice.
    public var offersMcpChoice: Bool { (mcps?.count ?? 0) > 1 }
    /// Its MCP's slicer takes `pause_at_layers`: the print sheet offers "Before layer N" pauses.
    public var offersLayerPauses: Bool { capabilities?.layerPauses ?? false }
    /// Ready to take a print, when the Mac knows; nil when it hasn't read the printer yet.
    public var isReady: Bool? { state.flatMap { $0 == "unknown" ? nil : $0 == "ready" } }
    public var isOffline: Bool { state == "offline" }
    /// Has a camera, when the Mac knows; Bambu printers do by default.
    public var hasCamera: Bool { capabilities.map { $0.camera != "none" } ?? isBambu }
    public var canPause: Bool { capabilities?.pause ?? false }
    public var canResume: Bool { capabilities?.resume ?? false }
    public var canCancel: Bool { capabilities?.cancel ?? false }
    public var offersQuality: Bool { capabilities?.quality ?? false }
    public var offersCopies: Bool { capabilities?.copies ?? false }
    public var offersStrength: Bool { capabilities?.strength ?? false }
    /// The model as people say it: "Bambu Lab P1S", "Prusa MK4S".
    public var modelName: String { model ?? (isBambu ? "Bambu Lab printer" : "3D printer") }
}

/// How a printer's MCP reaches the printer (`GET …/printers/<id>/route`): the MCP's own setting
/// (`counterpart_print_route`, both MCPs) with its own words for each connection. Counterpart keeps no copy.
public struct PrinterConnection: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Hashable, Sendable {
        public var id: String
        public var label: String
        public var available: Bool
        /// Why it can't be chosen, when `available` is false.
        public var reason: String?
        /// What Pause, Resume and Stop do on this connection, in the MCP's words.
        public var controls: String?
        public init(id: String, label: String, available: Bool = true, reason: String? = nil, controls: String? = nil) {
            self.id = id; self.label = label; self.available = available; self.reason = reason; self.controls = controls
        }
    }
    /// `lan`, `cloud`, `developer`, or a newer id the MCP names.
    public var route: String
    public var mode: String
    public var type: String
    public var choices: [String]
    /// Nil from an MCP that reports only `choices`.
    public var options: [Option]?
    public var savedTo: String?
    public init(route: String, mode: String = "", type: String = "", choices: [String], options: [Option]? = nil, savedTo: String? = nil) {
        self.route = route; self.mode = mode; self.type = type; self.choices = choices; self.options = options; self.savedTo = savedTo
    }

    /// Every choice with the MCP's words, or the known names for an MCP without `options`.
    public var shown: [Option] {
        choices.map { id in options?.first { $0.id == id } ?? Option(id: id, label: Self.fallbackLabel(id)) }
    }
    public var current: Option? { shown.first { $0.id == route } }
    static func fallbackLabel(_ id: String) -> String {
        switch id { case "lan": "Local network"; case "cloud": "Bambu Cloud"; case "developer": "Local network, Developer Mode"; default: id }
    }
}

public struct PrinterCatalog: Codable, Equatable, Sendable {
    public var destinations: [PrinterDestination]
    public var defaultDestinationId: String
    public init(destinations: [PrinterDestination], defaultDestinationId: String) {
        self.destinations = destinations; self.defaultDestinationId = defaultDestinationId
    }
    public func destination(_ id: String?) -> PrinterDestination? {
        destinations.first { $0.id == (id ?? defaultDestinationId) }
    }
    /// The listed printer an id stands for now: itself, or the printer it became after a Printer MCP change
    /// (its id through the other MCP, in `mcps`), or one of the catalog's `aliases` for it (S4: as the Mac resolves them).
    public func listed(_ id: String) -> String? {
        if destinations.contains(where: { $0.id == id }) { return id }
        return destinations.first { $0.mcps?.contains { $0.destinationId == id } == true || $0.aliases?.contains(id) == true }?.id
    }
    /// The printer a saved id stands for now, as the print sheet resolves it: itself, or the printer it became under its
    /// other MCP's id (review F2: matched exactly, the Result row said a listed printer "isn't on your Mac anymore").
    /// Nil id: the default printer.
    public func resolved(_ id: String?) -> PrinterDestination? {
        destination(id.flatMap { listed($0) } ?? id)
    }
}

/// A spool the printer reports (`GET /v1/objects/<id>/filaments`): an AMS slot or the external spool.
public struct PrinterFilament: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var slot: Int
    /// `#RRGGBB` or `#RRGGBBAA`.
    public var colour: String
    public var material: String
    public var name: String
    public var filamentId: String
    public var destinationId: String
    /// The one tray the Mac preselects (PR 2).
    public var suggested: Bool?
    /// Where the spool sits, in the printer MCP's own words; nil from an older Mac.
    public var label: String?
    /// Which spools can feed one print together (`ams`, `external`), as the printer MCP groups them.
    public var feed: String?
    public var id: Int { slot }

    public init(slot: Int, colour: String, material: String, name: String, filamentId: String, destinationId: String, suggested: Bool? = nil,
                label: String? = nil, feed: String? = nil) {
        self.slot = slot; self.colour = colour; self.material = material; self.name = name; self.filamentId = filamentId
        self.destinationId = destinationId; self.suggested = suggested; self.label = label; self.feed = feed
    }

    public var isExternal: Bool { slot >= 254 }
    /// The printer MCP's label for the spool; its material from an older Mac that doesn't send one.
    public var slotLabel: String { label ?? material }
    /// The spool as a person reads it: the printer MCP's name ("Sunflower Yellow PLA Basic"), which already says its material.
    public var spoolName: String { label != nil ? name : "\(material) \(displayName)" }
    /// "<label> · <name>", both the printer MCP's.
    public var title: String { label.map { "\($0) · \(name)" } ?? spoolName }

    /// The spool's name without its colour code or a repeated material ("Bambu PLA Basic #FFFFFF" → "Bambu PLA Basic").
    public var displayName: String {
        var text = name.replacingOccurrences(of: #"\s*#[0-9a-fA-F]{6,8}\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = " " + material
        if text.count > suffix.count, text.uppercased().hasSuffix(suffix.uppercased()) { text.removeLast(suffix.count) }
        return text.isEmpty ? material : text
    }

    /// This tray as the companion takes it in `filament`/`filaments` (the same identity it reported).
    var jsonObject: [String: Any] {
        ["slot": slot, "colour": colour, "material": material, "name": name,
         "filamentId": filamentId, "destinationId": destinationId]
    }

    /// Red, green, blue in 0…1, from `colour`.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let hex = colour.hasPrefix("#") ? String(colour.dropFirst()) : colour
        let value = Int(hex.prefix(6), radix: 16) ?? 0
        return (Double((value >> 16) & 255) / 255, Double((value >> 8) & 255) / 255, Double(value & 255) / 255)
    }
}

/// One filament of a multi-part model, with the spool the Mac suggests for it
/// (`GET /v1/objects/<id>/colour-mapping`; the same shape the Mac app reads over its control socket).
public struct ModelColourFilament: Codable, Identifiable, Equatable, Hashable, Sendable {
    /// 1-based project filament, as the 3MF numbers them.
    public var index: Int
    public var name: String?
    /// The colour this part belongs in, `#RRGGBB`, when the model or its design pass says one.
    public var colour: String?
    public var material: String?
    /// The suggested spool's absolute slot; nil when nothing is loaded.
    public var slot: Int?
    /// How far the suggested spool's colour is from `colour` (0 exact); nil when the colour is unknown.
    public var distance: Double?
    public var materialMismatch: Bool?
    /// No colour was known: the suggestion is only a starting point.
    public var guessed: Bool?
    /// The printer MCP's verdict on its proposal (`same-colour`, `closest`, `no-colour`, `none`) and what the person should know.
    public var verdict: String?
    public var note: String?
    public var id: Int { index }
    public init(index: Int, name: String? = nil, colour: String? = nil, material: String? = nil, slot: Int? = nil,
                distance: Double? = nil, materialMismatch: Bool? = nil, guessed: Bool? = nil, verdict: String? = nil, note: String? = nil) {
        self.index = index; self.name = name; self.colour = colour; self.material = material
        self.slot = slot; self.distance = distance; self.materialMismatch = materialMismatch; self.guessed = guessed
        self.verdict = verdict; self.note = note
    }
}

/// A multi-part model's filaments and the printer's loaded spools: which spool each colour prints from.
public struct ColourMapping: Codable, Equatable, Sendable {
    public var filaments: [ModelColourFilament]
    public var trays: [PrinterFilament]
    /// The model version these rows describe; sent back with Print so a redesign can't inherit old choices.
    public var modelVersion: String?
    public init(filaments: [ModelColourFilament], trays: [PrinterFilament], modelVersion: String? = nil) {
        self.filaments = filaments; self.trays = trays; self.modelVersion = modelVersion
    }
    /// The suggested spool for each filament (filament index → slot): the sheet's starting choices.
    public var suggestedSlots: [Int: Int] {
        Dictionary(uniqueKeysWithValues: filaments.compactMap { filament in filament.slot.map { (filament.index, $0) } })
    }
    /// The chosen spools in filament order, when every colour has one: what Print and Estimate send.
    public func spools(slots: [Int: Int]) -> [PrinterFilament]? {
        guard !filaments.isEmpty else { return nil }
        let choices = filaments.compactMap { filament in trays.first { $0.slot == slots[filament.index] } }
        return choices.count == filaments.count ? choices : nil
    }
    /// The chosen spools come from more than one feed (the printer MCP's `feed`): one print feeds from one.
    public func mixesFeeds(slots: [Int: Int]) -> Bool {
        Set(slots.values.compactMap { slot in trays.first { $0.slot == slot }?.feed }).count > 1
    }
    /// The MCP's note for a row while the person keeps its proposed spool.
    public func note(_ filament: ModelColourFilament, slots: [Int: Int]) -> String? {
        slots[filament.index] == filament.slot ? filament.note : nil
    }
}

/// The print sheet's choices (PRD §5.5), sent as chosen: the printer MCP turns them into its slicer's settings
/// (PRD §8.0). The sheet shows the numbers only from the slice the MCP reports.
public enum PrintQuality: String, CaseIterable, Codable, Sendable {
    case draft, standard, fine
    public var title: String { rawValue.capitalized }
}

public enum PrintStrength: String, CaseIterable, Codable, Sendable {
    case standard, strong, max
    public var title: String { rawValue.capitalized }
}

/// Which filament a print uses (`colour` in `POST …/print`, PRD §5.5).
public enum PrintColour: Equatable, Sendable {
    /// A tray the printer reported, sent as the full tray identity every companion accepts.
    case tray(PrinterFilament)
    /// The tray the Mac suggested, kept: the MCP matches the AMS itself.
    case auto
    /// The external spool, not the AMS.
    case external
    /// A printer that doesn't report its filament: the material, so the Mac slices at the right temperatures.
    case material(String)

    var json: (key: String, value: Any) {
        switch self {
        case .tray(let f): ("filament", f.jsonObject)
        case .auto: ("colour", ["auto": true])
        case .external: ("colour", ["external": true])
        case .material(let m): ("colour", ["material": m])
        }
    }
}

/// What the print sheet sends with Print.
public struct PrintChoice: Equatable, Sendable {
    /// Nil leaves the filament to the MCP's own defaults.
    public var colour: PrintColour?
    public var quality: PrintQuality
    public var strength: PrintStrength
    /// The previous print may have reached the printer, and you said it isn't printing this.
    public var checked: Bool
    /// How many on the plate (`slice_stl` `repetitions`), only when you chose a number: nil leaves the printer
    /// profile's own count (KAN-214 #230).
    public var copies: Int?
    /// The layers the printer stops before (the slicer's "Add pause", for magnets or nuts). Empty: no pause, and
    /// no key, so the body stays one every companion accepts.
    public var pauseBeforeLayers: [Int]
    /// A multi-part 3MF: the spool chosen for each of the model's filaments, in filament order. Sent instead
    /// of `colour` (never both), with the model version those choices were made against.
    public var filaments: [PrinterFilament]
    public var filamentsModelVersion: String?
    /// The sheet's estimate (`SliceEstimate.sliceSha256`): the Mac prints exactly that sliced file, the one its preview showed.
    public var sliceSha256: String?
    public init(colour: PrintColour?, quality: PrintQuality = .standard, strength: PrintStrength = .standard, checked: Bool = false, copies: Int? = nil,
                pauseBeforeLayers: [Int] = [], filaments: [PrinterFilament] = [], filamentsModelVersion: String? = nil, sliceSha256: String? = nil) {
        self.colour = colour; self.quality = quality; self.strength = strength; self.checked = checked; self.copies = copies.map { max(1, $0) }
        self.pauseBeforeLayers = Array(Array(Set(pauseBeforeLayers.filter { $0 >= 2 })).sorted().prefix(Self.maxPauses))
        self.filaments = filaments; self.filamentsModelVersion = filamentsModelVersion; self.sliceSha256 = sliceSha256
    }
    public init(filament: PrinterFilament, quality: PrintQuality = .standard, strength: PrintStrength = .standard, checked: Bool = false, copies: Int? = nil) {
        self.init(colour: .tray(filament), quality: quality, strength: strength, checked: checked, copies: copies)
    }
    /// The companion takes at most 16 pauses.
    public static let maxPauses = 16

    /// The `POST …/print` body. Standard quality and strength send nothing (the MCP's preset decides), and a
    /// chosen tray goes as `filament`, so a plain print is the body every companion accepts.
    public var body: [String: Any] {
        var json: [String: Any] = ["checked": checked]
        if !filaments.isEmpty {
            json["filaments"] = filaments.map(\.jsonObject)
            if let filamentsModelVersion { json["filamentsModelVersion"] = filamentsModelVersion }
        } else if let colour { json[colour.json.key] = colour.json.value }
        if quality != .standard { json["quality"] = quality.rawValue }
        if strength != .standard { json["strength"] = strength.rawValue }
        // Only a number you chose; otherwise the printer profile's count applies.
        if let copies { json["copies"] = copies }
        let pauses = Array(Array(Set(pauseBeforeLayers.filter { $0 >= 2 })).sorted().prefix(Self.maxPauses))
        if !pauses.isEmpty { json["pauseBeforeLayers"] = pauses }
        if let sliceSha256 { json["sliceSha256"] = sliceSha256 }
        return json
    }
}

extension PrinterDestination {
    /// "1.4.2 → 1.5.0" when the installed MCP is behind the newest version; nil when it's current or unknown.
    public var updateWords: String? {
        guard let installed = capabilities?.server?.version, let latest = capabilities?.update?.latestVersion,
              Self.isOlder(installed, than: latest) else { return nil }
        return "\(installed) → \(latest)"
    }

    /// Dotted version order: 1.4.10 is newer than 1.4.9.
    public static func isOlder(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }, y = b.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l < r }
        }
        return false
    }
}

