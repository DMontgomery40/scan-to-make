#if DEBUG
import Foundation
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

/// Design QA only (Debug builds): `Counterpart --design-fixtures <assets> [--design-screen main|print|popover|settings]`
/// runs the real app on screen with the mockup's projects (docs/design/overhaul/mockup-app/Shared/MockData.swift),
/// so it can be compared with screens/mac-*.jpg side by side. The assets are personal captures that are never
/// committed (mockup-app/README.md); the app reads them from the folder given. Nothing touches the companion.
@MainActor enum DesignFixtures {
    static var assets: URL?
    static var screen = "main"
    /// `--design-project <id> [--design-screen print]`, without fixtures: design QA of a Debug build against the real
    /// companion, on one real project (its print sheet asks the real printer for an estimate; it never prints).
    static var realProject: String? {
        guard assets == nil else { return nil }
        return CommandLine.arguments.firstIndex(of: "--design-project").flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil }
    }
    static var realScreen: String? { CommandLine.arguments.firstIndex(of: "--design-screen").flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } }
    /// `--design-select 1…6`: the mockup's project number to show (1, Mic mount, by default).
    static var selected: String {
        let number = CommandLine.arguments.firstIndex(of: "--design-select").flatMap { Int(CommandLine.arguments[$0 + 1]) } ?? 1
        return String(format: "0b6f0f43-7c35-4b8a-9a3c-%012d", number)
    }
    /// `--design-tab request|activity|print`.
    static var tab: String { CommandLine.arguments.firstIndex(of: "--design-tab").map { CommandLine.arguments[$0 + 1] } ?? "request" }
    static let micID = "0b6f0f43-7c35-4b8a-9a3c-000000000001"

    static func companion() -> FixtureObjects? {
        guard let assets else { return nil }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("counterpart-design-fixtures", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        let now = Date().timeIntervalSince1970 * 1000
        func folder(_ id: String, _ files: [String: String]) -> String {
            let dir = root.appendingPathComponent(id, isDirectory: true)
            for (to, from) in files {
                let target = dir.appendingPathComponent(to)
                try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? FileManager.default.copyItem(at: assets.appendingPathComponent(from), to: target)
            }
            return dir.path
        }
        let tools: [[String: Any]] = [
            ["atMs": now - 120_000, "kind": "tool", "text": "look       photo-3.jpg  left side, stitch rows"],
            ["atMs": now - 103_000, "kind": "tool", "text": "blender    select_region  left_side  (1,412 faces)"],
            ["atMs": now - 101_000, "kind": "tool", "text": "blender    sculpt  draw_sharp  strength 0.25"],
            ["atMs": now - 94_000, "kind": "tool", "text": "render     front, left  → compare with photo 3"],
            ["atMs": now - 82_000, "kind": "tool", "text": "check      stitch depth 0.8 mm (photo est. 0.8 mm)"],
        ]
        let p1s: [String: Any] = ["id": "p1s", "name": "P1S"]
        let printedOnP1S: [String: Any] = ["bundleId": "b0", "destination": p1s, "monitor": ["phase": "ended", "endState": "done"],
                                           "events": [["atMs": now - 90_000_000, "message": "Plate checked: clear"],
                                                      ["atMs": now - 89_900_000, "message": "Started"],
                                                      ["atMs": now - 86_500_000, "message": "Done"]]]
        let items: [[String: Any]] = [
            ["id": "0b6f0f43-7c35-4b8a-9a3c-000000000003", "createdAtMs": now - 1_000, "updatedAtMs": now, "title": "Cable clip",
             "instructions": "Copy this clip, 20% bigger.", "state": "printing", "photos": [], "passes": [],
             "current": ["model": "current/model.stl", "renders": ["current/renders/front.jpg"], "sizeMm": [22, 14, 9]],
             "print": ["bundleId": "b3", "printId": "print-3", "destination": p1s, "monitor": ["phase": "watching"],
                       "live": ["source": "counterpart", "state": "printing", "job": ["name": "Cable clip", "progress": 42, "remainingSec": 2_280]],
                       "printerStatus": ["state": "RUNNING", "checkedAtMs": now, "percent": 42, "remainingMinutes": 38]],
             "directory": folder("c3", ["current/model.stl": "mic.stl", "current/renders/front.jpg": "bed.jpg"])],
            ["id": "0b6f0f43-7c35-4b8a-9a3c-000000000002", "createdAtMs": now - 2_000, "updatedAtMs": now, "title": "Crochet potato",
             "instructions": "Copy this. Close up the bottom and keep the stitches.", "state": "touching-up", "photos": ["potato.png"], "scan": "scan.usdz",
             "progress": "Matching your photos",
             "passes": [["startedAtMs": now - 60_000, "estimate": ["remainingSec": 230, "endsAtMs": now + 230_000], "activity": tools]],
             "directory": folder("c2", ["photos/potato.png": "thumb-potato.png", "scan/scan.usdz": "scanB.usdz"])],
            ["id": "0b6f0f43-7c35-4b8a-9a3c-000000000004", "createdAtMs": now - 3_000, "updatedAtMs": now - 720_000, "title": "Plush, underside",
             "instructions": "Copy this plush, including the bottom.", "state": "needs-closeup", "scan": "scan.usdz",
             "question": ["closeup": "the underside"], "passes": [["startedAtMs": now - 900_000, "endedAtMs": now - 720_000, "status": "needs-closeup"]],
             "photos": ["plush.png"],
             "directory": folder("c4", ["photos/plush.png": "thumb-potato.png", "scan/scan.usdz": "scanB.usdz"])],
            ["id": micID, "createdAtMs": now - 4_000, "updatedAtMs": now - 120_000, "title": "Mic mount",
             "instructions": "Something that holds this mic on top of my monitor arm pole. Both are in the photos.", "state": "ready",
             "photos": ["photo1.jpg", "photo2.jpg", "photo3.jpg", "photo4.jpg"],
             "passes": [["startedAtMs": now - 600_000, "endedAtMs": now - 120_000, "status": "done", "activity": tools, "activityCount": 5]],
             "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"], "sizeMm": [48, 50, 54],
                         "changes": [["tag": "added", "text": "Cup slides over the pole top, 24 mm deep"],
                                     ["tag": "added", "text": "Snap cradle holds the mic level"],
                                     ["tag": "assumed", "text": "Mic size from published specs"],
                                     ["tag": "estimated", "text": "Pole size estimated ±0.5 mm"]]],
             "directory": folder("c1", ["current/model.stl": "mic.stl", "current/renders/front.png": "thumb-mic.png",
                                        "photos/photo1.jpg": "photo1.jpg", "photos/photo2.jpg": "photo2.jpg",
                                        "photos/photo3.jpg": "photo3.jpg", "photos/photo4.jpg": "photo4.jpg"])],
            ["id": "0b6f0f43-7c35-4b8a-9a3c-000000000005", "createdAtMs": now - 5_000, "updatedAtMs": now - 86_400_000, "title": "Potato, first try",
             "instructions": "Copy this, keep the stitches.", "state": "printed", "photos": [], "passes": [], "print": printedOnP1S,
             "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"]],
             "directory": folder("c5", ["current/model.stl": "mic.stl", "current/renders/front.png": "thumb-potato.png"])],
            ["id": "0b6f0f43-7c35-4b8a-9a3c-000000000006", "createdAtMs": now - 6_000, "updatedAtMs": Self.october30, "title": "Mic mount v1",
             "instructions": "Something that holds this mic on my monitor arm.", "state": "printed", "photos": [], "passes": [], "print": printedOnP1S,
             "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"]],
             "directory": folder("c6", ["current/model.stl": "mic.stl", "current/renders/front.png": "thumb-mic.png"])],
        ]
        return FixtureObjects(items: items, catalog: PrinterCatalog(destinations: [
            PrinterDestination(id: "p1s", name: "P1S", backend: "bambu-printer-mcp", model: "Bambu Lab P1S", address: "LAN", state: "ready",
                               origin: "claude-code", capabilities: .init(server: .init(name: "bambu-printer-mcp", version: "1.1.46"),
                                                                          camera: "bambu-tcp", filaments: "ams", pause: true, resume: true, cancel: true,
                                                                          quality: true, strength: true)),
            PrinterDestination(id: "mk4", name: "Garage MK4", backend: "mcp-3d-printer-server", model: "Prusa MK4S", address: "Klipper", state: "ready",
                               origin: "claude-desktop", capabilities: .init(server: .init(name: "mcp-3d-printer-server", version: "1.2.17"),
                                                                             quality: true, strength: true)),
            PrinterDestination(id: "ender", name: "Ender", backend: "mcp-3d-printer-server", model: "Creality Ender-3 V3", address: "OctoPrint",
                               state: "offline", origin: "codex",
                               capabilities: .init(server: .init(name: "mcp-3d-printer-server", version: "1.2.9"), progress: false,
                                                   missing: ["progress", "camera"],
                                                   update: .init(message: "Update to see progress and camera", package: "mcp-3d-printer-server",
                                                                 command: ["npm", "install", "-g", "mcp-3d-printer-server@latest"]))),
        ], defaultDestinationId: "p1s"), now: now)
    }

    private static var october30: Double {
        var parts = DateComponents(); parts.year = 2026; parts.month = 10; parts.day = 30; parts.hour = 12
        return (Calendar.current.date(from: parts) ?? Date()).timeIntervalSince1970 * 1000
    }
}

