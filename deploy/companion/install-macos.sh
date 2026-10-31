#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = --help ]; then
  echo 'Usage: bash deploy/companion/install-macos.sh <host.tailnet.ts.net> <tailscale-login>'
  echo 'Optional: BLENDER=/absolute/path/to/Blender; STM_INSTALL_ROOT=/absolute/private/directory'
  exit 0
fi
[ "$(uname -s)" = Darwin ] || { echo 'This installer requires macOS.' >&2; exit 1; }
[ "$#" = 2 ] || { echo 'Pass the Tailscale Serve FQDN and allowed login (see --help).' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Run as your login user, not sudo (launchd user agent).' >&2; exit 1; }
umask 077
source_root=$(cd "$(dirname "$0")/../.." && pwd)
state=${STM_INSTALL_ROOT:-"$HOME/Library/Application Support/Scan to Make"}
case "$state" in /*) ;; *) echo 'STM_INSTALL_ROOT must be absolute' >&2; exit 1 ;; esac
# Homebrew may be installed but absent from a noninteractive shell's PATH.
if ! command -v brew >/dev/null; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then export PATH="$(dirname "$candidate"):$PATH"; break; fi
  done
fi
if command -v brew >/dev/null; then
  brew install node@24 python@3.12
  node="$(brew --prefix node@24)/bin/node"
  python="$(brew --prefix python@3.12)/bin/python3.12"
else
  node=$(command -v node || true)
  python=$(command -v python3 || true)
  [ -n "$node" ] && [ -n "$python" ] || { echo 'Install Homebrew, or Node 24 and Python 3.12, then rerun.' >&2; exit 1; }
fi
[ "$("$node" -p 'process.versions.node.split(".")[0]')" = 24 ] || { echo 'Node 24 is required.' >&2; exit 1; }
"$python" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'
export PATH="$(dirname "$node"):$PATH"
mkdir -p "$state/releases"
app=$(mktemp -d "$state/releases/install-XXXXXXXX")
# Install the committed snapshot only, never local credentials, captures or node_modules.
git -C "$source_root" archive HEAD packages/contracts services/project services/companion \
  tools/capture-mesh-convert tools/capture-pipeline tools/capture-fit-eval \
  tools/scan-repair tools/scan-correct deploy/companion | tar -xf - -C "$app"
git -C "$source_root" rev-parse HEAD > "$app/REVISION"
for package in packages/contracts services/project services/companion; do npm ci --prefix "$app/$package"; done
npm run build --prefix "$app/services/companion"
for package in packages/contracts services/project services/companion; do npm prune --omit=dev --prefix "$app/$package"; done
"$python" -m venv "$app/.venv"
"$app/.venv/bin/pip" install -r "$app/tools/capture-mesh-convert/requirements.txt" -r "$app/tools/scan-correct/requirements.txt"
npm install --global --prefix "$app/printers/bambu" bambu-printer-mcp@1.1.42
npm install --global --prefix "$app/printers/generic" mcp-3d-printer-server@1.2.20
blender=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
if [ ! -x "$blender" ] && [ -z "${BLENDER:-}" ]; then
  bash "$app/deploy/companion/download-blender.sh" "$app/blender"
  blender="$app/blender/Blender.app/Contents/MacOS/Blender"
fi
[ -x "$blender" ] || { echo 'BLENDER must name an executable Blender 5.0.1 binary.' >&2; exit 1; }
version=$("$blender" --version)
[ "${version%%$'\n'*}" = 'Blender 5.0.1' ] || { echo 'Select Blender 5.0.1 with BLENDER (existing installation is preserved).' >&2; exit 1; }
# Qualify the native security boundary and full host/model/worker path before
# replacing a running service. Fixtures are synthetic; no provider API is called.
export BLENDER="$blender"
"$app/.venv/bin/python" -m unittest discover -s "$app/tools/scan-correct/tests" -p test_sandbox.py -v
"$app/.venv/bin/python" -m unittest discover -s "$app/tools/scan-correct/tests" -p test_native_cleanup.py -v
if [ ! -e "$state/auth" ]; then
  "$node" "$app/services/companion/dist/remote-auth-cli.js" init "$state/auth" "$1" "$2"
else
  # Do not silently reuse a different host/login when reinstalling.
  "$node" --input-type=module - "$app" "$state/auth" "$1" "$2" <<'JS'
import {pathToFileURL} from 'node:url';
const [app, dir, host, login] = process.argv.slice(2);
const {RemoteAuthStore} = await import(pathToFileURL(`${app}/services/companion/dist/remote-auth.js`));
const store = await RemoteAuthStore.open(dir);
if (store.host !== host || !store.allowsLogin(login)) throw new Error('Existing pairing configuration differs; use the original host/login.');
JS
fi
export PATH="$app/printers/bambu/bin:$app/printers/generic/bin:$PATH"
"$node" "$app/deploy/companion/mcp-smoke.mjs"
label=org.scantomake.companion
plist="$HOME/Library/LaunchAgents/$label.plist"
# All builds/downloads verified before replacing the running service.
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
"$python" "$app/deploy/companion/configure-macos.py" --state "$state" --app "$app" \
  --node "$node" --blender "$blender" --launch-agents "$HOME/Library/LaunchAgents"
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart "gui/$(id -u)/$label"
ready=0
for attempt in {1..15}; do
  if "$state/companion" "$app/deploy/companion/healthcheck.mjs" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "Service did not become ready. Inspect $state/logs" >&2; exit 1; }
printf '\nInstalled. Config: %s/companion.env\nCLI: %s/companion\n' "$state" "$state"
printf 'Enable private HTTPS with: tailscale serve --bg http://127.0.0.1:9077\n'
printf 'Native capture, repair and AI correction are installed; correction workers have no network access.\n'
"$state/companion" "$app/services/companion/dist/remote-auth-cli.js" pair-capture "$state/auth" "$2"
