# Install the companion

Run the companion on your own computer. It receives iPhone LiDAR captures,
converts USDZ, and runs scan cleanup. Printer credentials stay here, in the
companion's private env file; the phone receives only its pairing credential.

This package installs the capture-only companion and the kept Python tools,
Node 24, Blender **5.0.1**, `bambu-printer-mcp` **1.1.42**, and
`mcp-3d-printer-server` **1.2.20** (the lowercase npm name of
[mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server)).
Both printer servers are separate stdio MCP processes on `PATH`. The current
capture server does not yet wire the correction runner or printer handoff into
its HTTP routes. Installing their dependencies does not add those routes.

## Linux / NAS

Requires an x86-64 Linux Docker host, Docker Compose 2.30+ (raw env files), and
LAN access from the phone (directly or through your existing VPN), or Tailscale. Blender 5.0.1 has no official Linux ARM64 archive;
this image is **linux/amd64 only**. ARM NAS emulation is not qualified. Allow
several GB of disk for the image, build cache and captures.

```sh
git clone https://github.com/DMontgomery40/scan-to-make.git
cd scan-to-make
cp deploy/companion/companion.env.example deploy/companion/companion.env
chmod 600 deploy/companion/companion.env
docker compose -f deploy/companion/compose.yaml build
```

Choose one connection mode for this installation. **Existing LAN/VPN:** add
`SCAN_TO_MAKE_LAN_TLS_CERT=/data/tls/cert.pem` and
`SCAN_TO_MAKE_LAN_TLS_KEY=/data/tls/key.pem` to `companion.env`, then initialize
once using the Docker host's LAN IPv4 address:

```sh
docker compose -f deploy/companion/compose.yaml run --rm companion \
  python3 /app/deploy/companion/generate-lan-tls.py /data/tls 192.168.1.10
docker compose -f deploy/companion/compose.yaml run --rm companion \
  node /app/services/companion/dist/remote-auth-cli.js \
  init-lan /data/auth https://192.168.1.10:9077 /data/tls/cert.pem
docker compose -f deploy/companion/compose.yaml up -d
docker compose -f deploy/companion/compose.yaml exec companion \
  node /app/services/companion/dist/remote-auth-cli.js pair-capture /data/auth
```

Scan the QR with a phone build supporting the LAN certificate pin. No Serve
mapping is needed in this mode. The host firewall and existing VPN must allow
access to the selected address on port 9077.

