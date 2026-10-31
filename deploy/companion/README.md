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
Tailscale on the host and phone. Blender 5.0.1 has no official Linux ARM64 archive;
this image is **linux/amd64 only**. ARM NAS emulation is not qualified. Allow
several GB of disk for the image, build cache and captures. Download and install
[Tailscale](https://tailscale.com/download), sign both devices into the same
tailnet, and note the host's full `*.ts.net` name and your Tailscale login.

```sh
git clone https://github.com/DMontgomery40/scan-to-make.git
cd scan-to-make
cp deploy/companion/companion.env.example deploy/companion/companion.env
chmod 600 deploy/companion/companion.env
docker compose -f deploy/companion/compose.yaml build
```

Initialize pairing storage **once**, replacing both example values:

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

Paste the invitation into the app's Companion pairing screen within five
minutes. Tailscale may ask you to enable HTTPS for your tailnet. This uses
private Serve, not public Funnel: the existing companion requires Serve's
identity headers and a paired device token. See [transport setup](../../docs/tailscale-setup.md).

Compose uses **host networking on Linux**, so host Tailscale Serve can reach
the companion's existing `127.0.0.1:9077` listener. A Docker `ports:` mapping
cannot reach a service bound only to the container's loopback. NAS platforms
must support Linux host networking and host-side Tailscale Serve. The compose
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

Clone the repo as above, then run one installer command as your login user:

```sh
bash deploy/companion/install-macos.sh my-mac.my-tailnet.ts.net me@example.com
```

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

The installer prints a short-lived invitation. Install/sign in to Tailscale on
the Mac and phone, enable private HTTPS, then pair:

```sh
tailscale serve --bg http://127.0.0.1:9077
```

Private credentials go in
`~/Library/Application Support/Scan to Make/companion.env` (Node dotenv syntax;
quote values containing spaces or `#`). Installation paths are configured by
the launcher and kept out of the credential file. To get another invitation or
manage phones, use the installed CLI helper from any directory:

```sh
stm="$HOME/Library/Application Support/Scan to Make"
"$stm/companion" services/companion/dist/remote-auth-cli.js pair-capture "$stm/auth" me@example.com
"$stm/companion" services/companion/dist/remote-auth-cli.js devices "$stm/auth"
# After editing companion.env:
launchctl kickstart -k "gui/$(id -u)/org.scantomake.companion"
# Logs:
tail -n 100 "$stm/logs/companion-error.log"
```


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
