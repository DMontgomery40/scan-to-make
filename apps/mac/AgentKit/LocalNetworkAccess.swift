import Foundation
import Network

/// Gate the discovery operation to the foreground app, once per launch. A
/// background/login launch or lack of a LAN must not consume that attempt.
public struct LocalNetworkProbeGate {
    public private(set) var attempted = false
    public init() {}
    public mutating func begin(isForeground: Bool, hasLAN: Bool) -> Bool {
        guard isForeground, hasLAN, !attempted else { return false }
        attempted = true
        return true
    }
}

/// A bounded SSDP discovery from the app process makes macOS ask for this app's
/// Local Network privilege. It never sends a printer command, reads a reply,
/// infers permission from a send, or records an "allowed" flag. macOS owns the
/// decision and subsequent prompts. Keep the app running while David answers.
@MainActor public final class LocalNetworkAccess {
    private var gate = LocalNetworkProbeGate()
    private var group: NWConnectionGroup?
    private let monitor = NWPathMonitor()
    private var sent = false
    public var hasAttempted: Bool { gate.attempted }
    public init() {}
    public func observeNetwork(isForeground: @escaping @MainActor () -> Bool) {
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor in
                self?.requestIfNeeded(isForeground:isForeground(),hasLAN:!NetworkAddresses.current().lan.isEmpty)
            }
        }
        monitor.start(queue:.main)
    }
    deinit { monitor.cancel() }
    public func requestIfNeeded(isForeground: Bool, hasLAN: Bool) {
        guard gate.begin(isForeground:isForeground,hasLAN:hasLAN) else { return }
        do {
            let endpoint = NWEndpoint.hostPort(host:"239.255.255.250",port:2021)
            let group = NWConnectionGroup(with:try NWMulticastGroup(for:[endpoint]),using:.udp)
            self.group = group
            group.stateUpdateHandler = { [weak self] state in
                guard case .ready = state else { return }
                Task { @MainActor in self?.sendDiscovery() }
            }
            group.start(queue:.main)
            // Pending permission can keep the group waiting. Bound the network
            // work, not the application's lifetime or the system alert.
            DispatchQueue.main.asyncAfter(deadline:.now() + 60) { [weak self] in
                self?.group?.cancel(); self?.group = nil
            }
        } catch { /* The real printer check reports connectivity separately. */ }
    }
    private func sendDiscovery() {
        guard !sent, let group else { return }
        sent = true
        let request = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n"
        group.send(content:Data(request.utf8)) { _ in }
    }
}