**Tailscale option:** install [Tailscale](https://tailscale.com/download) and sign
both devices into the same tailnet. Initialize pairing storage **once**, replacing
both example values:

```sh
docker compose -f deploy/companion/compose.yaml run --rm companion \
  node /app/services/companion/dist/remote-auth-cli.js \
  init /data/auth my-computer.my-tailnet.ts.net me@example.com

docker compose -f deploy/companion/compose.yaml up -d
# On the Linux host, forward private tailnet HTTPS to the loopback companion:
tailscale serve --bg http://127.0.0.1:9077

docker compose -f deploy/companion/compose.yaml exec companion \
  node /app/services/companion/dist/remote-auth-cli.js \
  pair-capture /data/auth me@example.com
```

Scan the terminal QR with the iPhone Camera app within five minutes. The CLI
also prints a localhost-only pairing page address and the invitation JSON for
manual-paste clients. On Linux host networking the page is reachable from the
host browser; never add its temporary port to Serve. Tailscale may ask you to enable HTTPS for your tailnet. This uses
private Serve, not public Funnel: the existing companion requires Serve's
identity headers and a paired device token. See [transport setup](../../docs/tailscale-setup.md).

Compose uses **host networking on Linux**. In LAN mode the companion binds the
selected host IP; in Serve mode host Tailscale reaches the `127.0.0.1:9077` listener. A Docker `ports:` mapping
cannot reach a service bound only to the container's loopback. NAS platforms
must support Linux host networking; Serve mode also needs host-side Tailscale. The compose
file is not a Docker Desktop networking recipe.

The named `companion-data` volume holds `/data/auth`, `/data/capture`, and
`/data/home`. The image runs as UID/GID 1000; a named volume initializes with the
right ownership. If you substitute a bind mount, make its directory owned by
1000:1000 and private (`0700`). Do not share one capture directory between
multiple companion processes.

To change credentials, edit `deploy/companion/companion.env`, then recreate the
service with `docker compose -f deploy/companion/compose.yaml up -d`. Values in
this file are literal (no shell expansion and no wrapping quotes). Env files
and volume data are excluded from the build context. To use another listener
port, set `SCAN_TO_MAKE_GENERATION_PORT` and update the Serve target to match.

```sh
# Logs and shutdown (preserves data)
docker compose -f deploy/companion/compose.yaml logs --tail=100 companion
docker compose -f deploy/companion/compose.yaml down
# List/revoke paired phones
docker compose -f deploy/companion/compose.yaml exec companion \
  node /app/services/companion/dist/remote-auth-cli.js devices /data/auth
docker compose -f deploy/companion/compose.yaml exec companion \
  node /app/services/companion/dist/remote-auth-cli.js revoke /data/auth DEVICE_ID
```

Back up the env file and volume with the service stopped. To upgrade, pull the
source version you want, rebuild, and run `up -d`; keep the volume. `down -v`
removes captures and pairing state, so use ordinary `down` when preserving data.

## macOS

### Independent workers for the signed Counterpart Mac app

For the signed Mac app, use this source-only setup instead of installing a second
companion service. It installs the existing repair/correction/judge tools and
their Python packages outside the app. It does not install Homebrew, printer MCPs,
Blender, a login item, or another listener.

Use a local checkout containing the beta's exact release commit, an existing
**Python 3.12 with venv/ensurepip**, and **Blender 5.0.1**. The app's stripped Python
runtime does not include pip and cannot bootstrap this independent environment.
Open Counterpart once so its private `companion.env` exists. Then, while no cleanup
job is running, run from the checkout:

```sh
/opt/homebrew/bin/python3.12 deploy/companion/install-workers.py \
  --revision "${RELEASE_COMMIT:?Set the beta release source commit}" \
  --python /opt/homebrew/bin/python3.12 \
  --blender /Applications/Blender.app/Contents/MacOS/Blender \
  --env-file "$HOME/Library/Application Support/Scan to Make/companion.env"
```

Select the actual Python/Blender executables on your Mac. For a custom app state
directory, pass that directory's `companion.env`. Omit `--env-file` to install and
qualify workers without changing app configuration. Optional `--root` selects an
independent installation directory; the default is
`~/Library/Application Support/Counterpart Workers/<resolved source SHA>/`.
Existing revision directories are never replaced. To retry a failed setup, use
the same command: its incomplete owned revision directory is removed on failure.

The helper uses `git archive` of the resolved commit, so uncommitted files and
credentials are not copied. It retains the source archive and original LICENSE
files, creates a private venv, and installs the existing exact requirement pins
(`usd-core`, Pillow, and `pillow-heif`) as wheels directly from PyPI, without a pip
cache or global package changes. `python-install.json` records downloaded wheel
URLs/hashes; `installation.json` records the source archive hash, commit and runtime
versions. No worker or wheel is copied into the signed app.

Before app configuration changes, the existing tests must pass with **no skips**:
real HEIC encode/decode, Python/Blender/descendant network denial, and a synthetic
repair → loopback model correction → measured mesh export. This uses no paid model
account, real scan, printer, or user project. A missing/deprecated `sandbox-exec`
fails qualification. Failed setup leaves the existing env file untouched.

After qualification, `--env-file` atomically appends only worker paths, preserving
the existing settings and credential bytes and keeping mode 0600. It does not
restart the app or companion. Restart Counterpart when idle to load the paths.
To undo activation, remove the final `# Independent Counterpart cleanup worker
paths` block from `companion.env` while idle, then restart. Keep previous worker
directories while any saved configuration still references them.

This is an independent local source installation using the existing distribution
boundary. It does not establish terms for redistributing prebuilt GPL components;
retain the upstream wheel notices and the worker source/licenses when maintaining
or sharing an installation. See the [Mac inventory](../../apps/mac/DISTRIBUTION.md).

### Full legacy companion service

Choose the connection you already use. **I'm already set up:** if the phone can
reach this Mac on your LAN, including through an existing WireGuard, Firewalla or
other VPN tunnel, no Tailscale account is needed. Use the Mac's LAN IPv4 address:

```sh
bash deploy/companion/install-macos.sh --lan 192.168.1.10
```

This installs a native HTTPS listener on that address at port 9077. The QR carries
the companion's certificate fingerprint as well as the one-time code; the phone
pins that certificate before sending the code and for subsequent requests. Use a
mobile build with LAN QR support. There is no certificate-profile installation.
Allow incoming connections to Node if macOS Firewall prompts, and use a DHCP
reservation so the address stays stable. The VPN must already route the phone to
that LAN address; this installer does not alter your router or VPN.

**Tailscale option:** install and sign in to [Tailscale on the Mac](https://tailscale.com/docs/install/mac)
and phone. Obtain the Mac's `*.ts.net` name and allowed login, then run:

```sh
bash deploy/companion/install-macos.sh my-mac.my-tailnet.ts.net me@example.com
```

For the standalone macOS Tailscale app the CLI may be
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` rather than on `PATH`.
Only this option uses Serve. Both installer forms run as your login user from
the cloned checkout.

The installer uses Homebrew when present to install Node 24 and Python 3.12.
Without Homebrew it accepts an existing Node 24 plus Python 3.10+ with compatible
USD/HEIC wheels. It always snapshots the current `HEAD` commit, not uncommitted changes.
It builds that source snapshot in
`~/Library/Application Support/Scan to Make/releases/`, installs both npm MCPs,
and creates `~/Library/LaunchAgents/org.scantomake.companion.plist`. It starts
at login, runs as you, and restarts after a crash. The computer must be awake
and your user session logged in.

It uses `/Applications/Blender.app` if it is version 5.0.1. To select another
installation, prefix the command with
`BLENDER=/absolute/path/to/Blender.app/Contents/MacOS/Blender`. With no installed
Blender, Apple Silicon Macs download the checksummed 5.0.1 DMG into the private
release folder. Existing Blender applications are never replaced. There is no
official Intel macOS 5.0.1 download; this installer cannot supply that runtime
on Intel Macs.

Native macOS supports capture conversion, scan-repair and AI-driven scan-correct.
The host model adapter can reach its configured provider; correction Blender
workers and their children run under `/usr/bin/sandbox-exec` with `(deny network*)`, blocking
IPv4/IPv6 TCP, UDP and listening operations. Local IPC remains outside this boundary. The installer proves
that restriction and runs repair → a loopback model fixture → real correction
before replacing a running service. No paid provider call is used for setup.

This is a native path: no Colima VM, Docker context change or ARM Linux Blender
build is needed. The trusted worker retains filesystem access, as on Linux;
this is network isolation, not a general sandbox for model-written code.
Apple deprecates `sandbox-exec`; if it is absent or fails, installation/cleanup
fails closed instead of running without isolation.

The installer prints a terminal QR, a localhost-only QR page address, and the
invitation JSON fallback. Scan with your iPhone Camera app to pair. In Tailscale
mode only, first enable Serve; if that takes more than five minutes, generate a
fresh invitation with the helper below:

```sh
tailscale serve --bg http://127.0.0.1:9077
```

Private credentials go in
`~/Library/Application Support/Scan to Make/companion.env` (Node dotenv syntax;
quote values containing spaces or `#`). Installation paths are configured by
the launcher and kept out of the credential file. LAN certificate/key files live
under `tls/` in that same private state directory and survive upgrades. Certificates
last one year. For an expired certificate or changed LAN address, stop the agent,
move **both** `auth/` and `tls/` into a private backup directory, rerun the installer
with the new/current address, and re-pair every phone. Moving only `auth/` leaves
the old certificate in place and cannot repair its expiry or address mismatch.
Captures and `companion.env` can stay in place. The installer never silently
rotates a certificate under existing phone pairings.

To get another invitation or manage phones, use the helper from any directory.
In LAN mode omit the login (or use `lan`); in Tailscale mode supply your login:

```sh
stm="$HOME/Library/Application Support/Scan to Make"
"$stm/companion" services/companion/dist/remote-auth-cli.js pair-capture-and-printer-handoff "$stm/auth"
# Tailscale: append your login to pair-capture-and-printer-handoff.
"$stm/companion" services/companion/dist/remote-auth-cli.js devices "$stm/auth"
# After editing companion.env:
launchctl kickstart -k "gui/$(id -u)/org.scantomake.companion"
# Logs:
tail -n 100 "$stm/logs/companion-error.log"
```


Open the printed local page on the companion computer; its port is temporary and
is **not** the companion's Serve/API port. It refreshes to remove a consumed or
expired QR and closes shortly after expiry. Over SSH, the terminal QR is available
without opening a Mac window. Do not forward the page through Serve or share the
QR, invitation JSON or pairing deep link in chat or tickets. Stdout from the
pairing CLI remains JSON; QR and page instructions go to stderr.
The installer grants capture and printer-handoff access together. Use `pair-capture`
instead when the phone only needs capture access. Existing paired devices retain
their original scopes until explicitly re-paired.

To verify a real capture through the same HTTPS API as the phone, create a fresh
invitation privately and run the included smoke client. It pairs a separate test
device, uploads the USDZ, runs repair → measure → render, downloads all thirteen
artifacts and checks their hashes. It never supplies simulated Serve headers or
disables TLS verification. For LAN mode, the installed helper supplies the private
certificate path and the client verifies its fingerprint. For Tailscale, append
your login to the pairing command. Use a new output directory for each run:

```sh
umask 077
"$stm/companion" services/companion/dist/remote-auth-cli.js \
  pair-capture "$stm/auth" > "$HOME/companion-invitation.json"
"$stm/companion" deploy/companion/capture-smoke.mjs \
  "$HOME/companion-invitation.json" /absolute/capture.usdz "$HOME/companion-smoke-results"
rm "$HOME/companion-invitation.json"
```

The output directory is private and contains a device token in `device.json`,
job metadata and the returned meshes/report/images. Its summary prints only
identifiers, dimensions and verification counts. Revoke the displayed smoke
`deviceId` with the existing `revoke` command when finished. A failed run can
leave a retained project/job; the client never retries ambiguous POST requests.
Do not commit the invitation, token, capture or output directory.

For host-side cleanup while phone pipeline integration is in progress, the
installed launcher loads the same private env file and Python runtime:

```sh
stm="$HOME/Library/Application Support/Scan to Make"
"$stm/companion" deploy/companion/cleanup.mjs repair /absolute/capture.obj \
  --units mm --out /absolute/repaired
"$stm/companion" deploy/companion/cleanup.mjs run /absolute/repaired/repaired.obj \
  --units mm --out /absolute/corrected --adapter anthropic
```

Put `ANTHROPIC_API_KEY` in `companion.env`, or select the existing OpenAI-compatible
adapter with `--adapter openai --model MODEL --base-url URL --key-env KEY_NAME`.
The key remains in the host adapter; the existing worker env allowlist omits it.
`advise`, `measure` and `render` are also available through this helper. These
commands reuse the Python CLIs; they add no HTTP routes or new geometry logic.

Re-run the installer from a newer committed checkout to upgrade. Auth, captures
and `companion.env` are preserved; old release directories remain available.
The installer validates the existing host/login before replacing the service.
To stop and remove the login agent (data stays in place):

```sh
launchctl bootout "gui/$(id -u)/org.scantomake.companion"
rm "$HOME/Library/LaunchAgents/org.scantomake.companion.plist"
```

## Printer backends and LAN access

`bambu-printer-mcp` supplies `lay_flat`, `slice_stl`, `inspect_print_file`,
`print_3mf`, AMS resolution and the print safety/confirmation core. Packaging
reuses the published server and its mandatory install-time patches. It does
not implement slicing or printing. The generic server is installed independently
so those patches cannot alter its dependencies.

Set `PRINTER_HOST`, `BAMBU_MODEL`, `BAMBU_SERIAL` and `BAMBU_TOKEN` in the
companion's env file, following the
[Bambu setup guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/SETUP.md).
Other printer backends use the configuration described in the
[generic server README](https://github.com/DMontgomery40/mcp-3D-printer-server).
Keep both servers on stdio; no printer-MCP HTTP port is exposed by this package.

The host must have a route to the printer LAN. Direct Bambu transport uses
MQTT/TLS 8883, FTPS 990 and its data connections; printer mode, firewall/VLAN
rules and firmware determine which route works. Tailscale access to the companion
does not automatically make a remote printer reachable. Follow the backend's
[FULU guide](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md)
for signed bridge routes and its setup guide for model-specific requirements.
Human print confirmations stay with the selected MCP server.

A slicer, its exact machine/nozzle profiles, the FULU runtime, X2D native helper,
Bambu networking plug-in and interactive Blender MCP addon are **not bundled**.
Headless Blender for cleanup does not start a Blender MCP addon. Configure an
existing native slicer on macOS; on Linux, mount a Linux-compatible slicer and
its full matching profile tree, for example with a local Compose override:

```yaml
services:
  companion:
    volumes:
      - /absolute/linux-slicer-install:/opt/slicer:ro
```

Then set `SLICER_PATH` and `BAMBU_PROFILES_ROOT` to paths inside that mount.
GUI-only macOS binaries cannot run inside the Linux container. Follow upstream
setup for optional native/bridge routes; the image's MCP initialization test
proves discovery, not slicing or physical printer acceptance.

## Verification

From the repository root:

```sh
docker build --platform linux/amd64 -t scan-to-make-companion:local -f deploy/companion/Dockerfile .
bash deploy/companion/smoke.sh
bash -n deploy/companion/install-macos.sh
python3 deploy/companion/test_macos.py -v
python3 deploy/companion/test_install_workers.py -v
```

The smoke test creates an isolated temporary container/volume, initializes
pairing, exchanges an invitation, requires authenticated `/healthz` to return
`{"status":"ok","protocolVersion":"0.1.0"}`, and checks anonymous denial.
It initializes and lists tools from **both** MCPs, checks `Blender 5.0.1`, imports
USD/Pillow/HEIC, and exercises the real non-root correction network sandbox.
It removes its own container/volume on exit. No printer command is sent.

The recurring Docker health check is a **liveness** probe: in private mode an
anonymous `/healthz` must return the expected 403. Only the smoke test or a
paired phone proves authenticated health. macOS checks on Linux cover shell
syntax, platform guard, plist serialization, paths with spaces/apostrophes and
env-file preservation; they do not exercise Homebrew, DMG mounting or launchd.
The native Mac acceptance tests additionally prove live socket denial in Python
and Blender descendants, a real loopback model correction, and measured exports.
The mac-cleanup CI workflow runs the full correction suite on Apple Silicon.

Blender's Linux pin matches the existing scan-repair CI; both platforms also
check Blender's published checksum manifest. Upstream licence texts remain in
the Blender distribution, npm packages and Python distributions (including
`pillow_heif` bundled-library notices). This recipe builds locally and does not
publish a prebuilt image. Source references: [Blender 5.0.1](https://projects.blender.org/blender/blender/src/tag/v5.0.1),
[bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp),
[mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server),
[pillow-heif](https://github.com/bigcat88/pillow_heif).

Pairing commands, including the final installer step, write the single-use code
in invitation JSON to stdout. The terminal QR and temporary local page URL go
to stderr. Treat both streams as credentials: do not tee installation or pairing
output into shared logs or upload it as a CI artifact.
