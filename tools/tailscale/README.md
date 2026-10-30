# Tailscale preflight

`preflight.py` is a read-only host check for the phone-to-companion connection. It locates the Tailscale CLI, reads `version`, `status --json`, and `serve status --json`, and probes only the companion loopback health endpoint. It never installs Tailscale, signs in, changes Serve/Funnel, edits tailnet policy, approves devices, or touches a printer. The HTTP probe ignores environment proxies and refuses redirects.

```sh
python3 tools/tailscale/preflight.py
python3 tools/tailscale/preflight.py --json
python3 -m unittest discover -s tools/tailscale/tests -v
```

Exit `0` means host prerequisites and the local health protocol passed. Exit `2` means a named step or verification remains. Neither result establishes private HTTPS, service identity, or phone connectivity.

An anonymous `401` or `403` reports `authorization-required` with `identityVerified: false`. This can be the expected response from the authenticated companion, but an unrelated listener can return the same status. It stays non-ready and directs the operator to verify through the paired app/private HTTPS path; it does not recommend restarting a listener solely because authentication was denied. An unavailable listener and an invalid response have separate recovery guidance.

The companion authenticated transport and iOS native pairing are implemented. Real phone/tailnet acceptance is separate. `remotePhoneConnectivityVerified` is always false here. The legacy `remotePhoneConnectivityImplemented: false` field describes this tool's scope, not the product transport's availability.

The Python suite uses real ephemeral HTTP listeners and a fake Tailscale CLI. To additionally exercise the compiled companion's authenticated and legacy modes, first build it as described in its [README](../../services/companion/README.md), then run:

```sh
node tools/tailscale/tests/companion-integration.mjs
```

That fixture uses temporary pairing state, proves authenticated health succeeds while anonymous health is denied, and checks the actual Python probe. It does not contact a tailnet or phone. The Node integration command is separate from the Python-only preflight CI job.

See [setup and recovery](../../docs/tailscale-setup.md) for the current connection contract and remaining acceptance work.
