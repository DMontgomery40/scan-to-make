import { RemoteAuthStore } from './remote-auth.js';

try {
  const [command, directory, ...args] = process.argv.slice(2);
  if (!directory) throw new Error('Missing directory');
  let result: unknown;
  if (command === 'init' && args.length >= 2) {
    const [host, ...allowedLogins] = args;
    const store = await RemoteAuthStore.create(directory, {
      host: host!,
      allowedLogins,
    });
    result = { status: 'initialized', host: store.host };
  } else {
    const store = await RemoteAuthStore.open(directory);
    if(command==='pair-capture'&&args.length===1)
      result=await store.createPairing(args[0]!,['generation:health','projects:read','projects:write','captures:read','captures:import']);
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
    'Remote auth operation failed. Check command, private directory, configuration and lock.\nUsage: remote-auth-cli.js init <absolute-new-directory> <fqdn.ts.net> <login> [login...] | pair-capture <directory> <login> | devices <directory> | revoke <directory> <device-id>\n'
  );
  process.exitCode = 1;
}
