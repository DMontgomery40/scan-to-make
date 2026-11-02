#if canImport(SwiftUI)
import SwiftUI

/// The same saved controls on Mac and phone. Adapters supply their transport and native file URLs.
public struct ProjectSettingsForm: View {
    public struct Printer: Identifiable {
        public var id: String, name: String
        public var quality: Bool, strength: Bool, copies: Bool, materialChoice: Bool
        public init(id: String, name: String, quality: Bool, strength: Bool, copies: Bool, materialChoice: Bool) {
            self.id = id; self.name = name; self.quality = quality; self.strength = strength; self.copies = copies; self.materialChoice = materialChoice
        }
    }
    public struct Colour: Identifiable {
        public var id: String, name: String
        public var value: JSONValue
        public init(id: String, name: String, value: JSONValue) { self.id = id; self.name = name; self.value = value }
    }
    public struct File: Identifiable {
        public var id: String, name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }
    public struct Context {
        public var printers: [Printer], defaultPrinter: String?
        public var colours: [Colour], fusionAvailable: Bool
        public var filamentProblem: String?
        public init(printers: [Printer], defaultPrinter: String?, colours: [Colour], fusionAvailable: Bool, filamentProblem: String? = nil) {
            self.printers = printers; self.defaultPrinter = defaultPrinter; self.colours = colours
            self.fusionAvailable = fusionAvailable; self.filamentProblem = filamentProblem
        }
    }
    private let project: Project
    private let load: () async throws -> Context
    private let save: ([String: JSONValue]) async throws -> Void
    private let duplicate: () async throws -> Void
    private let delete: () async throws -> Void
    private let files: [File]
    private let download: (File) async throws -> URL
    private let reveal: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var context: Context?
    @State private var busy = false
    @State private var problem: String?
    @State private var deleting = false
    @State private var downloaded: [String: URL] = [:]
    @State private var material = ""

    public init(project: Project, files: [File], reveal: (() -> Void)? = nil,
                load: @escaping () async throws -> Context, save: @escaping ([String: JSONValue]) async throws -> Void,
                duplicate: @escaping () async throws -> Void, delete: @escaping () async throws -> Void,
                download: @escaping (File) async throws -> URL) {
        self.project = project; self.files = files; self.reveal = reveal; self.load = load; self.save = save
        self.duplicate = duplicate; self.delete = delete; self.download = download
        _name = State(initialValue: ProjectWords(project).title)
    }

