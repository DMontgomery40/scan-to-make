import Foundation

// Add printer… (PRD §5.8): what the companion's `printers.discover`, `.check`, `.obtain` and `.add` answer, and the
// form they take. Shared by the Mac (ControlKit, over the control socket) and the iPhone, iPad (CompanionClient, over
// `/v1/printers/setup/*`). Every brand, field, label and hint is the printer MCPs' own (`counterpart_setup_fields`).

public struct PrinterSetupOptions: Decodable, Sendable, Equatable {
    public struct Secret: Decodable, Sendable, Equatable {
        public let label: String
        public let hint: String?
        public let required: Bool
        /// The MCPs that can fetch it for the person (`printers.obtain`, e.g. OctoPrint's key approved in OctoPrint), in their words.
        public let obtain: Obtain?
    }
    /// A field's value the MCP can fetch instead of the person typing it: the button's words and the MCPs that offer it.
    public struct Obtain: Decodable, Sendable, Equatable {
        public let label: String
        public let hint: String?
        public let backends: [String]
    }
    /// One of the MCP's own settings (`counterpart_setup_fields`): the `.env` variable, its label and hint, and whether it's needed.
    public struct Field: Decodable, Sendable, Equatable, Identifiable {
        public let name: String
        public let env: String
        public let label: String
        public let hint: String?
        public let required: Bool
        /// "path": a file or folder on this Mac.
        public let input: String?
        public let choices: [Model]?
        public var id: String { name }
    }
    /// The slicer an MCP would run, as it resolves it now, and the settings that choose it.
    public struct Slicer: Decodable, Sendable, Equatable {
        public let type: String
        public let path: String?
        public let found: Bool
        public let profilesRoot: String?
        public let profilesFound: Bool?
        public let fields: [Field]
        public func field(_ name: String) -> Field? { fields.first { $0.name == name } }
    }
    /// An MCP on this Mac that can't say yet what it needs: its words for the person.
    public struct Update: Decodable, Sendable, Equatable, Identifiable {
        public let package: String
        public let message: String
        public var id: String { package }
    }
    /// A brand or host software: mcp-3D-printer-server's `PRINTER_TYPE`, and the MCPs that can reach it (the default first).
    public struct PrinterType: Decodable, Sendable, Equatable, Identifiable {
        public let printerType: String
        public let label: String
        public let backends: [String]
        /// Its MCP reads a serial number (it declares a `serial` field).
        public let serial: Bool
        public let secret: Secret?
        /// The address field in the MCP's words; `url` when it also takes a web address (https://…, a sub-path).
        public let address: Address?
        /// Every setting the MCP reads for this kind, in its words (its first MCP's list); nil from an older companion.
        public let fields: [Field]?
        /// The MCPs whose Check asks for this kind's camera picture (each MCP says so in `counterpart_setup_fields`); nil from an older companion.
        public let checkCamera: [String]?
        public func field(_ name: String) -> Field? { fields?.first { $0.name == name } }
        /// Whether Check asks this MCP for a camera picture of a printer of this kind.
        public func checksCamera(_ backend: String) -> Bool { checkCamera?.contains(backend) == true }
        public var id: String { printerType }
    }
    public struct Address: Decodable, Sendable, Equatable {
        public let hint: String?
        public let url: Bool?
    }
    public struct Model: Decodable, Sendable, Equatable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { value }
    }
    public let types: [PrinterType]
    /// Each MCP's own model names, by package.
    public let models: [String: [Model]]
    /// A serial number's prefix → its model (the MCP's own table).
    public let serialModels: [String: String]?
    /// The slicer each MCP would run and its settings, by package; nil from an older companion.
    public let slicer: [String: Slicer]?
    /// MCPs that need an update before they can set up printers.
    public let updates: [Update]?
    /// The model a typed serial number names, when it is one the MCP knows (its prefixes are all one length).
    public func model(forSerial serial: String) -> String? {
        guard let length = serialModels?.keys.first?.count else { return nil }
        let prefix = String(serial.trimmingCharacters(in: .whitespaces).prefix(length)).uppercased()
        return prefix.count == length ? serialModels?[prefix] : nil
    }
}

/// A printer Add printer… found: a configured MCP folder on this Mac, or a printer on the network. Never a secret.
public struct PrinterCandidate: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    /// `folder`, `ssdp` or `bonjour`.
    public let source: String
    public let name: String
    public let backend: String
    public let printerType: String
    public let model: String?
    public let host: String?
    public let port: String?
    public let serial: String?
    /// A configured MCP folder: Add runs it where it is, in one click.
    public let folder: String?
    /// Already one of the printers.
    public let added: Bool
    /// A folder whose `.env` lacks settings its MCP needs (names only), and what Add fills (only the model).
    public let missing: [String]?
    public let fill: [String: String]?
    /// Add also copies another MCP's authenticated route for this printer (lines in `fill`).
    public let route: Bool?
}

