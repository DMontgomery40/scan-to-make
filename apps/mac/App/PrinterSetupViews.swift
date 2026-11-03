import SwiftUI
import AppKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// Settings → Printers: both printer MCPs (Download for one this Mac hasn't), and Add printer… (journey M3, MAC-6).
// The MCPs are the backend: every button here is one companion call that finds, installs or runs them.

/// What Settings → Printers knows about printer setup on this Mac, read from the companion.
@MainActor final class PrinterSetupModel: ObservableObject {
    static let shared = PrinterSetupModel()
    /// The companion has `printers.mcps` and the setup methods (`capabilities.printerSetup`).
    @Published private(set) var available = false
    @Published private(set) var packages: [PrinterMcpPackage] = []

    static var socket: String { ModelAccessModel.socketPath(for:Installation(bundle:.main)) }
    /// A client that waits as long as the companion may take for this method (local-control.md "Deadlines").
    static func client(for method: String) throws -> ControlClient {
        try ControlClient(socketPath:socket, timeout:ControlClient.timeout(for:method))
    }

    func refresh() async {
        #if DEBUG
        if let fixture = DesignFixtures.printerMcps() { available = true; packages = fixture; return }
        #endif
        guard let status = try? await Self.client(for:"status.get").status() else { return }
        available = status.capabilities.printerSetup
        guard available, let packages = try? await Self.client(for:"printers.mcps").printerMcps() else { return }
        if self.packages != packages { self.packages = packages }
    }

    /// Download: the companion installs only that package; `mcp.update.*` events carry the progress.
    func download(_ package: PrinterMcpPackage) {
        let updates = PrinterUpdates.shared
        updates.set(package.appMcpId, .updating(from:nil, to:package.latestVersion))
        Task {
            do {
                switch try await Self.client(for:"printers.installMcp").installPrinterMcp(package.package) {
                case .installed:
                    updates.set(package.appMcpId, nil)
                    await refresh()
                case .started(let update):
                    if case .updating = updates.status[package.appMcpId] ?? .updating(from:nil, to:nil) { updates.set(package.appMcpId, McpUpdateStatus(update)) }
                }
            } catch let error as ControlRemoteError where !error.message.isEmpty {
                updates.set(package.appMcpId, .problem(error.message))
            } catch {
                updates.set(package.appMcpId, .problem("Counterpart couldn’t start the download. Try again."))
            }
        }
    }
}

/// One printer MCP that no printer uses yet: Installed (where, which version) or **Download**.
struct McpPackageRow: View {
    let package: PrinterMcpPackage
    let status: McpUpdateStatus?
    let download: () -> Void

    private var busy: Bool { status?.busy == true }
    private var place: String? {
        guard let install = package.installs.first else { return nil }
        switch install.kind {
        case "app": return "Counterpart’s copy"
        case "npx": return "Run with npx"
        case "folder", "checkout": return install.path.map { ($0 as NSString).abbreviatingWithTildeInPath }
        default: return install.path.map { ($0 as NSString).abbreviatingWithTildeInPath }
        }
    }

    var body: some View {
        HStack(alignment:.top, spacing:10) {
            VStack(alignment:.leading, spacing:3) {
                HStack(spacing:6) {
                    Text(package.label).font(.body.weight(.medium))
                    if package.installed, let version = package.version { Text(version).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                Text(package.description).font(.caption).foregroundStyle(.secondary)
                if let status { statusLine(status) }
                else if package.installed {
                    Text(["Installed", place].compactMap { $0 }.joined(separator:" · ") + ". No printer uses it yet.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            if !package.installed {
                Button(failed ? "Try Again" : "Download", action:download)
                    .buttonStyle(.glassProminent).disabled(busy || installedNow)
                    .help("Installs the latest \(package.label) for Counterpart only. Nothing else changes.")
            }
        }
    }

    private var failed: Bool { if case .failed = status { return true }; if case .problem = status { return true }; return false }
    private var installedNow: Bool { if case .updated = status { return true }; return false }

    @ViewBuilder private func statusLine(_ status: McpUpdateStatus) -> some View {
        switch status {
        case .updated(let version): Text(version.map { "Installed \($0)." } ?? "Installed.").font(.caption).foregroundStyle(Color.okGreen)
        case .updating(_, let to): Text(to.map { "Downloading \($0)…" } ?? "Downloading…").font(.caption).foregroundStyle(.secondary)
        case .failed: Text("The download didn’t finish. Nothing was changed.").font(.caption).foregroundStyle(.red)
        case .problem(let text): Text(text).font(.caption).foregroundStyle(.red)
        default: Text(status.words).font(.caption).foregroundStyle(.secondary)
        }
    }
}
