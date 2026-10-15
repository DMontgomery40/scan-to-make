# Tailscale preflight

`preflight.py` is a read-only readiness check for the future phone-to-companion connection. It locates the Tailscale CLI, reads `version`, `status --json`, and `serve status --json`, and probes only the companion loopback health endpoint. It never installs Tailscale, signs in, changes Serve/Funnel, edits tailnet policy, approves devices, or touches a printer.

```sh
python3 tools/tailscale/preflight.py
python3 tools/tailscale/preflight.py --json
python3 -m unittest discover -s tools/tailscale/tests -v
```

Exit `0` means this host is ready for the separate authenticated companion transport. Exit `2` means a named setup step remains. A ready result does **not** prove remote phone connectivity today: the current companion is loopback-only and the pairing/auth transport is a follow-on.

See [`docs/tailscale-setup.md`](../../docs/tailscale-setup.md) for the user path, connection/auth contract, recovery, and follow-on tickets.