public extension PrinterCandidate {
    /// The `.env` variable its MCP declares for the printer's model (`counterpart_setup_fields`), never a name the app knows.
    func modelSetting(_ options: PrinterSetupOptions?) -> String? {
        options?.types.first { $0.printerType == printerType }?.field("model")?.env
    }
    /// Its MCP needs a model Counterpart couldn't tell, by the MCP's own model field: the phone asks.
    func needsModel(_ options: PrinterSetupOptions?) -> Bool {
        guard let setting = modelSetting(options) else { return false }
        return missing?.contains(setting) == true && fill?[setting] == nil
    }
    /// The model Add fills for it, when Counterpart could tell.
    func filledModel(_ options: PrinterSetupOptions?) -> String? { modelSetting(options).flatMap { fill?[$0] } }
}

public extension PrinterForm {
    /// The form for a kind: values for fields its MCP doesn't declare (port, serial, model) are dropped, so they are never
    /// sent. Kept as they are when the kind's fields are unknown.
    mutating func keepFields(of type: PrinterSetupOptions.PrinterType?) {
        guard let type, type.fields != nil else { return }
        if type.field("port") == nil { port = nil }
        if type.field("serial") == nil { serial = "" }
        if type.field("model") == nil { model = nil }
    }
    /// What the kind's MCP requires that the form lacks (its required address, serial and model fields; the secret is the sheet's).
    func lacks(_ type: PrinterSetupOptions.PrinterType?) -> [PrinterSetupOptions.Field] {
        guard let fields = type?.fields else { return [] }
        return fields.filter { field in
            guard field.required else { return false }
            switch field.name {
            case "host": return host.trimmingCharacters(in: .whitespaces).isEmpty
            case "serial": return serial.trimmingCharacters(in: .whitespaces).isEmpty
            case "model": return model == nil
            default: return false
            }
        }
    }
    /// Types the serial number. The serial names the model (the MCP's own table) unless the person chose one, so a
    /// corrected serial picks again. `inferred` says whether the current model came from discovery or the serial; the
    /// result says whether the model now does.
    mutating func setSerial(_ value: String, options: PrinterSetupOptions?, inferred: Bool) -> Bool {
        serial = value
        guard model == nil || inferred else { return false }
        let models = options?.models[backend] ?? []
        let named = options?.model(forSerial: value).flatMap { found in models.contains { $0.value == found } ? found : nil }
        if named != nil || inferred { model = named }
        return named != nil
    }
}

public struct PrinterDiscovery: Decodable, Sendable, Equatable {
    public let found: [PrinterCandidate]
    /// `unavailable` when this Mac couldn't listen for Bambu printers (another app may hold the port).
    public let network: String
    public let options: PrinterSetupOptions
    /// Each MCP's name as people see it, from the companion (the phones' `/v1/printers/setup/discover`); nil over the socket.
    public let labels: [String: String]?
    /// An MCP's name: the companion's, else its package name as it is.
    public func label(_ backend: String) -> String { labels?[backend] ?? backend }
}

/// What Check and Add send: a found folder, or the form's fields. `secret` is the access code or API key.
/// Add printer…'s Slicer section, from the chosen MCP's own `slicer` fields (`counterpart_setup_fields`): its slicer
/// choice, and the paths it reads when it can't find its slicer or Bambu profiles. None for an MCP that declares none.
public struct SlicerControls: Sendable, Equatable {
    public let slicer: PrinterSetupOptions.Slicer
    public init?(options: PrinterSetupOptions?, backend: String) {
        guard let slicer = options?.slicer?[backend] else { return nil }
        self.slicer = slicer
    }
    /// The slicer choice, when the MCP offers one.
    public var choice: PrinterSetupOptions.Field? { slicer.field("slicer").flatMap { ($0.choices ?? []).isEmpty ? nil : $0 } }
    public var path: PrinterSetupOptions.Field? { slicer.field("slicer-path") }
    public var profiles: PrinterSetupOptions.Field? { slicer.field("profiles") }
    /// The slicer shown as chosen: the person's, else the one the MCP would run.
    public func selected(in form: PrinterForm) -> String { form.slicer ?? slicer.type }
    /// The MCP's own slicer sends nothing, so only a change is sent (and SLICER_TYPE agrees with SLICER_PATH).
    public func choose(_ value: String, in form: inout PrinterForm) { form.slicer = value == slicer.type ? nil : value }
}

/// Add printer…'s address field: the MCP's hint, and a prompt that offers a web address only where the MCP takes one.
public struct AddressField: Sendable, Equatable {
    public let hint: String?
    public let prompt: String
    public init(options: PrinterSetupOptions?, printerType: String) {
        let address = options?.types.first { $0.printerType == printerType }?.address
        hint = address?.hint
        prompt = address?.url == true ? "192.168.1.20, printer.local or https://…" : "192.168.1.20 or printer.local"
    }
}

