#if DEBUG
import Foundation
import CounterpartKit

/// Debug builds only, for UI tests and the screenshot comparisons against docs/design/overhaul/screens:
/// launched with `-CounterpartFixtures <folder>`, the app talks to this canned Mac instead of a real one.
/// The folder holds the mockups' own assets (mic.stl, thumb-mic.png, photo1–4.jpg, bed.jpg, …), which stay
/// out of Git. Release builds don't contain any of this.
enum Fixtures {
    static var folder: URL? {
        guard let path = UserDefaults.standard.string(forKey: "CounterpartFixtures"), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    /// `-CounterpartFixtureSet empty` shows a Mac with no projects yet.
    static var set: String { UserDefaults.standard.string(forKey: "CounterpartFixtureSet") ?? "all" }
    /// The mic mount's printer: the print sheet's selection, and what `-CounterpartScreen print-noams` starts on.
    nonisolated(unsafe) static var printer = "current"
    /// `supported` or `unsupported`: the mic mount is waiting on its printer's own question.
    nonisolated(unsafe) static var confirmation: String?
    /// `-CounterpartScreen confirm-mac-answers`: the Mac answers any printer question.
    nonisolated(unsafe) static var macAnswers = false
    /// `-CounterpartScreen preparing`: the cable clip is on the printer, getting ready (layer 0).
    nonisolated(unsafe) static var preparing = false
    /// Statuses set on this run (`PATCH …/settings`), by project id.
    nonisolated(unsafe) static var statuses: [String: String] = [:]
    nonisolated(unsafe) static var titles: [String: String] = [:]
    nonisolated(unsafe) static var projectPreferences: [String: [String: Any]] = [:]
    nonisolated(unsafe) static var duplicates: [[String: Any]] = []

    static let ids = (mic: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01", potato: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a02",
                      clip: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a03", plush: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a04",
                      first: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a05", v1: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a06",
                      failed: "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a07")

    /// A paired record for the canned Mac.
    static func store() -> MemoryStore {
        let record: [String: Any] = [
            "baseUrl": "https://192.168.68.123:9077", "addresses": ["https://192.168.68.123:9077"],
            "publicKeySha256": String(repeating: "ab", count: 32), "deviceId": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a99",
            "token": String(repeating: "t", count: 43), "protocolVersion": "0.1.0",
            "expiresAt": (Date().timeIntervalSince1970 + 25 * 86_400) * 1000,
            "scopes": ["generation:health", "projects:read", "projects:write", "captures:read", "captures:import", "printer-handoff:use"],
        ]
        let memory = MemoryStore()
        try? memory.write("current", JSONSerialization.data(withJSONObject: record))
        UserDefaults.standard.set("Mac mini", forKey: ProjectsStore.macNameKey)
        return memory
    }

    static func objects(now: Date = Date()) -> [[String: Any]] {
        if set == "empty" { return [] }
        let ms = now.timeIntervalSince1970 * 1000
        func ago(_ minutes: Double) -> Double { ms - minutes * 60_000 }
        let p1s: [String: Any] = ["id": "current", "name": "P1S"]
        let micRequest = "Something that holds this mic on top of my monitor arm pole. Both are in the photos."
        let potatoRequest = "Copy this. Close up the bottom and keep the stitches."
        let list: [[String: Any]] = [
            ["id": ids.mic, "createdAtMs": ago(30), "updatedAtMs": ago(2), "state": "ready", "title": "Mic mount", "kind": "fit",
             "instructions": micRequest, "photos": ["photo1.jpg", "photo2.jpg", "photo3.jpg", "photo4.jpg"],
             "passes": [["startedAtMs": ago(20), "endedAtMs": ago(2), "status": "done", "trigger": "new", "activityCount": 5],
                        ["startedAtMs": ago(10), "endedAtMs": ago(2), "status": "done", "note": "Make the clamp a bit tighter.", "trigger": "changes", "activityCount": 3]],
             "current": ["model": "current/model.stl", "renders": ["current/renders/mic.png"], "sizeMm": [48.2, 50.4, 53.9],
                         "changes": [["tag": "added", "text": "Built a cup that slides over the pole top, 24 mm deep"],
                                     ["tag": "added", "text": "Added a snap cradle that holds the mic level, ports left clear"],
                                     ["tag": "assumed", "text": "Used published size for the mic: 21 mm × 108 mm"],
                                     ["tag": "estimated", "text": "Pole diameter estimated from photos. Print a test ring first?", "toleranceMm": 0.5]]],
             "print": ["bundleId": "b0", "destination": p1s, "estimate": ["seconds": 4320, "grams": 22], "jobName": "mic-mount.3mf"],
             "printerDestinationId": printer]
                .merging(confirmation.map { kind in
                    ["state": "printing", "printConfirmation": ["id": "9c1f1c1e-2d1e-4c3a-9a51-0e7a0b9e1a09", "expiresAtMs": ms + 572_000, "supported": kind != "unsupported",
                        "message": "Start a checked print on P1S (01P00A451200123)? Nozzles: 0.4 mm. Materials: PLA. Peak targets: nozzle 220°C, bed 55°C, chamber 0°C. File SHA-256: 4f9c0b1e2d3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012e21a.",
                        "fields": kind == "unsupported" ? [] as [[String: Any]] : (kind == "generic" ? [
                            ["name": "speed", "title": "Print speed", "type": "string", "required": true, "enum": ["silent", "standard", "sport"],
                             "enumNames": ["Silent", "Standard", "Sport"], "default": "standard"],
                            ["name": "bed", "title": "Bed temperature (°C)", "type": "number", "required": false, "minimum": 40, "maximum": 110],
                        ] : []) + [["name": "confirmed", "title": "I checked the printer and confirm this operation", "required": true]]]] as [String: Any]
                } ?? [:]) { _, new in new },
            ["id": ids.potato, "createdAtMs": ago(8), "updatedAtMs": ago(0.2), "state": "touching-up", "title": "Crochet potato", "kind": "copy",
             "instructions": potatoRequest, "scan": "scan.usdz", "photos": [], "capture": ["potato.jpg"],
             "passes": [["startedAtMs": ago(6), "trigger": "new", "activityCount": 5,
                         "stages": [["id": "preparing", "words": "Got your scan", "startedAtMs": ago(6), "endedAtMs": ago(5.5), "typicalSec": 30],
                                    ["id": "preparing", "words": "Filled the gaps", "startedAtMs": ago(5.5), "endedAtMs": ago(3), "typicalSec": 150],
                                    ["id": "working", "words": "Matching your photos: restoring stitches on the left side", "startedAtMs": ago(3), "typicalSec": 300]],
                         "estimate": ["remainingSec": 240, "endsAtMs": ms + 240_000]]]],
            ["id": ids.clip, "createdAtMs": ago(120), "updatedAtMs": ago(0.1), "state": "printing", "title": "Cable clip", "instructions": "Copy this clip, 20% bigger.",
             "scan": "scan.usdz", "photos": [], "passes": [["startedAtMs": ago(110), "endedAtMs": ago(90), "status": "done"]],
             "current": ["model": "current/model.stl", "renders": ["current/renders/clip.png"], "sizeMm": [30, 12, 8]],
             "print": ["bundleId": "b1", "destination": p1s, "printId": "2c1f1c1e-2d1e-4c3a-9a51-0e7a0b9e1a04", "destinationId": "current",
                       "estimate": ["seconds": 3960, "grams": 9],
                       "live": ["source": "counterpart", "observedAt": ISO8601DateFormatter().string(from: now), "state": "printing",
                                "job": ["name": "clip", "progress": 42, "remainingSec": 2280, "layer": 84, "totalLayers": 212, "stage": "Printing"],
                                "endsAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(2280)),
                                "temps": ["nozzle": ["actual": 220, "target": 220], "bed": ["actual": 55, "target": 55]],
                                "activeFilament": ["slot": "A1", "material": "PLA", "color": "#141414"], "problems": []],
                       "monitor": ["phase": "watching", "milestonesSent": [], "firstLayerSent": true]]],
            ["id": ids.plush, "createdAtMs": ago(30), "updatedAtMs": ago(12), "state": "needs-closeup", "title": "Plush, underside",
             "instructions": "Copy this plush, including the bottom.", "scan": "scan.usdz", "photos": [], "capture": ["potato.jpg"],
             "passes": [["startedAtMs": ago(25), "endedAtMs": ago(12), "status": "needs-closeup"]],
             "question": ["closeup": "the underside"],
             "ask": ["id": "1b6f1c1e-2d1e-4c3a-9a51-0e7a0b9e1a03", "question": "Can you send a close-up of the underside? The scan never saw the bottom.",
                     "photo": "asks/1b6f1c1e-2d1e-4c3a-9a51-0e7a0b9e1a03.jpg", "region": ["x": 0.15, "y": 0.55, "width": 0.7, "height": 0.4],
                     "answers": ["camera", "photos", "best-guess"], "status": "open", "askedAtMs": ago(12)]],
            ["id": ids.first, "createdAtMs": ago(1600), "updatedAtMs": ago(1500), "state": "printed", "title": "Potato, first try",
             "instructions": "Copy this, keep the stitches.", "scan": "scan.usdz", "photos": [],
             "passes": [["startedAtMs": ago(1590), "endedAtMs": ago(1560), "status": "done"]],
             "current": ["model": "current/model.stl", "renders": ["current/renders/potato.png"], "sizeMm": [92, 61, 58]],
             "print": ["bundleId": "b2", "destination": p1s, "monitor": ["phase": "ended", "endState": "done",
                                                                       "endedAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(-1500 * 60))]]],
            ["id": ids.v1, "createdAtMs": ago(3000), "updatedAtMs": ago(2900), "state": "confirmed", "settings": ["status": "works"], "title": "Mic mount v1",
             "instructions": "Something that holds this mic on my monitor arm.", "photos": [],
             "passes": [["startedAtMs": ago(2990), "endedAtMs": ago(2950), "status": "done"]],
             "current": ["model": "current/model.stl", "renders": ["current/renders/mic.png"], "sizeMm": [48, 50, 54]],
             "print": ["bundleId": "b3", "destination": p1s, "monitor": ["phase": "ended", "endState": "done",
                                                                       "endedAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(-2900 * 60))]]],
            ["id": ids.failed, "createdAtMs": ago(20), "updatedAtMs": ago(4), "state": "failed", "title": "Crochet potato", "instructions": potatoRequest,
             "scan": "scan.usdz", "photos": [], "capture": ["potato.jpg"],
             "failure": "Blender closed on your Mac during the touch-up, before the stitches were restored. Open Blender on your Mac, then try again. Your scan and photos are kept.",
             "passes": [["startedAtMs": ago(10), "endedAtMs": ago(4), "status": "failed", "summary": "blender_mcp_call · connection closed", "activityCount": 3,
                         "stages": [["id": "preparing", "words": "Got your scan", "startedAtMs": ago(10), "endedAtMs": ago(9), "typicalSec": 30],
                                    ["id": "preparing", "words": "Filled the gaps", "startedAtMs": ago(9), "endedAtMs": ago(6), "typicalSec": 150],
                                    ["id": "working", "words": "Matching your photos", "startedAtMs": ago(6), "typicalSec": 300]]]]],
        ]
        // `-CounterpartFixtureSet grid`: only the projects Home shows as cards, so the grid is at the top.
        let shown = set == "grid" ? list.filter { ["ready", "printed", "confirmed", "failed"].contains($0["state"] as? String ?? "") } : list
        return (shown + duplicates).map(withStatus).map(withPreparing).map { original in
            guard let id = original["id"] as? String else { return original }
            var object = original
            if let title = titles[id] { object["title"] = title }
            if let preferences = projectPreferences[id] {
                var settings = object["settings"] as? [String: Any] ?? ["status": "not-printed"]
                for key in ["printDefaults", "designEngine", "notifications"] { if let value = preferences[key] { settings[key] = value } }
                object["settings"] = settings
                if let destination = preferences["printerDestinationId"] { object["printerDestinationId"] = destination is NSNull ? nil : destination }
                if let archived = preferences["archived"] { object["archived"] = archived }
            }
            return object
        }
    }

    /// The clip's print getting ready on the printer, as the companion words it (KAN-214 #237).
    private static func withPreparing(_ object: [String: Any]) -> [String: Any] {
        guard preparing, object["id"] as? String == ids.clip, var print = object["print"] as? [String: Any],
              var live = print["live"] as? [String: Any] else { return object }
        var object = object
        live["state"] = "preparing"
        live["job"] = ["name": "clip", "progress": 0, "layer": 0, "totalLayers": 212, "stage": "Heating"]
        print["live"] = live
        print["monitor"] = ["phase": "starting", "milestonesSent": [], "firstLayerSent": false]
        print["dispatchedAt"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-90))
        object["print"] = print
        object["status"] = ["phase": "preparing", "text": "Getting ready · Heating", "symbol": "printer", "tint": "accent"]
        return object
    }

    /// A status set on this run, as the companion's `setStatus` keeps it (KAN-214 #223): archived only hides;
    /// any other status shows it again, works confirms it, needs-changes un-confirms it.
    private static func withStatus(_ object: [String: Any]) -> [String: Any] {
        guard let id = object["id"] as? String, let status = statuses[id] else { return object }
        var object = object
        object["updatedAtMs"] = Date().timeIntervalSince1970 * 1000
        if status == "archived" {
            object["archived"] = true
        } else {
            object["archived"] = nil; object["outcome"] = nil
            switch status {
            case "works": object["state"] = "confirmed"; object["outcome"] = "works"
            case "printed": object["state"] = "printed"
            case "not-printed": object["state"] = "ready"
            case "needs-changes": object["outcome"] = "needs-changes"; if object["state"] as? String == "confirmed" { object["state"] = "printed" }
            default: break
            }
        }
        let state = object["state"] as? String
        let derived = object["archived"] as? Bool == true ? "archived" : state == "confirmed" ? "works"
            : object["outcome"] as? String == "needs-changes" ? "needs-changes" : ["printed", "sent"].contains(state ?? "") ? "printed" : "not-printed"
        object["settings"] = ["status": derived]
        return object
    }

    static let catalog: [String: Any] = [
        "defaultDestinationId": "current",
        "destinations": [
            ["id": "current", "name": "P1S", "backend": "bambu-printer-mcp", "model": "Bambu Lab P1S", "source": "current", "state": "ready",
             "capabilities": ["progress": true, "layers": true, "camera": "bambu-tcp", "filaments": "ams", "pause": true, "resume": true, "cancel": true,
                              "quality": true, "strength": true, "multiColour": false, "copies": true, "missing": [],
                              "server": ["name": "bambu-printer-mcp", "version": "1.1.48"]]],
            ["id": "mcp-garage", "name": "Garage MK4", "backend": "mcp-3d-printer-server", "model": "Prusa MK4S", "source": "mcp-profile", "origin": "claude-code", "state": "ready",
             "capabilities": ["progress": true, "layers": false, "camera": "none", "filaments": "single", "pause": true, "resume": true, "cancel": true,
                              "quality": true, "strength": true, "multiColour": false, "missing": [],
                              "server": ["name": "mcp-3d-printer-server", "version": "1.2.22"]]],
            ["id": "mcp-ender", "mcpId": "mcp-3d", "name": "Ender", "backend": "mcp-3d-printer-server", "model": "Creality Ender-3 V3", "source": "mcp-profile", "origin": "claude-desktop", "state": "ready",
             "capabilities": ["progress": false, "layers": false, "camera": "none", "filaments": "none", "pause": false, "resume": false, "cancel": true,
                              "quality": false, "strength": false, "multiColour": false, "missing": ["progress", "camera", "pause"],
                              "update": ["message": "Update mcp-3D-printer-server to see progress and camera.", "package": "mcp-3d-printer-server",
                                         "command": ["npm", "install", "-g", "mcp-3d-printer-server@latest"], "latestVersion": "1.2.22"],
                              "server": ["name": "mcp-3d-printer-server", "version": "1.2.9"]]],
        ],
    ]

    /// Every Mac setting, as KAN-214's settings.md shows them.
    static let settings: [String: Any] = [
        "milestones": "50",
        "notifications": ["mac": ["pass.ready": true, "print.milestone": false], "devices": ["0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a99": ["print.started": false]]],
        "general": ["openAtLogin": true, "showInDock": true, "keepAwake": true],
        "ai": ["revision": "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1aa1", "choice": ["kind": "claude-code"], "check": ["state": "connected"]],
        "fusion": ["state": "not-set-up", "message": "Not set up. Set Up installs the Fusion add-in."],
    ]
    static let devices: [[String: Any]] = [
        ["deviceId": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a99", "deviceName": "David's iPhone", "current": true, "model": "iPhone18,2"],
        ["deviceId": "1b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a98", "deviceName": "David's iPad", "model": "iPad16,3", "lastSeenAt": "2026-10-31T09:00:00Z"],
        ["deviceId": "2b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a97", "deviceName": "iPhone", "legacy": true],
    ]

    /// What each printer reports: the P1S's AMS, the MK4's one spool, nothing from the Ender.
    static func filaments(for destination: String) -> [[String: Any]] {
        switch destination {
        case "mcp-garage": [["slot": 0, "colour": "#2B2B38", "material": "PLA", "name": "Galaxy Black", "filamentId": "", "destinationId": "mcp-garage"]]
        case "mcp-ender": []
        default: filaments
        }
    }

    static let filaments: [[String: Any]] = [
        ["slot": 0, "colour": "#141414", "material": "PLA", "name": "Black", "filamentId": "GFA00", "destinationId": "current", "suggested": true],
        ["slot": 1, "colour": "#FAC71A", "material": "PLA", "name": "Yellow", "filamentId": "GFA00", "destinationId": "current"],
        ["slot": 2, "colour": "#BFEBDB", "material": "PETG", "name": "Translucent", "filamentId": "GFG00", "destinationId": "current"],
        ["slot": 3, "colour": "#6B7385", "material": "PLA", "name": "Blue Grey", "filamentId": "GFA00", "destinationId": "current"],
    ]

    /// The file a fixture path serves, from the assets folder.
    static func file(_ path: String) -> String? {
        if path.hasSuffix("/model.stl") { return "mic.stl" }
        if path.hasSuffix("/camera.jpg") { return "bed.jpg" }
        if path.contains("/renders/mic.png") { return "thumb-mic.png" }
        if path.contains("/renders/potato.png") || path.contains("/asks/") || path.hasSuffix("/capture/potato.jpg") { return "thumb-potato.png" }
        if path.contains("/renders/clip.png") { return "bed.jpg" }
        if let range = path.range(of: #"/photos/(photo[1-4]\.jpg)$"#, options: .regularExpression) { return String(path[range].dropFirst("/photos/".count)) }
        return nil
    }
}

/// The canned Mac.
struct FixtureTransport: HTTPTransport {
    let folder: URL

    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        func json(_ value: Any, _ status: Int = 200) -> HTTPReply { HTTPReply(status: status, body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
        let objects = Fixtures.objects()
        func object(_ id: String) -> [String: Any]? { objects.first { $0["id"] as? String == id } }
        let parts = path.split(separator: "/").map(String.init)
        if path == "/healthz" { return json(["status": "ok", "protocolVersion": "0.1.0", "capabilities": ["genericConfirmations": Fixtures.macAnswers, "mcpUpdates": true, "projectSettings": true, "projectRename": true, "projectPreferences": true, "printCopies": true]]) }
        if path == "/v1/objects/printers" { return json(Fixtures.catalog) }
        if path.hasPrefix("/v1/objects/printers/"), path.hasSuffix("/camera.jpg") {
            guard path.contains("/current/") else { return json(["error": ["code": "not-found", "message": "This printer has no camera"]], 404) }
            var reply = HTTPReply(status: 200, body: try Data(contentsOf: folder.appending(path: "bed.jpg")))
            reply.headers["X-Captured-At"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3))
            return reply
        }
        if path == "/v1/settings" { return json(["settings": Fixtures.settings]) }
        if path == "/v1/devices" && method == "GET" { return json(["devices": Fixtures.devices]) }
        if path.hasPrefix("/v1/devices/") && method == "DELETE" { return json(["removed": true]) }
        if path.hasPrefix("/v1/settings/") && method == "POST" { return json(["check": ["state": "checking"]]) }
        if path.hasPrefix("/v1/printers/mcp/") && method == "POST" { return json(["update": ["mcpId": "mcp-3d", "state": "waiting", "fromVersion": "1.2.9", "toVersion": "1.2.22"]]) }
        if path == "/v1/events" { return json(["error": ["code": "not-found", "message": "Not found"]], 404) }
        if path == "/v1/objects" && method == "GET" { return json(["objects": objects]) }
        if parts.count >= 3, parts[0] == "v1", parts[1] == "objects" {
            if parts.count == 4 && parts[2] == "printers" { return json(["error": ["code": "not-found"]], 404) }
            let id = parts[2]
            if parts.count == 3 { return object(id).map { json(["object": $0]) } ?? json(["error": ["code": "not-found"]], 404) }
            if parts[3] == "settings", method == "PATCH",
               let body = request.httpBody.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) {
                if let status = body["status"] as? String { Fixtures.statuses[id] = status }
                if let title = body["title"] as? String { Fixtures.titles[id] = title }
                Fixtures.projectPreferences[id, default: [:]].merge(body) { $1 }
                return Fixtures.objects().first { $0["id"] as? String == id }.map { json(["object": $0]) } ?? json(["error": ["code": "not-found"]], 404)
            }
            if parts[3] == "duplicate", method == "POST", var copied = object(id) {
                let copyId = UUID().uuidString.lowercased()
                copied["id"] = copyId; copied["title"] = String((copied["title"] as? String ?? "Project").prefix(114)) + " copy"
                copied["state"] = "ready"; copied["passes"] = [] as [Any]
                for key in ["print", "ask", "outcome", "archived", "pendingFollowup", "pendingPhotos", "messages"] { copied[key] = nil }
                var settings = copied["settings"] as? [String: Any] ?? [:]
                settings["status"] = "not-printed"; settings["archived"] = false; copied["settings"] = settings
                Fixtures.duplicates.append(copied)
                return json(["object": copied], 201)
            }
            if parts[3] == "filaments" { return json(["filaments": Fixtures.filaments(for: id == Fixtures.ids.mic ? Fixtures.printer : "current")]) }
            if parts[3] == "printer", method == "POST",
               let body = request.httpBody.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }), let destination = body["destinationId"] as? String {
                if id == Fixtures.ids.mic { Fixtures.printer = destination }
                return json(["object": Fixtures.objects().first { $0["id"] as? String == id } ?? [:]])
            }
            if parts[3] == "estimate", method == "POST" {
                let destination = id == Fixtures.ids.mic ? Fixtures.printer : "current"
                let seconds: Double = destination == "mcp-garage" ? 3900 : destination == "mcp-ender" ? 6480 : 4320
                return json(["destinationId": destination, "quality": "standard", "strength": "standard", "seconds": seconds, "grams": 22, "layers": 212,
                             "layerHeightMm": 0.2, "infillPercent": 15, "wallLoops": 2, "slicedAt": ISO8601DateFormatter().string(from: Date())])
            }
            if parts[3] == "passes" {
                return json(["activity": [
                    ["atMs": Date().timeIntervalSince1970 * 1000 - 60_000, "kind": "message", "text": "Photo 3 shows stitches on the left side the scan smoothed over. Restoring them there only."],
                    ["atMs": Date().timeIntervalSince1970 * 1000 - 50_000, "kind": "tool", "text": "look  photo-3.jpg  left side, stitch rows"],
                    ["atMs": Date().timeIntervalSince1970 * 1000 - 40_000, "kind": "tool", "text": "blender  select_region  left_side  (1,412 faces)"],
                    ["atMs": Date().timeIntervalSince1970 * 1000 - 30_000, "kind": "tool", "text": "blender  sculpt  draw_sharp  strength 0.25"],
                    ["atMs": Date().timeIntervalSince1970 * 1000 - 20_000, "kind": "tool", "text": "render  front, left  → compare with photo 3"],
                ]])
            }
            if method == "GET", let name = Fixtures.file(path) {
                let data = try Data(contentsOf: folder.appending(path: name))
                var reply = HTTPReply(status: 200, body: data)
                if path.hasSuffix("camera.jpg") { reply.headers["X-Captured-At"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3)) }
                return reply
            }
            if method == "POST", let current = object(id) { return json(["object": current]) }
        }
        return json(["error": ["code": "not-found", "message": "Not found"]], 404)
    }
}
#endif