extension DesignFixtures {
    /// The mockup's paired phones (mac-devices.jpg): an iPhone connected now and an iPad seen yesterday.
    static func macStatus() -> FixtureMac? { assets == nil ? nil : FixtureMac() }
}

struct FixtureMac: MacStatusSource {
    func status() async throws -> ControlStatus {
        ControlStatus(companionVersion: "fixture", pairedDeviceCount: 2, capabilities: .init(nearbyPairing: true))
    }
    func devices() async throws -> [ControlDevice] {
        let now = Date().timeIntervalSince1970 * 1000
        func day(_ month: Int, _ day: Int) -> Double {
            var parts = DateComponents(); parts.year = 2026; parts.month = month; parts.day = day; parts.hour = 12
            return (Calendar.current.date(from: parts) ?? Date()).timeIntervalSince1970 * 1000
        }
        return [ControlDevice(deviceId: "0b6f0f43-7c35-4b8a-9a3c-0000000000d1", deviceName: "David's iPhone 18 Pro", pairedAt: day(10, 30),
                              lastRefreshedAt: now - 30_000, expiresAt: now + 86_400_000, model: "iPhone18,2", lastSeenAt: now - 10_000),
                ControlDevice(deviceId: "0b6f0f43-7c35-4b8a-9a3c-0000000000d2", deviceName: "David's iPad Pro", pairedAt: day(10, 31),
                              lastRefreshedAt: now - 86_400_000, expiresAt: now + 86_400_000, model: "iPad16,3", lastSeenAt: now - 86_400_000)]
            // `--design-legacy`: the live Mac's pairings from before stable identity (KAN-214 PR 5 marks them).
            + (CommandLine.arguments.contains("--design-legacy") ? (1...3).map { index in
                ControlDevice(deviceId: "0b6f0f43-7c35-4b8a-9a3c-0000000000e\(index)", deviceName: "David's iPhone", pairedAt: day(10, 20 + index),
                              lastRefreshedAt: day(10, 22 + index), expiresAt: now + 86_400_000, legacy: true)
            } : [])
    }
    func removeDevice(_ id: String) async throws {}
    func address() -> String? { "mac-mini.local:9077" }
}

