#if DEBUG
import SwiftUI
import AppKit
import SceneKit
import simd
import ModelIO
import Vision
import CoreImage

/// Design QA only (Debug builds): `Scan to Make --render-objects-design <folder>` draws the objects
/// window with generic fixture objects to PNGs and exits. It never registers, pairs or probes the
/// network: it runs before any of that, with its own fixture companion. The fixture STLs are real
/// files read back through ModelScene, so the 3D stills also check the STL loading and framing.
@MainActor enum ObjectsDesign {
    /// Returns false if any window failed its stability check or the render failed.
    static func render(to output: URL) -> Bool {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        var done = false, steady = false
        Task { @MainActor in
            do { steady = try await renderAll(to:output) } catch { FileHandle.standardError.write(Data("design render failed: \(error)\n".utf8)) }
            done = true
        }
        while !done { RunLoop.main.run(until:Date().addingTimeInterval(0.05)) }
        return steady
    }

    private struct Shot { let name: String; let objects: [StmObject]?; let selection: String?; var dark = false; var threeD = false; var size: NSSize? }

    private static func renderAll(to output: URL) async throws -> Bool {
        var stability: [DesignStability.Result] = []
        try FileManager.default.createDirectory(at:output, withIntermediateDirectories:true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("stm-objects-design-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let objects = try fixtures(in:root, stills:output)
        // STM_DESIGN_SOLID=1: solid stand-ins for what the capture can't draw (glass buttons, the sidebar's material).
        let solid = ProcessInfo.processInfo.environment["STM_DESIGN_SOLID"] == "1"
        let byName = Dictionary(uniqueKeysWithValues:zip(["hook", "bracket", "mug", "clip", "arriving", "knob", "spacer", "noCamera"], objects))
        let list = objects.filter { $0.id != byName["noCamera"]!.id }
        let shots = [
            Shot(name:"window-ready-light", objects:list, selection:byName["hook"]!.id),
            Shot(name:"window-ready-dark", objects:list, selection:byName["hook"]!.id, dark:true),
            Shot(name:"window-3d-light", objects:list, selection:byName["hook"]!.id, threeD:true),
            Shot(name:"window-closeup-light", objects:list, selection:byName["bracket"]!.id),
            Shot(name:"window-touching-up-dark", objects:list, selection:byName["mug"]!.id, dark:true),
            Shot(name:"window-plate-light", objects:list, selection:byName["clip"]!.id),
            Shot(name:"window-plate-no-camera-dark", objects:[byName["noCamera"]!] + list, selection:byName["noCamera"]!.id, dark:true),
            Shot(name:"window-uncertain-light", objects:list, selection:byName["knob"]!.id),
            Shot(name:"window-smallest-light", objects:list, selection:byName["knob"]!.id, size:ObjectsWindow.minimumSize),
            Shot(name:"window-empty-light", objects:[], selection:nil),
            Shot(name:"window-not-set-up-dark", objects:nil, selection:nil, dark:true),
        ]
        for shot in shots {
            let model = ObjectsModel(companion:FixtureObjects(items:shot.objects))
            await model.refresh()
            model.selection = shot.selection
            let window = ObjectsWindow.make(model:model, startWith3D:shot.threeD, standIns:solid)
            window.appearance = NSAppearance(named:shot.dark ? .darkAqua : .aqua)
            if let size = shot.size { window.setContentSize(size) }
            window.alphaValue = 0 // drawn for the PNG only, never seen on screen
            window.ignoresMouseEvents = true
            window.orderFrontRegardless()
            try await Task.sleep(for:.seconds(shot.threeD ? 3 : 1.5))
            if ProcessInfo.processInfo.environment["STM_DESIGN_DEBUG"] == "1", let table = findTable(window.contentView!) {
                let row = table.numberOfRows > 0 && table.rowView(atRow:0, makeIfNecessary:false) != nil
                FileHandle.standardError.write(Data("\(shot.name): rows \(table.numberOfRows), row view \(row), visible \(table.visibleRect), on screen \(window.occlusionState.contains(.visible))\n".utf8))
            }
            dumpSidebar(window, name:shot.name)
            let sidebar = try sidebarDrawing(window, name:shot.name, to:output)
            if let sidebar {
                FileHandle.standardError.write(Data(("sidebar text \(shot.name): " + sidebar.1.joined(separator:" / ") + "\n").utf8))
            }
            try png(of:window, to:output.appendingPathComponent(shot.name + ".png"), sidebar:solid ? sidebar?.0 : nil)
            // The live SCNView draws through Metal, which the window capture can't see: ask it directly.
            if shot.threeD, let live = findSceneView(window.contentView!) {
                try write(live.snapshot(), to:output.appendingPathComponent(shot.name + "-scnview.png"))
            }
            stability += await DesignStability.check(window, name:shot.name)
            stability.append(DesignStability.minimumSize(window, name:shot.name, expected:ObjectsWindow.minimumSize))
            stability.append(DesignStability.scrollerFlip(window, name:shot.name))
            if ProcessInfo.processInfo.environment["STM_DESIGN_SWEEP"] == "1", shot.name.hasSuffix("ready-light") || shot.name.hasSuffix("plate-light") {
                stability += await DesignStability.sweep(window, name:shot.name)
            }
            if ProcessInfo.processInfo.environment["STM_DESIGN_FIT"] == "1", shot.name.hasSuffix("ready-light") || shot.name.hasSuffix("plate-light") {
                stability += await DesignStability.fit(window, name:shot.name)
            }
            window.orderOut(nil)
            window.close()
        }
        // The sidebar's rows are separate hosting views that SwiftUI doesn't draw in a window that
        // isn't on screen, so the cards are drawn on their own (renders are cached by the shots above).
        for dark in [false, true] {
            let cards = VStack(alignment:.leading, spacing:2) {
                ForEach(list) { object in
                    ObjectCard(object:object)
                        .padding(.horizontal, 10)
                        .frame(width:256, alignment:.leading)
                        .background(RoundedRectangle(cornerRadius:6).fill(object.id == byName["hook"]!.id ? Color.primary.opacity(0.09) : .clear))
                }
            }
            .padding(12)
            .background(Color(nsColor:dark ? NSColor(white:0.17, alpha:1) : NSColor(white:0.955, alpha:1)))
            .environment(\.colorScheme, dark ? .dark : .light)
            let renderer = ImageRenderer(content:cards)
            renderer.scale = 2
            if let image = renderer.nsImage { try write(image, to:output.appendingPathComponent("cards-\(dark ? "dark" : "light").png")) }
        }
        // The menu-bar popover and Settings → General, from fixtures: no socket, no pairing code.
        for dark in [false, true] {
            let mac = MacStatusModel(source:FixtureMac())
            await mac.refresh()
            let popover = MenuBarPopover(nearby:NearbyModel(companion:FixtureNearby()), mac:mac) {
                Image(nsImage:fixtureCode()).interpolation(.none).resizable().frame(width:232, height:232)
            }
            let popoverWindow = offscreen(popover, size:nil, dark:dark, titled:false)
            try await Task.sleep(for:.seconds(1))
            try png(of:popoverWindow, to:output.appendingPathComponent("popover-\(dark ? "dark" : "light").png"))
            stability += await DesignStability.check(popoverWindow, name:"popover-\(dark ? "dark" : "light")")
            popoverWindow.orderOut(nil); popoverWindow.close()

            let settings = offscreen(GeneralSettings(mac:mac).frame(width:560, height:680), size:NSSize(width:560, height:680), dark:dark, titled:true)
            try await Task.sleep(for:.seconds(1))
            try png(of:settings, to:output.appendingPathComponent("settings-\(dark ? "dark" : "light").png"))
            stability += await DesignStability.check(settings, name:"settings-\(dark ? "dark" : "light")")
            stability.append(DesignStability.scrollerFlip(settings, name:"settings-\(dark ? "dark" : "light")"))
            settings.orderOut(nil); settings.close()
        }
        return DesignStability.report(stability)
    }

    /// A window drawn for its PNG only: fully transparent and ignoring the real pointer. `size` nil: the content's own size.
    private static func offscreen<Content: View>(_ content: Content, size: NSSize?, dark: Bool, titled: Bool) -> NSWindow {
        let host = NSHostingView(rootView:content)
        let fitted = size ?? host.fittingSize // measured before sizing is turned off, which leaves no fitting size
        host.sizingOptions = []
        host.wantsLayer = true
        let window = NSWindow(contentRect:NSRect(origin:.zero, size:fitted), styleMask:titled ? [.titled, .closable] : [.borderless],
                              backing:.buffered, defer:false)
        window.title = "Counterpart Settings"
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setContentSize(fitted)
        window.appearance = NSAppearance(named:dark ? .darkAqua : .aqua)
        window.alphaValue = 0 // drawn for the PNG only, never seen on screen
        window.ignoresMouseEvents = true
        window.orderFrontRegardless()
        return window
    }

    /// A QR code for a made-up address, standing in for the pairing code.
    private static func fixtureCode() -> NSImage {
        let filter = CIFilter(name:"CIQRCodeGenerator")!
        filter.setValue(Data("https://example.invalid/pair/fixture".utf8), forKey:"inputMessage")
        let output = filter.outputImage!.transformed(by:CGAffineTransform(scaleX:8, y:8))
        let rep = NSCIImageRep(ciImage:output)
        let image = NSImage(size:rep.size)
        image.addRepresentation(rep)
        return image
    }

    private struct FixtureNearby: NearbyCompanion {
        func nearbyPairingEnabled() async throws -> Bool { false }
        func nearbyRequests() async throws -> [ControlNearbyRequest] { [] }
        func answerNearby(_ id: String, allow: Bool) async throws {}
    }

    private struct FixtureMac: MacStatusSource {
        func status() async throws -> ControlStatus {
            let json: [String: Any] = ["protocolVersion": 1, "companionVersion": "0.1.0", "transport": "lan", "pairedDeviceCount": 1,
                                       "capabilities": ["capture": true, "cleanup": true, "printerHandoff": true]]
            return try JSONDecoder().decode(ControlStatus.self, from:JSONSerialization.data(withJSONObject:json))
        }
        func devices() async throws -> [ControlDevice] {
            let paired = Date().timeIntervalSince1970 * 1000 - 9 * 86_400_000
            let json: [String: Any] = ["deviceId": "fixture-phone", "deviceName": "iPhone", "scopes": ["capture"], "pairedAt": paired,
                                       "lastRefreshedAt": paired, "expiresAt": paired + 1, "pairedVia": ["transport": "lan", "login": "lan"]]
            return [try JSONDecoder().decode(ControlDevice.self, from:JSONSerialization.data(withJSONObject:json))]
        }
        func removeDevice(_ id: String) async throws {}
        func address() -> String? { "192.168.1.20:9077" }
    }

    private static func findSceneView(_ view: NSView) -> SCNView? {
        if let scene = view as? SCNView { return scene }
        for child in view.subviews { if let scene = findSceneView(child) { return scene } }
        return nil
    }

    private static func findTable(_ view: NSView) -> NSTableView? {
        if let table = view as? NSTableView { return table }
        for child in view.subviews { if let table = findTable(child) { return table } }
        return nil
    }

    /// The sidebar list's rows as the table has them (their words are read from `sidebarDrawing`'s pixels:
    /// SwiftUI builds no accessibility tree in a window nobody can see).
    private static func dumpSidebar(_ window: NSWindow, name: String) {
        guard let table = findTable(window.contentView!) else {
            FileHandle.standardError.write(Data("sidebar \(name): no list\n".utf8)); return
        }
        let heights = (0..<table.numberOfRows).map { row in table.rowView(atRow:row, makeIfNecessary:true).map { "\(Int($0.frame.height))" } ?? "none" }
        FileHandle.standardError.write(Data("sidebar \(name): \(table.numberOfRows) rows (heights \(heights.joined(separator:","))), selected \(Array(table.selectedRowIndexes))\n".utf8))
    }

    /// The sidebar list drawn on its own by AppKit (`cacheDisplay`), which does draw its rows: the window
    /// capture can't, because the sidebar sits in a material only the window server composites. The selected
    /// row's selection is a material too, so it is drawn in the system's selection colour instead. Sidebar text
    /// is vibrant (blended against the material by the window server), so its colours here are not the real
    /// ones: this proves the rows and their words, not their text colour. Returns
    /// the drawing (also written as sidebar-<shot>.png) and the text read back from its pixels.
    private static func sidebarDrawing(_ window: NSWindow, name: String, to output: URL) throws -> (NSBitmapImageRep, [String])? {
        guard let table = findTable(window.contentView!), table.numberOfRows > 0,
              let rep = table.bitmapImageRepForCachingDisplay(in:table.bounds) else { return nil }
        var hidden: [NSView] = []
        for row in table.selectedRowIndexes {
            guard let view = table.rowView(atRow:row, makeIfNecessary:false) else { continue }
            for effect in view.subviews.compactMap({ $0 as? NSVisualEffectView }) where !effect.isHidden { effect.isHidden = true; hidden.append(effect) }
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:rep)
        (window.appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            NSColor.underPageBackgroundColor.setFill()
            NSRect(origin:.zero, size:rep.size).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        (window.appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            // Selection fills under the rows, then the rows themselves.
            for row in table.selectedRowIndexes {
                let rect = table.rect(ofRow:row).insetBy(dx:10, dy:1)
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:rep)
                let flipped = NSRect(x:rect.minX, y:table.bounds.height - rect.maxY, width:rect.width, height:rect.height)
                // Unemphasized: the drawing's text colours are the inactive window's, so its selection is too.
                NSColor.unemphasizedSelectedContentBackgroundColor.setFill()
                NSBezierPath(roundedRect:flipped, xRadius:8, yRadius:8).fill()
                NSGraphicsContext.restoreGraphicsState()
            }
            table.cacheDisplay(in:table.bounds, to:rep)
        }
        hidden.forEach { $0.isHidden = false }
        try rep.representation(using:.png, properties:[:])?.write(to:output.appendingPathComponent("sidebar-\(name).png"))
        var lines: [String] = []
        if let image = rep.cgImage {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage:image).perform([request])
            lines = (request.results ?? []).sorted { $0.boundingBox.minY > $1.boundingBox.minY }.compactMap { $0.topCandidates(1).first?.string }
        }
        return (rep, lines)
    }

    private static func png(of window: NSWindow, to url: URL, sidebar: NSBitmapImageRep? = nil) throws {
        // The frame view (with the title bar) when it has a layer; a borderless window has only its content's.
        let view = [window.contentView!.superview, window.contentView].compactMap { $0 }.first { $0.layer != nil } ?? window.contentView!
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        // The layer tree, not cacheDisplay: cacheDisplay skips the sidebar list's row layers.
        let scale = window.backingScaleFactor
        let width = Int(view.bounds.width * scale), height = Int(view.bounds.height * scale)
        if view.layer == nil || width == 0 || height == 0 {
            FileHandle.standardError.write(Data("png \(url.lastPathComponent): \(type(of:view)) layer \(view.layer != nil) \(width)×\(height)\n".utf8))
        }
        guard let layer = view.layer,
              let context = CGContext(data:nil, width:width, height:height, bitsPerComponent:8, bytesPerRow:0,
                                      space:CGColorSpace(name:CGColorSpace.sRGB)!, bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw CocoaError(.fileWriteUnknown)
        }
        context.setFillColor((window.appearance?.name == .darkAqua ? NSColor(white:0.12, alpha:1) : NSColor.white).cgColor)
        context.fill(CGRect(x:0, y:0, width:width, height:height))
        context.scaleBy(x:scale, y:scale)
        if layer.isGeometryFlipped == false && view.isFlipped == false {} // AppKit layers draw bottom-up like CG
        (window.appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            layer.render(in:context)
            // Solid stand-in: the sidebar's material hides the list from this capture, so lay AppKit's own
            // drawing of the list over it, on a solid sidebar colour, where the window shows it.
            if let sidebar, let table = findTable(window.contentView!), let list = table.enclosingScrollView {
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(cgContext:context, flipped:false)
                NSColor.underPageBackgroundColor.setFill()
                list.convert(list.bounds, to:nil).fill()
                sidebar.draw(in:table.convert(table.bounds, to:nil))
                NSGraphicsContext.restoreGraphicsState()
            }
        }
        guard let image = context.makeImage() else { throw CocoaError(.fileWriteUnknown) }
        try NSBitmapImageRep(cgImage:image).representation(using:.png, properties:[:])!.write(to:url)
    }

    // MARK: Fixtures

    private struct FixtureObjects: ObjectsCompanion {
        /// nil: objects aren't set up on this Mac.
        let items: [StmObject]?
        func objects() async throws -> [StmObject] {
            guard let items else { throw ControlRemoteError(code:"unavailable", message:"The requested capability is unavailable") }
            return items
        }
        private func refuse() throws -> StmObject { throw ControlRemoteError(code:"conflict", message:"fixture") }
        func correct(_ id: String, note: String) async throws -> StmObject { try refuse() }
        func answerCloseup(_ id: String, bestGuess: Bool) async throws -> StmObject { try refuse() }
        func print(_ id: String, checked: Bool) async throws -> StmObject { try refuse() }
        func answerPlate(_ id: String) async throws -> StmObject { try refuse() }
        func start(_ id: String) async throws -> StmObject { try refuse() }
        func delete(_ id: String) async throws { _ = try refuse() }
    }

    private static func fixtures(in root: URL, stills: URL) throws -> [StmObject] {
        let shapes: [(String, [Part])] = [("hook", hook()), ("bracket", bracket()), ("mug", mug())]
        var models: [String: (stl: URL, size: [Double], renders: [URL])] = [:]
        let library = root.appendingPathComponent("library")
        try FileManager.default.createDirectory(at:library, withIntermediateDirectories:true)
        for (name, parts) in shapes {
            let stl = library.appendingPathComponent("\(name).stl")
            let size = try writeSTL(parts, to:stl)
            guard let scene = ModelScene.load(stl) else { throw CocoaError(.fileReadCorruptFile) }
            // The 3D view's own framing, as a still: proves the STL reads back upright and in frame.
            try write(ModelScene.snapshot(scene, size:CGSize(width:900, height:675)), to:stills.appendingPathComponent("model-\(name).png"))
            scene.background.contents = NSColor(red:0.93, green:0.925, blue:0.915, alpha:1)
            var renders: [URL] = []
            for (index, angle) in [0.0, 1.25, -0.95].enumerated() {
                turn(scene, by:angle)
                let url = library.appendingPathComponent("\(name)-\(index).png")
                try write(ModelScene.snapshot(scene, size:CGSize(width:1024, height:768)), to:url)
                renders.append(url)
            }
            models[name] = (stl, size, renders)
        }
        let now = Date().timeIntervalSince1970 * 1000
        var objects: [StmObject] = []
        func add(_ name: String, model: String?, _ fields: [String: Any], plate: Bool = false) throws {
            let id = UUID().uuidString.lowercased()
            let folder = root.appendingPathComponent(id)
            try FileManager.default.createDirectory(at:folder.appendingPathComponent("current/renders"), withIntermediateDirectories:true)
            var json: [String: Any] = ["id": id, "createdAtMs": now - Double(objects.count) * 3_600_000, "updatedAtMs": now,
                                       "state": "ready", "photos": ["photo-01.heic", "photo-02.heic"], "passes": [["startedAtMs": now - 200_000, "endedAtMs": now - 60_000, "status": "done"]],
                                       "directory": folder.path]
            if let model, let source = models[model] {
                try FileManager.default.copyItem(at:source.stl, to:folder.appendingPathComponent("current/model.stl"))
                var renders: [String] = []
                for (index, render) in source.renders.enumerated() {
                    let relative = "current/renders/view-\(index).png"
                    try FileManager.default.copyItem(at:render, to:folder.appendingPathComponent(relative))
                    renders.append(relative)
                }
                json["current"] = ["model": "current/model.stl", "renders": renders, "sizeMm": source.size]
            }
            if plate { try write(platePhoto(), to:folder.appendingPathComponent("plate.jpg"), type:.jpeg) }
            json.merge(fields) { $1 }
            objects.append(try JSONDecoder().decode(StmObject.self, from:JSONSerialization.data(withJSONObject:json)))
            _ = name
        }
        try add("hook", model:"hook", ["instructions": "A hook for a 25 mm tube. It should hold a cup.", "scan": "scan.usdz"])
        try add("bracket", model:"bracket", ["instructions": "A shelf bracket, 3 mm thick, with two screw holes", "state": "needs-closeup",
                                            "question": ["closeup": "the screw holes on the back"]])
        try add("mug", model:nil, ["scan": "scan.usdz", "state": "touching-up", "passes": [["startedAtMs": now - 90_000]]])
        try add("clip", model:"bracket", ["instructions": "A clip that holds two cables under the desk", "state": "printing",
                                         "print": ["bundleId": "fixture"], "plate": ["item": "a printed part", "photo": true]], plate:true)
        try add("arriving", model:nil, ["scan": "scan.usdz", "state": "new", "passes": []])
        try add("knob", model:"mug", ["instructions": "A replacement knob for the bathroom cabinet that matches the others", "state": "failed",
                                     "failure": "The printer may have started this print. Check the printer before printing again.",
                                     "print": ["bundleId": "fixture", "uncertain": true]])
        try add("spacer", model:"hook", ["instructions": "A 12 mm spacer for the table leg", "state": "printed"])
        try add("noCamera", model:"bracket", ["instructions": "A cable clip", "state": "printing", "print": ["bundleId": "fixture"],
                                             "plate": ["noCamera": true]])
        return objects
    }

    /// Moves the scene's camera around the upright axis.
    private static func turn(_ scene: SCNScene, by angle: Double) {
        guard let eye = scene.rootNode.childNode(withName:"eye", recursively:false) else { return }
        if eye.value(forKey:"home") == nil { eye.setValue(NSValue(scnVector3:eye.position), forKey:"home") }
        let home = (eye.value(forKey:"home") as! NSValue).scnVector3Value
        // Separate steps: one mixed CGFloat/Double expression is too slow for Xcode 16's type checker (CI's runner).
        let c = CGFloat(cos(angle)), s = CGFloat(sin(angle))
        let x: CGFloat = home.x * c + home.z * s
        let z: CGFloat = home.z * c - home.x * s
        eye.position = SCNVector3(x, home.y, z)
        eye.look(at:SCNVector3Zero)
    }

    // Generic shapes, Z-up in millimetres like a slicer's STL, from ModelIO's primitives (their vertex
    // data is the real size; SceneKit's parametric shapes expose a unit template instead).
    private struct Part { let mesh: MDLMesh; let transform: simd_float4x4 }
    private static func place(_ mesh: MDLMesh, _ x: Float, _ y: Float, _ z: Float, tiltX: Float = 0) -> Part {
        var move = matrix_identity_float4x4
        move.columns.3 = SIMD4(x, y, z, 1)
        let c = cos(tiltX), s = sin(tiltX)
        let tilt = simd_float4x4(SIMD4(1, 0, 0, 0), SIMD4(0, c, s, 0), SIMD4(0, -s, c, 0), SIMD4(0, 0, 0, 1))
        return Part(mesh:mesh, transform:move * tilt)
    }
    private static func box(_ x: Float, _ y: Float, _ z: Float) -> MDLMesh {
        MDLMesh(boxWithExtent:SIMD3(x, y, z), segments:SIMD3(1, 1, 1), inwardNormals:false, geometryType:.triangles, allocator:nil)
    }
    /// ModelIO's cylinders run along Y (their x/z extent comes out as the radius); `upright` tips them to stand along Z.
    private static func cylinder(_ radius: Float, _ height: Float, _ x: Float, _ y: Float, _ z: Float, upright: Bool = true) -> Part {
        let mesh = MDLMesh(cylinderWithExtent:SIMD3(radius, height, radius), segments:SIMD2(72, 1), inwardNormals:false,
                           topCap:true, bottomCap:true, geometryType:.triangles, allocator:nil)
        return place(mesh, x, y, z, tiltX:upright ? .pi / 2 : 0)
    }
    private static func hook() -> [Part] {
        [place(box(14, 8, 74), 0, 0, 47), place(box(38, 8, 12), 12, 0, 6), place(box(10, 8, 28), 26, 0, 14),
         cylinder(11, 8, 0, 0, 90, upright:false)]
    }
    private static func bracket() -> [Part] {
        var parts = [place(box(64, 36, 5), 0, 0, 2.5), place(box(64, 5, 46), 0, 15.5, 23)]
        for x: Float in [-24, 24] {
            parts.append(place(box(4, 26, 26), x, 7, 12, tiltX:-.pi / 4))
            parts.append(cylinder(5, 7, x * 0.6, -9, 5.5))
        }
        return parts
    }
    private static func mug() -> [Part] {
        [cylinder(34, 84, 0, 0, 42), cylinder(36, 4, 0, 0, 82),
         place(box(9, 12, 50), 49, 0, 46), place(box(18, 12, 9), 40, 0, 66), place(box(18, 12, 9), 40, 0, 26)]
    }

    /// Writes the parts' triangles as binary STL and returns the size in millimetres.
    private static func writeSTL(_ parts: [Part], to url: URL) throws -> [Double] {
        var points: [SIMD3<Float>] = []
        for part in parts {
            guard let positions = part.mesh.vertexAttributeData(forAttributeNamed:MDLVertexAttributePosition, as:.float3) else { continue }
            let start = UnsafeRawPointer(positions.dataStart)
            let vertices = (0..<part.mesh.vertexCount).map { index -> SIMD3<Float> in
                let base = index * positions.stride
                let world = part.transform * SIMD4<Float>(start.loadUnaligned(fromByteOffset:base, as:Float.self),
                                                          start.loadUnaligned(fromByteOffset:base + 4, as:Float.self),
                                                          start.loadUnaligned(fromByteOffset:base + 8, as:Float.self), 1)
                return SIMD3(world.x, world.y, world.z)
            }
            for submesh in part.mesh.submeshes as? [MDLSubmesh] ?? [] where submesh.geometryType == .triangles {
                let map = submesh.indexBuffer.map()
                let bytes = UnsafeRawPointer(map.bytes)
                for index in 0..<submesh.indexCount {
                    switch submesh.indexType {
                    case .uInt8: points.append(vertices[Int(bytes.load(fromByteOffset:index, as:UInt8.self))])
                    case .uInt16: points.append(vertices[Int(bytes.loadUnaligned(fromByteOffset:index * 2, as:UInt16.self))])
                    default: points.append(vertices[Int(bytes.loadUnaligned(fromByteOffset:index * 4, as:UInt32.self))])
                    }
                }
            }
        }
        var data = Data(count:80)
        func append<T>(_ value: T) { withUnsafeBytes(of:value) { data.append(contentsOf:$0) } }
        append(UInt32(points.count / 3))
        var low = SIMD3<Float>(repeating:.greatestFiniteMagnitude), high = -low
        for start in stride(from:0, to:points.count - 2, by:3) {
            let (a, b, c) = (points[start], points[start + 1], points[start + 2])
            let normal = simd_normalize(simd_cross(b - a, c - a))
            for value in [normal, a, b, c] { append(value.x); append(value.y); append(value.z) }
            append(UInt16(0))
            low = simd_min(low, simd_min(a, simd_min(b, c))); high = simd_max(high, simd_max(a, simd_max(b, c)))
        }
        try data.write(to:url)
        let size = high - low
        return [Double(size.x), Double(size.y), Double(size.z)]
    }

    /// A generic printer-camera photo: a dark textured plate with one small printed part left on it.
    private static func platePhoto() -> NSImage {
        NSImage(size:NSSize(width:800, height:600), flipped:false) { rect in
            NSColor(calibratedWhite:0.11, alpha:1).setFill(); rect.fill()
            let plate = NSBezierPath(roundedRect:NSRect(x:70, y:40, width:660, height:500), xRadius:14, yRadius:14)
            NSGradient(starting:NSColor(calibratedWhite:0.30, alpha:1), ending:NSColor(calibratedWhite:0.20, alpha:1))!.draw(in:plate, angle:90)
            NSColor(calibratedWhite:0.36, alpha:1).setStroke()
            for x in stride(from:120.0, to:720, by:60) { let line = NSBezierPath(); line.move(to:NSPoint(x:x, y:60)); line.line(to:NSPoint(x:x, y:520)); line.lineWidth = 0.6; line.stroke() }
            let shadow = NSShadow(); shadow.shadowBlurRadius = 10; shadow.shadowOffset = NSSize(width:4, height:-6); shadow.shadowColor = .black.withAlphaComponent(0.6)
            NSGraphicsContext.saveGraphicsState(); shadow.set()
            NSColor(red:0.86, green:0.47, blue:0.22, alpha:1).setFill()
            NSBezierPath(roundedRect:NSRect(x:470, y:250, width:120, height:74), xRadius:10, yRadius:10).fill()
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
    }

    private static func write(_ image: NSImage, to url: URL, type: NSBitmapImageRep.FileType = .png) throws {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data:tiff),
              let data = bitmap.representation(using:type, properties:[.compressionFactor: 0.85]) else { throw CocoaError(.fileWriteUnknown) }
        try data.write(to:url)
    }
}
#endif
