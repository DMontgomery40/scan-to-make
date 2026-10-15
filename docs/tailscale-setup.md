# Tailscale easy mode for Scan to Make

Status: companion authenticated transport and iOS native pairing are implemented. Physical-phone/private-tailnet acceptance remains unverified. This preflight checks host prerequisites; it does not perform setup or authenticate the phone path.

The goal is boring and safe: a phone reaches the user's own companion over their private tailnet, while the companion process stays on loopback and every app request is paired. Tailscale gives us device identity, encrypted transport, MagicDNS names, and private HTTPS through Serve. It does not replace app pairing, and it must never become a public route to generation or printing.

## What exists today

The generation listener stays on `127.0.0.1:9077`. Legacy local mode requires the exact loopback `Host` and rejects browser-origin headers. Explicit authenticated mode instead requires the configured Serve host, HTTPS forwarding metadata, an allowed Tailscale login, and a per-device credential. See the [implemented companion transport and operator commands](../services/companion/README.md#authenticated-private-serve-transport). Do not expose legacy mode or widen the bind address.

The iOS app accepts a companion URL and one-time code or pasted invitation, exchanges them natively, and keeps credentials in Keychain. Native health/generation reject redirects and invalid certificates. Simulator fixture evidence is separate from real phone/private-HTTPS qualification. Camera QR scanning and Android secure pairing are not delivered by this flow.

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
4. Follow the companion operator commands to initialize authenticated mode and start it. Configure the one private Serve mapping only as an explicit operator action. Generate a short-lived invitation and enter its URL/code or paste it in the iOS app; verify health there. Preflight does not enable Serve or grant access.

No new account, auth key, subnet router, exit node, or public exposure is part of the easy path.

### If Tailscale is new to you

1. Install Tailscale on the companion host and phone from Tailscale's download/quickstart path.
2. Create or sign in to the same tailnet with your identity provider on both devices.
3. Keep MagicDNS enabled; it is on by default for current tailnets and gives the host a stable `*.ts.net` name.
4. If device approval is enabled on the tailnet, approve each new device in the admin console before expecting traffic to flow.
5. Run the preflight on the host. When an operator enables Serve, Tailscale may ask for web consent to enable HTTPS certificates; that consent is a separate, visible step and the preflight will not click through it for you.

## Connection and authorization contract

The following contract is implemented by explicit authenticated companion mode. Configuration checks and local fixtures do not establish that a particular phone or tailnet satisfies it.

```text
phone app
  -> https://<host>.<tailnet>.ts.net        (Tailscale Serve, tailnet only)
  -> http://127.0.0.1:9077                  (existing companion listener)
```

1. **Keep the backend loopback-only.** Do not widen the companion bind to a LAN or tailnet interface for v1. Serve terminates tailnet HTTPS and proxies to loopback.
2. **Private Serve only; never Funnel.** Funnel is public-internet exposure and does not carry tailnet identity headers. Scan to Make must not offer it for companion routes.
3. **Exact Host allowlist.** Remote mode accepts only the configured MagicDNS FQDN for this host. The current exact-loopback-Host rule stays for local mode.
4. **Tailnet policy is the outer gate.** Grants should allow only the account's intended phone/user to reach the companion host's Serve port. Do not ship or require a permissive tailnet-wide rule.
5. **Serve identity is required.** Serve strips spoofed identity headers and supplies `Tailscale-User-Login` for tailnet traffic. Remote mode must require that header and allowlist the expected login explicitly. Tagged or shared nodes without a user identity need an explicit policy decision, not a silent pass.
6. **Pair every phone.** The companion CLI emits a single-use pairing code and invitation JSON valid for at most five minutes. A QR payload is data, not a delivered camera-scanning interface. The invitation contains its version, Serve URL, code and expiry, never a Tailscale credential or auth key. The phone exchanges it for a per-device token stored in the phone keychain; the companion stores only a token hash, device label, scopes, expiry, and paired-device state.
7. **Scope narrowly.** The first remote scope is generation health/create only. Print plans, journal writes, printer discovery, and dispatch are not exposed by this contract. Any future route needs its own scope plus the existing exact-artifact, fresh-state, and human-approval gates.
8. **Fail closed.** Missing identity header, wrong login, wrong Host, unknown/revoked/expired pairing token, or a Funnel/public route rejects. Pairing attempts are rate-limited and errors do not reveal which secret part failed.
9. **Make revocation obvious.** The companion must list paired devices and revoke one without rotating everyone else. Removing a phone from the tailnet and revoking its pairing token are separate levers; do both for a lost phone.

Why user-installed Tailscale + Serve first, not embedded `tsnet`: the companion is currently a Node service, most target users can reuse an existing tailnet, and the OS client keeps login, updates, device approval, and revocation visible. Embedding Tailscale would add a Go sidecar or service rewrite plus node-state and auth-key management. Revisit only if distribution evidence shows the separate install is the real drop-off point.

## Recovery and revocation

- **Phone cannot see the host:** re-run preflight; check both devices are on the same tailnet, the host is online, device approval is complete, and verify authenticated health in the paired app. An anonymous loopback 401/403 is compatible with authenticated mode but cannot establish service identity; do not restart the service just for that denial.
- **Wrong account or stale login:** sign in again in the Tailscale app on the affected device. Do not paste credentials or auth keys into Scan to Make.
- **Stop sharing the companion:** disconnect the app to delete its local credential, revoke the device with the companion CLI, and disable access separately as needed. Disconnecting the app does not stop Serve. An operator can inspect `tailscale serve status`, then turn off the specific Serve mapping or reset Serve configuration with Tailscale's CLI. Preflight never performs this for you.
- **Lost phone:** remove/disable that machine in the Tailscale admin console and revoke its Scan to Make pairing token.
- **Replace the host:** remove the old machine from the tailnet, install on the new host, run preflight, and pair phones again. Old pairing tokens do not migrate.
- **Key/session expiry:** re-authenticate the device in Tailscale. Changing key-expiry policy is an account/security decision for the tailnet owner, not an app default.

## Remaining work

- **Physical-phone acceptance:** with a real phone and host on one tailnet, prove trusted HTTPS health, paired generation, wrong-login rejection, revoked-token rejection, and no Funnel route. No printing claim follows from that test.
- **Onboarding follow-ons:** camera QR scanning, Android secure pairing, and installation/sign-in assistance need separate implementation and acceptance. Existing iOS pairing is documented in the [mobile README](../apps/mobile/README.md).
- **Confirmed Serve helper:** if needed, a separate explicit action may enable/disable the private mapping and verify it. It must not be folded into read-only preflight.

## Primary sources

- Tailscale quickstart: https://tailscale.com/kb/1017/install
- Tailscale CLI and macOS script behavior: https://tailscale.com/kb/1080/cli
- Tailscale Serve, HTTPS consent, and identity headers: https://tailscale.com/kb/1312/serve
- `tailscale serve` command reference: https://tailscale.com/kb/1242/tailscale-serve
- Funnel (public exposure; explicitly not used): https://tailscale.com/kb/1223/funnel
- MagicDNS: https://tailscale.com/kb/1081/magicdns
- Device approval: https://tailscale.com/kb/1099/device-authorization
- Tailnet policy and grants syntax: https://tailscale.com/docs/reference/syntax/policy-file
