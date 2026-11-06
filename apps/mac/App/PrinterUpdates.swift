import Foundation
import SwiftUI
#if canImport(ControlKit)
import ControlKit
#endif

/// One printer MCP install's update, as Settings → Printers shows it (PRD §8.10). The companion does the work; the
/// Mac shows what `printers.updateMcp` answers and what the `mcp.update.*` events say after it.
enum McpUpdateStatus: Equatable, Sendable {
    case updating(from: String?, to: String?)
    /// Counterpart is sending, slicing or designing on that MCP: it updates as soon as that finishes (never for the printer's own print).
    case waiting
    case updated(version: String?)
    /// Already the newest version.
    case current
    /// The previous version stays in use; `log` is the tail the companion attached.
    case failed(log: String?)
    /// The companion couldn't tell how this copy is installed. `found` says what it saw, in plain words.
    case unresolved(found: String)
    /// The request itself didn't go through.
    case problem(String)

    /// Update can't be pressed again: one is running, or waits for the current print.
    var busy: Bool { if case .updating = self { return true }; return self == .waiting }
    /// Work under way now, shown with a spinner. Waiting for Counterpart's own send, slice or design to finish is a
    /// sentence alone (Nov 6: "mcps won't update they just spin forever").
    var spinning: Bool { if case .updating = self { return true }; return false }

    /// The line under the MCP's name.
    var words: String {
        switch self {
        case .updating(_, let to?): return "Updating to \(to)…"
        case .updating: return "Updating…"
        case .waiting: return "Updates as soon as Counterpart finishes its work on this printer."
        case .updated(let version?): return "Updated to \(version)."
        case .updated: return "Updated."
        case .current: return "Already the newest version."
        case .failed: return "The update didn’t finish. The version you had is still in use."
        case .unresolved(let found): return found
        case .problem(let text): return text
        }
    }

    /// From the method's answer.
    init(_ reply: McpUpdate) {
        switch reply.state {
        case "waiting": self = .waiting
        case "current": self = .current
        case "unresolved": self = .unresolved(found: reply.found?.isEmpty == false ? reply.found! : "Counterpart couldn’t tell how this copy is installed.")
        default: self = .updating(from: reply.fromVersion, to: reply.toVersion)
        }
    }

    /// From an `mcp.update.*` event: which install, and where it is now. Nil for any other event.
    static func from(_ event: CounterpartEvent) -> (mcpId: String, status: McpUpdateStatus)? {
        guard event.type.hasPrefix("mcp.update."), let mcpId = event.data?.mcpId else { return nil }
        switch event.type {
        case "mcp.update.started": return (mcpId, .updating(from: event.data?.fromVersion, to: event.data?.toVersion))
        case "mcp.update.waiting": return (mcpId, .waiting)
        case "mcp.update.done": return (mcpId, .updated(version: event.data?.toVersion))
        case "mcp.update.failed": return (mcpId, .failed(log: event.data?.log))
        default: return nil
        }
    }
}

/// The updates in flight, shared by Settings and the event relay.
@MainActor final class PrinterUpdates: ObservableObject {
    static let shared = PrinterUpdates()
    @Published private(set) var status: [String: McpUpdateStatus] = [:]

    func set(_ mcpId: String, _ status: McpUpdateStatus?) { record(mcpId, status) }

    /// How long a wait may go without word from the companion, which ends every wait within a minute (a send, slice or
    /// design that is still going ends it with a sentence). Past this, an event went missing, say a companion restart.
    var waitingLimit: Duration = .seconds(90)
    static let unheard = "Counterpart didn’t say whether this updated. Try Update again."
    private var waits: [String: UUID] = [:]

    /// Every change of an install's state: a wait that hears nothing more becomes a sentence and Update is offered again.
    private func record(_ mcpId: String, _ value: McpUpdateStatus?) {
        status[mcpId] = value
        guard value == .waiting else { waits[mcpId] = nil; return }
        let token = UUID(), limit = waitingLimit
        waits[mcpId] = token
        Task { [weak self] in
            try? await Task.sleep(for: limit)
            guard let self, self.waits[mcpId] == token, self.status[mcpId] == .waiting else { return }
            self.record(mcpId, .problem(Self.unheard))
        }
    }

    /// An `mcp.update.*` event. Returns whether it finished one (so the printers are read again for the new version).
    @discardableResult func apply(_ event: CounterpartEvent) -> Bool {
        guard let (mcpId, status) = McpUpdateStatus.from(event) else { return false }
        record(mcpId, status)
        if case .updated = status { return true }
        return false
    }

