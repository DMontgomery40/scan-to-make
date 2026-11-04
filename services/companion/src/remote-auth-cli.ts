import {readFile} from 'node:fs/promises';
import {certificateFingerprint, checkLanCertificate, isLanAuthority} from './lan-transport.js';
import { PHONE_SCOPES, RemoteAuthStore, type RemoteScope } from './remote-auth.js';
import {launchPairingPage, renderPairingQr} from './pairing-display.js';

try {
  const [command, directory, ...args] = process.argv.slice(2);
  if (!directory) throw new Error('Missing directory');
  let result: unknown;
  if (command === 'init-lan' && args.length === 2) {
    const url = new URL(args[0]!);
    if (url.protocol !== 'https:' || url.origin !== args[0] || !isLanAuthority(url.host)) throw new Error('Invalid LAN URL');
    const cert = await readFile(args[1]!);
    const certificateSha256 = certificateFingerprint(cert);
    checkLanCertificate(cert, url.hostname, certificateSha256);
    const store = await RemoteAuthStore.create(directory, {
      transport: 'lan', host: url.host, certificateSha256, allowedLogins: ['lan'],
    });
    result = {status: 'initialized', transport: 'lan', host: store.host};
  } else if (command === 'init' && args.length >= 2) {
    const [host, ...allowedLogins] = args;
    const store = await RemoteAuthStore.create(directory, {
      host: host!,
      allowedLogins,
    });
    result = { status: 'initialized', host: store.host };
  } else {
    const store = await RemoteAuthStore.open(directory);
    if((command==='pair'||command==='pair-capture'||command==='pair-capture-and-printer-handoff')&&(args.length===1||(args.length===0&&store.transport==='lan'))) {
      // A phone pairing grants what the iPhone app uses; pair-capture omits only printing.
      const invitation=await store.createPairing(args[0] ?? 'lan',command==='pair-capture'?PHONE_SCOPES.filter(scope=>scope!=='printer-handoff:use'):PHONE_SCOPES);
      result=invitation;
      // stdout remains a single JSON object for existing automation.
      let terminalQrShown = false;
      try {
        const qr=await renderPairingQr(invitation);
        process.stderr.write(`Scan with your iPhone Camera within five minutes:\n${qr.terminal}\n`);
        terminalQrShown = true;
        const pairingPageUrl=await launchPairingPage(directory,invitation);
        process.stderr.write(`Local pairing page: ${pairingPageUrl}\n`);
        result={...invitation,pairingPageUrl};
      } catch {
        process.stderr.write(terminalQrShown
          ? 'Local pairing page unavailable; use the terminal QR or invitation JSON.\n'
          : 'QR display unavailable; use the invitation JSON below.\n');
      }
    }
    else if(command==='pair-printer-handoff'&&args.length===1)
      result=await store.createPairing(args[0]!,['generation:health','printer-handoff:use']);
    else if (command === 'pair-mcp' && (args.length >= 1 || store.transport === 'lan')) {
      // docs/design/remote-mcp.md: a remote MCP client (`/v1/mcp`). read is always granted; phone scopes never are.
      const login = store.transport === 'lan' ? 'lan' : args[0]!;
      // In LAN mode the login is always `lan`; a leading `lan` is accepted and dropped.
      const chosen = store.transport === 'lan' ? (args[0] === 'lan' ? args.slice(1) : args) : args.slice(1);
      const known = ['read', 'design', 'control', 'print', 'raw'] as const;
      if (chosen.some(scope => !(known as readonly string[]).includes(scope))) throw new Error('Unknown scope');
      const scopes = known.filter(scope => scope === 'read' || chosen.includes(scope)).map(scope => `mcp:${scope}` as RemoteScope);
      if (scopes.includes('mcp:print')) process.stderr.write('print: this device can start prints with no question on your phone, unless the printer MCP itself asks.\n');
      if (scopes.includes('mcp:raw')) process.stderr.write('raw: this device can send raw printer, G-code and app commands, and use tools with no safety annotations.\n');
      result = await store.createPairing(login, scopes);
    }
    else if (command === 'devices' && args.length === 0)
      result = await store.listDevices();
    else if (command === 'revoke' && args.length === 1) {
      await store.revoke(args[0]!);
      result = { status: 'revoked', deviceId: args[0] };
    } else throw new Error('Invalid command');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    'Remote auth operation failed. Check command, private directory, configuration and lock.\nUsage: remote-auth-cli.js init <absolute-new-directory> <fqdn.ts.net> <login> [login...] | init-lan <absolute-new-directory> <https-lan-url> <certificate.pem> | pair <directory> [login] | pair-capture <directory> [login] | pair-capture-and-printer-handoff <directory> [login] | pair-printer-handoff <directory> <login> | pair-mcp <directory> [login] [design] [control] [print] [raw] | devices <directory> | revoke <directory> <device-id>\n'
  );
  process.exitCode = 1;
}
