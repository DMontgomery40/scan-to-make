import {spawn as nodeSpawn, type ChildProcess} from 'node:child_process';
import {createSocket, type Socket} from 'node:dgram';
import {isIPv4} from 'node:net';
import {networkInterfaces} from 'node:os';
import {createInterface} from 'node:readline';

/**
 * Printers on the local network, for Add printer… (MAC-6). Both scans are bounded and never fail the sheet: a
 * blocked port or a missing dns-sd only means nothing was found that way. Neither fetches a URL or contacts a printer.
 * The SSDP part is KAN-163's (branch KAN-163-printer-setup), unchanged in its checks.
 */

/** bambu-printer-mcp's model names for the DevModel ids Bambu Studio's printer definitions use. Unknown ids stay unset. */
export const BAMBU_MODEL_IDS: Record<string, string> = {
  'BL-P001': 'x1c', C11: 'p1p', C12: 'p1s', C13: 'x1e', N1: 'a1mini', N2S: 'a1', N6: 'x2d', N7: 'p2s',
  O1D: 'h2d', O1E: 'h2dpro', O1S: 'h2s', O1C: 'h2c', O1C2: 'h2c',
};

/**
 * The model a Bambu serial number's first three characters name, as bambu-printer-mcp reads them
 * (its src/safety/printer-state.ts SERIAL_MODELS), in its model names. X1 (00W) has no model name there, so it stays unset.
 */
export const BAMBU_SERIAL_MODELS: Record<string, string> = {
  '093': 'h2s', '094': 'h2d', '31B': 'h2c', '239': 'h2dpro', '20P': 'x2d',
  '00M': 'x1c', '03W': 'x1e', '01S': 'p1p', '01P': 'p1s', '22E': 'p2s', '039': 'a1', '030': 'a1mini',
};
export function modelFromSerial(serial?: string): string | undefined {
  return serial ? BAMBU_SERIAL_MODELS[serial.trim().slice(0, 3).toUpperCase()] : undefined;
}

export interface BambuAdvert {host: string; serial: string; model?: string; name: string; firmware?: string}

export function privateIPv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** One SSDP packet from a Bambu printer (NOTIFY on UDP 2021, or the answer to an M-SEARCH). */
export function parseBambuAdvert(packet: Buffer, address: string): BambuAdvert | undefined {
  if (packet.length > 8192 || !privateIPv4(address)) return undefined;
  const lines = packet.toString('utf8').split('\r\n');
  if (!['NOTIFY * HTTP/1.1', 'HTTP/1.1 200 OK'].includes(lines.shift() ?? '')) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 1) return undefined;
    const key = line.slice(0, at).trim().toLowerCase(), value = line.slice(at + 1).trim();
    if (headers.has(key) || /[\x00-\x1f\x7f]/.test(value)) return undefined;
    headers.set(key, value);
  }
  // Never follow Location URLs or let an announcement redirect credentials: it must be the sender itself.
  if (headers.get('location') !== address) return undefined;
  const serial = headers.get('usn'), model = headers.get('devmodel.bambu.com');
  if (!serial || !/^[A-Za-z0-9]{1,64}$/.test(serial) || !model || model.length > 64) return undefined;
  const firmware = headers.get('devversion.bambu.com');
  const known = BAMBU_MODEL_IDS[model];
  return {host: address, serial, ...(known ? {model: known} : {}), name: (headers.get('devname.bambu.com') || model).slice(0, 128),
    ...(firmware && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware) ? {firmware} : {})};
}

/** A send completes before the next interface: dgram resolves addresses asynchronously even for IP literals. */
export async function sendDiscoveryProbes(socket: Pick<Socket, 'addMembership' | 'setMulticastInterface' | 'setMulticastTTL' | 'send'>, addresses: string[], active: () => boolean) {
  for (const address of addresses) {
    if (!active()) return;
    try {
      socket.addMembership('239.255.255.250', address);
      socket.setMulticastInterface(address); socket.setMulticastTTL(1);
      await new Promise<void>((resolve, reject) => socket.send('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n',
        2021, '239.255.255.250', error => error ? reject(error) : resolve()));
    } catch { /* Other interfaces can still answer. */ }
  }
}