    /// Asks the companion to update (or, `fresh`, to install its own copy). The events carry it from there.
    func update(_ mcpId: String, fresh: Bool, socket: String) async {
        record(mcpId, .updating(from: nil, to: nil))
        do {
            let reply = try await ControlClient(socketPath: socket).updateMcp(mcpId, fresh: fresh)
            // An event may already have moved it on; never step back from a finished state.
            if case .updating = status[mcpId] ?? .updating(from: nil, to: nil) { record(mcpId, McpUpdateStatus(reply)) }
        } catch let error as ControlRemoteError where !error.message.isEmpty {
            record(mcpId, .problem(error.message))
        } catch {
            record(mcpId, .problem("Counterpart couldn’t start the update. Try again."))
        }
    }
}

extension McpUpdateStatus {
    /// "1.4.2 → 1.5.0" when a newer version is published, from the versions the companion reports.
    static func newer(installed: String?, latest: String?) -> Bool {
        guard let installed, let latest, installed != latest else { return false }
        let parts = { (text: String) in text.split(whereSeparator: { !$0.isNumber }).map { Int($0) ?? 0 } }
        let a = parts(installed), b = parts(latest)
        for index in 0..<max(a.count, b.count) {
            let x = index < a.count ? a[index] : 0, y = index < b.count ? b[index] : 0
            if x != y { return y > x }
        }
        return false
    }
}

/// One printer MCP install, from the destinations that use it.
struct PrinterMCP: Identifiable, Equatable {
    let name: String
    let version: String?
    let origin: String?
    let printers: [String]
    let update: PrinterCapabilities.Update?
    let missing: [String]
    /// The install, as `printers.updateMcp` names it.
    let mcpId: String?
    /// The install itself when the companion names it; else what tells installs apart for an older companion.
    var id: String { mcpId ?? "\(name)|\(origin ?? "")|\(version ?? "")" }
    /// A newer version is published (or the companion says this one lacks something).
    var updateAvailable: Bool { McpUpdateStatus.newer(installed:version, latest:update?.latestVersion) || update?.message.isEmpty == false }

    static func == (a: PrinterMCP, b: PrinterMCP) -> Bool { a.id == b.id && a.printers == b.printers }

    /// A printer MCP's name as people know it, from its package.
    static func label(_ backend: String) -> String { backend == "bambu-printer-mcp" ? "bambu-printer-mcp" : "mcp-3D-printer-server" }

    static func list(_ printers: [PrinterDestination]) -> [PrinterMCP] {
        // One row per install: by `mcpId` when the companion names it, so two installs never share a row (or an Update).
        let grouped = Dictionary(grouping:printers) { $0.mcpId ?? "\($0.mcpName)|\($0.origin ?? "")|\($0.capabilities?.server?.version ?? "")" }
        let rows = grouped.values.map { members in
            let first = members[0]
            return PrinterMCP(name:first.mcpName, version:first.capabilities?.server?.version, origin:first.origin, printers:members.map(\.name),
                              update:members.compactMap { $0.capabilities?.update }.first, missing:first.capabilities?.missing ?? [],
                              mcpId:members.compactMap(\.mcpId).first)
        }
        // A printer set up in both MCPs is listed once, under the MCP its prints go through; the other MCP still gets
        // its row (Nov 6: "now i only see one to update and missing the other one").
        let shown = Set(rows.map { $0.name.lowercased() })
        var others: [String: [String]] = [:]
        for printer in printers {
            for choice in printer.mcps ?? [] where choice.backend != printer.backend && !shown.contains(choice.backend.lowercased()) {
                others[choice.backend, default: []].append(printer.name)
            }
        }
        let more = others.map { backend, names in
            PrinterMCP(name:label(backend), version:nil, origin:nil, printers:names, update:nil, missing:[], mcpId:nil)
        }
        return (rows + more).sorted { $0.name == $1.name ? ($0.origin ?? "") < ($1.origin ?? "") : $0.name < $1.name }
    }

    /// Where its config lives, as people know it.
    var source: String {
        switch origin {
        case "printer-handoff": return "Counterpart · printer-handoff.json"
        case "counterpart": return "Counterpart · added in Settings"
        case "claude-code": return "Claude Code · ~/.claude.json"
        case "claude-desktop": return "Claude Desktop · claude_desktop_config.json"
        case "cursor": return "Cursor · ~/.cursor/mcp.json"
        case "codemode": return "Codemode"
        case "codex": return "Codex · ~/.codex/config.toml"
        default: return "Your MCP settings"
        }
    }
}

extension PrinterMcpPackage {
    /// Installed, and a newer version is published: a package no printer uses then offers Update, which installs
    /// the latest as Counterpart's own copy (`printers.updateMcp` with `appMcpId`, #320's path).
    var offersUpdate: Bool { installed && McpUpdateStatus.newer(installed: version, latest: latestVersion) }
    /// The Update button's name outside its row (the rotor lists buttons alone).
    func updateLabel(failed: Bool) -> String {
        failed ? "Try updating \(label) again" : "Update \(label)" + (latestVersion.map { " to " + $0 } ?? "")
    }
}
