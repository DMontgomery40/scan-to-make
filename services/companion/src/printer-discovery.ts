import {createSocket,type Socket} from 'node:dgram';
import {networkInterfaces} from 'node:os';
import {isIPv4} from 'node:net';
import type {PrinterModel} from './printer-setup-protocol.js';

export interface DiscoveredPrinter {printer_host:string;bambu_serial:string;bambu_model?:PrinterModel;name:string;firmware?:string}
// BambuStudio resources/printers/<model-id>.json; unknown identities are left
// unresolved for explicit selection, never guessed from a serial prefix.
const models:Record<string,PrinterModel> = {'BL-P001':'x1c',C11:'p1p',C12:'p1s',C13:'x1e',N1:'a1mini',N2S:'a1',N6:'x2d',N7:'p2s',O1D:'h2d',O1E:'h2dpro',O1S:'h2s',O1C:'h2c',O1C2:'h2c'};
export function privateIPv4(value:string) {
  if (!isIPv4(value)) return false;
  const [a,b] = value.split('.').map(Number);
  return a===10 || a===192&&b===168 || a===172&&b!>=16&&b!<=31;
}
export function parsePrinterAdvertisement(packet:Buffer,address:string):DiscoveredPrinter|undefined {
  if (packet.length>8192 || !privateIPv4(address)) return;
  const lines = packet.toString('utf8').split('\r\n');
  if (!['NOTIFY * HTTP/1.1','HTTP/1.1 200 OK'].includes(lines.shift() ?? '')) return;
  const headers = new Map<string,string>();
  for (const line of lines) {
    if (!line) continue;
    const at = line.indexOf(':'); if (at<1) return;
    const key = line.slice(0,at).trim().toLowerCase(),value = line.slice(at+1).trim();
    if (headers.has(key) || /[\x00-\x1f\x7f]/.test(value)) return;
    headers.set(key,value);
  }
  // Never follow Location URLs or let an announcement redirect credentials.
  if (headers.get('location')!==address) return;
  const serial=headers.get('usn'), model=headers.get('devmodel.bambu.com');
  if (!serial || !/^[A-Za-z0-9]{1,64}$/.test(serial) || !model || model.length>64) return;
  const firmware=headers.get('devversion.bambu.com');
  return {printer_host:address,bambu_serial:serial,...(models[model]?{bambu_model:models[model]}:{}),
    name:(headers.get('devname.bambu.com') || model).slice(0,128),
    ...(firmware && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware)?{firmware}:{})};
}
export interface PrinterDiscoveryResult {state:'complete'|'unavailable';printers:DiscoveredPrinter[]}
/** Bounded listener/probe. Bind failure (including Bambu Studio owning 2021)
 * stays distinct from a successful scan which found no printers. */
export function discoverPrinters(durationMs=7500):Promise<PrinterDiscoveryResult> {
  return new Promise(resolve=>{
    const socket=createSocket({type:'udp4',reuseAddr:true}), found=new Map<string,DiscoveredPrinter>();
    let finished=false;
    const finish=(state:PrinterDiscoveryResult['state'])=>{
      if (finished) return; finished=true;clearTimeout(timer);
      try {socket.close();} catch { /* Not bound yet. */ }
      resolve({state,printers:[...found.values()].sort((a,b)=>a.bambu_serial.localeCompare(b.bambu_serial))});
    };
    const timer=setTimeout(()=>finish('complete'),durationMs);
    socket.on('error',()=>finish('unavailable'));
    socket.on('message',(data,peer)=>{const value=parsePrinterAdvertisement(data,peer.address);if(value && found.size<64) found.set(value.bambu_serial+'@'+value.printer_host,value);});
    socket.bind(2021,'0.0.0.0',()=>{
      const interfaces=Object.values(networkInterfaces()).flat().filter(v=>v && !v.internal && v.family==='IPv4' && privateIPv4(v.address));
      void sendDiscoveryProbes(socket,interfaces.map(nic=>nic!.address),()=>!finished);
    });
  });
}

/** A send callback completes before the interface changes: dgram address
 * resolution is asynchronous even when the target is an IP literal. */
export async function sendDiscoveryProbes(socket:Pick<Socket,'addMembership'|'setMulticastInterface'|'setMulticastTTL'|'send'>,addresses:string[],active:()=>boolean) {
  for (const address of addresses) {
    if (!active()) return;
    try {
      socket.addMembership('239.255.255.250',address);
      socket.setMulticastInterface(address);socket.setMulticastTTL(1);
      await new Promise<void>((resolve,reject)=>socket.send('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n',2021,'239.255.255.250',error=>error?reject(error):resolve()));
    } catch { /* Other interfaces can still advertise. */ }
  }
}
