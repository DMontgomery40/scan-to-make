import Foundation

/// What a phone keeps of its Mac's projects, so a screen always draws what the phone has already shown, with or without the
/// Mac (David, Nov 11: "Never seen app in my life, since 2009 or so, struggle showing images it just had, 10 minutes later,
/// because of a dependency on some Mac mini"). Design: docs/design/overhaul/on-device-library.md.
///
/// - Where: Application Support (never purged by the system, unlike `Library/Caches`), one folder per paired Mac, excluded
///   from backup (the Mac can send it again) and protected until the phone's first unlock, so the background fill and a
///   Live Activity's picture still read it while the phone is locked.
/// - What: one file per project path (`pictures/part-….png`, `model.stl`, `asks/<id>.jpg`, …), the newest version the
///   phone has. A newer version is written beside it and replaces it only once it has fully arrived.
/// - The index (`index.json`) says, per file, its version, its size, what kind it is, and when its project was last opened,
///   which is what eviction reads.
public final class OnDeviceLibrary: @unchecked Sendable {
    /// What the person chose to keep on this phone (Settings → Keep on this iPhone).
    public enum Keep: String, CaseIterable, Codable, Sendable {
        case pictures, models, everything

        public var title: String {
            switch self {
            case .pictures: "Pictures only"
            case .models: "Pictures and 3D models"
            case .everything: "Everything, scans included"
            }
        }

        /// The most the library holds before it lets the oldest-opened projects' files go.
        public var ceiling: Int64 {
            switch self {
            case .pictures: 200 << 20
            case .models: 500 << 20
            case .everything: 2 << 30
            }
        }

        public func keeps(_ kind: Kind) -> Bool {
            switch self {
            case .pictures: kind == .picture
            case .models: kind != .scan
            case .everything: true
            }
        }

        public static let defaultsKey = "CounterpartLibraryKeep"
        public static var chosen: Keep {
            get { UserDefaults.standard.string(forKey: defaultsKey).flatMap(Keep.init(rawValue:)) ?? .models }
            set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
        }
    }

    /// What a project path is, for what to keep and what goes first when the library is full.
    public enum Kind: String, Codable, Sendable, Comparable {
        /// The Mac's pictures, renders, plate pictures, the question's photo: small, kept for every project, evicted last.
        case picture
        /// The 3D model the page turns (`model.stl`, a designer's original).
        case model
        /// A scan's model and its photos: large, kept only when the person chose everything, evicted first.
        case scan

        public static func of(_ name: String) -> Kind {
            if name == "model.stl" || name.hasPrefix("original/") { return .model }
            if name.hasPrefix("scan/") || name.hasPrefix("capture/") || name.hasPrefix("photos/") { return .scan }
            return .picture
        }

        /// The order eviction lets kinds go in: scans, then models, then pictures.
        private var evictionRank: Int { switch self { case .scan: 0; case .model: 1; case .picture: 2 } }
        public static func < (a: Kind, b: Kind) -> Bool { a.evictionRank < b.evictionRank }
    }

    public struct Entry: Codable, Equatable, Sendable {
        public var project: String
        public var name: String
        public var version: Int64
        /// The file's name in the project's folder: the version, then `variant`.
        public var file: String
        /// Which file of that name the Mac sent (the model's carries the selected original's hash): a request for another
        /// variant of the same version is not this one.
        public var variant: String
        public var bytes: Int64
        public var kind: Kind
        public var storedAt: Date
        /// The Mac's validator for these bytes (its `ETag`, a hash of the file), when it sent one: a newer project version
        /// asks the Mac with it and, if the bytes are the same, keeps this file instead of fetching it again.
        public var etag: String?
    }

    struct Index: Codable, Equatable {
        var entries: [String: Entry] = [:]
        /// When each project's page was last opened on this phone.
        var opened: [String: Date] = [:]
        /// Files the Mac refused as too large for a phone, by `project#name#version#variant`: never asked for again.
        var tooLarge: Set<String> = []
    }

    private let lock = NSLock()
    /// The folder holding every Mac's library; each Mac's is a folder named by a hash of its identity.
    public let base: URL
    private var mac: String?
    private var index = Index()

    public init(base: URL) { self.base = base }

    /// The app's library folder: Application Support, never Caches (which iOS may empty at any time).
    public static var defaultBase: URL {
        URL.applicationSupportDirectory.appending(path: "Counterpart/Library", directoryHint: .isDirectory)
    }

    // MARK: Which Mac

    /// The folder of the Mac now in use, or nil while none is paired.
    public var root: URL? { lock.withLock { mac.map(folder) } }
    public var isActive: Bool { lock.withLock { mac != nil } }

