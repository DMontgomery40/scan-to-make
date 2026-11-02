# Live Activity relay

A Cloudflare Worker at `https://counterpart.dtmont.com/relay/v1` that lets Counterpart for Mac update the iPhone's print Live Activity through APNs ([PRD §8.8](../../docs/design/overhaul/PRD.md#88-delivery-mac-cloudkit-and-the-live-activity-relay), §9.4).

- **Why it exists.** A Live Activity updates from APNs only with a push signed by the team's APNs key, and Apple says that key "must remain private". So the key lives here, as a Worker secret, and not in the Mac app.
- **What it does.** It takes one request, `POST /relay/v1/live-activity`, from the Mac's `EventRelay`. It validates the request strictly against the `PrintAttributes` and content-state schema, applies the rate limits and the deny list, and sends one `liveactivity` push to `api.push.apple.com`. It is not a general push relay.
- **The caller's contract** is in [`docs.md`](docs.md).

## Layout

| File | Job |
|---|---|
| `src/contract.ts` | The request schema and its strict validator |
| `src/apns.ts` | The ES256 provider token, the APNs request (headers and body), and how to read APNs' answer |
| `src/limiter.ts` | `RelayLimiter`, the SQLite-backed Durable Object that holds the rate limits, the deny list and the provider token |
| `src/relay.ts` | The HTTP handler |
| `wrangler.jsonc` | The Worker, its route, the Durable Object and its migration |
| `scripts/smoke.mjs` | `npm run smoke`: `wrangler dev` against a loopback stand-in for APNs |
| `scripts/check.mjs` | `npm run check`: one probe of a deployed relay, read as a verdict |

## Limits and storage

- **Per token** (keyed by the SHA-256 of the token): one push every 10 s and 2,000 a day.
  - The 10 s spacing covers every push on a token, including `end`. The caller resends after `Retry-After` (docs.md).
- **Per client IP:** 20,000 a day.
  - An IPv6 client is keyed by its /64, so changing addresses inside its own block doesn't reset its count.
- **Globally:** `GLOBAL_DAILY_CAP` a day (14,000 by default; see "Free plan").
- **Days** are UTC days, the same days as the free plan's quotas.
- **Deny list.** An APNs `410`, or `400 BadDeviceToken`, refuses that token hash for 30 days.
- **Provider token.** The Durable Object signs one token and every Worker isolate uses it. It refreshes the token every 50 minutes; Apple requires a refresh at least every 60 and at most every 20.
  - The token is stored so a restart doesn't mint a new one early.
  - After a `403 ExpiredProviderToken` or `InvalidProviderToken`, it mints again, at most once every 20 minutes.
- **What's stored:** token hashes, keyed hashes of client networks, counts and times, and the current provider token (which expires within the hour). It stores no push tokens, payloads or user data.
  - Counters for past days and expired deny entries are deleted by a daily alarm.
  - The IP hash is keyed with a value derived from the APNs key secret, so it can't be reversed without that secret.
- **Logs** record only the kind, the outcome, and the APNs status and reason, never the token, payload or IP. They're visible through `npx wrangler tail counterpart-relay`.

## Routing next to the docs site

`site/wrangler.jsonc` serves `counterpart.dtmont.com` as a Custom Domain. This Worker uses a **route**, `counterpart.dtmont.com/relay/*` on the `dtmont.com` zone.

- Cloudflare's routing docs: "Routes can `fetch()` Custom Domains and take precedence if configured on the same hostname."
- So `/relay/*` reaches this Worker, and every other path still reaches the docs Worker.
- The Custom Domain already gives the hostname a proxied DNS record, which a route needs.
- `site/` doesn't change.

## HTTP/2 to APNs

