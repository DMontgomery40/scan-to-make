import {RemoteAuthStore} from './remote-auth.js';
import {startPairingPage, type PairingInvitation} from './pairing-display.js';

// This is an internal child entry point. Invitation material arrives only via IPC.
const startup = setTimeout(() => process.exit(1), 5_000);
process.once('message', async (message: {directory: string; invitation: PairingInvitation}) => {
  clearTimeout(startup);
  try {
    const store = await RemoteAuthStore.open(message.directory);
    if (!(await store.isPairingActive(message.invitation.code))) throw new Error('Inactive');
    const page = await startPairingPage(store, message.invitation);
    if (!process.send) throw new Error('Missing parent');
    process.send(page.url, (error: Error | null) => { if (error) void page.close(); });
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void page.close());
  } catch { process.exit(1); }
});
