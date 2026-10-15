# Tailscale easy mode for Scan to Make

Status: setup recommendation and preflight. Remote phone connectivity is **not implemented yet**.

The goal is boring and safe: a phone reaches the user's own companion over their private tailnet, while the companion process stays on loopback and every app request is paired. Tailscale gives us device identity, encrypted transport, MagicDNS names, and private HTTPS through Serve. It does not replace app pairing, and it must never become a public route to generation or printing.

## What exists today

The companion generation listener binds `127.0.0.1:9077`, requires the exact loopback `Host`, rejects browser-origin headers, and does not authenticate local processes. That is right for a same-Mac simulator and wrong to expose unchanged. Simply installing Tailscale, binding the companion more widely, or turning on Funnel would not make the phone flow safe.

Run the read-only check first:

```sh
python3 tools/tailscale/preflight.py
```

It reports the next setup step without installing, signing in, changing Serve/Funnel, editing policy, approving a device, or touching a printer.

## Recommended user path

### If you already use Tailscale

1. Confirm the companion host and phone are signed in to the same tailnet.
2. Run `python3 tools/tailscale/preflight.py` on the host.
3. Fix only the named step (for example, sign in, approve a waiting device, or start the local companion), then re-run it.
4. When the authenticated transport lands, the setup flow will ask for one explicit confirmation before enabling private Serve, then show a pairing QR/code in the companion for the phone to scan.

No new account, auth key, subnet router, exit node, or public exposure is part of the easy path.

### If Tailscale is new to you

1. Install Tailscale on the companion host and phone from Tailscale's download/quickstart path.
2. Create or sign in to the same tailnet with your identity provider on both devices.
3. Keep MagicDNS enabled; it is on by default for current tailnets and gives the host a stable `*.ts.net` name.
4. If device approval is enabled on the tailnet, approve each new device in the admin console before expecting traffic to flow.
5. Run the preflight on the host. When the future setup step enables Serve, Tailscale may ask for web consent to enable HTTPS certificates; that consent is a separate, visible step and the preflight will not click through it for you.

## Connection and authorization contract

This is the contract for the follow-on companion transport; it is not current behavior.

```text
phone app
  -> https://<host>.<tailnet>.ts.net        (Tailscale Serve, tailnet only)
  -> http://127.0.0.1:9077                  (existing companion listener)
```

1. **Keep the backend loopback-only.** Do not widen the companion bind to a LAN or tailnet interface for v1. Serve terminates tailnet HTTPS and proxies to loopback.
2. **Private Serve only; never Funnel.** Funnel is public-internet exposure and does not carry tailnet identity headers. Scan to Make must not offer it for companion routes.
3. **Exact Host allowlist.** Remote mode accepts only the configured MagicDNS FQDN for this host. The current exact-loopback-Host rule stays for local mode.
4. **Tailnet policy is the outer gate.** Grants should allow only the account's intended phone/user to reach the companion host's Serve port. Do not ship or require a permissive tailnet-wide rule.
5. **Serve identity is required.** Serve strips spoofed identity headers and supplies `Tailscale-User-Login` for tailnet traffic. Remote mode must require that header and allowlist the expected login (by default, the host owner's). Tagged or shared nodes without a user identity need an explicit policy decision, not a silent pass.
6. **Pair every phone.** The companion shows a single-use pairing code/QR valid for at most five minutes. It contains only the Serve URL and pairing code — never a Tailscale credential or auth key. The phone exchanges it for a per-device token stored in the phone keychain; the companion stores only a token hash, device label, scopes, creation/last-seen times, and revocation state.
7. **Scope narrowly.** The first remote scope is generation health/create only. Print plans, journal writes, printer discovery, and dispatch are not exposed by this contract. Any future route needs its own scope plus the existing exact-artifact, fresh-state, and human-approval gates.
8. **Fail closed.** Missing identity header, wrong login, wrong Host, unknown/revoked/expired pairing token, or a Funnel/public route rejects. Pairing attempts are rate-limited and errors do not reveal which secret part failed.
9. **Make revocation obvious.** The companion must list paired devices and revoke one without rotating everyone else. Removing a phone from the tailnet and revoking its pairing token are separate levers; do both for a lost phone.

Why user-installed Tailscale + Serve first, not embedded `tsnet`: the companion is currently a Node service, most target users can reuse an existing tailnet, and the OS client keeps login, updates, device approval, and revocation visible. Embedding Tailscale would add a Go sidecar or service rewrite plus node-state and auth-key management. Revisit only if distribution evidence shows the separate install is the real drop-off point.

## Recovery and revocation

- **Phone cannot see the host:** re-run preflight; check both devices are on the same tailnet, the host is online, device approval is complete, and the companion health check passes.
- **Wrong account or stale login:** sign in again in the Tailscale app on the affected device. Do not paste credentials or auth keys into Scan to Make.
- **Stop sharing the companion:** use the future companion disconnect control. Manually, an operator can inspect `tailscale serve status`, then turn off the specific Serve mapping or reset Serve configuration with Tailscale's CLI. Preflight never performs this for you.
- **Lost phone:** remove/disable that machine in the Tailscale admin console and revoke its Scan to Make pairing token.
- **Replace the host:** remove the old machine from the tailnet, install on the new host, run preflight, and pair phones again. Old pairing tokens do not migrate.
- **Key/session expiry:** re-authenticate the device in Tailscale. Changing key-expiry policy is an account/security decision for the tailnet owner, not an app default.

## Follow-on tickets

1. **Companion remote transport/auth:** implement the Serve Host/identity checks, pairing exchange, token storage/scopes/revocation, and tests behind an explicit remote mode. Owner: companion/contracts seat.
2. **Native onboarding and pairing:** detect setup states, deep-link to official Tailscale install/sign-in, scan the pairing QR, store the token in the keychain, and show paired/revoked state. Owner: qualified UI author.
3. **Confirmed Serve helper:** if users need it, a separate explicit action may enable/disable the one private Serve mapping and verify it. It must never be folded into the read-only preflight without a new decision.
4. **Physical-phone acceptance:** with a real phone and host on one tailnet, prove health, one paired generation, wrong-login rejection, revoked-token rejection, and no Funnel route. No printing claim follows from that test.

## Primary sources

- Tailscale quickstart: https://tailscale.com/kb/1017/install
- Tailscale CLI and macOS script behavior: https://tailscale.com/kb/1080/cli
- Tailscale Serve, HTTPS consent, and identity headers: https://tailscale.com/kb/1312/serve
- `tailscale serve` command reference: https://tailscale.com/kb/1242/tailscale-serve
- Funnel (public exposure; explicitly not used): https://tailscale.com/kb/1223/funnel
- MagicDNS: https://tailscale.com/kb/1081/magicdns
- Device approval: https://tailscale.com/kb/1099/device-authorization
- Tailnet policy and grants syntax: https://tailscale.com/docs/reference/syntax/policy-file