APNs accepts only HTTP/2.
- **Production.** A deployed Worker's `fetch` reaches it, because Cloudflare's proxy stack speaks HTTP/2 to the origin. A workerd maintainer confirmed this in [cloudflare/workerd#4841](https://github.com/cloudflare/workerd/issues/4841), and the published Workers APNs clients rely on it.
  - Cloudflare doesn't document a guarantee, so `npm run check` after the deploy is the first real proof.
- **Locally.** workerd (`wrangler dev`, the tests) has no outbound HTTP/2. The smoke test therefore points `APNS_ORIGIN` at a loopback stand-in, and the unit tests replace `fetch`.
- **If production ever fails to reach APNs:**
  - the relay answers `503 apns_unreachable` (or `apns_unavailable`);
  - `wrangler tail` shows `"outcome":"apns-unreachable"`;
  - the phone keeps its activity current itself, as PRD §8.8 describes for running without the relay.

## Free plan

The Worker fits Cloudflare's free plan. Its per-day limits (Durable Objects pricing, Workers Free) are:
- 100,000 Worker requests;
- 100,000 Durable Object requests;
- 100,000 SQLite rows written;
- 5 million rows read.

**What one push costs:**
- 1 Worker request;
- 1 Durable Object request;
- about 4 rows read;
- 3 rows written (the token, IP and global counters).

**The tightest limit is rows written, so the default cap is sized for the worst case.**
- In the worst case every push comes from a new token and a new network, and the token is dead. That push writes 7 rows:
  - 3 counter rows;
  - 2 deletes when the next day's cleanup removes its token and IP rows (deletes are billed as writes);
  - 1 deny entry, and its delete 30 days later.
- About 250 more writes a day are fixed: the provider token (about 30), the alarm, and forced re-mints (at most 72 a day, 3 writes each).
- (100,000 − 250) / 7 ≈ 14,250, so the default `GLOBAL_DAILY_CAP` is **14,000**. At that cap the free plan's writes can't run out, whatever the traffic.
- In ordinary use a print reuses one token and one network, so a push costs about 3 writes. On the paid plan, or when running close to the cap, raise `GLOBAL_DAILY_CAP` in `wrangler.jsonc`.
- Requests rejected before the Durable Object (bad payloads) write nothing.
- If a quota runs out anyway, the Durable Object fails closed: the relay answers `503 relay_unavailable` until 00:00 UTC, and it sends nothing to APNs without counting it.

A Worker reaching its limits can't affect the docs site: static asset requests are free and don't count.

## The one manual step (David)

Create the APNs key, give it to the Worker, and deploy. Everything else is already in this directory.

1. **Create the key** in the Apple developer portal: [Certificates, Identifiers & Profiles → Keys → +](https://developer.apple.com/account/resources/authkeys/add).
   - Name: `Counterpart relay`.
   - Tick **Apple Push Notifications service (APNs)**, then **Configure**:
     - Environment: match the target signed app. Distribution builds use **Production**;
       locally signed build `202611021121` uses **Sandbox** and needs the sandbox relay origin below.
     - Key restriction: select the scope needed for Counterpart. An all-topics key is not a
       prerequisite. The pending topic-specific `com.scantomake` key still needs real APNs
       validation for the `com.scantomake.push-type.liveactivity` topic; registration is pending.
   - **Save → Continue → Register.**
   - Download `AuthKey_<KEY_ID>.p8`. Apple lets you download it only once.
   - Note the 10-character **Key ID**.
2. **Put the three secrets**, from the repository root. Wrangler reads each value from stdin. If the Worker doesn't exist yet, the first `secret put` creates it.
   ```sh
   cd services/relay
   npm ci
   npx wrangler login                     # once, if this Mac isn't logged in
   npx wrangler secret put APNS_KEY_P8 < ~/Downloads/AuthKey_ABC123DEFG.p8
   printf %s ABC123DEFG | npx wrangler secret put APNS_KEY_ID
   printf %s X7F5F9LR24 | npx wrangler secret put TEAM_ID
   ```
3. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
4. **Check it** (no phone needed):
   ```sh
   npm run check
   curl -s https://counterpart.dtmont.com/ | grep -o '<title>[^<]*'   # the docs site is unchanged
   ```
   `npm run check` sends one well-formed update for a random token and prints what the answer means:

   | Answer | Meaning |
   |---|---|
   | `410 token_inactive`, reason `BadDeviceToken` | **Working.** APNs authenticated the push over HTTP/2 and called the made-up token unknown. |
   | `503 not_configured` | A secret is missing or malformed |
   | `503 apns_auth` | Wrong Key ID or Team ID, or the .p8 belongs to another key |
   | `502 apns_rejected`, reason `BadEnvironmentKeyIdInToken` | The key is Sandbox-only |
   | `503 apns_unreachable` | The Worker couldn't reach APNs (see "HTTP/2 to APNs") |

   The made-up token's hash then sits on the deny list for 30 days, which is harmless.

**Match the relay to the signed app’s push environment.**
- Inspect the installed build’s signed [`aps-environment` entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment). A Release configuration
  alone does not imply production push tokens: locally signed Counterpart build `202611021121`
  has `aps-environment=development`.
- `development` requires the sandbox APNs host, a compatible key, and
  `APNS_ORIGIN = "https://api.sandbox.push.apple.com"` in a separate sandbox deployment.
  The pending sandbox key registration is not a completed provisioning step.
- `production` uses `api.push.apple.com` (the default when `APNS_ORIGIN` is unset) and a
  compatible production key. TestFlight/App Store distribution uses this environment.
- Do not send a development token to the production deployment. APNs can answer
  `400 BadDeviceToken`, after which this relay refuses that token for 30 days.
- Before deployment, verify the signed app, key environment, relay host and Live Activity
  topic agree, following [Apple’s token-based APNs setup](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns). Registering a key or passing the loopback smoke test does not prove delivery.

## Development

```sh
npm ci --ignore-scripts
npm test          # typecheck + vitest in the Workers runtime (@cloudflare/vitest-plugin)
npm run smoke     # wrangler dev + a loopback APNs stand-in
npm run build     # wrangler deploy --dry-run: validates the config and bundle, no login
```

The lockfile was generated with npm 11, because npm 10's resolver crashes on vite's optional peers. Both `npm ci` versions install it.