/// Add printer…'s button that fetches the key or access code through the chosen MCP, when its field declares one
/// (`obtain` in `counterpart_setup_fields`). Its words are the MCP's own; nil otherwise.
public struct ObtainControl: Sendable, Equatable {
    public let field = "secret"
    public let label: String
    public let hint: String?
    public init?(options: PrinterSetupOptions?, form: PrinterForm) {
        guard form.folder == nil, let obtain = options?.types.first(where: { $0.printerType == form.printerType })?.secret?.obtain,
              obtain.backends.contains(form.backend) else { return nil }
        label = obtain.label; hint = obtain.hint
    }
}

/// One step of `printers.obtain`: what the person sees, the page where they approve it, and once approved the value.
public struct ObtainStep: Decodable, Sendable, Equatable {
    public let session: String?
    /// `pending`, `approved` or `failed`.
    public let status: String
    public let message: String
    public let approveUrl: String?
    public let value: String?
    public init(session: String? = nil, status: String, message: String, approveUrl: String? = nil, value: String? = nil) {
        self.session = session; self.status = status; self.message = message; self.approveUrl = approveUrl; self.value = value
    }
    public var pending: Bool { status == "pending" }
    /// The approval page, http or https only.
    public var approvalPage: URL? { approveUrl.flatMap(URL.init(string:)).flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil } }
}

public struct PrinterForm: Sendable, Equatable, Encodable {
    public var folder: String?
    /// The MCP and the kind it drives, from the MCPs' own list; the sheet sets both before anything is sent.
    public var backend = ""
    public var printerType = ""
    public var host = ""
    public var port: String?
    public var serial = ""
    public var model: String?
    public var secret = ""
    public var name: String?
    /// The MCP's slicer settings, when the person sets them (`slicer.fields`): where the slicer and its Bambu profiles are.
    public var slicer: String?
    public var slicerPath: String?
    public var profiles: String?
    public init(folder: String? = nil) { self.folder = folder }
    /// The wire form `printers.check` and `printers.add` take (`PrinterFormSchema`), on the Mac's socket and the phone's HTTP alike.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        if let folder {
            try c.encode(folder, forKey: .folder)
            try c.encodeIfPresent(model, forKey: .model)
            return
        }
        try c.encode(backend, forKey: .backend); try c.encode(printerType, forKey: .printerType)
        try c.encode(host.trimmingCharacters(in: .whitespaces), forKey: .host)
        // Each value the form holds; `keepFields(of:)` drops what the chosen kind's MCP doesn't read.
        if let port, !port.isEmpty { try c.encode(port, forKey: .port) }
        let serial = serial.trimmingCharacters(in: .whitespaces)
        if !serial.isEmpty { try c.encode(serial, forKey: .serial) }
        try c.encodeIfPresent(model, forKey: .model)
        if !secret.isEmpty { try c.encode(secret, forKey: .secret) }
        if let name, !name.isEmpty { try c.encode(name, forKey: .name) }
        if let slicer, !slicer.isEmpty { try c.encode(slicer, forKey: .slicer) }
        if let slicerPath, !slicerPath.isEmpty { try c.encode(slicerPath, forKey: .slicerPath) }
        if let profiles, !profiles.isEmpty { try c.encode(profiles, forKey: .profiles) }
    }
    private enum Key: String, CodingKey { case folder, backend, printerType, host, port, serial, model, secret, name, slicer, slicerPath, profiles }
}

/// Check: what get_printer_status (and, for a Bambu printer, camera_snapshot) said. Never the MCP's own words.
public struct PrinterCheckResult: Decodable, Sendable, Equatable {
    public struct Image: Decodable, Sendable, Equatable { public let mimeType: String; public let base64: String }
    public let reached: Bool
    /// `connected`, `failed` or `not-supported`.
    public let camera: String
    public let image: Image?
    public let model: String?
}

public struct PrinterAdded: Decodable, Sendable, Equatable {
    public let id: String
    /// The printer it is listed as; another one when it is the same printer through another MCP.
    public let destinationId: String?
    public let sameAs: String?
}

/// Runs `printers.obtain` for the form until the person answers in the MCP's page, it fails, or the task is cancelled
/// (the sheet closed or the printer changed). Each step is shown as it comes; the last is returned.
public func obtainSetupValue(_ form: PrinterForm, field: String, step: (PrinterForm, String, String?) async throws -> ObtainStep,
                             shown: @MainActor (ObtainStep) -> Void) async throws -> ObtainStep {
    var current = try await step(form, field, nil)
    await shown(current)
    while current.pending, let session = current.session, !Task.isCancelled {
        current = try await step(form, field, session)
        if !Task.isCancelled { await shown(current) }
    }
    return current
}