    private var defaults: PrintSettings { project.settings?.printDefaults ?? project.print?.settings ?? PrintSettings() }
    private var printer: Printer? { context?.printers.first { $0.id == (project.printerDestinationId ?? context?.defaultPrinter) } }
    private var busyProject: Bool { project.state == .touchingUp || project.state == .printing }
    private var copy: Bool { project.usesCopyWorkflow }
    private var selectedColour: String { context?.colours.first { $0.value == defaults.colour }?.id ?? (defaults.colour == nil ? "profile" : "saved") }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name).accessibilityIdentifier("project-settings-name")
                    Button("Rename") { patch(["title": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]) }
                        .disabled(!Project.validName(name) || name == ProjectWords(project).title)
                    Picker("Status", selection: Binding(get: { project.statusUnderneath.rawValue }, set: { patch(["status": .string($0)]) })) {
                        Text("Not printed yet").tag("not-printed")
                        Text("Printed").tag("printed")
                        Text("Done — it works").tag("works")
                        Text("Needs changes").tag("needs-changes")
                    }.disabled(busyProject)
                } header: { Text("Project") } footer: { Text("Changes are saved on your Mac and shared with your other devices.") }
                printDefaults
                Section("Design") {
                    if copy { LabeledContent("Design engine", value: "Blender") }
                    else {
                        Picker("Design engine", selection: Binding(get: { project.settings?.designEngine ?? "auto" }, set: { patch(["designEngine": .string($0)]) })) {
                            Text("Automatic").tag("auto")
                            Text("Blender").tag("blender")
                            if context?.fusionAvailable == true || project.settings?.designEngine == "fusion" { Text("Fusion").tag("fusion") }
                        }
                        if context?.fusionAvailable != true { Text("Set up Fusion in app Settings to use it for this project's next changes.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                Section("Notifications") {
                    Picker("This project's prints", selection: Binding(get: { project.settings?.notifications ?? "all" }, set: { patch(["notifications": .string($0)]) })) {
                        Text("Milestones and done").tag("all")
                        Text("Only problems").tag("problems")
                    }
                    Text("Your device's notification settings still apply. Printer questions always need an answer.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Files") {
                    if let reveal { Button("Show in Finder", action: reveal) }
                    ForEach(files) { file in
                        if let url = downloaded[file.id] { ShareLink(file.name, item: url) }
                        else { Button("Export \(file.name)") { run { downloaded[file.id] = try await download(file) } } }
                    }
                    if files.isEmpty { Text("No model or original files yet.").foregroundStyle(.secondary) }
                    if let credit = project.credit?.object {
                        if let title = credit["title"]?.string { Text(title) }
                        if let author = credit["designer"]?.string { Text("By \(author)").foregroundStyle(.secondary) }
                        if let link = credit["url"]?.string, let url = URL(string: link), ["https", "http"].contains(url.scheme) { Link("Designer’s model page", destination: url) }
                    }
                }
                Section {
                    Button("Duplicate Project", systemImage: "plus.square.on.square") { run { try await duplicate(); dismiss() } }
                        .disabled(project.current == nil || project.state == .touchingUp).accessibilityIdentifier("project-settings-duplicate")
                    Button(project.isArchived ? "Show on Home" : "Archive — Hide from Home") { patch(["archived": .bool(!project.isArchived)]) }
                    Button("Delete Project", role: .destructive) { deleting = true }.disabled(busyProject)
                } footer: { Text("Duplicate copies the current model and settings. Archive keeps the project's files and status.") }
                if let problem { Section { Text(problem).foregroundStyle(.red).textSelection(.enabled) } }
            }
            .formStyle(.grouped).disabled(busy)
            .navigationTitle("Project Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(busy).accessibilityIdentifier("project-settings-done") } }
            .overlay { if busy { ProgressView().padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
            .task(id: project.printerDestinationId) {
                context = nil
                do { let loaded = try await load(); if !Task.isCancelled { context = loaded } }
                catch { if !Task.isCancelled { problem = message(error) } }
            }
            .confirmationDialog("Delete this project from your Mac?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete Project", role: .destructive) { run { try await delete(); dismiss() } }
            } message: { Text("Its model, photos and activity are removed from your Mac.") }
        }
    }

    private var printDefaults: some View {
        Section {
            if let context {
                Picker("Printer", selection: Binding(get: { project.printerDestinationId ?? "" }, set: { patch(["printerDestinationId": $0.isEmpty ? .null : .string($0)]) })) {
                    Text("Default printer").tag("")
                    ForEach(context.printers) { Text($0.name).tag($0.id) }
                    if let saved = project.printerDestinationId, !context.printers.contains(where: { $0.id == saved }) { Text("Saved printer (unavailable)").tag(saved) }
                }.disabled(busyProject)
                Picker("Quality", selection: Binding(get: { defaults.quality ?? "standard" }, set: { printPatch("quality", .string($0)) })) {
                    Text("Draft").tag("draft"); Text("Standard").tag("standard"); Text("Fine").tag("fine")
                }.disabled(printer?.quality != true).accessibilityIdentifier("project-settings-quality")
                Picker("Strength", selection: Binding(get: { defaults.strength ?? "standard" }, set: { printPatch("strength", .string($0)) })) {
                    Text("Standard").tag("standard"); Text("Strong").tag("strong"); Text("Max").tag("max")
                }.disabled(printer?.strength != true)
                Stepper(defaults.copies.map { "Copies: \($0)" } ?? "Copies: printer profile", value: Binding(get: { defaults.copies ?? 1 }, set: { printPatch("copies", .number(Double($0))) }), in: 1...64)
                    .disabled(printer?.copies != true).accessibilityIdentifier("project-settings-copies")
                if defaults.copies != nil { Button("Use printer profile's copy count") { printPatch("copies", nil) } }
                Picker("Colour", selection: Binding(get: { selectedColour }, set: { id in printPatch("colour", context.colours.first { $0.id == id }?.value) })) {
                    Text("Printer profile").tag("profile")
                    ForEach(context.colours) { Text($0.name).tag($0.id) }
                    if selectedColour == "saved" { Text("Saved choice (not currently reported)").tag("saved") }
                }
                if context.colours.isEmpty && printer?.materialChoice == true {
                    TextField("Material, for example PLA", text: $material)
                    Button("Use Material") { printPatch("colour", .object(["material": .string(material.trimmingCharacters(in: .whitespacesAndNewlines))])) }
                        .disabled(material.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let problem = context.filamentProblem { Text(problem).font(.caption).foregroundStyle(.secondary) }
            } else if problem != nil {
                Button("Try Reading Printer Settings Again") { run { context = try await load() } }
            } else { ProgressView("Reading printer settings…") }
        } header: { Text("Print defaults") } footer: { Text("One colour for the model. These defaults are reused when you print; you can change them for an individual print.") }
    }

    private func printPatch(_ key: String, _ value: JSONValue?) {
        guard let data = try? JSONEncoder().encode(defaults), case .object(var fields)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        fields[key] = value
        patch(["printDefaults": .object(fields)])
    }
    private func patch(_ values: [String: JSONValue]) { run { try await save(values) } }
    private func run(_ body: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true; problem = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await body() } catch { problem = message(error) }
        }
    }
    private func message(_ error: Error) -> String { (error as? CompanionError)?.message ?? error.localizedDescription }
}
public extension Project {
    var settingsFiles: [ProjectSettingsForm.File] {
        var result: [ProjectSettingsForm.File] = []
        if current != nil { result.append(.init(id: "model.stl", name: "Current model (STL)")) }
        if let scan { result.append(.init(id: "scan/" + scan, name: "Original scan")) }
        result += photos.map { .init(id: "photos/" + $0, name: $0) }
        result += (capture ?? []).map { .init(id: "capture/" + $0, name: $0) }
        if case .array(let originals)? = files?.object?["original"] {
            for (index, file) in originals.enumerated() {
                if let path = file.string, ["stl", "3mf", "usdz"].contains(URL(fileURLWithPath: path).pathExtension.lowercased()) { result.append(.init(id: "original/\(index)", name: URL(fileURLWithPath: path).lastPathComponent)) }
            }
        }
        return result
    }
}

#endif
