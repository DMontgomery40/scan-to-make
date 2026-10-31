import {readFile} from 'node:fs/promises';
import {certificateFingerprint, checkLanCertificate, isLanAuthority} from './lan-transport.js';
import { RemoteAuthStore } from './remote-auth.js';
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
    if(command==='pair-capture'&&(args.length===1||(args.length===0&&store.transport==='lan'))) {
      const invitation=await store.createPairing(args[0] ?? 'lan',['generation:health','projects:read','projects:write','captures:read','captures:import']);
      result=invitation;
      // stdout remains a single JSON object for existing automation.
      try {
        const qr=await renderPairingQr(invitation);
        process.stderr.write(`Scan with your iPhone Camera within five minutes:\n${qr.terminal}\n`);
        const pairingPageUrl=await launchPairingPage(directory,invitation);
        process.stderr.write(`Local pairing page: ${pairingPageUrl}\n`);
        result={...invitation,pairingPageUrl};
      } catch {
        process.stderr.write('QR display unavailable; use the invitation JSON below.\n');
      }
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
    'Remote auth operation failed. Check command, private directory, configuration and lock.\nUsage: remote-auth-cli.js init <absolute-new-directory> <fqdn.ts.net> <login> [login...] | init-lan <absolute-new-directory> <https-lan-url> <certificate.pem> | pair-capture <directory> [login] | devices <directory> | revoke <directory> <device-id>\n'
  );
  process.exitCode = 1;
}
