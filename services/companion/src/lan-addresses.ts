import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { PAIRING_LINK_MAX_ADDRESSES } from '@scan-to-make/contracts/pairing-link';
import { isLanAddress } from './lan-transport.js';

/**
 * Every address a phone could reach this Mac on, for pairing link v2 (MAC-5).
 * Chosen by interface type, not only by private range: VM and container bridges
 * (Colima, Docker, VMware) also carry private addresses, and each dead address in
 * a QR costs the phone a timeout before it tries the next.
 */
export type LanAddresses = { lan: string[]; tailscale: string[] };
type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

// Wired, Wi-Fi and Thunderbolt interfaces on macOS (en*) and Linux (eth*, en*, wl*).
const PHYSICAL = /^(en|eth|wl)[a-z0-9]*$/;
// Tailscale's tunnel: utun* on macOS, tailscale0 on Linux.
const TUNNEL = /^(utun\d+|tailscale\d+)$/;
const inTailscaleRange = (address: string) => {
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
};

/** The server binds explicit IPv4 addresses only, never a wildcard; discovery finds which ones. */
export const bindable = (address: string) => isIP(address) === 4 && address !== '0.0.0.0';

export function discoverAddresses(interfaces: Interfaces = networkInterfaces()): LanAddresses {
  const lan: string[] = [], tailscale: string[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    const infos = (interfaces[name] ?? []).filter((x) => !x.internal);
    const v4 = infos.filter((x) => x.family === 'IPv4').map((x) => x.address);
    if (PHYSICAL.test(name))
      lan.push(...v4.filter((a) => isLanAddress(a) && !a.startsWith('127.')));
    // A 100.64/10 address alone can be carrier NAT; Tailscale also gives the tunnel its fd7a:115c:a1e0::/48 address.
    else if (TUNNEL.test(name) && infos.some((x) => x.family === 'IPv6' && x.address.toLowerCase().startsWith('fd7a:115c:a1e0:')))
      tailscale.push(...v4.filter(inTailscaleRange));
  }
  return { lan: [...new Set(lan)], tailscale: [...new Set(tailscale)] };
}

/** Reads a command's stdout, or undefined. Injectable for tests. */
export type HostQuery = (command: string, args: string[]) => string | undefined;
const query: HostQuery = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; }
};
export type ReadText = (path: string) => string | undefined;
const readText: ReadText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };

/**
 * `<LocalHostName>.local` on macOS (scutil), the name Bonjour answers for. On Linux, the name the
 * Avahi daemon itself announces (its D-Bus GetHostNameFqdn), which already carries any collision
 * suffix it chose. Otherwise, or without a running Avahi, none.
 */
export function localHostName(platform: NodeJS.Platform = process.platform, run: HostQuery = query): string | undefined {
  if (platform === 'linux') {
    const reply = run('/usr/bin/busctl', ['--system', 'call', 'org.freedesktop.Avahi', '/', 'org.freedesktop.Avahi.Server', 'GetHostNameFqdn']);
    const name = /^s "([^"]*)"\s*$/.exec(reply?.trim() ?? '')?.[1];
    return name && /^[A-Za-z0-9-]{1,63}\.local$/.test(name) ? name : undefined;
  }
  if (platform !== 'darwin') return undefined;
  const name = run('/usr/sbin/scutil', ['--get', 'LocalHostName'])?.trim();
  return name && /^[A-Za-z0-9-]{1,63}$/.test(name) ? `${name}.local` : undefined;
}

/**
 * The computer's name as the user set it: the Mac's Computer Name (System Settings › General › About),
 * or on Linux the "pretty" hostname (Settings › About, hostnamectl --pretty) from /etc/machine-info.
 */
export function computerName(platform: NodeJS.Platform = process.platform, run: HostQuery = query, read: ReadText = readText): string | undefined {
  if (platform === 'linux') {
    for (const line of (read('/etc/machine-info') ?? '').split('\n')) {
      const match = /^PRETTY_HOSTNAME=(.*)$/.exec(line.trim());
      if (!match) continue;
      let value = match[1]!.trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
      value = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
      return value || undefined;
    }
    return undefined;
  }
  if (platform !== 'darwin') return undefined;
  return run('/usr/sbin/scutil', ['--get', 'ComputerName'])?.trim() || undefined;
}

/** The computer's name as people know it ("Mac mini", "Workshop PC"): the name the user set, else the host name without `.local`. */
export function macDisplayName(platform: NodeJS.Platform = process.platform, run: HostQuery = query, read: ReadText = readText, host: string = hostname()): string | undefined {
  const name = (computerName(platform, run, read) ?? host.replace(/\.local\.?$/i, '')).trim();
  return name ? name.slice(0, 64) : undefined;
}

/** The Host form of host:port as clients send it: lowercase, with the default port 443 left off. */
export const authority = (host: string, port: number) => new URL(`https://${host}:${port}`).host.toLowerCase();

/**
 * The origins a v2 pairing link lists, in the order the phone tries them: the primary
 * LAN address, the other LAN addresses, the .local name, then Tailscale. At most 8.
 */
export function pairingOrigins(primary: string, port: number, found: LanAddresses, localName?: string) {
  // Port 443 is left off, as URL serialisation and the phone both do.
  const origins = [primary, ...found.lan, ...(localName ? [localName] : []), ...found.tailscale]
    .map((host) => new URL(`https://${host}:${port}`).origin.replace(host.toLowerCase(), host));
  return [...new Set(origins.map((o) => o.toLowerCase()))].slice(0, PAIRING_LINK_MAX_ADDRESSES)
    .map((lower) => origins.find((o) => o.toLowerCase() === lower)!);
}