    private func folder(_ mac: String) -> URL {
        base.appending(path: String(Hex.sha256(Data(mac.utf8)).prefix(24)), directoryHint: .isDirectory)
    }

    /// Uses `mac`'s library (its identity: the paired address the saved project list is also kept under). Another Mac's
    /// library goes: a pairing to a different Mac clears what was kept for the old one. Call only with a pairing that was
    /// read, never because a read failed (a locked phone's Keychain read is not a pairing change, board X96).
    public func use(mac identity: String) {
        lock.withLock {
            guard mac != identity else { return }
            mac = identity
            let keep = folder(identity)
            for other in (try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? [] where other.standardizedFileURL != keep.standardizedFileURL {
                try? FileManager.default.removeItem(at: other)
            }
            prepare(keep)
            index = Self.read(keep)
        }
    }

    /// Unpaired: everything kept for any Mac goes.
    public func unpair() {
        lock.withLock {
            mac = nil
            index = Index()
            try? FileManager.default.removeItem(at: base)
        }
    }

    /// Clear (Settings): this Mac's files go; the library starts empty and fills again.
    public func clear() {
        lock.withLock {
            guard let mac else { return }
            let root = folder(mac)
            try? FileManager.default.removeItem(at: root)
            index = Index()
            prepare(root)
        }
    }

    // MARK: Reading (no network, no Keychain)

    /// This version of the file, when the library has it. A Mac picture (`pictures/…`) is named by what it draws, so the
    /// library's copy of that name is the file at any project version.
    public func file(project: String, name: String, version: Int64, file: String? = nil) -> URL? {
        lock.withLock {
            guard let mac, let entry = index.entries[Self.key(project, name)],
                  entry.version == version || Self.namedByContent(name),
                  file == nil || entry.variant == file else { return nil }
            let url = folder(mac).appending(path: project, directoryHint: .isDirectory).appending(path: entry.file)
            return FileManager.default.fileExists(atPath: url.path) ? url : nil
        }
    }

    /// The newest copy the library has of this file, of any version: what a screen draws at once.
    public func latest(project: String, name: String) -> (url: URL, version: Int64)? {
        lock.withLock {
            guard let mac, let entry = index.entries[Self.key(project, name)] else { return nil }
            let url = folder(mac).appending(path: project, directoryHint: .isDirectory).appending(path: entry.file)
            return FileManager.default.fileExists(atPath: url.path) ? (url, entry.version) : nil
        }
    }

    public var entries: [Entry] { lock.withLock { Array(index.entries.values) } }
    /// The bytes the library holds now.
    public var usage: Int64 { lock.withLock { index.entries.values.reduce(0) { $0 + $1.bytes } } }
    public func lastOpened(_ project: String) -> Date? { lock.withLock { index.opened[project] } }

    /// Refused as too large: this version of this file, this variant (another original of the same project version is
    /// its own file; review of #556, Cursor P2.1). `file` nil: any variant.
    public func isTooLarge(project: String, name: String, version: Int64, file: String? = nil) -> Bool {
        lock.withLock {
            let prefix = "\(Self.key(project, name))#\(version)"
            if let file { return index.tooLarge.contains("\(prefix)#\(file)") || index.tooLarge.contains(prefix) }
            return index.tooLarge.contains(prefix) || index.tooLarge.contains { $0.hasPrefix(prefix + "#") }
        }
    }

    /// The copy the library has of this file at an older version, with the Mac's validator, to ask the Mac whether it
    /// changed (`If-None-Match`). Only the same variant: another original is another file.
    public func validator(project: String, name: String, file: String) -> String? {
        lock.withLock {
            guard mac != nil, let entry = index.entries[Self.key(project, name)], entry.variant == file else { return nil }
            return entry.etag
        }
    }

    /// The Mac said the bytes are unchanged (304): the kept file is this version's too. Its name on disk stays, so what
    /// was drawn from it (mesh, still) is reused as it is.
    @discardableResult
    public func revalidated(project: String, name: String, version: Int64, file: String) -> URL? {
        lock.withLock {
            let key = Self.key(project, name)
            guard let mac, var entry = index.entries[key], entry.variant == file else { return nil }
            let url = folder(mac).appending(path: project, directoryHint: .isDirectory).appending(path: entry.file)
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            if version > entry.version { entry.version = version; index.entries[key] = entry; save(folder(mac)) }
            return url
        }
    }

    /// A Mac picture's name changes whenever what it draws changes (`pictures/<role>-<files>-<drawing>.png`, the
    /// companion's `pictureName`), so one name is one picture.
    public static func namedByContent(_ name: String) -> Bool { name.hasPrefix("pictures/") }

    // MARK: Writing

    /// Moves a fully arrived file into the library and returns where it is. The older version of the same file is removed
    /// only now, after the new one is in place; other files of the project (another version's model, a picture) stay.
    @discardableResult
    public func commit(_ arrived: URL, project: String, name: String, version: Int64, file: String, etag: String? = nil) throws -> URL {
        try lock.withLock {
            guard let mac else { throw CocoaError(.fileNoSuchFile) }
            let root = folder(mac)
            prepare(root)
            let key = Self.key(project, name)
            if let current = index.entries[key], current.version > version || (current.version == version && current.variant == file) {
                // A slow download of an older version finished after a newer one landed: the newer one stays.
                return root.appending(path: project, directoryHint: .isDirectory).appending(path: current.file)
            }
            let projectFolder = root.appending(path: project, directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: projectFolder, withIntermediateDirectories: true, attributes: Self.protection)
            // Each version has its own name, so the old file stays readable (and on screen) until the new one is whole.
            let target = projectFolder.appending(path: "v\(version)-\(file)")
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.moveItem(at: arrived, to: target)
            try? FileManager.default.setAttributes(Self.protection, ofItemAtPath: target.path)
            let bytes = Int64((try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0)
            if let previous = index.entries[key], previous.file != target.lastPathComponent {
                try? FileManager.default.removeItem(at: projectFolder.appending(path: previous.file))
            }
            index.entries[key] = Entry(project: project, name: name, version: version, file: target.lastPathComponent, variant: file, bytes: bytes,
                                       kind: Kind.of(name), storedAt: Date(), etag: etag)
            save(root)
            return target
        }
    }

    public func markTooLarge(project: String, name: String, version: Int64, file: String) {
        lock.withLock {
            index.tooLarge.insert("\(Self.key(project, name))#\(version)#\(file)")
            if let mac { save(folder(mac)) }
        }
    }

    /// The person opened this project's page: its files are the last to be evicted, and its model is fetched.
    public func opened(_ project: String, at date: Date = Date()) {
        lock.withLock {
            index.opened[project] = date
            if let mac { save(folder(mac)) }
        }
    }

    /// The project list says which projects exist: a deleted project's files go.
    public func prune(keeping projects: Set<String>) {
        lock.withLock {
            guard let mac else { return }
            let root = folder(mac)
            let gone = Set(index.entries.values.map(\.project)).union(index.opened.keys).subtracting(projects)
            guard !gone.isEmpty else { return }
            for project in gone {
                try? FileManager.default.removeItem(at: root.appending(path: project, directoryHint: .isDirectory))
                index.opened[project] = nil
            }
            index.entries = index.entries.filter { !gone.contains($0.value.project) }
            index.tooLarge = index.tooLarge.filter { key in !gone.contains(where: { key.hasPrefix($0 + "#") }) }
            save(root)
        }
    }

    /// Keeps the library under `ceiling` and to what the person chose: kinds they no longer keep go first, then scans,
    /// then models, then pictures, each from the project opened longest ago (never opened counts as oldest). Returns
    /// what went, in order.
    @discardableResult
    public func evict(keep: Keep, ceiling: Int64? = nil) -> [Entry] {
        lock.withLock {
            guard let mac else { return [] }
            let root = folder(mac)
            let limit = ceiling ?? keep.ceiling
            var total = index.entries.values.reduce(0) { $0 + $1.bytes }
            var removed: [Entry] = []
            func remove(_ entry: Entry) {
                try? FileManager.default.removeItem(at: root.appending(path: entry.project, directoryHint: .isDirectory).appending(path: entry.file))
                index.entries[Self.key(entry.project, entry.name)] = nil
                total -= entry.bytes
                removed.append(entry)
            }
            for entry in index.entries.values.sorted(by: order) where !keep.keeps(entry.kind) { remove(entry) }
            for entry in index.entries.values.sorted(by: order) where total > limit { remove(entry) }
            if !removed.isEmpty { save(root) }
            return removed
        }
    }

    /// Eviction order: by kind (scans, models, pictures), then by when the project was last opened (oldest first), then
    /// largest first.
    private func order(_ a: Entry, _ b: Entry) -> Bool {
        if a.kind != b.kind { return a.kind < b.kind }
        let ao = index.opened[a.project] ?? .distantPast, bo = index.opened[b.project] ?? .distantPast
        if ao != bo { return ao < bo }
        return a.bytes > b.bytes
    }

    // MARK: On disk

    static func key(_ project: String, _ name: String) -> String { "\(project)#\(name)" }

    /// Protected until the phone's first unlock after a restart, then readable while locked (Apple, "Encrypting Your App's
    /// Files"; `FileProtectionType.completeUntilFirstUserAuthentication`). Ignored on the Mac.
    static var protection: [FileAttributeKey: Any] {
        #if os(iOS)
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        [:]
        #endif
    }

    /// Creates the folder and marks the whole library excluded from backup ("Optimizing Your App's Data for iCloud Backup":
    /// set it on a directory, and again after writes, since some file operations reset it).
    private func prepare(_ root: URL) {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: Self.protection)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = base
        try? url.setResourceValues(values)
    }

    private static func read(_ root: URL) -> Index {
        guard let data = try? Data(contentsOf: root.appending(path: "index.json")),
              var index = try? JSONDecoder().decode(Index.self, from: data) else { return Index() }
        // A file removed outside the library (or never finished) leaves its entry: drop it.
        index.entries = index.entries.filter {
            FileManager.default.fileExists(atPath: root.appending(path: $0.value.project, directoryHint: .isDirectory).appending(path: $0.value.file).path)
        }
        return index
    }

    private func save(_ root: URL) {
        guard let data = try? JSONEncoder().encode(index) else { return }
        #if os(iOS)
        try? data.write(to: root.appending(path: "index.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: root.appending(path: "index.json"), options: .atomic)
        #endif
    }
}

/// Which of a project's files the phone keeps, and whether it fetches one by itself on the link it has now (the person's
/// own request always fetches). Pure, so the rules are tested without a network.
public enum LibraryPlan {
    /// A file the background fill may fetch for a project.
    public struct Want: Equatable, Sendable {
        public var project: Project
        public var name: String
        public var kind: OnDeviceLibrary.Kind
        /// Its size when the Mac lists it (scan files); nil when unknown.
        public var bytes: Double?
        public static func == (a: Want, b: Want) -> Bool { a.project.id == b.project.id && a.name == b.name }
    }

    /// The largest file the phone fetches by itself on an expensive (cellular, hotspot) or constrained (Low Data Mode) link.
    public static let meteredLimit: Double = 25 * 1024 * 1024

    /// Whether the background fill fetches this now. Pictures go on any link. Models and scans go on an unmetered link;
    /// on a metered one only when their size is known and under `meteredLimit` (a model's size is not listed, so it waits
    /// for Wi-Fi or for the page to ask). Kinds the person chose not to keep are never fetched by themselves.
    public static func fetches(_ want: Want, keep: OnDeviceLibrary.Keep, expensive: Bool, constrained: Bool) -> Bool {
        guard keep.keeps(want.kind) else { return false }
        if want.kind == .picture { return true }
        guard expensive || constrained else { return true }
        guard let bytes = want.bytes else { return false }
        return bytes <= meteredLimit
    }

    /// How many of the most recently changed projects get their model without being opened.
    public static let recentModels = 3

    /// Everything the library should hold for these projects, pictures first (every project), then models (opened
    /// projects and the few most recent), then, for opened projects, scans. `opened` is the projects whose page was opened.
    public static func wants(_ projects: [Project], opened: Set<String>, keep: OnDeviceLibrary.Keep) -> [Want] {
        var pictures: [Want] = [], models: [Want] = [], scans: [Want] = []
        let recent = Set(projects.sorted { $0.mediaVersion > $1.mediaVersion }.prefix(recentModels).map(\.id))
        for project in projects {
            var names: [String] = []
            if let picture = project.picturePath { names.append(picture) }
            names += (project.pictures ?? [:]).keys.sorted().compactMap { project.pictures?[$0] }
            // Every plate's picture, opened or not: a designer's file has no Mac picture, so its plate is the stage (the
            // away proof of #556: two pages said "not available" for plates the phone had never been asked to keep).
            names += (project.plates ?? []).compactMap(\.thumbnail)
            if opened.contains(project.id), let ask = project.openAsk, ask.photo != nil { names.append("asks/\(ask.id).jpg") }
            var seen = Set<String>()
            for name in names where !name.isEmpty && seen.insert(name).inserted {
                pictures.append(Want(project: project, name: name, kind: .picture, bytes: nil))
            }
            if (opened.contains(project.id) || recent.contains(project.id)), project.current?.model != nil || project.current != nil {
                models.append(Want(project: project, name: "model.stl", kind: .model, bytes: nil))
            }
            if opened.contains(project.id), case .file(let path) = project.scanModel(limit: Double(CompanionClient.scanLimit)) {
                let bytes = project.scanFiles?.first { "scan/\($0.name)" == path }?.bytes
                scans.append(Want(project: project, name: path, kind: .scan, bytes: bytes))
            }
        }
        return (pictures + models + scans).filter { keep.keeps($0.kind) }
    }
}
