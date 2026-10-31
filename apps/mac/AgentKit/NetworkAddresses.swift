import Foundation
import Darwin
import SystemConfiguration

public struct NetworkAddresses: Equatable {
    public let lan: [String]
    public let tailscale: [String]
    public let localHostname: String?
    public var all: [String] { lan + (localHostname.map { [$0] } ?? []) + tailscale }
    /// Keep all discovered addresses, but configure only a range accepted by
    /// the companion's LAN certificate/transport contract.
    public var setupAddress: String? {
        lan.first {
            guard Self.isUsableIPv4($0) else { return false }
            let parts = $0.split(separator:".").compactMap { Int($0) }
            return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1]))
                || (parts[0] == 192 && parts[1] == 168)
        }
    }
    public static func isUsableIPv4(_ value: String) -> Bool {
        let components = value.split(separator:".",omittingEmptySubsequences:false)
        guard components.count == 4 else { return false }
        let parts = components.compactMap { UInt8($0) }
        return parts.count == 4 && parts[0] != 127 && parts[0] != 0 && parts[0] < 224 && !(parts[0] == 169 && parts[1] == 254)
    }
    public static func orderedLAN(_ candidates: [(interface: String, address: String)], primaryInterface: String?) -> [String] {
        func rank(_ name: String) -> Int { name == primaryInterface ? 0 : name.hasPrefix("en") ? 1 : 2 }
        var seen: Set<String> = []
        return candidates.sorted {
            if rank($0.interface) != rank($1.interface) { return rank($0.interface) < rank($1.interface) }
            if $0.interface != $1.interface { return $0.interface < $1.interface }
            return $0.address < $1.address
        }.map(\.address).filter { seen.insert($0).inserted }
    }
    public static func current() -> Self {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return Self(lan:[],tailscale:[],localHostname:nil) }
        defer { freeifaddrs(head) }
        var lan: [(interface:String,address:String)] = []; var tailscale: [String] = []
        var cursor = head
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            let entry = item.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_RUNNING) != 0,
                  entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating:0,count:Int(NI_MAXHOST))
            guard getnameinfo(address,socklen_t(address.pointee.sa_len),&host,socklen_t(host.count),nil,0,NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString:host); let name = String(cString:entry.ifa_name)
            guard isUsableIPv4(ip) else { continue }
            let parts = ip.split(separator:".").compactMap { Int($0) }
            if parts[0] == 100 && (64...127).contains(parts[1]) { tailscale.append(ip) }
            else if name.hasPrefix("en") || name.hasPrefix("bridge") { lan.append((name,ip)) }
        }
        let hostname = SCDynamicStoreCopyLocalHostName(nil).map { ($0 as String) + ".local" }
        let store = SCDynamicStoreCreate(nil,"Scan to Make" as CFString,nil,nil)
        let global = SCDynamicStoreCopyValue(store,"State:/Network/Global/IPv4" as CFString) as? [String:Any]
        let primary = global?[kSCDynamicStorePropNetPrimaryInterface as String] as? String
        return Self(lan:orderedLAN(lan,primaryInterface:primary),tailscale:Array(Set(tailscale)).sorted(),localHostname:hostname)
    }
}
