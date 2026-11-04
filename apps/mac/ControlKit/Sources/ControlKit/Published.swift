import Foundation
import CounterpartKit

/// What a published model's project adds (PRD §8.11, KAN-214 PR 7), read beside CounterpartKit's `Project` until the
/// shared model carries it: the credit to the designer, the files, and the Ask's type (`file` for the designer's file,
/// `choice` for plates, objects and colours). Everything is optional and read tolerantly.
public struct PublishedExtras: Decodable, Sendable, Equatable {
    public struct Credit: Decodable, Sendable, Equatable {
        public let url: String
        public let designer: String?
        public let site: String?
        public let title: String?
        public let licence: String?
        /// Relative to the project's folder.
        public let thumbnail: String?
        public init(url: String, designer: String? = nil, site: String? = nil, title: String? = nil, licence: String? = nil, thumbnail: String? = nil) {
            self.url = url; self.designer = designer; self.site = site; self.title = title; self.licence = licence; self.thumbnail = thumbnail
        }
        /// "by *designer* on *site*".
        public var line: String? {
            switch (designer?.isEmpty == false ? designer : nil, site?.isEmpty == false ? site : nil) {
            case let (designer?, site?): return "by \(designer) on \(site)"
            case let (designer?, nil): return "by \(designer)"
            case let (nil, site?): return "on \(site)"
            default: return nil
            }
        }
    }
    public struct Option: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let detail: String?
        /// Relative to the project's folder.
        public let thumbnail: String?
        public init(id: String, label: String, detail: String? = nil, thumbnail: String? = nil) {
            self.id = id; self.label = label; self.detail = detail; self.thumbnail = thumbnail
        }
    }
    public struct Candidate: Decodable, Sendable, Equatable { public let path: String; public let name: String }
    public struct Ask: Decodable, Sendable, Equatable {
        public let id: String
        public let question: String
        /// `closeup` (absent), `file` or `choice`.
        public let type: String?
        public let options: [Option]?
        public let multiple: Bool?
        /// The model page, for a `file` Ask.
        public let url: String?
        public let modelName: String?
        public let site: String?
        /// `3mf`, `stl`.
        public let accepts: [String]?
        /// A file the companion thinks is the one, for "Use *name*?".
        public let candidate: Candidate?
        public let askedAtMs: Double?
        public let status: String?
        public var isOpen: Bool { status != "answered" }
    }
    public let credit: Credit?
    public let original: [String]?
    public let current: String?
    public let ask: Ask?
    /// Project Settings' Status (PRD §5.4): `not-printed`, `printed`, `works`, `needs-changes`.
    public let status: String?
    /// Hidden from the sidebar's groups, everything kept; separate from the status, which Unarchive restores.
    public let archived: Bool

    public init(credit: Credit? = nil, original: [String]? = nil, current: String? = nil, ask: Ask? = nil, status: String? = nil, archived: Bool = false) {
        self.credit = credit; self.original = original; self.current = current; self.ask = ask; self.status = status; self.archived = archived
    }

    private enum CodingKeys: String, CodingKey { case credit, files, ask, settings }
    private struct Files: Decodable { let original: [String]?; let current: String? }
    private struct Settings: Decodable { let status: String?; let archived: Bool? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        credit = try? c.decodeIfPresent(Credit.self, forKey: .credit)
        let files = try? c.decodeIfPresent(Files.self, forKey: .files)
        original = files?.original; current = files?.current
        ask = try? c.decodeIfPresent(Ask.self, forKey: .ask)
        let settings = try? c.decodeIfPresent(Settings.self, forKey: .settings)
        status = settings?.status
        archived = settings?.archived == true || settings?.status == "archived"
    }

    /// The open `file` Ask, if the project is waiting for the designer's file.
    public var fileAsk: Ask? { ask.flatMap { $0.type == "file" && $0.isOpen ? $0 : nil } }
    /// The open `choice` Ask (plates, objects, colours).
    public var choiceAsk: Ask? { ask.flatMap { $0.type == "choice" && $0.isOpen && !($0.options ?? []).isEmpty ? $0 : nil } }
}

public extension ControlClient {
    /// `objects.list` with what PRD §8.11 adds to each object, by id.
    func objectsAndExtras() async throws -> (projects: [Project], extras: [String: PublishedExtras]) {
        struct Reply: Decodable {
            struct Entry: Decodable {
                let project: Project?
                let id: String?
                let extras: PublishedExtras?
                private enum Keys: String, CodingKey { case id }
                init(from decoder: Decoder) throws {
                    project = try? Project(from: decoder)
                    id = try? decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .id)
                    extras = try? PublishedExtras(from: decoder)
                }
            }
            let objects: [Entry]
        }
        let reply: Reply = try await call("objects.list")
        var extras: [String: PublishedExtras] = [:]
        for entry in reply.objects { if let id = entry.id, let found = entry.extras, found != PublishedExtras() { extras[id] = found } }
        return (reply.objects.compactMap(\.project), extras)
    }
    /// Project Settings (PRD §5.4): `status` or `archived`, changed by hand on either device.
    func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project {
        struct Reply: Decodable { let object: Project }
        var params = patch
        params["id"] = .string(id)
        let reply: Reply = try await call("objects.settings.set", params)
        return reply.object
    }
    func addStarter(_ starterId: String) async throws -> Project {
        struct Reply: Decodable { let object: Project }
        let reply: Reply = try await call("objects.addStarter", ["starterId": .string(starterId)])
        return reply.object
    }
    func selectPlate(_ id: String, fileIndex: Int, plateIndex: Int) async throws -> Project {
        struct Reply: Decodable { let object: Project }
        let reply: Reply = try await call("objects.selectPlate", ["id": .string(id), "fileIndex": .number(Double(fileIndex)), "plateIndex": .number(Double(plateIndex))])
        return reply.object
    }
    /// Answers a `choice` Ask with the options picked.
    func answerAsk(_ id: String, askId: String, choices: [String]) async throws -> Project {
        struct Reply: Decodable { let object: Project }
        let reply: Reply = try await call("objects.answerAsk", ["id": .string(id), "askId": .string(askId), "choices": .array(choices.map(JSONValue.string))])
        return reply.object
    }
    /// A project for a published model: the page's link, and the person's words beside it.
    func createPublished(url: String, instructions: String?) async throws -> Project {
        struct Reply: Decodable { let object: Project }
        var params: [String: JSONValue] = ["url": .string(url), "kind": .string("published")]
        if let instructions, !instructions.isEmpty { params["instructions"] = .string(instructions) }
        let reply: Reply = try await call("objects.create", params)
        return reply.object
    }
}
