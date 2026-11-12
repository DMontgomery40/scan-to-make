import Foundation
import SwiftUI
#if canImport(ControlKit)
import ControlKit
#endif
import class CounterpartKit.MCPUpdateWaits
import struct CounterpartKit.PrinterSoftwareRow

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

    /// How long a wait may go without word from the companion (CounterpartKit's `MCPUpdateWaits`, shared with the phones).
    var waitingLimit: Duration { get { waits.waitingLimit } set { waits.waitingLimit = newValue } }
    var startedLimit: Duration { get { waits.startedLimit } set { waits.startedLimit = newValue } }
    static let unheard = MCPUpdateWaits.unheard
    private let waits = MCPUpdateWaits()

    /// Every change of an install's state: a wait or an update under way that hears nothing more becomes a sentence and
    /// Update is offered again.
    private func record(_ mcpId: String, _ value: McpUpdateStatus?) {
        status[mcpId] = value
        let phase: MCPUpdateWaits.Phase?
        switch value { case .waiting: phase = .waiting; case .updating: phase = .started; default: phase = nil }
        waits.note(mcpId, phase) { [weak self] in
            guard let self, self.status[mcpId]?.busy == true else { return }
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
    /// The package, as the companion names it (`bambu-printer-mcp`, `mcp-3d-printer-server`).
    var package: String? = nil
    /// The install itself when the companion names it; else what tells installs apart for an older companion.
    var id: String { mcpId ?? "\(name)|\(origin ?? "")|\(version ?? "")" }
    /// A newer version is published (or the companion says this one lacks something).
    var updateAvailable: Bool { McpUpdateStatus.newer(installed:version, latest:update?.latestVersion) || update?.message.isEmpty == false }

    static func == (a: PrinterMCP, b: PrinterMCP) -> Bool { a.id == b.id && a.printers == b.printers }

    /// A printer MCP's name as people know it. Only the Add Printer sheet still calls this (PrinterSetupViews.swift,
    /// lane B's); the rows below take the name the companion sends. Remove with that caller (AGENTS.md: no package branching).
    static func label(_ backend: String) -> String { backend == "bambu-printer-mcp" ? "bambu-printer-mcp" : "mcp-3D-printer-server" }

    static func list(_ printers: [PrinterDestination]) -> [PrinterMCP] {
        // One row per install: by `mcpId` when the companion names it, so two installs never share a row (or an Update).
        let grouped = Dictionary(grouping:printers) { $0.mcpId ?? "\(Self.packageKey($0.backend))|\($0.origin ?? "")|\($0.capabilities?.server?.version ?? "")" }
        let rows = grouped.values.map { members in
            let first = members[0]
            return PrinterMCP(name:Self.name(first), version:first.capabilities?.server?.version, origin:first.origin, printers:members.map(\.name),
                              update:members.compactMap { $0.capabilities?.update }.first, missing:first.capabilities?.missing ?? [],
                              mcpId:members.compactMap(\.mcpId).first, package:first.backend)
        }
        // A printer set up in both MCPs is listed once, under the MCP its prints go through; the other MCP still gets
        // its row, with its own install, name, version and Update, as the companion names them (Nov 6: "now i only see
        // one to update and missing the other one"). Left out only when that install already has a row: by `mcpId`, or
        // by package for a companion that doesn't name installs. Never by shown name.
        let shownInstalls = Set(rows.compactMap(\.mcpId)), shownPackages = Set(rows.compactMap { $0.package.map(Self.packageKey) })
        var others: [String: (choice: PrinterDestination.McpChoice, printers: [String])] = [:]
        for printer in printers {
            for choice in printer.mcps ?? [] where Self.packageKey(choice.backend) != Self.packageKey(printer.backend) {
                if let id = choice.mcpId { if shownInstalls.contains(id) { continue } }
                else if shownPackages.contains(Self.packageKey(choice.backend)) { continue }
                let key = choice.mcpId ?? Self.packageKey(choice.backend)
                others[key, default: (choice, [])].printers.append(printer.name)
            }
        }
        let more = others.values.map { other in
            let choice = other.choice
            return PrinterMCP(name:choice.label ?? choice.backend, version:choice.version, origin:nil, printers:other.printers,
                              update:choice.latestVersion.map { .init(message:"", package:choice.backend, command:nil, latestVersion:$0) },
                              missing:[], mcpId:choice.mcpId, package:choice.backend)
        }
        return (rows + more).sorted { $0.name == $1.name ? ($0.origin ?? "") < ($1.origin ?? "") : $0.name < $1.name }
    }

    /// The MCP a printer's prints go through, as the companion names it; an older companion's package id as sent.
    static func name(_ printer: PrinterDestination) -> String {
        printer.mcps?.first { Self.packageKey($0.backend) == Self.packageKey(printer.backend) }?.label ?? printer.mcpLabel ?? printer.backend
    }

    /// A package as the companion names it, whatever its case.
    static func packageKey(_ backend: String) -> String { backend.lowercased() }

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
    /// Settings → Printer software's row (#775), the same words as the iPhone and iPad (CounterpartKit `PrinterSoftwareRow`).
    var softwareRow: PrinterSoftwareRow {
        let uses = (uses ?? []).map { ($0.printerId ?? $0.printer, $0.printer, $0.mcpId, $0.kind, $0.version) }
        return PrinterSoftwareRow.build(label: label, version: appCopy?.version ?? (installed ? version : nil), appMcpId: appMcpId, hasAppCopy: appCopy != nil,
                                        available: available, upToDate: upToDate, usedBy: usedBy, uses: uses,
                                        moves: moves.map { ($0.mcpId, $0.title, $0.printers, $0.words, $0.reason) })
    }
    /// The Update button's name outside its row (the rotor lists buttons alone).
    func updateLabel(failed: Bool) -> String {
        failed ? "Try updating \(label) again" : "Update \(label)" + ((available ?? latestVersion).map { " to " + $0 } ?? "")
    }
}