/// The mockup's projects, served as the control socket would serve them. Actions answer from memory.
actor FixtureObjects: ObjectsCompanion {
    private var items: [[String: Any]]
    private let catalog: PrinterCatalog
    private let now: Double
    init(items: [[String: Any]], catalog: PrinterCatalog, now: Double) { self.items = items; self.catalog = catalog; self.now = now }

    private func decode(_ item: [String: Any]) throws -> Project {
        try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: item))
    }
    private func change(_ id: String, _ fields: [String: Any]) throws -> Project {
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code: "not-found", message: "") }
        items[index].merge(fields) { $1 }
        return try decode(items[index])
    }
    func objects() async throws -> [Project] { try items.map(decode) }
    func printers() async throws -> PrinterCatalog { catalog }
    func filaments(_ id: String) async throws -> [PrinterFilament] {
        [PrinterFilament(slot: 0, colour: "#141414", material: "PLA", name: "Black", filamentId: "GFA00", destinationId: "p1s", suggested: true),
         PrinterFilament(slot: 1, colour: "#FAC71A", material: "PLA", name: "Yellow", filamentId: "GFA01", destinationId: "p1s"),
         PrinterFilament(slot: 2, colour: "#BFEADB", material: "PETG", name: "Translucent", filamentId: "GFG00", destinationId: "p1s"),
         PrinterFilament(slot: 3, colour: "#6B7385", material: "PLA", name: "Blue Grey", filamentId: "GFA02", destinationId: "p1s")]
    }
    func status() async throws -> ControlStatus {
        ControlStatus(companionVersion: "fixture", pairedDeviceCount: 1,
                      capabilities: .init(nearbyPairing: true, objectsCreate: true, events: true, printControl: true, printSettings: true))
    }
    func devices() async throws -> [ControlDevice] {
        [ControlDevice(deviceId: "0b6f0f43-7c35-4b8a-9a3c-0000000000d1", deviceName: "David's iPhone", pairedAt: now - 2 * 86_400_000,
                       lastRefreshedAt: now - 30_000, expiresAt: now + 86_400_000, model: "iPhone18,2", lastSeenAt: now - 10_000)]
    }
    func aiProvider() async -> String? { "Claude" }
    func estimate(_ id: String, destinationId: String?, quality: PrintSettings.Quality, strength: PrintSettings.Strength) async throws -> PrintEstimate {
        let json: [String: Any] = ["destinationId": destinationId ?? "p1s", "quality": quality.rawValue, "strength": strength.rawValue,
                                   "seconds": quality == .fine ? 7_800 : quality == .draft ? 2_900 : 4_320, "grams": strength == .standard ? 22 : 29,
                                   "layerHeightMm": quality == .fine ? 0.12 : quality == .draft ? 0.28 : 0.20,
                                   "infillPercent": strength == .max ? 40 : strength == .strong ? 25 : 15, "slicedAt": "2026-11-01T12:00:00Z"]
        return try JSONDecoder().decode(PrintEstimate.self, from: JSONSerialization.data(withJSONObject: json))
    }
    func correct(_ id: String, note: String) async throws -> Project { try change(id, ["state": "touching-up"]) }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> Project { try change(id, ["state": "touching-up"]) }
    func print(_ id: String, checked: Bool) async throws -> Project { try change(id, ["state": "printing"]) }
    func start(_ id: String) async throws -> Project { try change(id, ["state": "touching-up"]) }
    func delete(_ id: String) async throws { items.removeAll { $0["id"] as? String == id } }
}
#endif

