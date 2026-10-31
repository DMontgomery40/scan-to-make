// In authenticated mode /healthz correctly rejects anonymous probes. This is a
// liveness check; smoke.sh separately proves paired, authorized health.
const port = process.env.SCAN_TO_MAKE_GENERATION_PORT ?? '9077';
const r = await fetch(`http://127.0.0.1:${port}/healthz`, {signal: AbortSignal.timeout(3000)});
const body = await r.json();
const ok = process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR
  ? r.status === 403 && body.error?.code === 'forbidden'
  : r.status === 200 && body.status === 'ok' && body.protocolVersion === '0.1.0';
if (!ok) process.exit(1);