/** Listens on UDP 2021 for `durationMs`. A port another app holds (Bambu Studio) is `unavailable`, not "none found". */
export function discoverBambu(durationMs = 4000): Promise<{state: 'complete' | 'unavailable'; printers: BambuAdvert[]}> {
  return new Promise(resolve => {
    const socket = createSocket({type: 'udp4', reuseAddr: true}), found = new Map<string, BambuAdvert>();
    let finished = false;
    const finish = (state: 'complete' | 'unavailable') => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket.close(); } catch { /* not bound yet */ }
      resolve({state, printers: [...found.values()].sort((a, b) => a.serial.localeCompare(b.serial))});
    };
    const timer = setTimeout(() => finish('complete'), durationMs);
    socket.on('error', () => finish('unavailable'));
    socket.on('message', (data, peer) => { const value = parseBambuAdvert(data, peer.address); if (value && found.size < 64) found.set(`${value.serial}@${value.host}`, value); });
    try {
      socket.bind(2021, '0.0.0.0', () => {
        const interfaces = Object.values(networkInterfaces()).flat().filter(nic => nic && !nic.internal && nic.family === 'IPv4' && privateIPv4(nic.address));
        void sendDiscoveryProbes(socket, interfaces.map(nic => nic!.address), () => !finished);
      });
    } catch { finish('unavailable'); }
  });
}

/** Bonjour types other printers' hosts advertise, and mcp-3D-printer-server's PRINTER_TYPE for each. */
export const BONJOUR_TYPES: Record<string, string> = {
  '_octoprint._tcp': 'octoprint',
  // Moonraker's zeroconf component (Klipper); PrusaLink's type is best-effort (it may only advertise _http._tcp).
  '_moonraker._tcp': 'klipper',
  '_prusalink._tcp': 'prusa',
};
export interface BonjourService {type: string; name: string; host: string; port: string}

/** `dns-sd -Z` zone lines: `<instance>.<type> SRV <priority> <weight> <port> <target>`. */
export function parseZoneLine(line: string, type: string): BonjourService | undefined {
  const match = /^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d{1,5})\s+(\S+)/.exec(line.trim());
  if (!match) return undefined;
  const [, instance, port, target] = match as unknown as [string, string, string, string];
  const suffix = `.${type}`;
  const raw = instance.endsWith(suffix) ? instance.slice(0, -suffix.length) : instance;
  const name = raw.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/\\(.)/g, '$1').slice(0, 128);
  const host = target.replace(/\.$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || Number(port) < 1 || Number(port) > 65535) return undefined;
  return {type, name, host, port};
}

export type Spawn = (command: string, args: string[], options: {stdio: ['ignore', 'pipe', 'ignore']}) => ChildProcess;

/** Browses each type with mDNSResponder's own `dns-sd -Z` for `durationMs`, on macOS. */
export function discoverBonjour(durationMs = 3000, options: {spawn?: Spawn; platform?: NodeJS.Platform} = {}): Promise<BonjourService[]> {
  if ((options.platform ?? process.platform) !== 'darwin') return Promise.resolve([]);
  const spawn = options.spawn ?? (nodeSpawn as Spawn);
  return Promise.all(Object.keys(BONJOUR_TYPES).map(type => new Promise<BonjourService[]>(resolve => {
    const found = new Map<string, BonjourService>();
    let child: ChildProcess;
    try { child = spawn('/usr/bin/dns-sd', ['-Z', type, 'local'], {stdio: ['ignore', 'pipe', 'ignore']}); }
    catch { resolve([]); return; }
    const done = () => { clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve([...found.values()]); };
    const timer = setTimeout(done, durationMs);
    child.on('error', done);
    if (child.stdout) createInterface({input: child.stdout}).on('line', line => {
      const service = parseZoneLine(line, type);
      if (service && found.size < 32) found.set(`${service.host}:${service.port}`, service);
    });
  }))).then(lists => lists.flat());
}
