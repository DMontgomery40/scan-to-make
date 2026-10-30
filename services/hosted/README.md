# Hosted service (skeleton)

Local-dev skeleton for the paid hosted path described in
[docs/hosted-service.md](../../docs/hosted-service.md). It is **not**
production infrastructure: no accounts, object storage, job queue, workers,
billing or deployment live here yet.

What exists:

- `startHostedServer` (`src/hosted.ts`): a loopback-only listener with one
  endpoint, `GET /healthz`, reporting the service identity and the shared
  contract schema ids from `@scan-to-make/contracts`. It mirrors the
  companion listener's local boundary (exact loopback Host, browser-origin
  requests rejected, `{error: {code, message}}` failures).
- `createInMemoryTrialLedger` (`src/metering.ts`): the free-trial metering
  seam — per-user, per-unit check/record with atomic in-memory enforcement.
  The hosted build replaces this with a durable append-only ledger; the
  shape stays.

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/hosted --ignore-scripts
npm test --prefix services/hosted
npm run serve --prefix services/hosted   # http://127.0.0.1:9079/healthz
```

`SCAN_TO_MAKE_HOSTED_PORT` selects a different local port (`0` picks a free
one). Nothing here contacts a cloud provider, a model API, or a printer.
