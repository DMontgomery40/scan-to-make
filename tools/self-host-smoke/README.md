# Self-host smoke

Two commands take a clean checkout from this branch and exercise the local tools. Offline smoke stays independent; authenticated smoke does not replace it. Both always report native review/export acceptance as `OPEN`.

```sh
tools/self-host-smoke/smoke.sh
tools/self-host-smoke/auth-smoke.sh
```

## Offline tools (`smoke.sh`)

`smoke.sh` bootstraps the dependencies and smoke-tests the offline capture tools:

```sh
tools/self-host-smoke/smoke.sh
```

### Steps

1. Creates or reuses a venv with `usd-core==26.8`.
   - Default location: `${XDG_CACHE_HOME:-~/.cache}/scan-to-make/usd-core-26.8-venv`, outside the repo.
   - Override with `SMOKE_VENV=...`.
   - `SMOKE_SKIP_INSTALL=1` reuses an existing venv without running pip.
   - `PYTHON=...` picks the bootstrap interpreter, which must be 3.10 or newer.
2. Runs the unit tests:
   - `tools/capture-mesh-convert`
   - `tools/capture-fit-eval` (stdlib `python3`)
   - `tools/capture-pipeline` (pipeline and duplicate)
3. Builds the converter's synthetic fixtures, then runs the synthetic repros: `capture-pipeline/repro.py` and `capture-pipeline/duplicate_repro.py`.
4. Prints a PASS/FAIL line for each step and writes logs to a temp directory.

The script exits 0 only if every step passes.

### Offline requirements

- `python3` 3.10 or newer, with `venv`. On a fresh Ubuntu 24.04 machine, install the system package first (`sudo apt-get install python3.12-venv`); stock Ubuntu 24.04 lacks ensurepip/venv without it, and the smoke creates a Python virtual environment.
- Network access to PyPI on the first run, for `usd-core`.
- No credentials, services, or devices.

## Authenticated HTTP path (`auth-smoke.sh`)

`auth-smoke.sh` starts this checkout's companion listener and talks to the real project/capture routes. Auth is local fixture only: `RemoteAuthStore` in a temp directory, Host `companion.example-tail.ts.net`, allowlisted login, and Tailscale Serve forwarding headers from `services/companion/tests/fixtures/tailscale-serve-v1.94.2.json`. There is no production access, live tailnet, or device change.

```sh
tools/self-host-smoke/auth-smoke.sh
```

### Steps

1. Creates or reuses the same `usd-core==26.8` venv as the offline smoke. Prefers `python3.12` when `PYTHON` is unset.
2. Runs `npm ci` + build for `packages/contracts`, `services/project`, and `services/companion` as the companion README describes. Build artifacts are removed afterward so a successful run leaves `git status --porcelain` empty.
3. Builds a real `two_layer.usdz` fixture with `tools/capture-mesh-convert/make_fixtures.py`.
4. Initializes isolated auth, pairs a capture-scoped device (`projects:read/write`, `captures:read/import`) and a generation-only device, then starts `generation-cli.js` with `SCAN_TO_MAKE_REMOTE_AUTH_DIR`, `SCAN_TO_MAKE_CAPTURE_DIR`, and `SCAN_TO_MAKE_CAPTURE_PYTHON`.
5. Happy path against the live listener:
   - `PUT /v1/saved-projects/:id` with `If-None-Match: *`
   - `POST` captures with `model/vnd.usdz+zip`
   - restart the listener on the same auth/capture directories
   - reopen the exact project JSON and ETag
   - download the original USDZ and require byte equality plus matching `X-Content-SHA256` / binding hash
6. Negative checks that must fail closed: generation-only token → `403`; stale `If-Match` → `412`.
7. Prints `PASS` for the authenticated HTTP path and `OPEN` for native review/export acceptance.

The script exits 0 only when sync → import → restart → reopen/exact-download and the negative checks all behave correctly.

`SMOKE_KEEP_BUILD=1` leaves `node_modules`/`dist` in the checkout for debugging.

### Authenticated requirements

- Node 22+ and `npm`, in addition to the offline Python/venv needs.
- Network access for the first `npm ci` and `usd-core` install.
- Local loopback only. Do not point this at a production companion or tailnet.

## Not covered (gate stays OPEN)

Native review/export acceptance is **not** exercised by either command. Both summaries always print it as `OPEN`. A passing offline run means the offline tools work on synthetic fixtures. A passing authenticated run means the fixture-auth HTTP path preserved exact project JSON and original USDZ bytes across restart. Neither run is device capture, native UI review/export, or physical-fit validation.