#if DEBUG
import ScreenCaptureKit
import AppKit
import UniformTypeIdentifiers

/// Design QA only: `--design-snapshot <folder>` writes a PNG of each of this app's own windows, as the window
/// server composites them (Liquid Glass included), a few seconds after launch. ScreenCaptureKit's
/// `currentProcess` content needs no Screen Recording permission because it is this process's own windows.
@MainActor enum DesignSnapshot {
    static func scheduleIfAsked() {
        guard let index = CommandLine.arguments.firstIndex(of: "--design-snapshot"), index + 1 < CommandLine.arguments.count else { return }
        let folder = URL(fileURLWithPath: CommandLine.arguments[index + 1], isDirectory: true)
        let delay = CommandLine.arguments.firstIndex(of: "--design-delay").flatMap { Double(CommandLine.arguments[$0 + 1]) } ?? 6
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            await capture(to: folder)
        }
    }

    static func capture(to folder: URL) async {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let frames = NSApp.windows.filter(\.isVisible).map { "\($0.title) \(NSStringFromRect($0.frame)) content \(NSStringFromRect($0.contentLayoutRect))" }
        try? frames.joined(separator: "\n").write(to: folder.appendingPathComponent("windows.txt"), atomically: true, encoding: .utf8)
        do {
            let content = try await SCShareableContent.currentProcess
            let mine = content.windows.filter { $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier }
            NSLog("KAN220 shareable windows %d, mine %d", content.windows.count, mine.count)
            for (index, window) in mine.enumerated() {
                // The window server may hold it as a Stage Manager thumbnail; ask for the window's real size.
                guard let app = NSApp.windows.first(where: { $0.windowNumber == Int(window.windowID) }), app.frame.width > 120 else { continue }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let configuration = SCStreamConfiguration()
                let scale = app.backingScaleFactor
                configuration.width = Int(app.frame.width * scale)
                configuration.height = Int(app.frame.height * scale)
                configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                let name = (window.title?.isEmpty == false ? window.title! : "window-\(index)").replacingOccurrences(of: "/", with: "-")
                let url = folder.appendingPathComponent("\(name).png")
                if let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) {
                    CGImageDestinationAddImage(destination, image, nil)
                    CGImageDestinationFinalize(destination)
                }
                NSLog("KAN220 captured %@", url.path)
            }
        } catch {
            NSLog("KAN220 capture failed %@", String(describing: error))
        }
    }
}
#endif
