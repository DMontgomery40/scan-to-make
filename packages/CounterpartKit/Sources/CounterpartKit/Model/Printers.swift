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
    public var id: Int { slot }

    public init(slot: Int, colour: String, material: String, name: String, filamentId: String, destinationId: String, suggested: Bool? = nil) {
        self.slot = slot; self.colour = colour; self.material = material; self.name = name; self.filamentId = filamentId
        self.destinationId = destinationId; self.suggested = suggested
    }

    public var isExternal: Bool { slot >= 254 }
    /// "A1", "A2" … for AMS slots, "Ext" for the external spool.
    public var slotLabel: String { isExternal ? "Ext" : "A\(slot + 1)" }

    /// The spool's name without its colour code or a repeated material ("Bambu PLA Basic #FFFFFF" → "Bambu PLA Basic").
    public var displayName: String {
        var text = name.replacingOccurrences(of: #"\s*#[0-9a-fA-F]{6,8}\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = " " + material
        if text.count > suffix.count, text.uppercased().hasSuffix(suffix.uppercased()) { text.removeLast(suffix.count) }
        return text.isEmpty ? material : text
    }

    /// Red, green, blue in 0…1, from `colour`.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let hex = colour.hasPrefix("#") ? String(colour.dropFirst()) : colour
        let value = Int(hex.prefix(6), radix: 16) ?? 0
        return (Double((value >> 16) & 255) / 255, Double((value >> 8) & 255) / 255, Double(value & 255) / 255)
    }
}

/// The print sheet's choices (PRD §5.5). Quality and strength map to the slicer through the MCP (§8.5).
public enum PrintQuality: String, CaseIterable, Codable, Sendable {
    case draft, standard, fine
    public var title: String { rawValue.capitalized }
    public var layerHeightMm: Double { switch self { case .draft: 0.28; case .standard: 0.20; case .fine: 0.12 } }
}

public enum PrintStrength: String, CaseIterable, Codable, Sendable {
    case standard, strong, max
    public var title: String { rawValue.capitalized }
    public var walls: Int { switch self { case .standard: 2; case .strong: 4; case .max: 6 } }
    public var infillPercent: Int { switch self { case .standard: 15; case .strong: 25; case .max: 40 } }
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
        case .tray(let f): ("filament", ["slot": f.slot, "colour": f.colour, "material": f.material, "name": f.name,
                                         "filamentId": f.filamentId, "destinationId": f.destinationId] as [String: Any])
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
    public init(colour: PrintColour?, quality: PrintQuality = .standard, strength: PrintStrength = .standard, checked: Bool = false, copies: Int? = nil,
                pauseBeforeLayers: [Int] = []) {
        self.colour = colour; self.quality = quality; self.strength = strength; self.checked = checked; self.copies = copies.map { max(1, $0) }
        self.pauseBeforeLayers = Array(Array(Set(pauseBeforeLayers.filter { $0 >= 2 })).sorted().prefix(Self.maxPauses))
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
        if let colour { json[colour.json.key] = colour.json.value }
        if quality != .standard { json["quality"] = quality.rawValue }
        if strength != .standard { json["strength"] = strength.rawValue }
        // Only a number you chose; otherwise the printer profile's count applies.
        if let copies { json["copies"] = copies }
        if !pauseBeforeLayers.isEmpty { json["pauseBeforeLayers"] = pauseBeforeLayers }
        return json
    }

    /// "0.20 mm layers · 2 walls · 15% infill"
    public var settingsLine: String {
        String(format: "%.2f mm layers · %d walls · %d%% infill", quality.layerHeightMm, strength.walls, strength.infillPercent)
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

